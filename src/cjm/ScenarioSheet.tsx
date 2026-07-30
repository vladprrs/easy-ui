import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { cjm } from "../app/strings/cjm";
import { buildPlayerPath } from "../player/navigation";
import { buildFlowTree, flattenFlowTree, screenFlowIndex, type FlowTreeNode } from "../prototype/flowGraph";
import { verifyEdge, type NavigationGraph } from "../prototype/navigationGraph";
import type { PrototypeDoc } from "../prototype/schema";
import { FlowTree } from "./FlowTree";
import { LazyMount } from "./LazyMount";

/**
 * Режим «Сценарии» (план `docs/plans/2026-07-29-scrn-gallery-ux.md` §7 T2b) — простыня
 * секций по флоу в DFS-порядке дерева `flow.parentId` плюс дерево слева.
 *
 * Зачем поверх дорожек: в дорожках якорный шаг ветки собственного тайла не получает
 * (`lanesLayout.collectSegments` его пропускает), поэтому ветку нельзя прочитать
 * end-to-end. Лента здесь рендерит **все** шаги флоу подряд.
 *
 * Рёбра и легенду верификации простыня не рисует (это язык дорожек); вместо них у
 * каждого шага, кроме первого, стоит собственная метка проходимости перехода из
 * предыдущего шага — для дочерних флоу это единственный индикатор связности (§3).
 */

const sectionDomId = (flowId: string) => `cjm-flow-section-${flowId}`;

function FlowSection({ node, graph, routeBase, placeholder, renderTile, sharedFlows, register }: {
  node: FlowTreeNode;
  graph: NavigationGraph;
  routeBase: string;
  placeholder: { width: number; height: number };
  renderTile: (screenId: string, flowId?: string, stepIndex?: number, noteOverride?: string) => ReactNode;
  sharedFlows: number;
  register: (flowId: string, element: HTMLElement | null) => void;
}) {
  const flow = node.flow;
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const headingId = `${sectionDomId(flow.id)}-heading`;
  const firstStep = flow.steps[0];
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
    className="cjm-sheet-section scroll-mt-6"
    style={{ marginInlineStart: (node.depth - 1) * 24 }}
  >
    <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 id={headingId} className="font-eui-display text-lg font-medium text-eui-ink">{flow.name}</h2>
      <p className="font-eui-ui text-xs text-eui-slate-500">
        {cjm.sheetScreensCount(flow.steps.length)} · {cjm.sheetInFlows(sharedFlows)}
      </p>
      <div className="ml-auto flex items-center gap-2 font-eui-ui text-xs">
        <button
          type="button"
          className="rounded-full border border-eui-brand/25 px-3 py-1 font-semibold text-eui-brand"
          onClick={() => { void copyLink(); }}
        >
          {copied === "done" ? cjm.sheetLinkCopied : copied === "failed" ? cjm.sheetCopyFailed : cjm.sheetCopyLink}
        </button>
        {playerHref === undefined ? null : <Link
          to={playerHref}
          className="rounded-full border border-eui-brand/25 px-3 py-1 font-semibold text-eui-brand"
        >{cjm.sheetOpenInPlayer}</Link>}
      </div>
    </header>
    {flow.description ? <p className="mt-1 font-eui-ui text-sm text-eui-slate-500">{flow.description}</p> : null}
    {flow.steps.length === 0 ? <p className="mt-4 font-eui-ui text-sm text-eui-slate-500">{cjm.sheetEmptySteps}</p> : <ol
      className="cjm-sheet-strip mt-4 flex items-start gap-6 overflow-x-auto pb-4"
      aria-label={cjm.sheetStepsAria(flow.name)}
    >
      {flow.steps.map((step, stepIndex) => {
        const previous = flow.steps[stepIndex - 1];
        const verified = previous === undefined ? null : verifyEdge(graph, previous.screenId, step.screenId);
        return <li key={`${flow.id}:${stepIndex}`} className="shrink-0" data-screen-id={step.screenId} data-flow-step={stepIndex}>
          <p className="mb-1 h-5 font-eui-ui text-[11px] text-eui-slate-500">
            {verified === null ? null : <span className="cjm-step-verified rounded-full bg-eui-lilac-100 px-2 py-0.5" data-verified={verified}>{cjm.stepVerified(verified)}</span>}
          </p>
          <LazyMount
            data-cjm-step={`${flow.id}:${stepIndex}`}
            placeholderHeight={placeholder.height}
            placeholderWidth={placeholder.width}
          >{renderTile(step.screenId, flow.id, stepIndex, step.note)}</LazyMount>
        </li>;
      })}
    </ol>}
  </section>;
}

export function ScenarioSheet({ doc, graph, routeBase, placeholder, renderTile }: {
  doc: PrototypeDoc;
  graph: NavigationGraph;
  routeBase: string;
  placeholder: { width: number; height: number };
  renderTile: (screenId: string, flowId?: string, stepIndex?: number, noteOverride?: string) => ReactNode;
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

  return <section className="cjm-sheet mx-auto mt-8 flex max-w-[1600px] items-start gap-8" aria-label={cjm.sheetAria}>
    {/* `max-lg:hidden`, а не `hidden lg:block`: compat-CSS shadcn глушит responsive-оверрайды
        базовых утилит, и `lg:block` не пересилил бы `hidden` (см. memory shadcn-compat-css-cascade). */}
    <nav className="cjm-sheet-tree sticky top-0 w-60 shrink-0 max-lg:hidden">
      <FlowTree roots={roots} activeFlowId={activeFlowId} onActivate={activate} label={cjm.treeAria} />
    </nav>
    <div className="flex min-w-0 flex-1 flex-col gap-10">
      {nodes.map((node) => <FlowSection
        key={node.flow.id}
        node={node}
        graph={graph}
        routeBase={routeBase}
        placeholder={placeholder}
        renderTile={renderTile}
        sharedFlows={sharedFlows.get(node.flow.id) ?? 1}
        register={register}
      />)}
    </div>
  </section>;
}
