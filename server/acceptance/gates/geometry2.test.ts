import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import pngjs from "pngjs";
import { migrate } from "../../migrations";
import { ApiError } from "../../http";
import type { CandidateEntry } from "../../components/candidates";
import type { CaptureProbe, JobOutcome, JobStatus, ScreenshotResult } from "../../screenshot/service";
import { spawnInkBboxWorker, type InkBboxResult } from "../inkBbox";
import { AcceptanceOrchestrator } from "../orchestrator";
import { ACCEPTANCE_POLICIES, policyProfileHash } from "../policies";
import { AcceptanceRepo, type CandidateRow } from "../repo";
import { readArtifact } from "../evidence";
import { geometry2Gate } from "./geometry2";
import type { AcceptanceCaptureService, CandidateSubject, GateContext } from "./types";

/**
 * Гейт `geometry` v2 (план 2026-08-03 §5 W3).
 *
 * Главный предмет — **инвариант**: `fail` возможен только с непустым `overflow.sources[]` либо с
 * названным `expectedGeometry`-расхождением (KPI §1: «geometry failures без названного
 * descendant/cause → 0»). Наблюдённый overflow без объяснения обязан деградировать в
 * `indeterminate`: он всё равно не даст случаю `pass` (D10), но не обвинит компонент ложно.
 */

const { PNG } = pngjs;
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const profile = ACCEPTANCE_POLICIES["default-v1"];
const COMPONENT_ID = "geo2-probe";
const LAYOUT = { x: 64, y: 64, width: 140, height: 96 };
const BLUR = { elementKey: "highlight", elementPath: "div>div.highlight", cause: "filter:blur(68px)", rect: { x: 46.5, y: 47, width: 175, height: 130 } };

function framePng(width: number, height: number, ink: { x: number; y: number; width: number; height: number }): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(0);
  for (let y = ink.y; y < ink.y + ink.height; y += 1) {
    for (let x = ink.x; x < ink.x + ink.width; x += 1) {
      const offset = (y * width + x) * 4;
      png.data[offset + 3] = 0xff;
    }
  }
  return PNG.sync.write(png);
}

interface PaintShape {
  layoutBounds?: { x: number; y: number; width: number; height: number } | null;
  /** W1b: бокс корня. По умолчанию совпадает с layout-контуром — типичный однокоренной компонент. */
  rootBounds?: { x: number; y: number; width: number; height: number } | null;
  /** W1b: клип, объявленный самим корнем (факт `clipExpectation`). */
  rootClip?: { property: string; value: string } | null;
  effectSources?: unknown[];
  clipChain?: unknown[];
  bytes?: Uint8Array;
}

const paintResult = (shape: PaintShape = {}): ScreenshotResult => ({
  kind: "paint", surface: "component", componentId: COMPONENT_ID, draftRev: 1, bundleHash: "bundle",
  designSystemMetaVersion: null, resolvedSpaceScale: {}, viewport: { width: 390, height: 844 }, dpr: 2,
  paintMargin: 64, bytes: shape.bytes ?? new Uint8Array([1, 2, 3]), width: 536, height: 448, imageProduced: true,
  captureClean: true, productErrors: [], infraNoise: [], runtimeWarnings: [],
  consoleErrors: [], pageErrors: [], rendererBuild: null, browserVersion: "test/1",
  rects: [], truncated: false, total: 0,
  details: [{
    key: "root", instance: 0,
    layoutBounds: shape.layoutBounds === undefined ? { ...LAYOUT } : shape.layoutBounds,
    rootBounds: shape.rootBounds === undefined ? { ...LAYOUT } : shape.rootBounds,
    rootClip: shape.rootClip ?? null,
    effectSources: shape.effectSources ?? [],
    clipChain: shape.clipChain ?? [],
  }],
} as unknown as ScreenshotResult);

class PaintCapture implements AcceptanceCaptureService {
  probes: (CaptureProbe | undefined)[] = [];
  constructor(private readonly result: ScreenshotResult) {}
  enqueueComponentCandidate(_id: string, _c: { rev: number; sourceHash: string }, opts: { probe?: CaptureProbe; viewport: unknown }): Promise<{ jobId: string }> {
    this.probes.push(opts.probe);
    return Promise.resolve({ jobId: "job_1" });
  }
  get(): JobStatus { return { status: "done", result: this.result }; }
  outcome(): JobOutcome { return "ok"; }
  hasBackgroundCapacity(): boolean { return true; }
}

/** Заглушка ink-bbox: контур чернил задаётся прямо, как если бы его посчитал воркер. */
const ink = (bounds: { x: number; y: number; width: number; height: number } | null, clamped?: Partial<{ left: boolean; right: boolean; top: boolean; bottom: boolean }>) =>
  (): Promise<InkBboxResult> => Promise.resolve({
    ok: true, source: "alpha", image: { width: 536, height: 448 }, deviceScaleFactor: 2,
    pixelBounds: bounds === null ? null : { x: bounds.x * 2, y: bounds.y * 2, width: bounds.width * 2, height: bounds.height * 2 },
    bounds,
    clamped: { left: false, right: false, top: false, bottom: false, ...clamped },
  });

async function context(options: { result?: ScreenshotResult; inkBbox?: GateContext["inkBbox"]; expectedGeometry?: { width: number; height: number }; expectedSurfaces?: Record<string, { width: number; height: number }>; clipExpectation?: "root-does-not-clip-layout"; casePolicy?: Record<string, unknown>; policyId?: keyof typeof ACCEPTANCE_POLICIES; db?: Database; referenceAssetId?: string; dsf?: number } = {}) {
  const dir = await mkdtemp(resolve(process.cwd(), ".geo2-test-"));
  dirs.push(dir);
  const service = new PaintCapture(options.result ?? paintResult());
  const ctx: GateContext = {
    db: options.db ?? (null as unknown as Database),
    dataDir: dir,
    service,
    policy: ACCEPTANCE_POLICIES[options.policyId ?? "default-v1"],
    runId: "acc_00000000-0000-4000-8000-000000000000",
    candidate: { componentId: COMPONENT_ID, rev: 1, sourceHash: "src" } as unknown as CandidateSubject,
    case: {
      caseId: "alpha", caseKey: "alpha", props: {}, propsHash: "ph", aliasOfCaseId: null,
      ...(options.expectedGeometry ? { expectedGeometry: options.expectedGeometry } : {}),
      ...(options.expectedSurfaces ? { expectedSurfaces: options.expectedSurfaces as never } : {}),
      ...(options.clipExpectation ? { clipExpectation: options.clipExpectation } : {}),
      ...(options.referenceAssetId ? { referenceAssetId: options.referenceAssetId } : {}),
      ...(options.casePolicy ? { casePolicy: options.casePolicy } : {}),
    },
    surface: { viewport: { width: 390, height: 844 }, dsf: options.dsf ?? 2, theme: "light" },
    determinismSampled: false,
    shared: new Map<string, unknown>(),
    sleep: () => Promise.resolve(),
    now: () => Date.now(),
    ...(options.inkBbox ? { inkBbox: options.inkBbox } : { inkBbox: ink({ ...LAYOUT }) }),
  };
  return { ctx, service, dir };
}

// ------------------------------------------------------------------- вердикты

test("clean geometry passes and the paint frame plus facts land in evidence", async () => {
  const { ctx, service, dir } = await context();
  const result = await geometry2Gate.run(ctx);
  expect(service.probes).toEqual(["paint"]);
  expect(result.status).toBe("pass");
  expect(result.metrics).toMatchObject({ semantics: "v2-paint", policyVerdict: "clean", deviceScaleFactor: 2, paintMargin: 64 });
  expect(result.artifacts?.map((item) => item.name).sort()).toEqual(["geometry.json", "paint.png"]);
  const facts = JSON.parse(new TextDecoder().decode((await readArtifact(dir, result.artifacts!.find((item) => item.name === "geometry.json")!.sha256))!)) as { layoutBounds: unknown; paintBoundsSource: string };
  expect(facts.layoutBounds).toEqual(LAYOUT);
  expect(facts.paintBoundsSource).toBe("alpha");
});

test("paint overflow with a named descendant fails and the detail carries the CSS cause", async () => {
  const { ctx } = await context({
    result: paintResult({ effectSources: [BLUR] }),
    inkBbox: ink({ x: 46.5, y: 47, width: 175, height: 130 }),
  });
  const result = await geometry2Gate.run(ctx);
  expect(result.status).toBe("fail");
  expect(result.metrics).toMatchObject({ policyVerdict: "paint-overflow-not-clipped" });
  const overflow = result.metrics!.overflow as { sources: { elementKey: string; cause: string }[] };
  expect(overflow.sources[0]).toMatchObject({ elementKey: "highlight", cause: "filter:blur(68px)" });
  expect(result.detail).toContain("filter:blur(68px)");
});

test("инвариант: overflow без названного источника даёт indeterminate, а не fail", async () => {
  const { ctx } = await context({ inkBbox: ink({ x: 46.5, y: 47, width: 175, height: 130 }) });
  const result = await geometry2Gate.run(ctx);
  expect(result.status).toBe("indeterminate");
  expect((result.metrics!.overflow as { sources: unknown[] }).sources).toHaveLength(0);
  expect(result.metrics!.policyVerdict).toBe("paint-overflow-not-clipped");
});

/**
 * R3: вердикт геометрии выходит наружу типизированным кодом словаря E3. `severity` берётся из
 * того же `geometryVerdictBlocks`, что и статус гейта: допущенная краска — предупреждение, а не
 * ошибка, `clean`/`indeterminate` кода не эмитят вовсе.
 */
test("policyVerdict маппится в surface_overflow с severity по допускам", async () => {
  const { ctx } = await context({
    result: paintResult({ effectSources: [BLUR] }),
    inkBbox: ink({ x: 46.5, y: 47, width: 175, height: 130 }),
  });
  const failed = await geometry2Gate.run(ctx);
  expect(failed.metrics!.codes).toEqual([
    { code: "surface_overflow", severity: "error", detail: expect.stringContaining("ink extends past the layout bounds"), ref: "paint-overflow-not-clipped" },
  ]);

  const clean = await context();
  expect((await geometry2Gate.run(clean.ctx)).metrics!.codes).toEqual([]);

  const allowed = await context({
    result: paintResult({ effectSources: [BLUR] }),
    inkBbox: ink({ x: 46.5, y: 47, width: 175, height: 130 }),
    casePolicy: { allowPaintOverflow: true },
  });
  const allowedResult = await geometry2Gate.run(allowed.ctx);
  expect(allowedResult.status).toBe("pass");
  expect((allowedResult.metrics!.codes as { severity: string }[])[0]!.severity).toBe("warning");
});

test("allowPaintOverflow и expectedClip переводят ожидаемую краску в pass, не пряча вердикт", async () => {
  const allowed = await context({
    result: paintResult({ effectSources: [BLUR] }),
    inkBbox: ink({ x: 46.5, y: 47, width: 175, height: 130 }),
    casePolicy: { allowPaintOverflow: true },
  });
  const result = await geometry2Gate.run(allowed.ctx);
  expect(result.status).toBe("pass");
  expect(result.metrics).toMatchObject({ policyVerdict: "paint-overflow-not-clipped", allowPaintOverflow: true });

  const clipped = await context({
    result: paintResult({ effectSources: [BLUR], clipChain: [{ key: "card", property: "overflow", value: "hidden hidden", effective: true }] }),
    inkBbox: ink({ x: 46.5, y: 47, width: 175, height: 130 }),
    casePolicy: { expectedClip: true },
  });
  const clippedResult = await geometry2Gate.run(clipped.ctx);
  expect(clippedResult.status).toBe("pass");
  expect(clippedResult.metrics!.policyVerdict).toBe("paint-overflow-clipped");
});

/**
 * План 2026-08-06 §W3 (строка 6 фидбэка): бюджет — декларация «столько краски за контуром по этой
 * стороне ожидаемо». Он снимает блокировку, но не переписывает факты: вердикт-класс и величины
 * overflow в метриках остаются теми же, что и без бюджета.
 */
test("overflowBudgetPx: краска в пределах бюджета — pass с сохранённым вердикт-классом", async () => {
  const within = await context({
    result: paintResult({ effectSources: [BLUR] }),
    inkBbox: ink({ x: 46.5, y: 47, width: 175, height: 130 }),
    casePolicy: { overflowBudgetPx: { left: 18, right: 18, top: 18, bottom: 18 } },
  });
  const result = await geometry2Gate.run(within.ctx);
  expect(result.status).toBe("pass");
  expect(result.metrics).toMatchObject({ policyVerdict: "paint-overflow-not-clipped", allowPaintOverflow: false });
  expect(result.metrics!.overflow).toMatchObject({ left: 17.5, right: 17.5, top: 17, bottom: 17 });
  expect(result.metrics!.overflowBudgetPx).toEqual({ left: 18, right: 18, top: 18, bottom: 18 });
  expect((result.metrics!.codes as { severity: string }[])[0]!.severity).toBe("warning");

  // За бюджетом по одной стороне — блокирует ровно как раньше, с названным виновником.
  const over = await context({
    result: paintResult({ effectSources: [BLUR] }),
    inkBbox: ink({ x: 46.5, y: 47, width: 175, height: 130 }),
    casePolicy: { overflowBudgetPx: { left: 18, right: 4, top: 18, bottom: 18 } },
  });
  const overResult = await geometry2Gate.run(over.ctx);
  expect(overResult.status).toBe("fail");
  expect((overResult.metrics!.codes as { severity: string }[])[0]!.severity).toBe("error");
});

test("per-case sizeDeltaPx побеждает профильный допуск габаритов", async () => {
  // Профиль default-v1 терпит 2 px; layout 140 против заявленных 132 — это 8 px расхождения.
  const strict = await context({ expectedGeometry: { width: 132, height: 96 } });
  expect((await geometry2Gate.run(strict.ctx)).status).toBe("fail");

  const tolerant = await context({
    expectedGeometry: { width: 132, height: 96 },
    casePolicy: { sizeDeltaPx: 8 },
  });
  const result = await geometry2Gate.run(tolerant.ctx);
  expect(result.status).toBe("pass");
  expect(result.metrics).toMatchObject({ policyVerdict: "clean", sizeTolerancePx: 8 });
  expect(result.metrics!.expectedGeometryDelta).toBeNull();
});

test("expectedGeometry mismatch is a named failure even without any effect source", async () => {
  const { ctx } = await context({
    result: paintResult({ layoutBounds: { ...LAYOUT, width: 175 } }),
    inkBbox: ink({ ...LAYOUT, width: 175 }),
    expectedGeometry: { width: 140, height: 96 },
  });
  const result = await geometry2Gate.run(ctx);
  expect(result.status).toBe("fail");
  expect(result.metrics).toMatchObject({ policyVerdict: "layout-overflow" });
  expect(result.metrics!.expectedGeometryDelta).toMatchObject({ widthDelta: 35 });
  expect(result.detail).toContain("expected 140×96");
});

test("clamped ink and a missing layout contour stay indeterminate with actionable diagnostics", async () => {
  const clamped = await context({ inkBbox: ink({ x: 0, y: 64, width: 268, height: 96 }, { left: true }) });
  const clampedResult = await geometry2Gate.run(clamped.ctx);
  expect(clampedResult.status).toBe("indeterminate");
  expect(clampedResult.detail).toContain("increase the paint margin");

  const noLayout = await context({ result: paintResult({ layoutBounds: null }) });
  const noLayoutResult = await geometry2Gate.run(noLayout.ctx);
  expect(noLayoutResult.status).toBe("indeterminate");
  expect(noLayoutResult.metrics!.policyVerdict).toBe("indeterminate");
});

// ------------------------------------------------------- интеграция: полный ран

test("acceptance run with geometry v2: real ink beyond the layout box fails the run with named sources", async () => {
  const dir = await mkdtemp(resolve(process.cwd(), ".geo2-run-test-"));
  dirs.push(dir);
  const db = new Database(":memory:");
  migrate(db);
  db.run("INSERT INTO components (id,name,head_rev,created_at,updated_at,design_system) VALUES (?,?,1,'now','now','yandex-pay')", [COMPONENT_ID, "Geo2Probe"]);
  const repo = new AcceptanceRepo(db);
  const { candidate } = repo.createCandidate({
    componentId: COMPONENT_ID, designSystem: "yandex-pay", rev: 1, sourceHash: "src", bundleHash: "bundle",
    hostAbiVersion: 4, themeVersion: 1, observedCatalogRevision: "cat", policyProfileHash: policyProfileHash(profile),
    createdBy: "user_a",
  });
  // Кадр честный: чернила (dsf=2) шире layout-контура 140×96 при поле 64px.
  const png = framePng(536, 448, { x: 93, y: 94, width: 350, height: 260 });
  const paint = paintResult({ effectSources: [BLUR], bytes: new Uint8Array(png) });
  const image: ScreenshotResult = {
    kind: "image-bytes", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), width: 10, height: 10, imageProduced: true,
    consoleErrors: [], pageErrors: [], captureClean: true, productErrors: [], infraNoise: [], runtimeWarnings: [],
    rendererBuild: null, browserVersion: "test/1",
  } as unknown as ScreenshotResult;

  const service: AcceptanceCaptureService = {
    enqueueComponentCandidate: (_id, _c, opts) => Promise.resolve({ jobId: opts.probe === "paint" ? "paint" : "image" }),
    get: (jobId) => {
      if (jobId === "paint") return { status: "done", result: paint };
      if (jobId === "image") return { status: "done", result: image };
      throw new ApiError(404, "job_not_found", "Screenshot job not found");
    },
    outcome: () => "ok",
    hasBackgroundCapacity: () => true,
  };
  const entry = {
    version: 1, sourceHash: "src", componentIds: [COMPONENT_ID], createdAt: new Date().toISOString(), ok: true,
    extracted: { ok: true, warnings: [], meta: { events: [], slots: [], description: "probe", examples: { alpha: { label: "a" } }, propsJsonSchema: { type: "object" } } },
    parityWarnings: [], bundleHash: "bundle", hostAbiVersion: 4,
  } as unknown as CandidateEntry;
  const orchestrator = new AcceptanceOrchestrator({
    db, dataDir: dir, service, autoDrain: false, sleep: () => Promise.resolve(),
    // Настоящий ink-воркер: PNG синтетический, но измеряется он тем же кодом, что в проде.
    inkBbox: spawnInkBboxWorker,
    resolveCandidate: (row: CandidateRow) => Promise.resolve({
      candidateId: row.candidate_id, componentId: row.component_id, designSystem: row.design_system, rev: row.rev,
      sourceHash: row.source_hash, bundleHash: row.bundle_hash, hostAbiVersion: row.host_abi_version,
      themeVersion: row.theme_version, entry,
    } as CandidateSubject),
  });

  const started = await orchestrator.startRun({ candidateId: candidate.candidate_id, createdBy: "user_a" });
  const run = await orchestrator.executeRun(started.run.run_id);
  expect(run.status).toBe("fail");
  const row = repo.cases(run.run_id)[0]!;
  expect(row.verdict).toBe("fail");
  const gates = JSON.parse(row.gates_json!) as { gate: string; status: string; detail?: string; metrics?: Record<string, unknown> }[];
  const geometry = gates.find((gate) => gate.gate === "geometry")!;
  expect(geometry.status).toBe("fail");
  expect(geometry.metrics!.policyVerdict).toBe("paint-overflow-not-clipped");
  expect((geometry.metrics!.overflow as { sources: { elementKey: string }[] }).sources[0]!.elementKey).toBe("highlight");
  const severity = JSON.parse(row.severity_json!) as { class: string };
  expect(severity.class).toBe("geometry");
  db.close();
});


// ------------------------------------------- поверхности геометрии (W1a, план 2026-08-07)

test("W1a: расхождение поверхности даёт fail с кодом surface_mismatch и ref-поверхностью", async () => {
  // Кадр меряет union 140×96, случай объявил 160×96: вердикт обязан **назвать** поверхность, а не
  // деградировать в `indeterminate` («провал без виновника») — имя поверхности и есть виновник.
  const { ctx, dir } = await context({ expectedSurfaces: { layoutUnion: { width: 160, height: 96 } } });
  const result = await geometry2Gate.run(ctx);
  expect(result.status).toBe("fail");
  expect(result.metrics!.policyVerdict).toBe("surface-mismatch");
  expect(result.metrics!.divergingSurfaces).toEqual(["layoutUnion"]);
  expect(result.metrics!.codes).toEqual([
    { code: "surface_mismatch", severity: "error", detail: expect.stringContaining("surface layoutUnion measured"), ref: "layoutUnion" },
  ]);
  // Проекция на легаси-поле сохраняется, и поверхности доезжают до `geometry.json`.
  expect(result.metrics!.expectedGeometryDelta).toMatchObject({ widthDelta: -20, heightDelta: 0 });
  const record = JSON.parse(new TextDecoder().decode((await readArtifact(dir,
    result.artifacts!.find((item) => item.name === "geometry.json")!.sha256))!)) as { surfaces: Record<string, { verdict: string }> };
  expect(record.surfaces.layoutUnion!.verdict).toBe("size-mismatch");
});

test("W1a: доволновой случай не получает ни одного нового ключа в метриках и артефакте", async () => {
  const { ctx, dir } = await context({ expectedGeometry: { width: 140, height: 96 } });
  const result = await geometry2Gate.run(ctx);
  expect(result.status).toBe("pass");
  expect(result.metrics!.surfaces).toBeUndefined();
  expect("divergingSurfaces" in result.metrics!).toBe(false);
  const record = JSON.parse(new TextDecoder().decode((await readArtifact(dir,
    result.artifacts!.find((item) => item.name === "geometry.json")!.sha256))!)) as Record<string, unknown>;
  expect("surfaces" in record).toBe(false);
});

test("W1a: kill-switch EASYUI_GEOMETRY_SURFACES_DISABLED возвращает легаси-вердикт", async () => {
  process.env.EASYUI_GEOMETRY_SURFACES_DISABLED = "1";
  try {
    const { ctx } = await context({ expectedSurfaces: { layoutUnion: { width: 160, height: 96 } } });
    const result = await geometry2Gate.run(ctx);
    // Поверхности до допусков не доехали ⇒ прежний код, прежний вердикт: ожидания просто нет.
    expect(result.status).toBe("pass");
    expect(result.metrics!.policyVerdict).toBe("clean");
    expect(result.metrics!.surfaces).toBeUndefined();
  } finally {
    delete process.env.EASYUI_GEOMETRY_SURFACES_DISABLED;
  }
});

// ------------------------------------- безусловные замеры W1b (план 2026-08-07 §1.1)

/** Ассет эталона с габаритами в **device px** (колонки nullable — отсюда третий исход замера). */
function assetWith(db: Database, dims: { width: number | null; height: number | null }): string {
  const id = `asset_${"a".repeat(56)}${Math.floor(Math.random() * 1e6).toString().padStart(8, "0")}`.slice(0, 70);
  db.run("INSERT INTO assets (id,sha256,mime,size,width,height,original_name,created_at) VALUES (?,?,?,?,?,?,?,'now')",
    [id, id.slice(6), "image/png", 1, dims.width, dims.height, "ref.png"]);
  return id;
}

test("W1b: rootBounds измерен безусловно и доезжает до вердикта, метрик и мемо фактов", async () => {
  // Замер аддитивен: он есть и там, где поверхностей никто не объявлял, — иначе первая декларация
  // ожидания стоила бы пересъёмки (AC §3.4).
  const plain = await context();
  const plainResult = await geometry2Gate.run(plain.ctx);
  expect(plainResult.metrics!.rootBounds).toEqual(LAYOUT);
  expect(plain.ctx.shared.get("geometry.facts:alpha")).toMatchObject({ rootBounds: LAYOUT });

  // Объявленный `root` судится по **своему** факту, а не по union'у.
  const mismatch = await context({
    result: paintResult({ rootBounds: { x: 64, y: 64, width: 343, height: 88 } }),
    expectedSurfaces: { root: { width: 320, height: 88 } },
  });
  const mismatchResult = await geometry2Gate.run(mismatch.ctx);
  expect(mismatchResult.status).toBe("fail");
  expect(mismatchResult.metrics!.divergingSurfaces).toEqual(["root"]);
  expect((mismatchResult.metrics!.surfaces as Record<string, { observed: unknown }>).root!.observed)
    .toEqual({ width: 343, height: 88 });
});

test("W1b: rootBounds не измерен (Fragment-корень) ⇒ поверхность root = not-measured, не догадка", async () => {
  const { ctx } = await context({
    result: paintResult({ rootBounds: null }),
    expectedSurfaces: { root: { width: 140, height: 96 } },
  });
  const result = await geometry2Gate.run(ctx);
  expect(result.metrics!.rootBounds).toBeNull();
  expect((result.metrics!.surfaces as Record<string, { verdict: string }>).root!.verdict).toBe("not-measured");
  // Union 140×96 совпал бы с ожиданием — подстановка чужого факта дала бы ложный `clean`.
  expect(result.metrics!.divergingSurfaces).toEqual([]);
  // Объявлено и не проверено ⇒ вердикта нет: `pass` тут был бы молчаливым «сойдёт».
  expect(result.status).toBe("indeterminate");
  expect(result.detail).toContain("surface root was not measured");
});

test("W1b: referenceExportDims нормализуются в CSS px делением на dsf", async () => {
  const db = new Database(":memory:");
  migrate(db);
  // Экспорт 2x: 734×176 device px ⇒ 367×88 CSS px — ровно та величина, которую объявляет манифест.
  const assetId = assetWith(db, { width: 734, height: 176 });
  const { ctx } = await context({ db, referenceAssetId: assetId, expectedSurfaces: { referenceExport: { width: 367, height: 88 } } });
  const result = await geometry2Gate.run(ctx);
  expect(result.metrics!.referenceExportDims).toEqual({ width: 367, height: 88 });
  expect((result.metrics!.surfaces as Record<string, { verdict: string }>).referenceExport!.verdict).toBe("clean");

  const drift = await context({ db, referenceAssetId: assetId, expectedSurfaces: { referenceExport: { width: 343, height: 88 } } });
  const driftResult = await geometry2Gate.run(drift.ctx);
  expect(driftResult.status).toBe("fail");
  expect(driftResult.metrics!.divergingSurfaces).toEqual(["referenceExport"]);
  expect(driftResult.metrics!.codes).toEqual([
    { code: "surface_mismatch", severity: "error", detail: expect.stringContaining("surface referenceExport measured"), ref: "referenceExport" },
  ]);
  db.close();
});

test("W1b: три исхода замера эталона — факт, not-measured, dimensions_irreconcilable", async () => {
  const db = new Database(":memory:");
  migrate(db);

  // 1. Ассета у случая нет вовсе — факта нет, отказа тоже нет.
  const none = await context({ db });
  const noneResult = await geometry2Gate.run(none.ctx);
  expect(noneResult.metrics!.referenceExportDims).toBeNull();
  expect(noneResult.metrics!.referenceExportDimsSource).toMatchObject({ reason: "no_reference" });
  expect(noneResult.metrics!.codes).toEqual([]);

  // 2. Колонки габаритов nullable: ассет есть, чисел нет ⇒ `not-measured`, а не отказ.
  const blind = await context({
    db, referenceAssetId: assetWith(db, { width: null, height: null }),
    expectedSurfaces: { referenceExport: { width: 367, height: 88 } },
  });
  const blindResult = await geometry2Gate.run(blind.ctx);
  expect(blindResult.metrics!.referenceExportDimsSource).toMatchObject({ reason: "asset_dims_missing" });
  expect((blindResult.metrics!.surfaces as Record<string, { verdict: string }>).referenceExport!.verdict).toBe("not-measured");
  expect(blindResult.metrics!.codes).toEqual([]);
  expect(blindResult.status).toBe("indeterminate");

  // 3. Габариты есть, но не сводятся с dsf=2 (нечётная ширина: экспорт снят в другом масштабе).
  const odd = assetWith(db, { width: 367, height: 88 });
  const declared = await context({ db, referenceAssetId: odd, expectedSurfaces: { referenceExport: { width: 367, height: 88 } } });
  const declaredResult = await geometry2Gate.run(declared.ctx);
  expect(declaredResult.metrics!.referenceExportDims).toBeNull();
  expect(declaredResult.metrics!.codes).toEqual([
    { code: "dimensions_irreconcilable", severity: "error", detail: expect.stringContaining("367×88 device px"), ref: odd },
  ]);
  // Вердикта по этой поверхности нет — и гейт это говорит, а не выдаёт `pass`.
  expect(declaredResult.status).toBe("indeterminate");

  // Та же несводимость без объявленной поверхности — диагностика: ничей вердикт от неё не зависит.
  const undeclared = await context({ db, referenceAssetId: odd });
  const undeclaredResult = await geometry2Gate.run(undeclared.ctx);
  expect((undeclaredResult.metrics!.codes as { severity: string }[])[0]!.severity).toBe("warning");
  // Никто ничего не объявлял — несводимость ничей вердикт не двигает.
  expect(undeclaredResult.status).toBe("pass");

  // dsf=1: те же 367×88 device px сводятся один к одному.
  const oneToOne = await context({ db, referenceAssetId: odd, dsf: 1, expectedSurfaces: { referenceExport: { width: 367, height: 88 } } });
  const oneToOneResult = await geometry2Gate.run(oneToOne.ctx);
  expect(oneToOneResult.metrics!.referenceExportDims).toEqual({ width: 367, height: 88 });
  expect(oneToOneResult.metrics!.codes).toEqual([]);
  db.close();
});

test("W1b: clipExpectation судится по клипу самого корня, а не по предкам поверхности", async () => {
  const honest = await context({
    result: paintResult({ rootBounds: { x: 64, y: 64, width: 343, height: 88 }, clipChain: [{ key: "card", property: "overflow", value: "hidden hidden", effective: true }] }),
    expectedSurfaces: { root: { width: 343, height: 88 } }, clipExpectation: "root-does-not-clip-layout",
  });
  const honestResult = await geometry2Gate.run(honest.ctx);
  expect(honestResult.metrics!.clipSatisfied).toBe(true);

  const violated = await context({
    result: paintResult({ rootBounds: { x: 64, y: 64, width: 343, height: 88 }, rootClip: { property: "overflow", value: "hidden hidden" } }),
    expectedSurfaces: { root: { width: 343, height: 88 } }, clipExpectation: "root-does-not-clip-layout",
  });
  const violatedResult = await geometry2Gate.run(violated.ctx);
  expect(violatedResult.status).toBe("fail");
  expect(violatedResult.metrics!.clipSatisfied).toBe(false);
  expect(violatedResult.detail).toContain("the root box declares overflow: hidden hidden");
});
