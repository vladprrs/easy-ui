import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Geometry Contract 2.0 в реальном chromium (план 2026-08-03 §5 W3).
 *
 * Проверяется то, что нельзя проверить unit-тестом: `probe:"paint"` действительно снимает
 * поверхность прозрачной и с полем, ink-bbox реального кадра **шире** честного `layoutBounds`, а
 * гейт `geometry` падает **с названным виновником** — потомком с CSS-причиной (`box-shadow`).
 * Второй прогон с `allowPaintOverflow` показывает, что вердикт при этом остаётся честным
 * (`paint-overflow-not-clipped`), а блокирует его именно политика, а не измерение.
 *
 * Живёт в `e2e/preview/`: только preview-проект поднимает `SERVE_DIST` (иначе капчур — 501) и
 * `EASYUI_ACCEPTANCE_MATRIX=1` (иначе acceptance-ручки отвечают 404).
 */

const DS_ID = "e2e-geometry-paint";
const COMPONENT_ID = "e2e-paint-probe";

/**
 * Фикстура ровно про дефект §19.2: контент честно 140×96, а красит он заметно шире — тень внешнего
 * блока и абсолютно спозиционированная подсветка. Размеры заданы явно, чтобы `layoutBounds` был
 * предсказуемым числом, а не результатом раскладки текста.
 */
const SOURCE = `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ label: z.string() }),
  description: "Paint probe: a 140x96 card whose shadow and halo paint far outside the layout box",
  atomicLevel: "atom" as const,
  examples: { card: { label: "Card" } },
};

export default function PaintProbe({ props }: EasyUIComponentProps<{ label: string }>) {
  return (
    <div style={{ position: "relative", width: 140, height: 96, boxSizing: "border-box", background: "#ffffff", color: "#000000", boxShadow: "0px 0px 24px 12px rgba(0,0,0,0.75)" }}>
      <div style={{ position: "absolute", left: -18, top: -18, width: 176, height: 132, background: "rgba(255,0,0,0.4)" }} />
      <span style={{ position: "relative" }}>{props.label}</span>
    </div>
  );
}
`;

interface RunView {
  status: string;
  progress: { total: number; completed: number; failed: number };
  failedCases: { caseId: string; failedGates: { gate: string; detail?: string }[] }[];
}

interface GeometryMetrics {
  policyVerdict: string;
  paintMargin: number;
  deviceScaleFactor: number;
  layoutBounds: { x: number; y: number; width: number; height: number } | null;
  paintBounds: { x: number; y: number; width: number; height: number } | null;
  paintBoundsSource: string | null;
  paintClamped: { left: boolean; right: boolean; top: boolean; bottom: boolean } | null;
  overflow: { left: number; right: number; top: number; bottom: number; sources: { elementKey: string | null; cause: string; contribution: { total: number } }[] };
}

interface CaseView {
  caseId: string;
  verdict: string;
  gates: { gate: string; status: string; detail?: string; metrics?: GeometryMetrics }[];
  artifacts: { name: string }[];
}

async function ensureFixture(request: APIRequestContext): Promise<void> {
  const system = await request.post("/api/design-systems", {
    data: { id: DS_ID, name: "E2E Geometry Paint", description: "Design system for the paint-probe e2e" },
  });
  expect([201, 409], await system.text()).toContain(system.status());
  const existing = await request.get(`/api/components/${COMPONENT_ID}`);
  if (existing.status() === 200) return;
  const created = await request.post("/api/components", {
    data: {
      id: COMPONENT_ID, name: "PaintProbe", source: SOURCE, designSystem: DS_ID,
      intent: "Карточка с тенью и подсветкой для приёмки контура краски (geometry 2.0)",
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

async function runOnce(request: APIRequestContext, candidateId: string, caseSetId?: string): Promise<{ run: RunView; cases: CaseView[] }> {
  const started = await request.post("/api/acceptance-runs", {
    data: { candidateId, ...(caseSetId ? { caseSetId } : {}), refresh: "all" },
  });
  expect(started.status(), await started.text()).toBe(202);
  const { runId } = await started.json() as { runId: string };
  const run = await pollRun(request, runId);
  const casesResponse = await request.get(`/api/acceptance-runs/${runId}/cases`);
  expect(casesResponse.status()).toBe(200);
  const { cases } = await casesResponse.json() as { cases: CaseView[] };
  return { run, cases };
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

test("probe=paint measures real ink beyond the layout box and names the descendant that paints it", async ({ request }) => {
  test.setTimeout(600_000);
  await ensureFixture(request);

  const candidate = await createCandidate(request, COMPONENT_ID);

  const { run, cases } = await runOnce(request, candidate.candidateId);
  expect(run.status, JSON.stringify(run.failedCases)).toBe("fail");

  const geometry = cases[0]!.gates.find((gate) => gate.gate === "geometry")!;
  expect(geometry.status).toBe("fail");
  const metrics = geometry.metrics!;

  // Честный контур: 140×96 внутри поля 64px, независимо от того, как широко компонент красит.
  expect(metrics.layoutBounds).toMatchObject({ x: metrics.paintMargin, y: metrics.paintMargin, width: 140, height: 96 });
  expect(metrics.paintBoundsSource).toBe("alpha");
  expect(metrics.paintClamped).toMatchObject({ left: false, right: false, top: false, bottom: false });

  // Чернила шире контура по всем сторонам — то, что вообще не измерялось до этой волны.
  const paint = metrics.paintBounds!;
  expect(paint.width).toBeGreaterThan(140);
  expect(paint.height).toBeGreaterThan(96);
  expect(metrics.overflow.left).toBeGreaterThan(0);
  expect(metrics.overflow.right).toBeGreaterThan(0);
  expect(metrics.overflow.top).toBeGreaterThan(0);
  expect(metrics.overflow.bottom).toBeGreaterThan(0);

  // Инвариант W3: провал обязан назвать потомка и CSS-причину.
  expect(metrics.policyVerdict).toBe("paint-overflow-not-clipped");
  expect(metrics.overflow.sources.length).toBeGreaterThan(0);
  const causes = metrics.overflow.sources.map((source) => source.cause);
  expect(causes.some((cause) => cause.startsWith("box-shadow:") || cause.startsWith("position:"))).toBe(true);
  expect(geometry.detail).toBeTruthy();
  expect(cases[0]!.artifacts.map((artifact) => artifact.name)).toContain("paint.png");

  // Тот же кадр, тот же вердикт — но объявленный допуск случая делает его неблокирующим.
  const allowManifest = {
    manifestVersion: 1,
    componentId: COMPONENT_ID,
    capture: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, theme: "light" },
    policy: { profile: "default-v1", perCase: { card: { allowPaintOverflow: true } } },
    cases: [{ id: "card", props: { label: "Card" } }],
  };
  const put = await request.put(`/api/components/${COMPONENT_ID}/case-sets`, { data: { manifest: allowManifest } });
  expect(put.status(), await put.text()).toBe(200);
  const caseSet = await put.json() as { caseSetId: string };

  const allowed = await runOnce(request, candidate.candidateId, caseSet.caseSetId);
  expect(allowed.run.status, JSON.stringify(allowed.run.failedCases)).toBe("pass");
  const allowedGeometry = allowed.cases[0]!.gates.find((gate) => gate.gate === "geometry")!;
  expect(allowedGeometry.status).toBe("pass");
  // Вердикт не подменён допуском: измерение осталось тем же, изменилась только блокировка.
  expect(allowedGeometry.metrics!.policyVerdict).toBe("paint-overflow-not-clipped");
  expect(allowedGeometry.metrics!.overflow.sources.length).toBeGreaterThan(0);
});
