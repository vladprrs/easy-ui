import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { inset, panel, pillGhost } from "../app/chrome";
import { cjm } from "../app/strings/cjm";
import { buildPlayerPath } from "../player/navigation";
import { buildFlowTree, flattenFlowTree, screenFlowIndex, type FlowTreeNode } from "../prototype/flowGraph";
import { verifyEdge, type NavigationGraph } from "../prototype/navigationGraph";
import type { PrototypeDoc } from "../prototype/schema";
import { FlowTree } from "./FlowTree";
import { LazyMount } from "./LazyMount";
import { ScreenLightbox } from "./ScreenLightbox";
import { sheetStripTile } from "../designSystems/deviceMetrics";

/**
 * Режим «Сценарии» (план `docs/plans/2026-07-29-scrn-gallery-ux.md` §7 T2b,
 * редизайн 2026-07-30 — макет 02) — простыня секций по флоу в DFS-порядке дерева
 * `flow.parentId` плюс дерево слева.
 *
 * Зачем поверх дорожек: в дорожках якорный шаг ветки собственного тайла не получает
 * (`lanesLayout.collectSegments` его пропускает), поэтому ветку нельзя прочитать
 * end-to-end. Лента здесь рендерит **все** шаги флоу подряд.
 *
 * Рёбра и легенду верификации простыня не рисует (это язык дорожек); вместо них у
 * каждого шага, кроме первого, стоит собственная метка проходимости перехода из
 * предыдущего шага — для дочерних флоу это единственный индикатор связности (§3).
 * В редизайне метка — круг 14px: зелёная «✓» у проверенного перехода, приглушённое
 * «–» у остальных.
 */

const sectionDomId = (flowId: string) => `cjm-flow-section-${flowId}`;

function StepVerified({ verified }: { verified: "static" | "dynamic" | "missing" }) {
  const ok = verified === "static";
  return <span
    className={`cjm-step-verified grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full text-[9px] leading-none ${ok ? "bg-pay-valid text-white" : "bg-pay-deep/[0.22] text-white"}`}
    data-verified={verified}
    title={cjm.stepVerified(verified)}
  >
    <span aria-hidden="true">{ok ? "✓" : "–"}</span>
    <span className="sr-only">{cjm.stepVerified(verified)}</span>
  </span>;
}

function FlowSection({ node, doc, graph, routeBase, renderTile, sharedFlows, register, onOpenStep }: {
  node: FlowTreeNode;
  doc: PrototypeDoc;
  graph: NavigationGraph;
  routeBase: string;
  renderTile: (screenId: string, flowId: string, stepIndex: number, noteOverride: string | undefined, onOpen: () => void) => ReactNode;
  sharedFlows: number;
  register: (flowId: string, element: HTMLElement | null) => void;
  onOpenStep: (flowId: string, stepIndex: number) => void;
}) {
  const flow = node.flow;
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const headingId = `${sectionDomId(flow.id)}-heading`;
  const firstStep = flow.steps[0];
  const screenNames = useMemo(() => new Map(doc.screens.map((screen) => [screen.id, screen.name])), [doc.screens]);
  const playerHref = firstStep === undefined
    ? undefined
    : `${buildPlayerPath(routeBase, firstStep.screenId)}?${new URLSearchParams({ flow: flow.id, step: "0" })}`;

  const copyLink = async () => {
    // Внутренний URL вида: режим «Сценарии» дефолтный, поэтому `?flow=` достаточно.
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    const href = `${origin}${routeBase}/cjm?${new URLSearchParams({ flow: flow.id })}`;
    try {
      await navigator.clipboard.writeText(href);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  };

  return <section
    ref={(element) => register(flow.id, element)}
    id={sectionDomId(flow.id)}
    data-flow-id={flow.id}
    data-flow-depth={node.depth}
    aria-labelledby={headingId}
    className={`cjm-sheet-section ${panel} scroll-mt-6 p-6`}
    // Вложенность сценария читается отступом секции — как ступени в дереве слева.
    style={{ marginInlineStart: (node.depth - 1) * 28 }}
  >
    <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 id={headingId} className="text-xl font-medium text-eui-ink">{flow.name}</h2>
      <p className="text-[13px] text-eui-slate-500">
        {cjm.sheetScreensCount(flow.steps.length)} · {cjm.sheetInFlows(sharedFlows)}
      </p>
      <div className="ml-auto flex items-center gap-2">
        <button type="button" className={`${pillGhost} px-3 py-1.5 text-[13px]`} onClick={() => { void copyLink(); }}>
          {copied === "done" ? cjm.sheetLinkCopied : copied === "failed" ? cjm.sheetCopyFailed : cjm.sheetCopyLink}
        </button>
        {playerHref === undefined ? null : <Link to={playerHref} className={`${pillGhost} px-3 py-1.5 text-[13px]`}>{cjm.sheetOpenInPlayer}</Link>}
      </div>
    </header>
    {flow.description ? <p className="mt-1 text-[13px] text-eui-slate-500">{flow.description}</p> : null}
    {flow.steps.length === 0 ? <p className="mt-4 text-[13px] text-eui-slate-500">{cjm.sheetEmptySteps}</p> : <div className={`${inset} mt-4 p-4`}>
      <ol className="cjm-sheet-strip flex items-start gap-3 overflow-x-auto" aria-label={cjm.sheetStepsAria(flow.name)}>
        {flow.steps.map((step, stepIndex) => {
          const previous = flow.steps[stepIndex - 1];
          const verified = previous === undefined ? null : verifyEdge(graph, previous.screenId, step.screenId);
          return <li key={`${flow.id}:${stepIndex}`} className="w-[132px] shrink-0" data-screen-id={step.screenId} data-flow-step={stepIndex}>
            <LazyMount
              data-cjm-step={`${flow.id}:${stepIndex}`}
              placeholderHeight={sheetStripTile.fallbackHeight}
              placeholderWidth={sheetStripTile.width}
            >{renderTile(step.screenId, flow.id, stepIndex, step.note, () => onOpenStep(flow.id, stepIndex))}</LazyMount>
            <p className="mt-2 text-[11px] text-eui-slate-500">{cjm.stepNumber(stepIndex + 1)}</p>
            <div className="flex items-start gap-1.5">
              <p className="min-w-0 flex-1 text-[11px] leading-tight text-eui-ink">{screenNames.get(step.screenId) ?? step.screenId}</p>
              {verified === null ? null : <StepVerified verified={verified} />}
            </div>
            {step.note ? <p className="mt-1 text-[11px] leading-tight text-eui-slate-500">{step.note}</p> : null}
          </li>;
        })}
      </ol>
    </div>}
  </section>;
}

export function ScenarioSheet({ doc, graph, routeBase, renderTile, renderStage }: {
  doc: PrototypeDoc;
  graph: NavigationGraph;
  routeBase: string;
  renderTile: (screenId: string, flowId: string, stepIndex: number, noteOverride: string | undefined, onOpen: () => void) => ReactNode;
  /** Кадр 330×640 для лайтбокса (макет 03). */
  renderStage: (screenId: string) => ReactNode;
}) {
  const roots = useMemo(() => buildFlowTree(doc.flows), [doc.flows]);
  const nodes = useMemo(() => flattenFlowTree(roots), [roots]);
  const byScreen = useMemo(() => screenFlowIndex(doc), [doc]);
  // «в M сценариях»: сколько всего сценариев переиспользуют экраны этого — считая его
  // самого, поэтому M ≥ 1. Работает и на плоских флоу сегодняшних документов.
  const sharedFlows = useMemo(() => new Map(nodes.map((node) => {
    const flows = new Set<string>();
    for (const step of node.flow.steps) {
      for (const participation of byScreen.get(step.screenId) ?? []) flows.add(participation.flowId);
    }
    return [node.flow.id, flows.size === 0 ? 1 : flows.size];
  })), [byScreen, nodes]);

  const [activeFlowId, setActiveFlowId] = useState<string | null>(nodes[0]?.flow.id ?? null);
  const [openStep, setOpenStep] = useState<{ flowId: string; stepIndex: number } | null>(null);
  const [zonesVisible, setZonesVisible] = useState(true);
  const sections = useRef(new Map<string, HTMLElement>());
  const register = useCallback((flowId: string, element: HTMLElement | null) => {
    if (element) sections.current.set(flowId, element);
    else sections.current.delete(flowId);
  }, []);

  const order = nodes.map((node) => node.flow.id).join(",");
  // Синхронизация дерева со скроллом простыни: активен верхний из видимых сейчас разделов.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const ids = order === "" ? [] : order.split(",");
    const visible = new Set<string>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const flowId = (entry.target as HTMLElement).dataset.flowId;
        if (flowId === undefined) continue;
        if (entry.isIntersecting) visible.add(flowId);
        else visible.delete(flowId);
      }
      const next = ids.find((id) => visible.has(id));
      if (next !== undefined) setActiveFlowId(next);
    }, { rootMargin: "0px 0px -55% 0px" });
    for (const id of ids) {
      const element = sections.current.get(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [order]);

  const activate = useCallback((flowId: string) => {
    setActiveFlowId(flowId);
    // jsdom не реализует scrollIntoView — вид не должен от него зависеть.
    sections.current.get(flowId)?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, []);

  const openFlow = openStep === null ? undefined : doc.flows?.find((flow) => flow.id === openStep.flowId);

  return <>
    <section className="cjm-sheet mx-auto grid max-w-[1600px] items-start gap-5 lg:grid-cols-[300px_minmax(0,1fr)]" aria-label={cjm.sheetAria}>
      {/* `max-lg:hidden`, а не `hidden lg:block`: compat-CSS shadcn глушит responsive-оверрайды
          базовых утилит, и `lg:block` не пересилил бы `hidden` (см. memory shadcn-compat-css-cascade). */}
      <nav className={`cjm-sheet-tree ${panel} sticky top-0 p-4 max-lg:hidden`}>
        <FlowTree roots={roots} activeFlowId={activeFlowId} onActivate={activate} label={cjm.treeAria} />
        <p className={`${inset} mt-4 px-4 py-3 text-[13px] text-eui-ink`}>{cjm.sheetHint}</p>
      </nav>
      <div className="flex min-w-0 flex-col gap-5">
        {nodes.map((node) => <FlowSection
          key={node.flow.id}
          node={node}
          doc={doc}
          graph={graph}
          routeBase={routeBase}
          renderTile={renderTile}
          sharedFlows={sharedFlows.get(node.flow.id) ?? 1}
          register={register}
          onOpenStep={(flowId, stepIndex) => setOpenStep({ flowId, stepIndex })}
        />)}
      </div>
    </section>
    {openStep !== null && openFlow !== undefined ? <ScreenLightbox
      doc={doc}
      flow={openFlow}
      stepIndex={openStep.stepIndex}
      routeBase={routeBase}
      zonesVisible={zonesVisible}
      onToggleZones={() => setZonesVisible((visible) => !visible)}
      onStep={(stepIndex) => setOpenStep({ flowId: openStep.flowId, stepIndex })}
      onClose={() => setOpenStep(null)}
      renderStage={renderStage}
    /> : null}
  </>;
}
