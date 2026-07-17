import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import { PrototypeChrome } from "../app/PrototypeChrome";
import { buildPlayerPath } from "../player/navigation";
import { cjm, cjmDocumentTitle } from "../app/strings/cjm";
import { useDocumentTitle } from "../app/useDocumentTitle";
import type { CustomPlayerRuntime } from "../catalog/runtime";
import { createPlayerRuntime } from "../catalog/runtime";
import { ThemeStyle, useDesignSystemTheme } from "../designSystems/theme";
import { previewTileSizes } from "../designSystems/deviceMetrics";
import { buildNavigationGraph } from "../prototype/navigationGraph";
import type { PrototypeDoc } from "../prototype/schema";
import { CjmEdgesOverlay, computeLogicalEdgeRoutes } from "./CjmEdgesOverlay";
import { CjmScreenTile } from "./CjmScreenTile";
import { createCjmRegistry } from "./cjmRegistry";
import { computeCjmLanes, type CjmLayout } from "./lanesLayout";

interface ConnectorGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
  sourceY: number;
  targetY: number;
}

function sameGeometry(left: ConnectorGeometry | null, right: ConnectorGeometry): boolean {
  return left !== null && Object.keys(right).every((key) => left[key as keyof ConnectorGeometry] === right[key as keyof ConnectorGeometry]);
}

/** Connects the measured centers of two adjacent tiles; it does not encode a flow edge. */
function CjmConnector({ sourceScreenId, targetScreenId }: { sourceScreenId: string; targetScreenId: string }) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [geometry, setGeometry] = useState<ConnectorGeometry | null>(null);
  useLayoutEffect(() => {
    const source = anchorRef.current?.parentElement;
    const target = source?.nextElementSibling;
    if (!(source instanceof HTMLElement) || !(target instanceof HTMLElement) || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const sourceRect = source.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const sourceCenter = sourceRect.height / 2;
      const targetCenter = targetRect.top - sourceRect.top + targetRect.height / 2;
      const top = Math.min(sourceCenter, targetCenter) - 12;
      const next = {
        left: sourceRect.width,
        top,
        width: Math.max(0, targetRect.left - sourceRect.right),
        height: Math.abs(targetCenter - sourceCenter) + 24,
        sourceY: sourceCenter - top,
        targetY: targetCenter - top,
      };
      setGeometry((current) => sameGeometry(current, next) ? current : next);
    });
    observer.observe(source);
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  return <>
    <span ref={anchorRef} className="sr-only" />
    {geometry === null || geometry.width === 0 ? null : <svg
      aria-hidden="true"
      className="cjm-connector pointer-events-none absolute z-10 overflow-visible"
      data-source-screen-id={sourceScreenId}
      data-target-screen-id={targetScreenId}
      data-testid="cjm-connector"
      style={{ left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height }}
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      fill="none"
    >
      <path data-testid="cjm-connector-line" d={`M0 ${geometry.sourceY} L${geometry.width} ${geometry.targetY}`} stroke="#844EDC" strokeWidth="2.5" strokeLinecap="round" />
      <path d={`M${geometry.width - 8} ${geometry.targetY - 7} L${geometry.width} ${geometry.targetY} L${geometry.width - 8} ${geometry.targetY + 7}`} stroke="#844EDC" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>}
  </>;
}

function UnassignedLane({ layout, tile }: { layout: CjmLayout; tile: (screenId: string) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(20);
  if (!layout.unassigned.length) return null;
  const shown = open ? layout.unassigned.slice(0, visible) : [];
  return <section className="cjm-unassigned mx-auto mt-8 max-w-[1600px]">
    <button
      type="button"
      className="font-eui-ui text-sm font-semibold text-eui-brand"
      aria-expanded={open}
      onClick={() => {
        setOpen((current) => !current);
        setVisible(20);
      }}
    >
      {cjm.unassignedCount(layout.unassigned.length)}
    </button>
    {open ? <div className="mt-4 flex items-start gap-6 overflow-x-auto pb-4" aria-label={cjm.unassignedAria}>
      {shown.map((screenId) => <div key={screenId} className="shrink-0">{tile(screenId)}</div>)}
      {visible < layout.unassigned.length ? <button type="button" className="shrink-0 self-center rounded-lg border bg-white px-4 py-2 font-eui-ui text-sm text-eui-brand" onClick={() => setVisible((current) => Math.min(current + 20, layout.unassigned.length))}>{cjm.showMore}</button> : null}
    </div> : null}
  </section>;
}

export function CjmView({ doc, custom, runtimeKey, routeBase, version, designSystemMetaVersion }: { doc: PrototypeDoc; custom?: CustomPlayerRuntime; runtimeKey: string; routeBase: string; version?: number; designSystemMetaVersion?: number | null }) {
  useDocumentTitle(cjmDocumentTitle(doc.name, version));
  const runtime = useMemo(() => createPlayerRuntime({ navigate() {}, back() {}, openUrl() {}, restart() {} }, custom, doc.designSystem), [custom, doc.designSystem]);
  const registry = useMemo(() => createCjmRegistry(runtime.registry), [runtime.registry]);
  const customTypes = useMemo(() => new Set(Object.keys(custom?.definitions ?? {})), [custom]);
  const themeContent = useDesignSystemTheme(doc.designSystem, designSystemMetaVersion);
  const graph = useMemo(() => buildNavigationGraph(doc), [doc]);
  const layout = useMemo(() => computeCjmLanes(doc, graph), [doc, graph]);
  const routing = useMemo(() => computeLogicalEdgeRoutes(layout), [layout]);
  const screens = useMemo(() => new Map(doc.screens.map((screen) => [screen.id, screen])), [doc.screens]);
  const location = useLocation();
  // Голый routeBase редиректится на startScreen, и ScenarioBar удалил бы корректный step —
  // при валидной паре flow/step хром получает явный Player-URL экрана шага.
  const playerPath = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const flowId = params.get("flow");
    const step = params.get("step");
    if (flowId === null || step === null || !/^\d+$/.test(step)) return undefined;
    const screenId = doc.flows?.find((flow) => flow.id === flowId)?.steps[Number(step)]?.screenId;
    return screenId === undefined ? undefined : buildPlayerPath(routeBase, screenId);
  }, [doc.flows, location.search, routeBase]);
  const designSystemName = doc.designSystem;
  const metadata = <dl aria-label={cjm.metadataAria} className="flex flex-wrap items-center gap-2 font-eui-ui text-xs text-eui-slate-500">
    <div><dt className="sr-only">{cjm.screensLabel}</dt><dd className="rounded-full bg-eui-lilac-100 px-2.5 py-1">{cjm.screensCount(doc.screens.length)}</dd></div>
    {doc.flows ? <div><dt className="sr-only">{cjm.flowsLabel}</dt><dd className="rounded-full bg-eui-lilac-100 px-2.5 py-1">{cjm.flowsCount(doc.flows.length)}</dd></div> : null}
    <div><dt className="sr-only">{cjm.designSystemLabel}</dt><dd className="rounded-full bg-eui-lilac-100 px-2.5 py-1">{designSystemName}</dd></div>
  </dl>;
  const renderTile = (screenId: string, flowId?: string, stepIndex?: number, noteOverride?: string) => {
    const screen = screens.get(screenId);
    if (!screen) return null;
    return <CjmScreenTile doc={doc} screen={screen} registry={registry} handlers={runtime.handlers} runtimeKey={runtimeKey} routeBase={routeBase} customTypes={customTypes} customDefinitions={custom?.definitions} themeContent={themeContent} noteOverride={noteOverride} flowId={flowId} stepIndex={stepIndex} />;
  };
  // Единый хром /p/* (WF-4): навигация Плеер/Редактор живёт в сегментах хрома,
  // тело вью — только stage (описание + лента экранов).
  return <main className="cjm-root flex h-full min-h-0 flex-col">
    <ThemeStyle content={themeContent} />
    <PrototypeChrome prototypeId={doc.id} prototypeName={doc.name} view="cjm" version={version} playerPath={playerPath} status={metadata} />
    <div className="cjm-stage min-h-0 flex-1 overflow-y-auto bg-eui-lav p-6 sm:p-8">
      {doc.description ? <p className="mx-auto max-w-[1600px] font-eui-ui text-eui-slate-500">{doc.description}</p> : null}
      {layout.linear ? <ol className="cjm-list mx-auto mt-8 flex items-start gap-16 overflow-x-auto pb-8" aria-label={cjm.screensAria}>
      {doc.screens.map((screen, index) => <li className="relative shrink-0" key={screen.id} data-screen-id={screen.id}>
        {renderTile(screen.id)}
        {index < doc.screens.length - 1 ? <CjmConnector sourceScreenId={screen.id} targetScreenId={doc.screens[index + 1]!.id} /> : null}
      </li>)}
      </ol> : <>
        <div className="cjm-grid-scroll mt-8 overflow-x-auto pb-8">
          <div
            className="cjm-grid relative mx-auto grid w-max items-start"
            aria-label={cjm.lanesAria}
            style={{
              columnGap: routing.columnGap,
              rowGap: routing.rowGap,
              gridTemplateColumns: `minmax(12rem, 16rem) repeat(${layout.columns}, ${previewTileSizes[doc.device].width + 24}px)`,
            }}
          >
            <CjmEdgesOverlay layout={layout} routing={routing} />
            {layout.lanes.map((lane, laneIndex) => <div
              key={`${lane.key}:label`}
              className="cjm-lane-label sticky left-0 z-30 self-stretch bg-eui-lav py-3 pr-4 font-eui-ui"
              data-cjm-lane={laneIndex}
              data-testid="cjm-lane-label"
              style={{ gridColumn: 1, gridRow: laneIndex + 1 }}
            >
              <h2 className="font-semibold">{lane.name ?? cjm.mainLaneName}</h2>
              {lane.description ? <p className="mt-1 text-sm text-eui-slate-500">{lane.description}</p> : null}
            </div>)}
            {layout.lanes.flatMap((lane) => lane.nodes.map((node) => {
              const stepIndex = Number(node.key.slice(node.key.lastIndexOf(":") + 1));
              const flowId = lane.key.slice("flow:".length);
              return <div
                key={node.key}
                className="relative z-20"
                data-cjm-node={node.key}
                data-screen-id={node.screenId}
                style={{ gridColumn: node.column + 2, gridRow: node.lane + 1 }}
              >
                {renderTile(node.screenId, flowId, stepIndex, node.note)}
              </div>;
            }))}
          </div>
        </div>
        <div className="cjm-edge-legend mx-auto flex max-w-[1600px] flex-wrap gap-4 font-eui-ui text-xs" aria-label={cjm.legendAria}>
          <span><i className="cjm-legend-line" />{cjm.verifiedStatic}</span>
          <span><i className="cjm-legend-line" data-verified="dynamic" />{cjm.verifiedDynamic}</span>
          <span><i className="cjm-legend-line" data-verified="missing" />{cjm.verifiedMissing}</span>
        </div>
        <UnassignedLane layout={layout} tile={(screenId) => renderTile(screenId)} />
      </>}
    </div>
  </main>;
}
