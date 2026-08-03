import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pngjs from "pngjs";
import { migrate } from "../../migrations";
import { putArtifact, readArtifact } from "../evidence";
import { ACCEPTANCE_POLICIES } from "../policies";
import { spawnNormalizedDiffWorker } from "../../visual/diff-runner";
import type { CandidateSubject, GateContext } from "./types";
import { paintShaKey } from "./geometry2";
import { visualGate, visualSeverityClass } from "./visual";

/**
 * Гейт `visual` (план 2026-08-03 §2 A5, §5 W5a).
 *
 * Предмет — **обязательность и честность вердикта**, а не арифметика diff'а (её держит
 * `server/visual-diff-normalize.test.ts`):
 * - без эталона: `skipped` у необязательного гейта, `indeterminate` у обязательного (D10 —
 *   `skipped` допустим только необязательным);
 * - несводимые размеры: `indeterminate` с названной причиной, а не `fail`;
 * - порог случая: per-case `maxRawDiffPct` манифеста перекрывает профильный.
 */

const { PNG } = pngjs;
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const INK: [number, number, number, number] = [0x20, 0x40, 0xc0, 0xff];

function framePng(
  width: number, height: number,
  rect: { x: number; y: number; width: number; height: number; color: [number, number, number, number] } | null,
): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(0);
  if (rect) {
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        const offset = (y * width + x) * 4;
        png.data[offset] = rect.color[0]; png.data[offset + 1] = rect.color[1];
        png.data[offset + 2] = rect.color[2]; png.data[offset + 3] = rect.color[3];
      }
    }
  }
  return PNG.sync.write(png);
}

const CANDIDATE = framePng(40, 32, { x: 8, y: 6, width: 16, height: 12, color: INK });
/** Тот же кадр с перекрашенным прямоугольником: 15% холста — заведомо выше любого бюджета. */
const RECOLOURED = framePng(40, 32, { x: 8, y: 6, width: 16, height: 12, color: [0xc0, 0x20, 0x20, 0xff] });
/** Кадр другого размера: свести с кандидатом нельзя ни crop'ом, ни pad'ом. */
const OVERSIZED = framePng(200, 160, { x: 20, y: 20, width: 40, height: 40, color: INK });

const sha256 = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** Кладёт байты в asset-store так же, как это делает ingest: строка в `assets` + файл по sha. */
async function putAsset(db: Database, dataDir: string, bytes: Buffer): Promise<string> {
  const sha = sha256(new Uint8Array(bytes));
  const id = `asset_${sha}`;
  await mkdir(resolve(dataDir, "assets"), { recursive: true });
  await writeFile(resolve(dataDir, "assets", sha), bytes);
  db.run(
    "INSERT OR IGNORE INTO assets (id,sha256,mime,size,width,height,original_name,created_at) VALUES (?,?,?,?,?,?,?,?)",
    [id, sha, "image/png", bytes.byteLength, null, null, "reference.png", new Date().toISOString()],
  );
  return id;
}

interface ContextOptions {
  policyId?: keyof typeof ACCEPTANCE_POLICIES;
  referenceAssetId?: string | null;
  casePolicy?: { maxRawDiffPct?: number };
  cropLineage?: { rect: [number, number, number, number] };
  /** Кандидатный кадр в CAS; `null` — гейт вызывается без снятого paint-кадра. */
  candidate?: Buffer | null;
  runDiff?: GateContext["runDiff"];
}

async function context(options: ContextOptions = {}) {
  const dir = await mkdtemp(resolve(process.cwd(), ".visual-gate-test-"));
  dirs.push(dir);
  const db = new Database(":memory:");
  migrate(db);
  const shared = new Map<string, unknown>();
  const candidate = options.candidate === undefined ? CANDIDATE : options.candidate;
  if (candidate) {
    const stored = await putArtifact(dir, new Uint8Array(candidate));
    shared.set(paintShaKey("alpha"), stored.sha256);
  }
  const ctx: GateContext = {
    db,
    dataDir: dir,
    service: null as unknown as GateContext["service"],
    policy: ACCEPTANCE_POLICIES[options.policyId ?? "default-v1"],
    runId: "acc_00000000-0000-4000-8000-000000000000",
    candidate: { componentId: "visual-probe", rev: 1, sourceHash: "src" } as unknown as CandidateSubject,
    case: {
      caseId: "alpha", caseKey: "alpha", props: {}, propsHash: "ph", aliasOfCaseId: null,
      ...(options.referenceAssetId === undefined ? {} : { referenceAssetId: options.referenceAssetId }),
      ...(options.casePolicy ? { casePolicy: options.casePolicy } : {}),
      ...(options.cropLineage ? { cropLineage: options.cropLineage } : {}),
    },
    surface: { viewport: { width: 390, height: 844 }, dsf: 2, theme: "light" },
    determinismSampled: false,
    shared,
    sleep: () => Promise.resolve(),
    now: () => Date.now(),
    runDiff: options.runDiff ?? spawnNormalizedDiffWorker,
  };
  return { ctx, db, dir };
}

test("случай без эталона: skipped у необязательного гейта и indeterminate у обязательного", async () => {
  const advisory = await context();
  const skipped = await visualGate.run(advisory.ctx);
  expect(skipped.status).toBe("skipped");
  expect(skipped.metrics).toMatchObject({ required: false, reason: "no_reference" });
  advisory.db.close();

  // `pixel-strict-v1` требует визуального вердикта: `skipped` замаскировал бы непроверенный случай.
  const strict = await context({ policyId: "pixel-strict-v1" });
  const indeterminate = await visualGate.run(strict.ctx);
  expect(indeterminate.status).toBe("indeterminate");
  expect(indeterminate.metrics).toMatchObject({ required: true, reason: "no_reference" });
  expect(indeterminate.detail).toContain("referenceAssetId");
  strict.db.close();
});

test("эталон == кандидат: pass, метрики и оба артефакта в CAS", async () => {
  const { ctx, db, dir } = await context({ policyId: "pixel-strict-v1" });
  const referenceAssetId = await putAsset(db, dir, CANDIDATE);
  ctx.case.referenceAssetId = referenceAssetId;

  const result = await visualGate.run(ctx);
  expect(result.status).toBe("pass");
  expect(result.metrics).toMatchObject({
    required: true, maxRawDiffPct: 0.5, rawDiffPct: 0, aaDiffPct: 0, maxChannelDelta: 0,
    referenceAssetId, severityClass: "aa", totalRegions: 0,
  });
  expect(result.metrics!.bestOffset).toMatchObject({ dx: 0, dy: 0, residualPct: 0 });
  expect(result.artifacts?.map((item) => item.name).sort()).toEqual(["diff.png", "normalized-candidate.png", "visual.json"]);
  // Эталон в CAS **не** копируется (A5): в манифест кейса едет его asset-id.
  const record = JSON.parse(new TextDecoder().decode(
    (await readArtifact(dir, result.artifacts!.find((item) => item.name === "visual.json")!.sha256))!,
  )) as { verdict: string; referenceAssetId: string; metrics: { rawDiffPct: number } };
  expect(record).toMatchObject({ verdict: "pass", referenceAssetId });
  expect(record.metrics.rawDiffPct).toBe(0);
  db.close();
});

test("сломанный эталон: fail с метриками, severity-класс из aaDiffPct", async () => {
  const { ctx, db, dir } = await context();
  ctx.case.referenceAssetId = await putAsset(db, dir, RECOLOURED);

  const result = await visualGate.run(ctx);
  expect(result.status).toBe("fail");
  const metrics = result.metrics as { rawDiffPct: number; aaDiffPct: number; maxChannelDelta: number; severityClass: string; regions: unknown[] };
  expect(metrics.rawDiffPct).toBeGreaterThan(2);
  expect(metrics.aaDiffPct).toBeGreaterThan(2);
  expect(metrics.maxChannelDelta).toBeGreaterThan(0);
  // Расхождение не объясняется сглаживанием ⇒ класс `raw` (тяжелее `aa` по рангу D10).
  expect(metrics.severityClass).toBe("raw");
  expect(metrics.regions).toHaveLength(1);
  expect(result.detail).toContain("exceeds the 2%");
  db.close();
});

test("per-case maxRawDiffPct манифеста перекрывает профильный порог", async () => {
  const lenient = await context({ casePolicy: { maxRawDiffPct: 90 } });
  lenient.ctx.case.referenceAssetId = await putAsset(lenient.db, lenient.dir, RECOLOURED);
  const passed = await visualGate.run(lenient.ctx);
  expect(passed.status).toBe("pass");
  expect(passed.metrics).toMatchObject({ maxRawDiffPct: 90 });
  lenient.db.close();

  const strict = await context({ casePolicy: { maxRawDiffPct: 0 } });
  strict.ctx.case.referenceAssetId = await putAsset(strict.db, strict.dir, framePng(40, 32, { x: 8, y: 6, width: 16, height: 13, color: INK }));
  const failed = await visualGate.run(strict.ctx);
  expect(failed.status).toBe("fail");
  expect(failed.metrics).toMatchObject({ maxRawDiffPct: 0 });
  strict.db.close();
});

test("несводимые размеры — indeterminate с причиной, а не fail без метрик", async () => {
  const { ctx, db, dir } = await context({ policyId: "pixel-strict-v1" });
  ctx.case.referenceAssetId = await putAsset(db, dir, OVERSIZED);

  const result = await visualGate.run(ctx);
  expect(result.status).toBe("indeterminate");
  expect(result.metrics).toMatchObject({ reason: "dimensions_irreconcilable" });
  expect(result.metrics).not.toHaveProperty("rawDiffPct");
  expect(result.detail).toContain("could not be reconciled");
  expect(result.artifacts?.map((item) => item.name)).toEqual(["visual.json"]);
  db.close();
});

test("cropLineage.rect приводит эталон-вырезку к кадру случая", async () => {
  const parent = new PNG({ width: 200, height: 160 });
  parent.data.fill(0);
  // Вставляем кандидатный кадр в макет по смещению (20, 10) — это и есть `cropLineage.rect`.
  const inner = PNG.sync.read(CANDIDATE);
  for (let y = 0; y < inner.height; y += 1) {
    const from = y * inner.width * 4;
    inner.data.copy(parent.data, ((10 + y) * 200 + 20) * 4, from, from + inner.width * 4);
  }
  const { ctx, db, dir } = await context({ cropLineage: { rect: [20, 10, 40, 32] } });
  ctx.case.referenceAssetId = await putAsset(db, dir, PNG.sync.write(parent));

  const result = await visualGate.run(ctx);
  expect(result.status).toBe("pass");
  expect(result.metrics).toMatchObject({ cropApplied: true, rawDiffPct: 0, sourceDims: { width: 200, height: 160 } });
  db.close();
});

test("без снятого paint-кадра и при отказе воркера вердикт не выдаётся", async () => {
  const noFrame = await context({ candidate: null });
  noFrame.ctx.case.referenceAssetId = await putAsset(noFrame.db, noFrame.dir, CANDIDATE);
  const missing = await visualGate.run(noFrame.ctx);
  expect(missing.status).toBe("indeterminate");
  expect(missing.metrics).toMatchObject({ reason: "no_candidate_frame" });
  noFrame.db.close();

  const broken = await context({ runDiff: () => Promise.resolve({ ok: false as const, error: "worker died" }) });
  broken.ctx.case.referenceAssetId = await putAsset(broken.db, broken.dir, CANDIDATE);
  const failedWorker = await visualGate.run(broken.ctx);
  expect(failedWorker.status).toBe("indeterminate");
  expect(failedWorker.metrics).toMatchObject({ reason: "diff_worker_error" });
  expect(failedWorker.detail).toContain("worker died");
  broken.db.close();
});

test("severity-класс: расхождение в пределах AA-бюджета — aa, структурное — raw", () => {
  expect(visualSeverityClass({ rawDiffPct: 3, aaDiffPct: 0.2 }, 2)).toBe("aa");
  expect(visualSeverityClass({ rawDiffPct: 3, aaDiffPct: 2.9 }, 2)).toBe("raw");
});
