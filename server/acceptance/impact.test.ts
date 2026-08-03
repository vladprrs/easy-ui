import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import pngjs from "pngjs";
import { migrate } from "../migrations";
import { ApiError } from "../http";
import { insertDesignSystemVersion } from "../designSystems";
import { assetRefsOf, sourceShapeHashOf, writeCandidate, type CandidateEntry } from "../components/candidates";
import type { CaptureProbe, JobOutcome, JobStatus, ScreenshotResult } from "../screenshot/service";
import type { InkBboxResult } from "./inkBbox";
import { computeImpact } from "./impact";
import { normalizeThemeResources, observedResourcesOfRun, themeTokenCssVar } from "./resources";
import type { AcceptanceCaptureService, CandidateSubject } from "./gates/types";
import { AcceptanceOrchestrator } from "./orchestrator";
import { readinessPolicyHashOf } from "./ids";
import { ACCEPTANCE_POLICIES, policyProfileHash } from "./policies";
import { AcceptanceRepo, type CandidateRow } from "./repo";

// W6 (план 2026-08-03 §3 D6, §5 W6): импакт-анализ и частичная пересъёмка.

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const profile = ACCEPTANCE_POLICIES["default-v1"];
const COMPONENT_ID = "acc-impact-probe";
const DS = "yandex-pay";

const ASSET_A = `asset_${"a".repeat(64)}`;
const ASSET_B = `asset_${"b".repeat(64)}`;
const ASSET_C = `asset_${"c".repeat(64)}`;

const { PNG } = pngjs;

/** Кадр случая — настоящий PNG; позиция прямоугольника выводится из props (как в runner.test.ts). */
function framePng(props: Record<string, unknown> | undefined): Uint8Array {
  const seed = [...JSON.stringify(props ?? {})].reduce((sum, char) => (sum + char.charCodeAt(0)) % 7, 0);
  const png = new PNG({ width: 24, height: 20 });
  png.data.fill(0);
  for (let y = 4; y < 14; y += 1) {
    for (let x = 4 + seed; x < 12 + seed; x += 1) {
      const offset = (y * 24 + x) * 4;
      png.data[offset] = 0x20; png.data[offset + 1] = 0x40; png.data[offset + 2] = 0xc0; png.data[offset + 3] = 0xff;
    }
  }
  return new Uint8Array(PNG.sync.write(png));
}

/**
 * Наблюдённые ресурсы кадра выводятся из props случая: `asset` уезжает в `images`, `token` — в
 * `tokens`. Это и есть шов, который делает импакт доказательным: случай «видел» ровно тот ассет,
 * который ему передали, а не тот, который упомянут в исходнике.
 */
const readinessFor = (props: Record<string, unknown> | undefined) => ({
  readinessMet: true as boolean | null,
  readinessReason: null as string | null,
  readinessPolicyHash: readinessPolicyHashOf(profile.readiness) as string | null,
  readinessEvidence: {
    fontFaces: [], images: { total: 1, decoded: 1, failed: 0 }, pendingRequests: [] as string[],
    framesWaited: 2, animationsDisabled: true,
    themeResources: {
      tokens: typeof props?.token === "string" ? [props.token] : [],
      icons: [],
      images: typeof props?.asset === "string" ? [props.asset] : [],
    },
  } as Record<string, unknown> | null,
  captureEnvFingerprint: "env-fingerprint" as string | null,
  captureEnv: null as Record<string, unknown> | null,
});

const PAINT_LAYOUT = { x: 64, y: 64, width: 140, height: 96 };

const cleanInk = (): Promise<InkBboxResult> => Promise.resolve({
  ok: true, source: "alpha", image: { width: 536, height: 448 }, deviceScaleFactor: 2,
  pixelBounds: { x: 128, y: 128, width: 280, height: 192 }, bounds: { ...PAINT_LAYOUT },
  clamped: { left: false, right: false, top: false, bottom: false },
});

class FakeCapture implements AcceptanceCaptureService {
  calls: { probe?: CaptureProbe; props?: Record<string, unknown> }[] = [];
  private statuses = new Map<string, JobStatus>();
  private outcomes = new Map<string, JobOutcome>();

  /** Props случаев, снятых начиная с `from`-го вызова — предмет проверки «сняли ровно затронутых». */
  capturedAssetsSince(from: number): string[] {
    return [...new Set(this.calls.slice(from).map((call) => String(call.props?.asset ?? "")))].sort();
  }

  enqueueComponentCandidate(
    _id: string,
    _candidate: { rev: number; sourceHash: string },
    opts: { props?: Record<string, unknown>; probe?: CaptureProbe; deliver?: "asset" | "bytes"; background?: boolean; viewport: unknown },
  ): Promise<{ jobId: string }> {
    const call = this.calls.length + 1;
    this.calls.push({ probe: opts.probe, props: opts.props });
    const jobId = `job_${call}`;
    const bytes = framePng(opts.props);
    const readiness = readinessFor(opts.props);
    const common = {
      bytes, imageProduced: true, captureClean: true, productErrors: [], infraNoise: [], runtimeWarnings: [],
      consoleErrors: [], pageErrors: [], rendererBuild: null, browserVersion: "test/1", ...readiness,
    };
    const result = opts.probe === "paint"
      ? {
        kind: "paint", surface: "component", componentId: COMPONENT_ID, draftRev: 1, bundleHash: "bundle",
        designSystemMetaVersion: null, resolvedSpaceScale: {}, viewport: { width: 390, height: 844 }, dpr: 2,
        paintMargin: 64, width: 536, height: 448, ...common,
        rects: [], truncated: false, total: 0,
        details: [{ key: "root", instance: 0, layoutBounds: { ...PAINT_LAYOUT }, effectSources: [], clipChain: [] }],
      }
      : { kind: "image-bytes", width: 10, height: 10, ...common };
    this.statuses.set(jobId, { status: "done", result: result as unknown as ScreenshotResult });
    this.outcomes.set(jobId, "ok");
    return Promise.resolve({ jobId });
  }

  get(jobId: string): JobStatus {
    const status = this.statuses.get(jobId);
    if (!status) throw new ApiError(404, "job_not_found", "Screenshot job not found");
    return status;
  }
  outcome(jobId: string): JobOutcome | undefined { return this.outcomes.get(jobId); }
  hasBackgroundCapacity(): boolean { return true; }
}

/** Четыре случая: два «смотрят» на ASSET_A, два — на ASSET_B. */
const CASES = [
  { key: "a1", props: { asset: ASSET_A, token: "--eui-color-bg" } },
  { key: "a2", props: { asset: ASSET_A, token: "--eui-color-fg" } },
  { key: "b1", props: { asset: ASSET_B, token: "--eui-color-fg" } },
  { key: "b2", props: { asset: ASSET_B, token: "--eui-color-accent" } },
];

const entryFor = (sourceHash: string, source: string): CandidateEntry => ({
  version: 1, sourceHash,
  sourceShapeHash: sourceShapeHashOf(source),
  assetRefs: [...assetRefsOf(source)].sort(),
  componentIds: [COMPONENT_ID], createdAt: new Date().toISOString(), ok: true,
  extracted: { ok: true, warnings: [], meta: { events: [], slots: [], description: "probe", propsJsonSchema: { type: "object" } } } as unknown as CandidateEntry["extracted"],
  parityWarnings: [], bundleHash: "bundle", hostAbiVersion: 4,
});

async function setup() {
  const dir = await mkdtemp(resolve(process.cwd(), ".acc-impact-test-"));
  dirs.push(dir);
  const db = new Database(":memory:");
  migrate(db);
  db.run("INSERT INTO components (id,name,head_rev,created_at,updated_at,design_system) VALUES (?,?,1,'now','now',?)", [COMPONENT_ID, "AccImpactProbe", DS]);
  const repo = new AcceptanceRepo(db);
  const service = new FakeCapture();
  const entries = new Map<string, CandidateEntry>();
  const subject = (row: CandidateRow): CandidateSubject => ({
    candidateId: row.candidate_id, componentId: row.component_id, designSystem: row.design_system, rev: row.rev,
    sourceHash: row.source_hash, bundleHash: row.bundle_hash, hostAbiVersion: row.host_abi_version,
    themeVersion: row.theme_version, entry: entries.get(row.source_hash)!,
  });
  const orchestrator = new AcceptanceOrchestrator({
    db, dataDir: dir, service, autoDrain: false, sleep: () => Promise.resolve(),
    inkBbox: cleanInk,
    resolveCandidate: (row) => Promise.resolve(subject(row)),
  });

  /** Кандидат + его запись в candidate-кэше (там и живут доказательства формы W6). */
  const candidateFor = async (options: { rev: number; source: string; themeVersion?: number | null; withShape?: boolean }): Promise<CandidateRow> => {
    const sourceHash = `src-${new Bun.CryptoHasher("sha256").update(options.source).digest("hex").slice(0, 16)}`;
    const entry = entryFor(sourceHash, options.source);
    if (options.withShape === false) { delete entry.sourceShapeHash; delete entry.assetRefs; }
    entries.set(sourceHash, entry);
    await writeCandidate(dir, entry);
    const { candidate } = repo.createCandidate({
      componentId: COMPONENT_ID, designSystem: DS, rev: options.rev, sourceHash, bundleHash: "bundle",
      hostAbiVersion: 4, themeVersion: options.themeVersion === undefined ? 1 : options.themeVersion,
      observedCatalogRevision: "cat", policyProfileHash: policyProfileHash(profile), createdBy: "user_a",
    });
    return candidate;
  };

  return { db, dir, repo, service, orchestrator, candidateFor };
}

type Harness = Awaited<ReturnType<typeof setup>>;

const runFor = async (harness: Harness, candidate: CandidateRow, baselineRunId?: string) => {
  const started = await harness.orchestrator.startRun({
    candidateId: candidate.candidate_id, createdBy: "user_a", cases: CASES,
    ...(baselineRunId === undefined ? {} : { baselineRunId }),
  });
  const run = await harness.orchestrator.executeRun(started.run.run_id);
  return { run, impact: started.impact };
};

const reuseReasons = (harness: Harness, runId: string): Record<string, string | null> =>
  Object.fromEntries(harness.repo.cases(runId).map((row) => [row.case_id, row.reuse_reason]));

const SOURCE_A = `export const src = "/api/assets/${ASSET_A}"; export const other = "/api/assets/${ASSET_B}";`;
/** Ровно та же форма, ASSET_A заменён на ASSET_C. */
const SOURCE_A_SWAPPED = `export const src = "/api/assets/${ASSET_C}"; export const other = "/api/assets/${ASSET_B}";`;
/** Изменён не-литерал: форма исходника другая. */
const SOURCE_RESHAPED = `export const src = "/api/assets/${ASSET_A}"; export const other = "/api/assets/${ASSET_B}"; export const pad = 4;`;

// -------------------------------------------------- нормализация ресурсов (W4 → W6)

test("наблюдённые ресурсы: отсутствие коллекций — это «неизвестно», а не «пусто»", () => {
  expect(normalizeThemeResources(null)).toBeNull();
  expect(normalizeThemeResources({ tokens: ["--eui-color-bg"] })).toBeNull();
  const full = normalizeThemeResources({ tokens: ["--eui-color-bg"], icons: ["asset_i"], images: ["asset_m"] })!;
  expect([...full.assets].sort()).toEqual(["asset_i", "asset_m"]);
  expect(themeTokenCssVar("color.bg-muted")).toBe("--eui-color-bg-muted");
});

// -------------------------------------------------------------- базисы импакта

test("asset-only: замена одного литерала затрагивает только случаи, которые его наблюдали", async () => {
  const harness = await setup();
  const baseCandidate = await harness.candidateFor({ rev: 1, source: SOURCE_A });
  const { run } = await runFor(harness, baseCandidate);
  expect(run.status).toBe("pass");

  const next = await harness.candidateFor({ rev: 2, source: SOURCE_A_SWAPPED });
  const impact = await computeImpact({ db: harness.db, dataDir: harness.dir, repo: harness.repo, candidate: next, baselineRun: run });
  expect(impact.basis).toBe("asset-only");
  expect(impact.changedAssets).toEqual([ASSET_A, ASSET_C].sort());
  expect(impact.affectedCases).toEqual(["a1", "a2"]);
  expect(impact.unaffectedCases).toEqual(["b1", "b2"]);
  expect(impact.recaptureCount).toBe(2);
  harness.db.close();
});

test("asset-only с пустым диффом: идентичный билд не затрагивает ничего", async () => {
  const harness = await setup();
  const baseCandidate = await harness.candidateFor({ rev: 1, source: SOURCE_A });
  const { run } = await runFor(harness, baseCandidate);
  const impact = await computeImpact({ db: harness.db, dataDir: harness.dir, repo: harness.repo, candidate: baseCandidate, baselineRun: run });
  expect(impact.basis).toBe("asset-only");
  expect(impact.affectedCases).toEqual([]);
  expect(impact.recaptureCount).toBe(0);
  harness.db.close();
});

test("theme-only: дифф токенов темы затрагивает только случаи, применившие изменённый токен", async () => {
  const harness = await setup();
  insertDesignSystemVersion(harness.db, DS, 1, { tokens: { "color.bg": "#fff", "color.fg": "#000" }, fonts: [], icons: [] }, "now");
  insertDesignSystemVersion(harness.db, DS, 2, { tokens: { "color.bg": "#eee", "color.fg": "#000" }, fonts: [], icons: [] }, "now");
  const baseCandidate = await harness.candidateFor({ rev: 1, source: SOURCE_A, themeVersion: 1 });
  const { run } = await runFor(harness, baseCandidate);

  // Тот же исходник, новая версия темы — второй кандидат отличается только `themeVersion`.
  const next = harness.repo.createCandidate({
    componentId: COMPONENT_ID, designSystem: DS, rev: 1, sourceHash: baseCandidate.source_hash, bundleHash: "bundle",
    hostAbiVersion: 4, themeVersion: 2, observedCatalogRevision: "cat", policyProfileHash: policyProfileHash(profile), createdBy: "user_a",
  }).candidate;
  const impact = await computeImpact({ db: harness.db, dataDir: harness.dir, repo: harness.repo, candidate: next, baselineRun: run });
  expect(impact.basis).toBe("theme-only");
  expect(impact.changedTokens).toEqual(["--eui-color-bg"]);
  // `--eui-color-bg` наблюдал только случай a1.
  expect(impact.affectedCases).toEqual(["a1"]);
  expect(impact.recaptureCount).toBe(1);
  harness.db.close();
});

test("theme-only: смена шрифта действует документ-широко — затронуты все случаи", async () => {
  const harness = await setup();
  const font = { family: "Ya Sans", src: `asset_${"f".repeat(64)}` };
  insertDesignSystemVersion(harness.db, DS, 1, { tokens: {}, fonts: [], icons: [] }, "now");
  insertDesignSystemVersion(harness.db, DS, 2, { tokens: {}, fonts: [font], icons: [] }, "now");
  const baseCandidate = await harness.candidateFor({ rev: 1, source: SOURCE_A, themeVersion: 1 });
  const { run } = await runFor(harness, baseCandidate);
  const next = harness.repo.createCandidate({
    componentId: COMPONENT_ID, designSystem: DS, rev: 1, sourceHash: baseCandidate.source_hash, bundleHash: "bundle",
    hostAbiVersion: 4, themeVersion: 2, observedCatalogRevision: "cat", policyProfileHash: policyProfileHash(profile), createdBy: "user_a",
  }).candidate;
  const impact = await computeImpact({ db: harness.db, dataDir: harness.dir, repo: harness.repo, candidate: next, baselineRun: run });
  expect(impact.basis).toBe("theme-only");
  expect(impact.affectedCases).toHaveLength(4);
  expect(impact.reason).toContain("font faces");
  harness.db.close();
});

test("conservative: правка не-литерала, смена обоих входов и запись без доказательств формы", async () => {
  const harness = await setup();
  const baseCandidate = await harness.candidateFor({ rev: 1, source: SOURCE_A });
  const { run } = await runFor(harness, baseCandidate);

  const reshaped = await harness.candidateFor({ rev: 2, source: SOURCE_RESHAPED });
  const shapeImpact = await computeImpact({ db: harness.db, dataDir: harness.dir, repo: harness.repo, candidate: reshaped, baselineRun: run });
  expect(shapeImpact.basis).toBe("conservative");
  expect(shapeImpact.affectedCases).toHaveLength(4);
  expect(shapeImpact.recaptureCount).toBe(4);
  expect(shapeImpact.reason).toContain("Source shape hash differs");

  // Изменились и исходник, и тема — узкого базиса нет по построению.
  const both = await harness.candidateFor({ rev: 3, source: SOURCE_A_SWAPPED, themeVersion: 2 });
  const bothImpact = await computeImpact({ db: harness.db, dataDir: harness.dir, repo: harness.repo, candidate: both, baselineRun: run });
  expect(bothImpact.basis).toBe("conservative");
  expect(bothImpact.reason).toContain("Both the component source and the design-system theme version changed");

  // Запись кандидат-кэша без W6-полей (собрана до волны) — доказательства нет.
  const legacy = await harness.candidateFor({ rev: 4, source: SOURCE_A_SWAPPED, withShape: false });
  const legacyImpact = await computeImpact({ db: harness.db, dataDir: harness.dir, repo: harness.repo, candidate: legacy, baselineRun: run });
  expect(legacyImpact.basis).toBe("conservative");
  expect(legacyImpact.reason).toContain("no source-shape evidence");
  harness.db.close();
});

test("случай без readiness-evidence затронут даже внутри узкого базиса", async () => {
  const harness = await setup();
  const baseCandidate = await harness.candidateFor({ rev: 1, source: SOURCE_A });
  const { run } = await runFor(harness, baseCandidate);

  // Стираем доказательство одного незатронутого случая — «неизвестно» обязано стать «затронут».
  harness.db.run("UPDATE acceptance_cases SET gates_json=NULL WHERE run_id=? AND case_id='b1'", [run.run_id]);
  const resources = await observedResourcesOfRun(harness.dir, harness.repo, run.run_id);
  expect(resources.get("b1")).toBeNull();

  const next = await harness.candidateFor({ rev: 2, source: SOURCE_A_SWAPPED });
  const impact = await computeImpact({ db: harness.db, dataDir: harness.dir, repo: harness.repo, candidate: next, baselineRun: run });
  expect(impact.basis).toBe("asset-only");
  expect(impact.affectedCases).toEqual(["a1", "a2", "b1"]);
  expect(impact.unaffectedCases).toEqual(["b2"]);
  harness.db.close();
});

test("нетерминальный или чужой baseline: conservative / 422", async () => {
  const harness = await setup();
  const baseCandidate = await harness.candidateFor({ rev: 1, source: SOURCE_A });
  const started = await harness.orchestrator.startRun({ candidateId: baseCandidate.candidate_id, createdBy: "user_a", cases: CASES });
  const queued = harness.repo.requireRun(started.run.run_id);
  const impact = await computeImpact({ db: harness.db, dataDir: harness.dir, repo: harness.repo, candidate: baseCandidate, baselineRun: queued });
  expect(impact.basis).toBe("conservative");
  expect(impact.reason).toContain("only a terminal run");

  harness.db.run("INSERT INTO components (id,name,head_rev,created_at,updated_at,design_system) VALUES ('other','Other',1,'now','now',?)", [DS]);
  const foreign = harness.repo.createCandidate({
    componentId: "other", designSystem: DS, rev: 1, sourceHash: "src-other", bundleHash: "bundle", hostAbiVersion: 4,
    themeVersion: 1, observedCatalogRevision: "cat", policyProfileHash: policyProfileHash(profile), createdBy: "user_a",
  }).candidate;
  await expect(computeImpact({ db: harness.db, dataDir: harness.dir, repo: harness.repo, candidate: foreign, baselineRun: queued }))
    .rejects.toThrow(expect.objectContaining({ code: "baseline_run_mismatch" }));
  harness.db.close();
});

// ------------------------------------------------------- частичная пересъёмка

test("«49→1»-класс: ран с baselineRunId снимает только затронутые случаи, остальные наследуют вердикт", async () => {
  const harness = await setup();
  const baseCandidate = await harness.candidateFor({ rev: 1, source: SOURCE_A });
  const first = await runFor(harness, baseCandidate);
  expect(first.run.status).toBe("pass");
  const before = harness.service.calls.length;

  const next = await harness.candidateFor({ rev: 2, source: SOURCE_A_SWAPPED });
  const second = await runFor(harness, next, first.run.run_id);
  expect(second.impact?.basis).toBe("asset-only");
  expect(second.run.status).toBe("pass");

  // Снимались ровно случаи, наблюдавшие изменившийся ассет.
  expect(harness.service.capturedAssetsSince(before)).toEqual([ASSET_A]);
  expect(reuseReasons(harness, second.run.run_id)).toEqual({
    a1: null, a2: null, b1: "impact:asset-only", b2: "impact:asset-only",
  });
  const cases = Object.fromEntries(harness.repo.cases(second.run.run_id).map((row) => [row.case_id, row]));
  expect(cases.b1!.verdict).toBe("pass");
  expect(JSON.parse(cases.b1!.gates_json!) as unknown[]).not.toHaveLength(0);
  expect(JSON.parse(second.run.progress_json).reused).toBe(2);
  expect(JSON.parse(second.run.impact_json!).basis).toBe("asset-only");

  // Перенесённый вердикт записан под НОВЫМ отпечатком: третий ран реюзает его обычным путём.
  const third = await runFor(harness, next);
  expect(harness.repo.cases(third.run.run_id).filter((row) => row.reuse_reason === "case_fingerprint")).toHaveLength(4);
  harness.db.close();
});

test("conservative-импакт не экономит ничего: все случаи сняты заново", async () => {
  const harness = await setup();
  const baseCandidate = await harness.candidateFor({ rev: 1, source: SOURCE_A });
  const first = await runFor(harness, baseCandidate);
  const before = harness.service.calls.length;

  const reshaped = await harness.candidateFor({ rev: 2, source: SOURCE_RESHAPED });
  const second = await runFor(harness, reshaped, first.run.run_id);
  expect(second.impact?.basis).toBe("conservative");
  expect(harness.service.capturedAssetsSince(before)).toEqual([ASSET_A, ASSET_B].sort());
  expect(Object.values(reuseReasons(harness, second.run.run_id)).every((reason) => reason === null)).toBe(true);
  expect(JSON.parse(second.run.progress_json).reused).toBe(0);
  harness.db.close();
});

test("вычищенные артефакты baseline отменяют перенос: случай снимается заново", async () => {
  const harness = await setup();
  const baseCandidate = await harness.candidateFor({ rev: 1, source: SOURCE_A });
  const first = await runFor(harness, baseCandidate);
  const before = harness.service.calls.length;
  // Гейты b1 остались, но их артефакты «вычищены» подменой адресов на несуществующие.
  harness.db.run(
    "UPDATE acceptance_cases SET gates_json=REPLACE(gates_json,'\"sha256\":\"','\"sha256\":\"dead') WHERE run_id=? AND case_id='b1'",
    [first.run.run_id],
  );

  const next = await harness.candidateFor({ rev: 2, source: SOURCE_A_SWAPPED });
  const second = await runFor(harness, next, first.run.run_id);
  expect(reuseReasons(harness, second.run.run_id).b1).toBeNull();
  expect(reuseReasons(harness, second.run.run_id).b2).toBe("impact:asset-only");
  expect(harness.service.capturedAssetsSince(before)).toEqual([ASSET_A, ASSET_B].sort());
  harness.db.close();
});

test("refresh перебивает импакт: явный форс дороже, но он — прямое указание автора", async () => {
  const harness = await setup();
  const baseCandidate = await harness.candidateFor({ rev: 1, source: SOURCE_A });
  const first = await runFor(harness, baseCandidate);

  const next = await harness.candidateFor({ rev: 2, source: SOURCE_A_SWAPPED });
  const started = await harness.orchestrator.startRun({
    candidateId: next.candidate_id, createdBy: "user_a", cases: CASES, baselineRunId: first.run.run_id, refresh: "all",
  });
  const run = await harness.orchestrator.executeRun(started.run.run_id);
  expect(Object.values(reuseReasons(harness, run.run_id))).toEqual(["refresh:all", "refresh:all", "refresh:all", "refresh:all"]);
  harness.db.close();
});
