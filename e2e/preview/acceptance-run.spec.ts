import { expect, test, type APIRequestContext } from "@playwright/test";
import { unzipSync } from "fflate";
import pngjs from "pngjs";

/**
 * Матричная приёмка кандидата против реального Bun preview-сервера (план 2026-08-03 §5 W1a).
 *
 * Живёт в `e2e/preview/`, а не в `dev/`, осознанно: dev-проект не поднимает `SERVE_DIST`, и
 * `ScreenshotService.available()` вернул бы 501 — гейты `render`/`determinism` без капчура
 * не считаются. Preview-сервер стартует с `EASYUI_ACCEPTANCE_MATRIX=1` (см. `playwright.config.ts`).
 *
 * Проверяется полный путь: кандидат → ран → poll до терминала → per-case вердикты → evidence-zip,
 * и главное свойство фазы — **повторный ран того же кандидата переиспользует все случаи**
 * (`progress.reused === progress.total`), то есть стоит почти ноль.
 */

const DS_ID = "e2e-acceptance";
const COMPONENT_ID = "e2e-acceptance-probe";

const SOURCE = `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ label: z.string() }),
  description: "Acceptance probe: renders a single static label",
  atomicLevel: "atom" as const,
  examples: {
    alpha: { label: "Alpha" },
    beta: { label: "Beta" },
    gamma: { label: "Gamma" },
  },
};

export default function AcceptanceProbe({ props }: EasyUIComponentProps<{ label: string }>) {
  return <div style={{ padding: 8, background: "#fff", color: "#000" }}>{props.label}</div>;
}
`;

interface RunView {
  runId: string;
  status: string;
  progress: {
    total: number; completed: number; reused: number; failed: number;
    /** Каскад reuse волны W1: кадр не снимался / вердикт пересчитан / кадр пересравнён. */
    frameReused?: number; verdictRecomputed?: number; rediffed?: number;
  };
  /** Алгебра refresh (план 2026-08-04, D-B/C1): что попросили, что потребовал импакт, что применилось. */
  refresh: {
    requested: RefreshPlan; impact: RefreshPlan; effective: RefreshPlan;
  } | null;
  failedCases: { caseId: string; failedGates: { gate: string; detail?: string }[] }[];
}

interface RefreshPlan {
  frame: { all: boolean; failed: boolean; caseIds: string[] };
  verdict: { all: boolean; failed: boolean; caseIds: string[] };
}

interface GateView { gate: string; status: string; detail?: string; metrics?: Record<string, unknown> }

interface CaseView {
  caseId: string;
  verdict: string;
  reuseReason: string | null;
  gates: GateView[];
  artifacts: { name: string; sha256: string }[];
}

async function ensureFixture(request: APIRequestContext): Promise<void> {
  const system = await request.post("/api/design-systems", {
    data: { id: DS_ID, name: "E2E Acceptance", description: "Design system for the acceptance-run e2e" },
  });
  expect([201, 409], await system.text()).toContain(system.status());
  const existing = await request.get(`/api/components/${COMPONENT_ID}`);
  if (existing.status() === 200) return;
  const created = await request.post("/api/components", {
    data: {
      id: COMPONENT_ID, name: "AcceptanceProbe", source: SOURCE, designSystem: DS_ID,
      intent: "Показывает статичную подпись для приёмочного прогона матрицы состояний",
    },
  });
  expect(created.status(), await created.text()).toBe(201);
}

async function pollRun(request: APIRequestContext, runId: string): Promise<RunView> {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const response = await request.get(`/api/acceptance-runs/${runId}`);
    expect(response.status()).toBe(200);
    const run = await response.json() as RunView;
    if (!["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("acceptance run did not terminalize within 180s");
}

/**
 * Постановка кандидата троттлится тем же лимитом, что и validate (`429 validate_in_flight` /
 * `429 queue_full`, см. `docs/server-api.md`): параллельные acceptance-спеки конкурируют за те же
 * два глобальных слота. Ограниченный ретрай — часть контракта ручки, а не маскировка флейка.
 */
async function createCandidate(request: APIRequestContext, componentId: string): Promise<{ candidateId: string; status: string; rev: number }> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await request.post(`/api/components/${componentId}/candidates`, { data: {} });
    if (response.status() === 200) return await response.json() as { candidateId: string; status: string; rev: number };
    expect([429], `${response.status()}: ${await response.text()}`).toContain(response.status());
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("candidate creation stayed throttled for 60s");
}

test("candidate → run → cases → evidence, and a repeat run reuses every case", async ({ request }) => {
  test.setTimeout(600_000);
  await ensureFixture(request);

  const candidate = await createCandidate(request, COMPONENT_ID);
  expect(candidate.candidateId).toMatch(/^cand_[0-9a-f]{64}$/);
  expect(candidate.status).toBe("validated");

  const started = await request.post("/api/acceptance-runs", { data: { candidateId: candidate.candidateId } });
  expect(started.status(), await started.text()).toBe(202);
  const queued = await started.json() as { runId: string; status: string; cases: number };
  expect(queued.status).toBe("queued");
  expect(queued.cases).toBe(3);

  const run = await pollRun(request, queued.runId);
  expect(run.status, JSON.stringify(run.failedCases)).toBe("pass");
  expect(run.progress.total).toBe(3);
  expect(run.progress.completed).toBe(3);
  expect(run.progress.failed).toBe(0);

  const casesResponse = await request.get(`/api/acceptance-runs/${queued.runId}/cases`);
  expect(casesResponse.status()).toBe(200);
  const { cases } = await casesResponse.json() as { cases: { caseId: string; verdict: string; artifacts: { name: string }[] }[] };
  expect(cases.map((item) => item.caseId).sort()).toEqual(["alpha", "beta", "gamma"]);
  for (const item of cases) {
    expect(item.verdict).toBe("pass");
    expect(item.artifacts.map((artifact) => artifact.name)).toContain("render.png");
  }

  const evidence = await request.get(`/api/acceptance-runs/${queued.runId}/evidence`);
  expect(evidence.status()).toBe(200);
  expect(evidence.headers()["content-type"]).toBe("application/zip");
  expect((await evidence.body()).byteLength).toBeGreaterThan(0);

  // A3/D1: тот же кандидат, та же поверхность — все случаи приезжают из кэша результатов.
  const repeatResponse = await request.post("/api/acceptance-runs", { data: { candidateId: candidate.candidateId } });
  expect(repeatResponse.status(), await repeatResponse.text()).toBe(202);
  const repeat = await repeatResponse.json() as { runId: string };
  const repeated = await pollRun(request, repeat.runId);
  expect(repeated.status).toBe("pass");
  expect(repeated.progress.reused).toBe(repeated.progress.total);
});

// ---------------------------------------------------------------------------------------------
// Каскад reuse, эталоны и promote на реальном контуре (план 2026-08-04 §W9.1)
// ---------------------------------------------------------------------------------------------

/**
 * Три сценария волны W9, которых не может unit-тест: кадр здесь снимает **настоящий** chromium, а
 * эталоном служит его же байт-в-байт вывод, поэтому «0% расхождения» — измеренный факт, а не
 * договорённость фикстуры.
 *
 * - **threshold-only recompute** (репро P0-3/P0-4): падение по порогу → новый набор, отличающийся
 *   ровно одним числом, + `--refresh failed --baseline-run` ⇒ `verdictRecomputed > 0`, ни одной
 *   пересъёмки, `pass`.
 * - **reference-change re-diff** (анти-репро C0): смена только `referenceAssetId` ⇒ `rediffed > 0`
 *   и вердикт, измеренный по новому эталону, — никогда пересчёт старых метрик.
 * - **content-hug + promote** (W5 + P0-1/P0-2): эталон, обрезанный по содержимому, сервер сам
 *   паддит до канонической paint-канвы (visual pass), после чего `pixel-strict-v1`-ран
 *   промоутится с линковкой `candidateId`/`acceptanceRunId` в строке версии.
 *
 * Все три живут на одном кандидате и одном наборе кадров: фикстура снимает paint-канвы **один
 * раз** (ран без эталонов), а дальше строит из них эталоны — точный, «уехавший» и content-hug.
 */

const REUSE_DS = "e2e-acceptance-reuse";
const REUSE_COMPONENT = "e2e-acceptance-reuse-probe";

/**
 * Фикстура каскада: прямоугольник без текста, шрифтов и эффектов. Ни одного источника недетерминизма
 * — иначе «эталон = собственный кадр» перестало бы давать честный ноль, а `pixel-strict-v1` с его
 * нулевыми геометрическими допусками ловил бы тень вместо дефекта.
 */
const REUSE_SOURCE = `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ width: z.number(), tone: z.string() }),
  description: "Reuse probe: a plain opaque rectangle whose width and colour come from props",
  atomicLevel: "atom" as const,
  examples: { base: { width: 120, tone: "#2f6fed" } },
};

export default function ReuseProbe({ props }: EasyUIComponentProps<{ width: number; tone: string }>) {
  return <div style={{ width: props.width, height: 48, background: props.tone }} />;
}
`;

const { PNG } = pngjs;

/** Случаи фикстуры: по одному на сценарий, props различаются (общего кадра у них быть не должно). */
const REUSE_CASES = {
  recompute: { width: 120, tone: "#2f6fed" },
  rediff: { width: 132, tone: "#1f9d55" },
  hug: { width: 96, tone: "#b4341f" },
} as const;

type ReuseCaseId = keyof typeof REUSE_CASES;

interface ReuseCaseSpec {
  id: string;
  props: Record<string, unknown>;
  referenceAssetId?: string;
  referenceSurface?: "content-hug" | "paint";
  expectedGeometry?: { width: number; height: number };
  maxRawDiffPct?: number;
}

/** Манифест набора. `requireVisual` обязателен там, где порог обязан влиять на вердикт рана. */
function reuseManifest(cases: ReuseCaseSpec[], requireVisual: boolean): Record<string, unknown> {
  const perCase = Object.fromEntries(cases
    .filter((item) => item.maxRawDiffPct !== undefined)
    .map((item) => [item.id, { maxRawDiffPct: item.maxRawDiffPct }]));
  return {
    manifestVersion: 1,
    componentId: REUSE_COMPONENT,
    capture: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, theme: "light" },
    ...(requireVisual ? { requireVisual: true } : {}),
    ...(Object.keys(perCase).length > 0 ? { policy: { perCase } } : {}),
    cases: cases.map((item) => ({
      id: item.id,
      props: item.props,
      ...(item.referenceAssetId === undefined ? {} : { referenceAssetId: item.referenceAssetId }),
      ...(item.referenceSurface === undefined ? {} : { referenceSurface: item.referenceSurface }),
      ...(item.expectedGeometry === undefined ? {} : { expectedGeometry: item.expectedGeometry }),
    })),
  };
}

async function putCaseSet(request: APIRequestContext, cases: ReuseCaseSpec[], requireVisual: boolean): Promise<string> {
  const response = await request.put(`/api/components/${REUSE_COMPONENT}/case-sets`, {
    data: { manifest: reuseManifest(cases, requireVisual) },
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json() as { caseSetId: string }).caseSetId;
}

interface StartOptions {
  refresh?: "none" | "failed" | "all" | { caseIds: string[] };
  baselineRunId?: string;
  policy?: string;
}

async function startAndPoll(request: APIRequestContext, candidateId: string, caseSetId: string, options: StartOptions = {}): Promise<RunView> {
  const started = await request.post("/api/acceptance-runs", {
    data: {
      candidateId, caseSetId,
      ...(options.refresh === undefined ? {} : { refresh: options.refresh }),
      ...(options.baselineRunId === undefined ? {} : { baselineRunId: options.baselineRunId }),
      ...(options.policy === undefined ? {} : { policy: options.policy }),
    },
  });
  expect(started.status(), await started.text()).toBe(202);
  const { runId } = await started.json() as { runId: string };
  const run = await pollRun(request, runId);
  return { ...run, runId };
}

async function runCases(request: APIRequestContext, runId: string): Promise<Map<string, CaseView>> {
  const response = await request.get(`/api/acceptance-runs/${runId}/cases`);
  expect(response.status()).toBe(200);
  const { cases } = await response.json() as { cases: CaseView[] };
  return new Map(cases.map((item) => [item.caseId, item]));
}

const visualOf = (view: CaseView): GateView => {
  const gate = view.gates.find((item) => item.gate === "visual");
  if (!gate) throw new Error(`case ${view.caseId} has no visual gate: ${JSON.stringify(view.gates.map((item) => item.gate))}`);
  return gate;
};

async function uploadPng(request: APIRequestContext, name: string, bytes: Buffer): Promise<string> {
  const upload = await request.post("/api/assets", {
    multipart: { file: { name, mimeType: "image/png", buffer: bytes } },
  });
  expect([200, 201], await upload.text()).toContain(upload.status());
  return (await upload.json() as { id: string }).id;
}

/** Содержимое канвы: paint-кадр без поля `margin` — ровно то, что отдаёт экспорт узла Figma. */
function cropContent(paint: Buffer, offset: number): Buffer {
  const source = PNG.sync.read(paint);
  const width = source.width - 2 * offset;
  const height = source.height - 2 * offset;
  expect(width, "content crop must stay inside the paint canvas").toBeGreaterThan(0);
  const out = new PNG({ width, height });
  PNG.bitblt(source, out, offset, offset, width, height, 0, 0);
  return PNG.sync.write(out);
}

/** «Уехавший» эталон: содержимое перекрашено целиком — расхождение заведомо больше единиц процента. */
function repaintContent(paint: Buffer, offset: number): Buffer {
  const png = PNG.sync.read(paint);
  for (let y = offset; y < png.height - offset; y += 1) {
    for (let x = offset; x < png.width - offset; x += 1) {
      const at = (y * png.width + x) * 4;
      png.data[at] = 0xff; png.data[at + 1] = 0x00; png.data[at + 2] = 0x00; png.data[at + 3] = 0xff;
    }
  }
  return PNG.sync.write(png);
}

interface ReuseFixture {
  candidateId: string;
  rev: number;
  sourceHash: string;
  /** Точный эталон случая — его же собственный paint-кадр. */
  exact: Record<ReuseCaseId, string>;
  /** Эталон с перекрашенным содержимым. */
  drift: Record<ReuseCaseId, string>;
  /** Эталон, обрезанный по содержимому (`referenceSurface: "content-hug"`). */
  hugContent: string;
  /** Смещение содержимого внутри канвы, device px (`paintMargin × dsf`). */
  contentOffset: number;
  /** Измеренный layout-корень случая `hug` — он же `expectedGeometry` content-hug-набора. */
  hugLayoutRoot: { width: number; height: number };
}

let reuseFixturePromise: Promise<ReuseFixture> | null = null;

/**
 * Одна съёмка на все три сценария: ран **без эталонов** даёт paint-канвы (их кладёт гейт
 * `geometry`), из которых и строятся эталоны. Порядок обязателен именно такой — эталон, придуманный
 * до кадра, проверял бы совпадение фикстуры с самой собой, а не работу нормализации.
 */
function reuseFixture(request: APIRequestContext): Promise<ReuseFixture> {
  reuseFixturePromise ??= (async (): Promise<ReuseFixture> => {
    const system = await request.post("/api/design-systems", {
      data: { id: REUSE_DS, name: "E2E Acceptance Reuse", description: "Design system for the acceptance reuse e2e" },
    });
    expect([201, 409], await system.text()).toContain(system.status());
    const existing = await request.get(`/api/components/${REUSE_COMPONENT}`);
    if (existing.status() !== 200) {
      const created = await request.post("/api/components", {
        data: {
          id: REUSE_COMPONENT, name: "ReuseProbe", source: REUSE_SOURCE, designSystem: REUSE_DS,
          intent: "Рисует сплошной прямоугольник заданной ширины — фикстура каскада reuse и эталонов",
        },
      });
      expect(created.status(), await created.text()).toBe(201);
    }

    const candidate = await createCandidate(request, REUSE_COMPONENT);
    const candidateView = await request.get(`/api/component-candidates/${candidate.candidateId}`);
    expect(candidateView.status()).toBe(200);
    const { sourceHash } = await candidateView.json() as { sourceHash: string };

    const bootstrapSet = await putCaseSet(
      request,
      (Object.keys(REUSE_CASES) as ReuseCaseId[]).map((id) => ({ id, props: REUSE_CASES[id] })),
      false,
    );
    const bootstrap = await startAndPoll(request, candidate.candidateId, bootstrapSet);
    expect(bootstrap.status, JSON.stringify(bootstrap.failedCases)).toBe("pass");

    // Байты артефактов уезжают только evidence-архивом (`caseView` отдаёт имена и адреса).
    const evidence = await request.get(`/api/acceptance-runs/${bootstrap.runId}/evidence`);
    expect(evidence.status(), await evidence.text()).toBe(200);
    const archive = unzipSync(new Uint8Array(await evidence.body()));

    const cases = await runCases(request, bootstrap.runId);
    const geometry = cases.get("hug")!.gates.find((gate) => gate.gate === "geometry")!;
    const metrics = geometry.metrics as {
      paintMargin: number; deviceScaleFactor: number; layoutBounds: { width: number; height: number };
    };
    const contentOffset = Math.round(metrics.paintMargin * metrics.deviceScaleFactor);
    expect(contentOffset).toBeGreaterThan(0);
    const hugLayoutRoot = { width: metrics.layoutBounds.width, height: metrics.layoutBounds.height };
    expect(hugLayoutRoot).toEqual({ width: REUSE_CASES.hug.width, height: 48 });

    const exact = {} as Record<ReuseCaseId, string>;
    const drift = {} as Record<ReuseCaseId, string>;
    let hugContent = "";
    for (const id of Object.keys(REUSE_CASES) as ReuseCaseId[]) {
      const entry = archive[`${id}/paint.png`];
      expect(entry, `evidence archive has no ${id}/paint.png`).toBeTruthy();
      const paint = Buffer.from(entry!);
      exact[id] = await uploadPng(request, `${id}-exact.png`, paint);
      drift[id] = await uploadPng(request, `${id}-drift.png`, repaintContent(paint, contentOffset));
      if (id === "hug") hugContent = await uploadPng(request, "hug-content.png", cropContent(paint, contentOffset));
    }
    expect(new Set([...Object.values(exact), ...Object.values(drift), hugContent]).size).toBe(7);

    return { candidateId: candidate.candidateId, rev: candidate.rev, sourceHash, exact, drift, hugContent, contentOffset, hugLayoutRoot };
  })();
  return reuseFixturePromise;
}

test("смена только порога + --refresh failed --baseline-run: вердикт пересчитан, ни одной пересъёмки", async ({ request }) => {
  test.setTimeout(900_000);
  const fixture = await reuseFixture(request);
  const props = REUSE_CASES.recompute;

  // Baseline: эталон разошёлся с кадром заведомо сильнее порога в 1% — визуальный провал по числу.
  const strictSet = await putCaseSet(request, [
    { id: "recompute", props, referenceAssetId: fixture.drift.recompute, maxRawDiffPct: 1 },
  ], true);
  const baseline = await startAndPoll(request, fixture.candidateId, strictSet);
  expect(baseline.status).toBe("fail");
  const baselineCase = (await runCases(request, baseline.runId)).get("recompute")!;
  expect(visualOf(baselineCase).status).toBe("fail");
  const rawDiffPct = (visualOf(baselineCase).metrics as { rawDiffPct: number }).rawDiffPct;
  expect(rawDiffPct).toBeGreaterThan(1);
  expect(rawDiffPct).toBeLessThan(80);

  // Второй набор отличается ровно одним числом — порогом упавшего случая.
  const relaxedSet = await putCaseSet(request, [
    { id: "recompute", props, referenceAssetId: fixture.drift.recompute, maxRawDiffPct: 80 },
  ], true);
  expect(relaxedSet).not.toBe(strictSet);
  const second = await startAndPoll(request, fixture.candidateId, relaxedSet, {
    refresh: "failed", baselineRunId: baseline.runId,
  });

  expect(second.status, JSON.stringify(second.failedCases)).toBe("pass");
  // Главный AC фидбэка: кадр переиспользован целиком, вердикт пересчитан по сохранённым метрикам.
  expect(second.progress.frameReused).toBe(second.progress.total);
  expect(second.progress.verdictRecomputed).toBeGreaterThan(0);
  expect(second.progress.rediffed).toBe(0);
  // Тройка refresh: попросили verdict-скоуп, им же и обошлись.
  expect(second.refresh?.requested.verdict.failed).toBe(true);
  expect(second.refresh?.effective.verdict.failed).toBe(true);
  expect(second.refresh?.effective.frame).toEqual({ all: false, failed: false, caseIds: [] });

  const recomputed = (await runCases(request, second.runId)).get("recompute")!;
  expect(recomputed.reuseReason).toBe("recompute:policy");
  const visual = visualOf(recomputed);
  expect(visual.status).toBe("pass");
  // Метрики те же самые — новым стал только порог, по которому их прочли.
  expect(visual.metrics).toMatchObject({ maxRawDiffPct: 80, rawDiffPct });
});

test("смена только эталона: кадр пересравнён (re-diff), а не пересчитан по старым метрикам", async ({ request }) => {
  test.setTimeout(900_000);
  const fixture = await reuseFixture(request);
  const props = REUSE_CASES.rediff;

  // Baseline: эталон — собственный кадр случая, расхождение обязано быть нулевым.
  const exactSet = await putCaseSet(request, [
    { id: "rediff", props, referenceAssetId: fixture.exact.rediff, maxRawDiffPct: 5 },
  ], true);
  const baseline = await startAndPoll(request, fixture.candidateId, exactSet);
  expect(baseline.status, JSON.stringify(baseline.failedCases)).toBe("pass");
  expect((visualOf((await runCases(request, baseline.runId)).get("rediff")!).metrics as { rawDiffPct: number }).rawDiffPct).toBe(0);

  // Меняется **только** эталон: порог, props и кандидат прежние.
  const swappedSet = await putCaseSet(request, [
    { id: "rediff", props, referenceAssetId: fixture.drift.rediff, maxRawDiffPct: 5 },
  ], true);
  const second = await startAndPoll(request, fixture.candidateId, swappedSet);

  expect(second.progress.frameReused).toBe(second.progress.total);
  expect(second.progress.rediffed).toBeGreaterThan(0);
  expect(second.progress.verdictRecomputed).toBe(0);
  expect(second.progress.reused).toBe(0);

  const rediffed = (await runCases(request, second.runId)).get("rediff")!;
  expect(rediffed.reuseReason).toBe("rediff:comparison");
  const visual = visualOf(rediffed);
  // Вердикт вынесен по новому эталону — и это **измерение**, а не чтение старого числа новым порогом.
  expect(visual.status).toBe("fail");
  expect(visual.metrics).toMatchObject({ referenceAssetId: fixture.drift.rediff, maxRawDiffPct: 5 });
  expect((visual.metrics as { rawDiffPct: number }).rawDiffPct).toBeGreaterThan(5);
  expect(second.status).toBe("fail");
});

test("content-hug эталон: сервер паддит его до paint-канвы, strict-ран проходит и промоутится с линковкой", async ({ request }) => {
  test.setTimeout(900_000);
  const fixture = await reuseFixture(request);
  const props = REUSE_CASES.hug;

  // `expectedGeometry` объявлен намеренно, а не для красоты: канва content-hug строится от
  // layout-корня, и кадр, приехавший из кэша, свежих `layoutBounds` в ран не приносит
  // (`reference_canvas_unresolved`). Для content-hug-набора корень — часть манифеста, и ровно это
  // говорит диагностика гейта.
  const hugSet = await putCaseSet(request, [
    {
      id: "hug", props, referenceAssetId: fixture.hugContent,
      referenceSurface: "content-hug", expectedGeometry: fixture.hugLayoutRoot,
    },
  ], true);

  // Шаг 1: паддинг эталона считает сервер (§W5) — pass без единого ручного пикселя.
  const hugRun = await startAndPoll(request, fixture.candidateId, hugSet);
  expect(hugRun.status, JSON.stringify(hugRun.failedCases)).toBe("pass");
  const hugCase = (await runCases(request, hugRun.runId)).get("hug")!;
  const hugVisual = visualOf(hugCase);
  expect(hugVisual.status).toBe("pass");
  expect((hugVisual.metrics as { rawDiffPct: number }).rawDiffPct).toBe(0);
  const normalization = (hugVisual.metrics as { referenceNormalization: Record<string, unknown> }).referenceNormalization;
  expect(normalization).toMatchObject({
    referenceSurface: "content-hug",
    cropApplied: false,
    placement: { x: fixture.contentOffset, y: fixture.contentOffset },
    layoutRootSource: "expectedGeometry",
  });
  // Канва нормализации — та же, в которой снят кадр: иначе сравнивались бы разные холсты.
  expect(normalization.padTo).toEqual((hugVisual.metrics as { candDims: unknown }).candDims);

  // Шаг 2: тот же набор под `pixel-strict-v1` — профиль, который до волны W3 не мог быть промоутнут.
  const strictRun = await startAndPoll(request, fixture.candidateId, hugSet, { policy: "pixel-strict-v1" });
  expect(strictRun.status, JSON.stringify(strictRun.failedCases)).toBe("pass");
  const strictCase = (await runCases(request, strictRun.runId)).get("hug")!;
  expect(visualOf(strictCase).status).toBe("pass");

  // Кандидат заранее знает, что этот ран годен к публикации (candidate-view, W3).
  const candidateView = await request.get(`/api/component-candidates/${fixture.candidateId}`);
  expect(candidateView.status()).toBe(200);
  const runs = (await candidateView.json() as { runs: { runId: string; policyProfileId: string; promotionEligible: boolean }[] }).runs;
  expect(runs.find((item) => item.runId === strictRun.runId))
    .toMatchObject({ policyProfileId: "pixel-strict-v1", promotionEligible: true });

  // Шаг 3: promote с явной линковкой — строка версии обязана нести оба id (репро P0-1/P0-2).
  const promote = await request.post(`/api/components/${REUSE_COMPONENT}/promote`, {
    data: {
      baseRev: fixture.rev, sourceHash: fixture.sourceHash,
      candidateId: fixture.candidateId, acceptanceRunId: strictRun.runId,
      message: "W9 e2e: strict-ран промоутится с линковкой",
    },
  });
  expect(promote.status(), await promote.text()).toBe(201);
  const version = await promote.json() as {
    version: number; candidateId: string | null; acceptanceRunId: string | null; acceptanceRunIds: string[];
    acceptancePolicy: { profileId: string } | null;
  };
  expect(version.candidateId).toBe(fixture.candidateId);
  expect(version.acceptanceRunId).toBe(strictRun.runId);
  expect(version.acceptanceRunIds).toEqual([strictRun.runId]);
  expect(version.acceptancePolicy).toMatchObject({ profileId: "pixel-strict-v1" });

  // Список версий — плоский массив DTO (`ComponentRepo.versions`), а не объект-обёртка.
  const versions = await request.get(`/api/components/${REUSE_COMPONENT}/versions`);
  expect(versions.status()).toBe(200);
  const listed = (await versions.json() as { version: number; candidateId: string | null; acceptanceRunId: string | null; acceptanceRunIds: string[] }[])
    .find((item) => item.version === version.version);
  expect(listed).toMatchObject({
    candidateId: fixture.candidateId, acceptanceRunId: strictRun.runId, acceptanceRunIds: [strictRun.runId],
  });
});
