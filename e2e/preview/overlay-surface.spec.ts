import { unzipSync } from "fflate";
import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Viewport-поверхность приёмки (план 2026-08-06 §W5 T5c) в реальном chromium.
 *
 * Проверяется то, чего не докажет jsdom:
 * - `capture.surface: "viewport"` действительно строит внутри padded-поверхности узел размера
 *   вьюпорта, и кадр получается ровно `(viewport + 2×margin) × dsf` при дефолтном маргине 16;
 * - overlay-aware layout root: сцена **пустая** (только оверлей, без scrim и фона), и всё же
 *   `layoutBounds` ненулевой — до волны это была бы измеренная пустота и `indeterminate`;
 * - высотный инвариант: шит с двухметровой лентой внутри меряется по своему боксу, а не по ленте;
 * - hug-поверхность рядом не изменилась ни на пиксель: тот же дефолтный маргин 64 и свой контур.
 *
 * **Ограничение, зафиксированное честно (расхождение с §W5 T5c.1).** Host-примитив `Overlay`
 * недоступен из TSX опубликованного компонента: ABI (`easy-ui/runtime`, `server/shims/abi-v*.ts`)
 * экспортирует `token`/`space`/`color`/`Icon` и ничего больше, а имя `Overlay` резервировано для
 * элементов **документа**, которых в компонентной приёмке нет. Поэтому шеллы здесь воспроизводят
 * DOM-контракт оверлея (`[data-eui-overlay-content]` в stage host'е), а сам примитив покрыт
 * DOM-тестами `src/catalog/hostPrimitives/Overlay.test.tsx`. Путь «custom TSX → host Overlay»
 * требует расширения ABI и вынесен из этой волны.
 *
 * Живёт в `e2e/preview/`: только preview-проект поднимает `SERVE_DIST` и
 * `EASYUI_ACCEPTANCE_MATRIX=1`.
 */

const DS_ID = "e2e-overlay-surface";
const COMPONENT_ID = "e2e-overlay-shell";
const VIEWPORT = { width: 390, height: 844 };
const DSF = 2;
/** Дефолт поля viewport-поверхности (`VIEWPORT_SURFACE_PAINT_MARGIN_PX`). */
const VIEWPORT_MARGIN = 16;
/** Дефолт поля hug-поверхности (`DEFAULT_PAINT_MARGIN_PX`) — он не изменился. */
const HUG_MARGIN = 64;
const INSET = 16;

/**
 * Четыре шелла одним компонентом: `variant` выбирает сцену. Один компонент вместо четырёх — это
 * один кандидат и два рана вместо восьми; на предмет теста (поверхность, корень, кадр) выбор не
 * влияет, а стоимость прогона отличается кратно.
 */
const SOURCE = `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ variant: z.enum(["sheet", "popup", "scroll", "hug"]) }),
  description: "Overlay surface shells: bottom sheet, centered popup, scrolling sheet and a plain hug card",
  atomicLevel: "molecule" as const,
  examples: { sheet: { variant: "sheet" }, popup: { variant: "popup" }, scroll: { variant: "scroll" }, hug: { variant: "hug" } },
};

const SURFACE = { background: "#101828", color: "#ffffff", boxSizing: "border-box" as const };

export default function OverlayShell({ props }: EasyUIComponentProps<{ variant: "sheet" | "popup" | "scroll" | "hug" }>) {
  if (props.variant === "hug") {
    return <div style={{ ...SURFACE, width: 200, height: 120, padding: 16 }}>Hug popup</div>;
  }
  if (props.variant === "popup") {
    return (
      <div
        data-eui-overlay-content=""
        style={{ ...SURFACE, position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)",
          width: "max-content", maxWidth: "calc(100% - 32px)", maxHeight: "calc(100% - 32px)", overflow: "hidden", padding: 24 }}
      >
        Centered popup
      </div>
    );
  }
  const scrolls = props.variant === "scroll";
  return (
    <div
      data-eui-overlay-content=""
      style={{ ...SURFACE, position: "absolute", left: 16, right: 16, bottom: 16, maxHeight: "calc(100% - 32px)",
        ...(scrolls ? { overflowY: "auto" as const, overscrollBehavior: "contain" as const } : { overflow: "hidden" as const }) }}
    >
      <div style={{ height: scrolls ? 2000 : 240 }}>Sheet body</div>
    </div>
  );
}
`;

interface RunView {
  runId?: string;
  status: string;
  failedCases: { caseId: string; failedGates: { gate: string; detail?: string }[] }[];
}

interface GeometryMetrics {
  policyVerdict: string;
  paintMargin: number;
  deviceScaleFactor: number;
  layoutBounds: { x: number; y: number; width: number; height: number } | null;
  overflow: { left: number; right: number; top: number; bottom: number; sources: unknown[] };
}

interface CaseView {
  caseId: string;
  verdict: string;
  gates: { gate: string; status: string; detail?: string; metrics?: GeometryMetrics }[];
}

async function ensureFixture(request: APIRequestContext): Promise<void> {
  const system = await request.post("/api/design-systems", {
    data: { id: DS_ID, name: "E2E Overlay Surface", description: "Design system for the viewport-surface e2e" },
  });
  expect([201, 409], await system.text()).toContain(system.status());
  const existing = await request.get(`/api/components/${COMPONENT_ID}`);
  if (existing.status() === 200) return;
  const created = await request.post("/api/components", {
    data: {
      id: COMPONENT_ID, name: "OverlayShell", source: SOURCE, designSystem: DS_ID,
      intent: "Шеллы оверлейной сцены для приёмки viewport-поверхности (шит, попап, прокручиваемый шит, hug-карточка)",
    },
  });
  expect(created.status(), await created.text()).toBe(201);
}

/** Постановка кандидата троттлится теми же двумя глобальными слотами, что и validate. */
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
    if (!["queued", "running"].includes(run.status)) return { ...run, runId };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("acceptance run did not terminalize within 180s");
}

async function runCaseSet(request: APIRequestContext, candidateId: string, manifest: unknown): Promise<{ run: RunView; cases: Map<string, CaseView> }> {
  const put = await request.put(`/api/components/${COMPONENT_ID}/case-sets`, { data: { manifest } });
  expect(put.status(), await put.text()).toBe(200);
  const { caseSetId } = await put.json() as { caseSetId: string };
  const started = await request.post("/api/acceptance-runs", { data: { candidateId, caseSetId, refresh: "all" } });
  expect(started.status(), await started.text()).toBe(202);
  const { runId } = await started.json() as { runId: string };
  const run = await pollRun(request, runId);
  const casesResponse = await request.get(`/api/acceptance-runs/${runId}/cases`);
  expect(casesResponse.status()).toBe(200);
  const { cases } = await casesResponse.json() as { cases: CaseView[] };
  return { run, cases: new Map(cases.map((item) => [item.caseId, item])) };
}

const geometryOf = (view: CaseView) => {
  const gate = view.gates.find((item) => item.gate === "geometry")!;
  expect(gate.status, `${view.caseId}: ${gate.detail ?? ""}`).toBe("pass");
  return gate.metrics!;
};

/** Размеры PNG из IHDR: единственный способ увидеть настоящий размер кадра, снятого браузером. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

test("capture.surface=viewport: кадр вьюпорта, overlay-корень на пустой сцене, hug рядом не изменился", async ({ request }) => {
  test.setTimeout(900_000);
  await ensureFixture(request);
  const candidateId = await createCandidate(request);

  // --- viewport-поверхность: три шелла, все со «сценой из одного оверлея» (никакого scrim) ------
  const viewportRun = await runCaseSet(request, candidateId, {
    manifestVersion: 1,
    componentId: COMPONENT_ID,
    capture: { viewport: VIEWPORT, deviceScaleFactor: DSF, theme: "light", surface: "viewport" },
    policy: { profile: "default-v1" },
    cases: [
      { id: "fixed-sheet", props: { variant: "sheet" } },
      { id: "fixed-popup", props: { variant: "popup" } },
      { id: "scroll-sheet", props: { variant: "scroll" } },
    ],
  });
  expect(viewportRun.run.status, JSON.stringify(viewportRun.run.failedCases)).toBe("pass");

  for (const caseId of ["fixed-sheet", "fixed-popup", "scroll-sheet"]) {
    const metrics = geometryOf(viewportRun.cases.get(caseId)!);
    // Поле viewport-поверхности — 16, а не 64: кадр вьюпорта и без того велик.
    expect(metrics.paintMargin, caseId).toBe(VIEWPORT_MARGIN);
    // Главное утверждение волны: сцена пустая (только оверлей), а контур **ненулевой**.
    const bounds = metrics.layoutBounds!;
    expect(bounds, caseId).not.toBeNull();
    expect(bounds.width, caseId).toBeGreaterThan(0);
    expect(bounds.height, caseId).toBeGreaterThan(0);
    // Позади оверлея не нарисовано ничего, поэтому и paint-overflow нет — вердикт чистый.
    expect(metrics.policyVerdict, caseId).toBe("clean");
  }

  // Шит прижат к низу вьюпорта и растянут по ширине минус inset; координаты — от **внешней**
  // поверхности, поэтому x = margin + inset.
  const sheet = geometryOf(viewportRun.cases.get("fixed-sheet")!).layoutBounds!;
  expect(sheet.x).toBe(VIEWPORT_MARGIN + INSET);
  expect(sheet.width).toBe(VIEWPORT.width - 2 * INSET);
  expect(sheet.height).toBe(240);
  expect(sheet.y + sheet.height).toBe(VIEWPORT_MARGIN + VIEWPORT.height - INSET);

  // Попап — shrink-to-fit по центру: `transform` корня больше его не дисквалифицирует.
  const popup = geometryOf(viewportRun.cases.get("fixed-popup")!).layoutBounds!;
  expect(popup.width).toBeLessThan(VIEWPORT.width - 2 * INSET);
  expect(Math.abs((popup.x + popup.width / 2) - (VIEWPORT_MARGIN + VIEWPORT.width / 2))).toBeLessThanOrEqual(1);

  // Высотный инвариант: внутри двухметровая лента, а меряется бокс шита.
  const scroll = geometryOf(viewportRun.cases.get("scroll-sheet")!).layoutBounds!;
  expect(scroll.height).toBe(VIEWPORT.height - 2 * INSET);
  expect(scroll.height).toBeLessThan(2000);

  // Размер кадра — на реальном chromium: `(viewport + 2×margin) × dsf`.
  const evidence = await request.get(`/api/acceptance-runs/${viewportRun.run.runId}/evidence`);
  expect(evidence.status(), await evidence.text()).toBe(200);
  const archive = unzipSync(new Uint8Array(await evidence.body()));
  for (const caseId of ["fixed-sheet", "fixed-popup", "scroll-sheet"]) {
    const paint = archive[`${caseId}/paint.png`];
    expect(paint, `evidence archive has no ${caseId}/paint.png`).toBeTruthy();
    expect(pngSize(paint!), caseId).toEqual({
      width: (VIEWPORT.width + 2 * VIEWPORT_MARGIN) * DSF,
      height: (VIEWPORT.height + 2 * VIEWPORT_MARGIN) * DSF,
    });
  }

  // --- hug-поверхность: тот же компонент, доволновой путь ------------------------------------
  const hugRun = await runCaseSet(request, candidateId, {
    manifestVersion: 1,
    componentId: COMPONENT_ID,
    capture: { viewport: VIEWPORT, deviceScaleFactor: DSF, theme: "light" },
    policy: { profile: "default-v1" },
    cases: [{ id: "popup-hug", props: { variant: "hug" } }],
  });
  expect(hugRun.run.status, JSON.stringify(hugRun.run.failedCases)).toBe("pass");
  const hug = geometryOf(hugRun.cases.get("popup-hug")!);
  expect(hug.paintMargin).toBe(HUG_MARGIN);
  expect(hug.layoutBounds).toMatchObject({ x: HUG_MARGIN, y: HUG_MARGIN, width: 200, height: 120 });
});
