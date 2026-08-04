import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildDeterminismArgs,
  compareBrowserVersion,
  DEFAULT_RENDERER_POLICY_HASH,
  declarationFromManifest,
  fallbackDeclaration,
  majorMinorBuild,
  readRendererManifest,
  RENDERER_SCHEMA,
  RENDERER_VERSION,
  rendererDeclaration,
  rendererFingerprint,
  rendererFingerprintOf,
  rendererReport,
  strictManifestEnabled,
  type RendererDeclaration,
} from "./renderer";
import { CASE_FINGERPRINT_ALGO_VERSION, caseFingerprint, DEFAULT_READINESS_POLICY_HASH } from "../acceptance/ids";
import pin from "./rendererPin.json";
import { openDatabase } from "../db";
import { createTestHandler } from "../test-auth";
import { isTerminalJobOutcome, ScreenshotService, type RunJob, type WorkerResult } from "../screenshot/service";
import { prototypeDocSchema } from "../../src/prototype/schema";

// R1 плана 2026-08-03-renderer-contract-2: отпечаток рендерера — объявленный, серверный,
// до-капчурный, построенный от **фактически запускаемого** бинаря (chrome-headless-shell).
// Инвариант K8 §1: reuse приёмки не переживает апгрейд chromium.

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const MANIFEST = {
  manifestVersion: 1,
  rendererVersion: "r2",
  os: "linux",
  arch: "x64",
  nodeVersion: "24.4.0",
  playwrightVersion: "1.61.1",
  browserName: "chromium",
  browserVersion: "149.0.7827.55",
  browserRevision: "1228",
  launchedExecutable: "chrome-headless-shell",
  browserExecutableSha256: "a".repeat(64),
  chromeExecutableSha256: "b".repeat(64),
  fontStackSha256: "c".repeat(64),
  systemLibsHash: "d".repeat(64),
  appFontsSha256: "e".repeat(64),
  contextOptionsHash: null,
  provenance: { buildSha: "deadbeef", imageRef: "ghcr.io/example/easy-ui:deadbeef", builtAt: "2026-08-03T00:00:00.000Z", bunVersion: "1.3.14" },
};

const declaration = (patch: Partial<Record<string, unknown>> = {}): RendererDeclaration =>
  declarationFromManifest({ ...MANIFEST, ...patch });

const caseWith = (rendererFingerprintValue: string): string => caseFingerprint({
  algoVersion: CASE_FINGERPRINT_ALGO_VERSION,
  candidateId: `cand_${"0".repeat(64)}`,
  caseKey: "alpha",
  propsHash: "props-1",
  surface: { viewport: { width: 390, height: 844 }, dsf: 2, theme: "light" },
  readinessPolicyHash: DEFAULT_READINESS_POLICY_HASH,
  rendererFingerprint: rendererFingerprintValue,
  casePolicyHash: "case-policy-v0",
  referenceAssetId: null,
});

describe("renderer fingerprint 2.0", () => {
  test("K8: подмена версии или sha фактически запускаемого бинаря меняет и отпечаток, и case_fingerprint", () => {
    const base = declaration();
    const baseFingerprint = rendererFingerprintOf(base, DEFAULT_READINESS_POLICY_HASH);

    // Апгрейд chromium: новая версия и новый бинарь. Именно этот сценарий переживал reuse до R1.
    const upgraded = declaration({ browserVersion: "150.0.7900.10", browserExecutableSha256: "f".repeat(64) });
    const upgradedFingerprint = rendererFingerprintOf(upgraded, DEFAULT_READINESS_POLICY_HASH);
    expect(upgradedFingerprint).not.toBe(baseFingerprint);
    expect(caseWith(upgradedFingerprint)).not.toBe(caseWith(baseFingerprint));

    // Пересборка того же бинаря (только sha) — тоже другой рендерер.
    const rebuilt = rendererFingerprintOf(declaration({ browserExecutableSha256: "9".repeat(64) }), DEFAULT_READINESS_POLICY_HASH);
    expect(rebuilt).not.toBe(baseFingerprint);
    expect(caseWith(rebuilt)).not.toBe(caseWith(baseFingerprint));

    // Шрифтовой стек образа и системные библиотеки — тоже входы растра.
    for (const patch of [{ fontStackSha256: "1".repeat(64) }, { systemLibsHash: "2".repeat(64) }, { appFontsSha256: "3".repeat(64) }]) {
      expect(rendererFingerprintOf(declaration(patch), DEFAULT_READINESS_POLICY_HASH)).not.toBe(baseFingerprint);
    }
  });

  test("K8: правка provenance (коммит, imageRef, время сборки) отпечаток НЕ меняет", () => {
    const base = rendererFingerprintOf(declaration(), DEFAULT_READINESS_POLICY_HASH);
    const moved = declaration({
      provenance: { buildSha: "cafebabe", imageRef: "ghcr.io/example/easy-ui:cafebabe", builtAt: "2026-09-09T09:09:09.000Z", bunVersion: "1.4.0" },
    });
    expect(rendererFingerprintOf(moved, DEFAULT_READINESS_POLICY_HASH)).toBe(base);
    expect(caseWith(rendererFingerprintOf(moved, DEFAULT_READINESS_POLICY_HASH))).toBe(caseWith(base));
    // …и `chromeExecutableSha256` — тоже: полный chrome кадров не рисует (C-B1).
    expect(rendererFingerprintOf(declaration({ chromeExecutableSha256: "0".repeat(64) }), DEFAULT_READINESS_POLICY_HASH)).toBe(base);
  });

  test("политика readiness входит в отпечаток, а сам отпечаток детерминирован", () => {
    const base = declaration();
    expect(rendererFingerprintOf(base, DEFAULT_READINESS_POLICY_HASH)).toBe(rendererFingerprintOf(declaration(), DEFAULT_READINESS_POLICY_HASH));
    expect(rendererFingerprintOf(base, "other-policy")).not.toBe(rendererFingerprintOf(base, DEFAULT_READINESS_POLICY_HASH));
    expect(rendererFingerprintOf(base, DEFAULT_READINESS_POLICY_HASH)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("bump алгоритма отпечатка случая в пакете ровно один: версия === 5", () => {
    // §2.2 N5: R1 меняет схему входа (captureEnvFingerprint → rendererFingerprint), дальнейшие
    // волны (флаги R2a, строгая readiness R4) меняют только значения внутри уже входящих хешей.
    expect(CASE_FINGERPRINT_ALGO_VERSION).toBe(5);
  });

  test("детерминизм-флаги запуска входят в отпечаток дословно", () => {
    // R1 фиксирует явные дубли того, что playwright передаёт сам, — чтобы отпечаток перестал
    // зависеть от внутренностей chromiumSwitches() конкретной версии playwright (C-M2).
    expect(buildDeterminismArgs()).toEqual(["--force-color-profile=srgb", "--hide-scrollbars"]);
    const base = declaration();
    const drifted: RendererDeclaration = { ...base, launchDeterminismArgsHash: "different" };
    expect(rendererFingerprintOf(drifted, DEFAULT_READINESS_POLICY_HASH)).not.toBe(rendererFingerprintOf(base, DEFAULT_READINESS_POLICY_HASH));
  });
});

describe("renderer manifest", () => {
  test("манифест образа читается, provenance едет рядом с объявлением", async () => {
    const dir = await mkdtemp(resolve(process.cwd(), ".tmp-renderer-"));
    dirs.push(dir);
    const file = resolve(dir, "renderer-manifest.json");
    await writeFile(file, JSON.stringify(MANIFEST));
    const manifest = readRendererManifest(file);
    expect(manifest).not.toBeNull();
    const parsed = declarationFromManifest(manifest!);
    expect(parsed.source).toBe("manifest");
    expect(parsed.launchedExecutable).toBe("chrome-headless-shell");
    expect(parsed.browserExecutableSha256).toBe("a".repeat(64));
    expect(parsed.provenance?.buildSha).toBe("deadbeef");
    expect(parsed.rendererSchema).toBe(RENDERER_SCHEMA);
  });

  test("отсутствующий/битый манифест не бросает, а даёт null", async () => {
    expect(readRendererManifest(undefined)).toBeNull();
    expect(readRendererManifest("/nope/renderer-manifest.json")).toBeNull();
    const dir = await mkdtemp(resolve(process.cwd(), ".tmp-renderer-"));
    dirs.push(dir);
    const file = resolve(dir, "broken.json");
    await writeFile(file, "{not json");
    expect(readRendererManifest(file)).toBeNull();
  });

  test("dev-фолбэк деградирует полями в null и остаётся стабильным", () => {
    const fallback = fallbackDeclaration();
    expect(fallback.source).toBe("fallback");
    expect(fallback.browserExecutableSha256).toBeNull();
    expect(fallback.fontStackSha256).toBeNull();
    expect(fallback.provenance).toBeNull();
    expect(fallback.rendererVersion).toBe(RENDERER_VERSION);
    // Дешёвые факты рабочего дерева всё же известны — иначе отпечаток был бы бессодержателен.
    expect(fallback.playwrightVersion).toBe(pin.playwright);
    expect(rendererFingerprintOf(fallback, DEFAULT_READINESS_POLICY_HASH))
      .toBe(rendererFingerprintOf(fallbackDeclaration(), DEFAULT_READINESS_POLICY_HASH));
  });

  test("объявление процесса заморожено: повторные чтения дают тот же отпечаток", () => {
    const first = rendererDeclaration();
    expect(rendererDeclaration()).toBe(first);
    expect(rendererFingerprint(DEFAULT_READINESS_POLICY_HASH)).toBe(rendererFingerprint(DEFAULT_READINESS_POLICY_HASH));
    const report = rendererReport();
    expect(report.policyHash).toBe(DEFAULT_RENDERER_POLICY_HASH);
    expect(report.fingerprint).toBe(rendererFingerprintOf(first, DEFAULT_RENDERER_POLICY_HASH));
    expect(report.rendererVersion).toBe(RENDERER_VERSION);
  });
});

describe("сверка версии браузера", () => {
  test("сравнение по major.minor.build, patch игнорируется", () => {
    expect(majorMinorBuild("149.0.7827.55")).toBe("149.0.7827");
    expect(majorMinorBuild("test/1")).toBeNull();
    expect(compareBrowserVersion("149.0.7827.55", "149.0.7827.99")).toBe("match");
    expect(compareBrowserVersion("149.0.7827.55", "150.0.7900.10")).toBe("mismatch");
    // Синтетические версии стендов не должны превращаться в отказ капчура.
    expect(compareBrowserVersion("149.0.7827.55", "test/1")).toBe("unknown");
    expect(compareBrowserVersion(null, "149.0.7827.55")).toBe("unknown");
  });

  test("strict-режим — дефолт, EASYUI_RENDERER_STRICT_MANIFEST=0 его снимает", () => {
    const previous = process.env.EASYUI_RENDERER_STRICT_MANIFEST;
    try {
      delete process.env.EASYUI_RENDERER_STRICT_MANIFEST;
      expect(strictManifestEnabled()).toBe(true);
      process.env.EASYUI_RENDERER_STRICT_MANIFEST = "0";
      expect(strictManifestEnabled()).toBe(false);
      process.env.EASYUI_RENDERER_STRICT_MANIFEST = "1";
      expect(strictManifestEnabled()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.EASYUI_RENDERER_STRICT_MANIFEST;
      else process.env.EASYUI_RENDERER_STRICT_MANIFEST = previous;
    }
  });
});

describe("сверка манифеста на капчуре (§3 E2)", () => {
  // Наблюдённая версия приезжает от воркера (`browser.version()`); объявленная — из манифеста
  // (в тестовом дереве — dev-фолбэк, который берёт версию из browsers.json playwright).
  const PNG_1X1 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]);
  const workerOk = (browserVersion: string): WorkerResult => ({
    ok: true, pngBase64: Buffer.from(PNG_1X1).toString("base64"), width: 1, height: 1,
    consoleErrors: [], pageErrors: [], browserVersion,
  });

  async function captureWith(browserVersion: string) {
    const dir = await mkdtemp(resolve(process.cwd(), ".tmp-renderer-job-"));
    dirs.push(dir);
    const db = openDatabase(":memory:");
    const runJob: RunJob = async () => workerOk(browserVersion);
    const service = new ScreenshotService({ db, dataDir: dir, serveDist: "dist", captureOrigin: "http://127.0.0.1:8787", chromiumAvailable: true, runJob });
    const handler = createTestHandler(db, { dataDir: dir, screenshots: service });
    const original = prototypeDocSchema.parse(await Bun.file("test/fixtures/host-content.json").json());
    const doc = { ...original, id: `renderer-${browserVersion.replace(/\W/g, "-")}`, name: "renderer probe" };
    const created = await handler(new Request("http://test/api/prototypes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc }) }));
    expect(created.status).toBe(201);
    const enqueued = await handler(new Request(`http://test/api/prototypes/${doc.id}/screens/welcome/screenshot`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, theme: "light" }),
    }));
    expect(enqueued.status).toBe(202);
    const { jobId } = await enqueued.json() as { jobId: string };
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const status = service.get(jobId);
      if (status.status === "done" || status.status === "error") { db.close(); return status; }
      await Bun.sleep(10);
    }
    db.close();
    throw new Error("capture job did not settle");
  }

  test("расхождение major.minor.build даёт renderer_mismatch, совпадение — обычный кадр", async () => {
    const declared = rendererDeclaration().browserVersion;
    expect(declared).not.toBeNull();

    const mismatched = await captureWith("199.0.1111.0");
    expect(mismatched.status).toBe("error");
    expect(mismatched.error?.code).toBe("renderer_mismatch");
    expect(mismatched.error?.message).toContain("199.0.1111.0");
    // R3: у расхождения собственный **терминальный** исход таксономии — приёмка больше не тратит
    // на него бюджет инфраструктурных ретраев (ретрай в том же процессе даст то же расхождение).
    expect(mismatched.outcome).toBe("renderer_mismatch");
    expect(mismatched.failure?.code).toBe("renderer_mismatch");
    expect(isTerminalJobOutcome("renderer_mismatch")).toBe(true);
    expect(isTerminalJobOutcome("subprocess_error")).toBe(false);

    // Та же major.minor.build, другой patch — не расхождение (T-M7).
    const patched = await captureWith(`${majorMinorBuild(declared)!}.999`);
    expect(patched.status).toBe("done");
    const declaredOnJob = (patched.result as { renderer?: { fingerprint: string; source: string } } | undefined)?.renderer;
    expect(declaredOnJob?.fingerprint).toBe(rendererReport().fingerprint);
    expect(declaredOnJob?.source).toBe(rendererDeclaration().source);
  });

  test("EASYUI_RENDERER_STRICT_MANIFEST=0 деградирует расхождение до предупреждения", async () => {
    const previous = process.env.EASYUI_RENDERER_STRICT_MANIFEST;
    process.env.EASYUI_RENDERER_STRICT_MANIFEST = "0";
    try {
      const status = await captureWith("199.0.1111.0");
      expect(status.status).toBe("done");
      expect(status.result?.runtimeWarnings.some((warning) => warning.startsWith("renderer_mismatch:"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.EASYUI_RENDERER_STRICT_MANIFEST;
      else process.env.EASYUI_RENDERER_STRICT_MANIFEST = previous;
    }
  });
});
