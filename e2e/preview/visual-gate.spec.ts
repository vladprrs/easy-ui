import { expect, test, type APIRequestContext } from "@playwright/test";
import { unzipSync } from "fflate";

/**
 * Минимальный визуальный гейт приёмки против реального Bun preview-сервера
 * (план 2026-08-03 §2 A5, §5 W5a).
 *
 * Живёт в `e2e/preview/` по той же причине, что `acceptance-run.spec.ts` и `case-sets.spec.ts`:
 * только preview-проект поднимает `SERVE_DIST` и `EASYUI_ACCEPTANCE_MATRIX=1`.
 *
 * **Честный контур эталона.** Обычный скриншот компонента и paint-кадр случая — разные картинки
 * (у paint-кадра прозрачный фон и маргин-поле), поэтому эталоном служит не «снимок ручкой», а
 * ровно тот кадр, который приёмка кладёт в evidence:
 *
 *   1. ран №1 по двум случаям без эталонов → скачать `evidence.zip` → достать оба `paint.png`;
 *   2. объявить эталоном случая **его собственный** кадр (`requireVisual: true`) → ран №2 обязан
 *      пройти с `rawDiffPct: 0`;
 *   3. подсунуть тому же случаю кадр **соседнего** состояния (те же габариты, другой цвет) →
 *      ран №3 обязан упасть с метриками.
 *
 * Пункт 3 — то, ради чего гейт существует: провал обязан быть **измеренным**, а не «что-то не так».
 * Заодно он остаётся в зоне нормализации: габариты сходятся, поэтому вердикт — `fail`, а не
 * `indeterminate` «несводимые размеры».
 */

const DS_ID = "e2e-visual-gate";
const COMPONENT_ID = "e2e-visual-gate-probe";
const CASE_ID = "solid";
const OTHER_CASE_ID = "muted";

const SOURCE = `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ tone: z.string() }),
  description: "Visual-gate probe: a fixed-size opaque box with no text, so the frame is byte-stable",
  atomicLevel: "atom" as const,
  examples: { base: { tone: "accent" } },
};

export default function VisualGateProbe({ props }: EasyUIComponentProps<{ tone: string }>) {
  return <div style={{ width: 96, height: 64, borderRadius: 8, background: props.tone === "accent" ? "#3355cc" : "#888888" }} />;
}
`;

interface CauseView { code: string; confidence: number; detail: string }

interface RunView {
  status: string;
  progress: { total: number; completed: number; failed: number };
  /** W5b: группы ремедиаций терминального рана, отсортированные по числу случаев. */
  remediationGroups: { key: string; cause: CauseView; cases: string[]; caseCount: number; suggestion: string }[];
  failedCases: { caseId: string; causes: CauseView[]; failedGates: { gate: string; status: string; detail?: string; metrics?: Record<string, unknown> }[] }[];
}

interface CaseView {
  caseId: string;
  verdict: string;
  referenceAssetId: string | null;
  causes: CauseView[];
  gates: { gate: string; status: string; detail?: string; metrics?: Record<string, unknown>; causes?: CauseView[] }[];
  artifacts: { name: string }[];
}

/** Базовый набор: два состояния одинаковых габаритов и разного цвета. */
function manifest(options: { referenceAssetId?: string; requireVisual?: boolean; onlyFirst?: boolean } = {}): Record<string, unknown> {
  const cases: Record<string, unknown>[] = [{
    id: CASE_ID,
    props: { tone: "accent" },
    ...(options.referenceAssetId ? { referenceAssetId: options.referenceAssetId } : {}),
  }];
  if (options.onlyFirst !== true) cases.push({ id: OTHER_CASE_ID, props: { tone: "muted" } });
  return {
    manifestVersion: 1,
    componentId: COMPONENT_ID,
    capture: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, theme: "light" },
    ...(options.requireVisual ? { requireVisual: true } : {}),
    cases,
  };
}

async function ensureFixture(request: APIRequestContext): Promise<void> {
  const system = await request.post("/api/design-systems", {
    data: { id: DS_ID, name: "E2E Visual Gate", description: "Design system for the acceptance visual-gate e2e" },
  });
  expect([201, 409], await system.text()).toContain(system.status());
  const existing = await request.get(`/api/components/${COMPONENT_ID}`);
  if (existing.status() === 200) return;
  const created = await request.post("/api/components", {
    data: {
      id: COMPONENT_ID, name: "VisualGateProbe", source: SOURCE, designSystem: DS_ID,
      intent: "Однотонная коробка фиксированного размера для пиксельной приёмки визуального гейта",
    },
  });
  expect(created.status(), await created.text()).toBe(201);
}

/** Постановка кандидата делит троттлинг с validate — ограниченный ретрай входит в контракт ручки. */
async function createCandidate(request: APIRequestContext): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await request.post(`/api/components/${COMPONENT_ID}/candidates`, { data: {} });
    if (response.status() === 200) return (await response.json() as { candidateId: string }).candidateId;
    expect([429], `${response.status()}: ${await response.text()}`).toContain(response.status());
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("candidate creation stayed throttled for 60s");
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

async function publishCaseSet(request: APIRequestContext, body: Record<string, unknown>): Promise<string> {
  const put = await request.put(`/api/components/${COMPONENT_ID}/case-sets`, { data: { manifest: body } });
  expect(put.status(), await put.text()).toBe(200);
  return (await put.json() as { caseSetId: string }).caseSetId;
}

async function runCaseSet(request: APIRequestContext, candidateId: string, caseSetId: string): Promise<{ runId: string; run: RunView; cases: CaseView[] }> {
  const started = await request.post("/api/acceptance-runs", { data: { candidateId, caseSetId } });
  expect(started.status(), await started.text()).toBe(202);
  const runId = (await started.json() as { runId: string }).runId;
  const run = await pollRun(request, runId);
  const casesResponse = await request.get(`/api/acceptance-runs/${runId}/cases`);
  expect(casesResponse.status()).toBe(200);
  return { runId, run, cases: (await casesResponse.json() as { cases: CaseView[] }).cases };
}

async function uploadPng(request: APIRequestContext, name: string, bytes: Buffer): Promise<string> {
  const upload = await request.post("/api/assets", {
    multipart: { file: { name, mimeType: "image/png", buffer: bytes } },
  });
  expect([200, 201], await upload.text()).toContain(upload.status());
  return (await upload.json() as { id: string }).id;
}

test("paint-кадр как эталон: run без эталона → эталон из evidence → pass → чужой кадр эталоном → fail с метриками", async ({ request }) => {
  test.setTimeout(900_000);
  await ensureFixture(request);
  const candidateId = await createCandidate(request);

  // --- ран №1: без эталонов. Визуальный гейт необязателен и честно пропускает случаи.
  const baseline = await runCaseSet(request, candidateId, await publishCaseSet(request, manifest()));
  expect(baseline.run.status, JSON.stringify(baseline.run.failedCases)).toBe("pass");
  const first = baseline.cases.find((item) => item.caseId === CASE_ID)!;
  expect(first.gates.find((gate) => gate.gate === "visual")?.status).toBe("skipped");
  expect(first.artifacts.map((item) => item.name)).toContain("paint.png");

  // Эталон достаётся из evidence-архива: это ровно тот кадр, который приёмка и сравнивает.
  const evidence = await request.get(`/api/acceptance-runs/${baseline.runId}/evidence`);
  expect(evidence.status(), await evidence.text()).toBe(200);
  const archive = unzipSync(new Uint8Array(await evidence.body()));
  const own = archive[`${CASE_ID}/paint.png`];
  const neighbour = archive[`${OTHER_CASE_ID}/paint.png`];
  expect(own, `evidence entries: ${Object.keys(archive).join(", ")}`).toBeTruthy();
  expect(neighbour, `evidence entries: ${Object.keys(archive).join(", ")}`).toBeTruthy();

  // --- ран №2: собственный кадр эталоном, визуал обязателен ⇒ pass с нулевым расхождением.
  const referenceAssetId = await uploadPng(request, "paint-reference.png", Buffer.from(own!));
  const matching = await runCaseSet(request, candidateId,
    await publishCaseSet(request, manifest({ referenceAssetId, requireVisual: true, onlyFirst: true })));
  expect(matching.run.status, JSON.stringify(matching.run.failedCases)).toBe("pass");
  // W5b: прошедшему случаю объяснять нечего — ни причин, ни групп ремедиаций.
  expect(matching.run.remediationGroups).toEqual([]);
  expect(matching.cases[0]!.causes).toEqual([]);
  const passed = matching.cases[0]!;
  expect(passed.referenceAssetId).toBe(referenceAssetId);
  const visualPass = passed.gates.find((gate) => gate.gate === "visual")!;
  expect(visualPass.status).toBe("pass");
  expect(visualPass.metrics).toMatchObject({ required: true, rawDiffPct: 0, aaDiffPct: 0, maxChannelDelta: 0 });
  expect(passed.artifacts.map((item) => item.name).sort()).toEqual(
    expect.arrayContaining(["diff.png", "normalized-candidate.png", "visual.json"]),
  );

  // --- ран №3: кадр соседнего состояния (те же габариты, другой цвет) ⇒ fail, и провал измерен.
  const wrongAssetId = await uploadPng(request, "paint-reference-wrong.png", Buffer.from(neighbour!));
  const broken = await runCaseSet(request, candidateId,
    await publishCaseSet(request, manifest({ referenceAssetId: wrongAssetId, requireVisual: true, onlyFirst: true })));
  expect(broken.run.status).toBe("fail");
  const failed = broken.cases[0]!;
  expect(failed.verdict).toBe("fail");
  const visualFail = failed.gates.find((gate) => gate.gate === "visual")!;
  expect(visualFail.status).toBe("fail");
  const metrics = visualFail.metrics as {
    rawDiffPct: number; aaDiffPct: number; maxChannelDelta: number;
    regions: { areaPct: number }[]; bestOffset: { dx: number; dy: number };
  };
  expect(metrics.rawDiffPct).toBeGreaterThan(0);
  expect(metrics.maxChannelDelta).toBeGreaterThan(0);
  expect(metrics.regions.length).toBeGreaterThan(0);
  expect(visualFail.detail).toContain("exceeds the");
  // Провал названного случая виден в run-репорте и отсортирован по severity.
  expect(broken.run.failedCases[0]!.caseId).toBe(CASE_ID);
  expect(broken.run.failedCases[0]!.failedGates.map((gate) => gate.gate)).toContain("visual");

  // --- W5b: провал классифицирован и сгруппирован в ремедиацию (диагностика, не вердикт).
  expect(failed.causes.length).toBeGreaterThanOrEqual(1);
  expect(visualFail.causes?.length).toBeGreaterThanOrEqual(1);
  expect(failed.causes[0]!.confidence).toBeGreaterThan(0);
  expect(failed.causes[0]!.detail.length).toBeGreaterThan(0);
  expect(broken.run.failedCases[0]!.causes.map((cause) => cause.code)).toEqual(failed.causes.map((cause) => cause.code));
  expect(broken.run.remediationGroups.length).toBeGreaterThanOrEqual(1);
  const group = broken.run.remediationGroups[0]!;
  expect(group.key).toMatch(/^[0-9a-f]{64}$/);
  expect(group.cases).toContain(CASE_ID);
  expect(group.caseCount).toBe(group.cases.length);
  expect(group.cause.code).toBe(failed.causes[0]!.code);
  expect(group.suggestion.length).toBeGreaterThan(0);
});
