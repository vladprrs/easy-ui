import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { extractDefinition } from "./components/extract-subprocess";
import { writeCandidate } from "./components/candidates";
import { runtimeDefaultsWarnings } from "./components/runtimeDefaults";
import { buildFingerprint, candidateId } from "./acceptance/ids";

/**
 * W9 (план `docs/plans/2026-08-07-migration-feedback-wave.md` §1.6, §W9): серверная сторона
 * runtime schema defaults — drift-аудит извлечения, сдвиг candidate id через `sourceHash` и
 * предупреждение приёмки о поднятом аварийном kill-switch'е.
 */

const fixture = (name: string) => resolve(import.meta.dir, "fixtures", `${name}.tsx`);
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

const killSwitchBefore = process.env.EASYUI_RUNTIME_DEFAULTS_DISABLED;
afterEach(() => {
  if (killSwitchBefore === undefined) delete process.env.EASYUI_RUNTIME_DEFAULTS_DISABLED;
  else process.env.EASYUI_RUNTIME_DEFAULTS_DISABLED = killSwitchBefore;
});

test("drift-аудит: схема с дефолтом без capability даёт runtime_default_drift", async () => {
  const drifting = await extractDefinition(fixture("schema-defaults-drift"), { smoke: false });
  expect(drifting.ok).toBe(true);
  const warning = drifting.warnings.find((item) => item.startsWith("runtime_default_drift:"));
  expect(warning).toBeDefined();
  // Предупреждение обязано называть **поля**: «где-то есть дефолт» не чинится.
  expect(warning).toContain("size");
  expect(warning).not.toContain("label");

  // Та же схема с объявленной capability предупреждения не даёт: дрейфа нет — есть контракт.
  const flagged = await extractDefinition(fixture("schema-defaults-flagged"), { smoke: false });
  expect(flagged.ok).toBe(true);
  expect(flagged.warnings.some((item) => item.startsWith("runtime_default_drift:"))).toBe(false);
  // …и capability доезжает до meta — именно отсюда её читают candidates/publish.
  expect(flagged.meta?.capabilities?.runtimeSchemaDefaults).toBe(true);
});

test("candidate id двигается через sourceHash, а не через новый вход отпечатка", async () => {
  const before = await Bun.file(fixture("schema-defaults-drift")).text();
  const after = await Bun.file(fixture("schema-defaults-flagged")).text();
  // Отпечатки не расширялись (§1.6): единственная разница входов — `sourceHash` исходника.
  const idOf = (source: string) => candidateId({
    componentId: "cmp_badge", designSystem: "yandex-pay", rev: 7,
    buildFingerprint: buildFingerprint({
      sourceHash: sha256(source), bundleHash: "b".repeat(64), hostAbiVersion: 2, themeVersion: 3,
    }),
  });
  expect(idOf(before)).not.toBe(idOf(after));
  // Тот же исходник — тот же id: сдвиг именно от объявления флага, а не от нестабильности хэша.
  expect(idOf(after)).toBe(idOf(after));
});

test("accept-status предупреждает о kill-switch'е только для флагнутой семьи", async () => {
  const dataDir = await mkdtemp(resolve(import.meta.dir, "..", ".e2e-data", "w9-"));
  try {
    const run = { candidate_id: "cand_x", component_id: "cmp_badge" };
    const flaggedHash = "1".repeat(64);
    const plainHash = "2".repeat(64);
    await writeCandidate(dataDir, {
      version: 1, sourceHash: flaggedHash, componentIds: ["cmp_badge"], createdAt: new Date().toISOString(), ok: true,
      extracted: { ok: true, warnings: [], meta: { events: [], slots: [], description: "x", capabilities: { runtimeSchemaDefaults: true } } },
    });
    await writeCandidate(dataDir, {
      version: 1, sourceHash: plainHash, componentIds: ["cmp_badge"], createdAt: new Date().toISOString(), ok: true,
      extracted: { ok: true, warnings: [], meta: { events: [], slots: [], description: "x" } },
    });

    // Штатный режим: предупреждений нет ни у кого — и запись кандидата даже не читается.
    delete process.env.EASYUI_RUNTIME_DEFAULTS_DISABLED;
    expect(await runtimeDefaultsWarnings(dataDir, run, flaggedHash)).toEqual([]);

    process.env.EASYUI_RUNTIME_DEFAULTS_DISABLED = "1";
    // Нефлагнутая семья kill-switch'ем не затронута: её рендер и так доволновый.
    expect(await runtimeDefaultsWarnings(dataDir, run, plainHash)).toEqual([]);
    const warnings = await runtimeDefaultsWarnings(dataDir, run, flaggedHash);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe("runtime_defaults_disabled");
    expect(warnings[0]!.candidateId).toBe("cand_x");
    // Пропавшая запись кандидата (TTL/GC) — не повод выдумывать флаг.
    expect(await runtimeDefaultsWarnings(dataDir, run, "3".repeat(64))).toEqual([]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
