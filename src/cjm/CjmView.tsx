import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { PrototypeChrome } from "../app/PrototypeChrome";
import { inset, panel, pillGhost, pillPrimary, segmentActive, segmentIdle, segmentTrack } from "../app/chrome";
// Загрузчик списка версий для ShareDialog переиспользуется как есть: W6 сливает
// шаринг в одно окно, и заводить здесь вторую копию загрузки было бы работой в стол.
import { GalleryShareDialog } from "../gallery/GalleryShareDialog";
import { buildPlayerPath } from "../player/navigation";
import { cjm, cjmDocumentTitle } from "../app/strings/cjm";
import { useDocumentTitle } from "../app/useDocumentTitle";
import type { CustomPlayerRuntime } from "../catalog/runtime";
import { createPlayerRuntime } from "../catalog/runtime";
import { ThemeStyle, useDesignSystemTheme } from "../designSystems/theme";
import { previewTileSizes } from "../designSystems/deviceMetrics";
import { buildNavigationGraph } from "../prototype/navigationGraph";
import type { PrototypeDoc } from "../prototype/schema";
import { CjmCounters } from "./CjmCounters";
import { CjmEdgesOverlay, computeLogicalEdgeRoutes } from "./CjmEdgesOverlay";
import { CjmScreenTile } from "./CjmScreenTile";
import { createCjmRegistry } from "./cjmRegistry";
import { LazyMount } from "./LazyMount";
import { ScenarioSheet } from "./ScenarioSheet";
import { computeCjmLanes, type CjmLayout } from "./lanesLayout";

/** Режим `/p/:id/cjm`: дефолт — «Сценарии», дорожки живут за `?view=lanes` (план §6.1). */
export type CjmViewMode = "scenarios" | "lanes";

const readViewMode = (search: string): CjmViewMode => new URLSearchParams(search).get("view") === "lanes" ? "lanes" : "scenarios";

/** Ссылка режима: остальные параметры (`flow`/`step`) сохраняются как есть. */
function viewSearch(search: string, mode: CjmViewMode): string {
  const params = new URLSearchParams(search);
  if (mode === "lanes") params.set("view", "lanes");
  else params.delete("view");
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

/** Презентация не знает про сценарии и режим разбора: срезаем `flow`/`step`/`view`. */
function presentSearch(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of ["flow", "step", "view"]) params.delete(key);
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

/**
 * Переключатель режима разбора. Живёт в канве над рядом счётчиков, а не в actions
 * хрома (план 2026-07-31, S1): здесь известен `layout.linear`, и контракт §6.1
 * («на линейном документе переключателя нет») выражается местом рендера.
 */
function ViewSwitch({ mode, search }: { mode: CjmViewMode; search: string }) {
  return <nav aria-label={cjm.viewSwitchAria} className={segmentTrack}>
    {([["scenarios", cjm.viewScenarios], ["lanes", cjm.viewLanes]] as const).map(([id, label]) => <Link
      key={id}
      to={{ search: viewSearch(search, id) }}
      replace
      aria-current={mode === id ? "page" : undefined}
      data-cjm-view={id}
      className={mode === id ? segmentActive : segmentIdle}
    >{label}</Link>)}
  </nav>;
}

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
      <path data-testid="cjm-connector-line" d={`M0 ${geometry.sourceY} L${geometry.width} ${geometry.targetY}`} stroke="#2D083A" strokeWidth="2.5" strokeLinecap="round" />
      <path d={`M${geometry.width - 8} ${geometry.targetY - 7} L${geometry.width} ${geometry.targetY} L${geometry.width - 8} ${geometry.targetY + 7}`} stroke="#2D083A" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>}
  </>;
}

/** Батчинг по 20 снят (T2a): единственный механизм стоимости — IntersectionObserver в `LazyMount`. */
function UnassignedLane({ layout, tile, placeholder }: { layout: CjmLayout; tile: (screenId: string) => React.ReactNode; placeholder: { width: number; height: number } }) {
  const [open, setOpen] = useState(false);
  if (!layout.unassigned.length) return null;
  return <section className={`cjm-unassigned mx-auto mt-5 max-w-[1600px] ${inset} p-4`}>
    <button
      type="button"
      className="text-[13px] font-medium text-eui-ink"
      aria-expanded={open}
      onClick={() => setOpen((current) => !current)}
    >
      {cjm.unassignedCount(layout.unassigned.length)}
    </button>
    {open ? <div className="mt-4 flex items-start gap-6 overflow-x-auto pb-4" aria-label={cjm.unassignedAria}>
      {layout.unassigned.map((screenId) => <LazyMount
        key={screenId}
        className="shrink-0"
        data-screen-id={screenId}
        placeholderHeight={placeholder.height}
        placeholderWidth={placeholder.width}
      >{tile(screenId)}</LazyMount>)}
    </div> : null}
  </section>;
}

export function CjmView({ doc, custom, runtimeKey, routeBase, version, designSystemMetaVersion }: { doc: PrototypeDoc; custom?: CustomPlayerRuntime; runtimeKey: string; routeBase: string; version?: number; designSystemMetaVersion?: number | null }) {
  useDocumentTitle(cjmDocumentTitle(doc.name, version));
  const [shareOpen, setShareOpen] = useState(false);
  const runtime = useMemo(() => createPlayerRuntime({ navigate() {}, back() {}, openUrl() {}, restart() {} }, custom, doc.designSystem), [custom, doc.designSystem]);
  const registry = useMemo(() => createCjmRegistry(runtime.registry), [runtime.registry]);
  const customTypes = useMemo(() => new Set(Object.keys(custom?.definitions ?? {})), [custom]);
  const themeContent = useDesignSystemTheme(doc.designSystem, designSystemMetaVersion);
  const graph = useMemo(() => buildNavigationGraph(doc), [doc]);
  const layout = useMemo(() => computeCjmLanes(doc, graph), [doc, graph]);
  const routing = useMemo(() => computeLogicalEdgeRoutes(layout), [layout]);
  const screens = useMemo(() => new Map(doc.screens.map((screen) => [screen.id, screen])), [doc.screens]);
  const location = useLocation();
  // Контракт §6.1: на линейном документе (без `doc.flows` — сегодня это весь прод)
  // дефолтный режим показывает ту же ленту экранов, а переключатель скрыт.
  const mode = layout.linear ? "scenarios" : readViewMode(location.search);
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
  // Крошка хрома получает третий уровень — активный сценарий. Источник истины здесь
  // URL (`?flow=`), а не скролл простыни: крошка — это адрес, и она не должна мигать
  // при каждом проезде секции. Ссылки «Скопировать ссылку» и возврат из плеера
  // приходят именно с `?flow=`.
  const scenarioName = useMemo(() => {
    const flowId = new URLSearchParams(location.search).get("flow");
    return flowId === null ? undefined : doc.flows?.find((flow) => flow.id === flowId)?.name;
  }, [doc.flows, location.search]);
  // Плейсхолдер ленивой обёртки = стартовые габариты самого тайла (`CjmFrame`),
  // поэтому монтирование не двигает геометрию грида и рёбер.
  const placeholder = useMemo(() => ({ width: previewTileSizes[doc.device].width + 24, height: previewTileSizes[doc.device].fallbackHeight }), [doc.device]);
  // Чипы-дубли метаданных сняты (план 2026-07-31, W1-4): те же числа живут в ряду
  // счётчиков, а хром отдан действиям. Презентация подписана явно — она срезает
  // `flow`/`step`, и подпись «без сценария» запрещает тихую потерю контекста.
  const actions = <>
    <button type="button" className={pillGhost} onClick={() => setShareOpen(true)}>{cjm.share}</button>
    <Link className={pillPrimary} to={`${routeBase}/present${presentSearch(location.search)}`}>{cjm.present}</Link>
  </>;
  const renderTile = (screenId: string, flowId?: string, stepIndex?: number, noteOverride?: string, variant?: "full" | "sheet" | "stage", onOpen?: () => void) => {
    const screen = screens.get(screenId);
    if (!screen) return null;
    return <CjmScreenTile doc={doc} screen={screen} registry={registry} handlers={runtime.handlers} runtimeKey={runtimeKey} routeBase={routeBase} customTypes={customTypes} customDefinitions={custom?.definitions} themeContent={themeContent} noteOverride={noteOverride} flowId={flowId} stepIndex={stepIndex} variant={variant} onOpen={onOpen} />;
  };
  // Единый хром /p/* (WF-4): навигация Плеер/Редактор живёт в сегментах хрома,
  // тело вью — только stage (шапка канвы + лента экранов).
  return <main className="cjm-root flex h-full min-h-0 flex-col">
    <ThemeStyle content={themeContent} />
    <PrototypeChrome prototypeId={doc.id} prototypeName={doc.name} view="cjm" version={version} playerPath={playerPath} scenarioName={scenarioName} actions={actions} />
    <div className="cjm-stage min-h-0 flex-1 overflow-y-auto bg-pay-lavender p-5 font-pay-text">
      {/* Описание — одна строка: длинный текст читается по title, а шапка канвы
          не отжимает счётчики вниз (план 2026-07-31, m1(ux)). */}
      {doc.description ? <p title={doc.description} className="mx-auto mb-5 line-clamp-1 max-w-[1600px] text-eui-slate-500">{doc.description}</p> : null}
      {layout.linear ? null : <div className="mx-auto mb-5 flex max-w-[1600px] items-center">
        <ViewSwitch mode={mode} search={location.search} />
      </div>}
      {/* Счётчики — общая шапка обоих режимов: сюда переехали числа из снятых
          чипов хрома, поэтому ряд рендерится и на линейном документе. */}
      <CjmCounters doc={doc} graph={graph} />
      {layout.linear ? <ol className="cjm-list mx-auto mt-8 flex items-start gap-16 overflow-x-auto pb-8" aria-label={cjm.screensAria}>
      {doc.screens.map((screen, index) => <li className="relative shrink-0" key={screen.id} data-screen-id={screen.id}>
        <LazyMount placeholderHeight={placeholder.height} placeholderWidth={placeholder.width}>{renderTile(screen.id)}</LazyMount>
        {index < doc.screens.length - 1 ? <CjmConnector sourceScreenId={screen.id} targetScreenId={doc.screens[index + 1]!.id} /> : null}
      </li>)}
      </ol> : mode === "scenarios" ? <div data-cjm-mode="scenarios" className="mt-5 flex flex-col gap-5">
        <ScenarioSheet
          doc={doc}
          graph={graph}
          routeBase={routeBase}
          renderTile={(screenId, flowId, stepIndex, noteOverride, onOpen) => renderTile(screenId, flowId, stepIndex, noteOverride, "sheet", onOpen)}
          renderStage={(screenId) => renderTile(screenId, undefined, undefined, undefined, "stage")}
        />
      </div> : <>
        <div className={`cjm-grid-scroll ${panel} mt-5 overflow-x-auto p-5`}>
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
              className="cjm-lane-label sticky left-0 z-30 self-stretch bg-white py-3 pr-4"
              data-cjm-lane={laneIndex}
              data-testid="cjm-lane-label"
              style={{ gridColumn: 1, gridRow: laneIndex + 1 }}
            >
              <h2 className="text-sm font-medium text-eui-ink">{lane.name ?? cjm.mainLaneName}</h2>
              {lane.description ? <p className="mt-1 text-xs text-eui-slate-500">{lane.description}</p> : null}
            </div>)}
            {layout.lanes.flatMap((lane) => lane.nodes.map((node) => {
              const stepIndex = Number(node.key.slice(node.key.lastIndexOf(":") + 1));
              const flowId = lane.key.slice("flow:".length);
              return <LazyMount
                key={node.key}
                className="relative z-20"
                data-cjm-node={node.key}
                data-screen-id={node.screenId}
                placeholderHeight={placeholder.height}
                placeholderWidth={placeholder.width}
                style={{ gridColumn: node.column + 2, gridRow: node.lane + 1 }}
              >
                {renderTile(node.screenId, flowId, stepIndex, node.note)}
              </LazyMount>;
            }))}
          </div>
        </div>
        <div className="cjm-edge-legend mx-auto mt-4 flex max-w-[1600px] flex-wrap items-center gap-4 text-xs text-eui-slate-500" aria-label={cjm.legendAria}>
          <span><i className="cjm-legend-line" />{cjm.verifiedStatic}</span>
          <span><i className="cjm-legend-line" data-verified="dynamic" />{cjm.verifiedDynamic}</span>
          <span><i className="cjm-legend-line" data-verified="missing" />{cjm.verifiedMissing}</span>
          <button type="button" className={`${pillGhost} ml-auto px-3 py-1.5 text-xs`} onClick={() => window.print()}>{cjm.print}</button>
        </div>
        <UnassignedLane layout={layout} tile={(screenId) => renderTile(screenId)} placeholder={placeholder} />
      </>}
    </div>
    {/* В draft-контексте версии нет: 0 не совпадёт ни с одной опубликованной,
        и диалог выберет последнюю — ровно то поведение, что нужно. */}
    {shareOpen ? <GalleryShareDialog prototypeId={doc.id} latestVersion={version ?? 0} onClose={() => setShareOpen(false)} /> : null}
  </main>;
}
