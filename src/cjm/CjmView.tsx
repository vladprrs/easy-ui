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
import { lanesTile, previewTileSizes } from "../designSystems/deviceMetrics";
import { buildNavigationGraph, type EdgeVerification } from "../prototype/navigationGraph";
import type { PrototypeDoc } from "../prototype/schema";
import { CjmCounters } from "./CjmCounters";
import { CjmEdgesOverlay, computeLogicalEdgeRoutes, edgeArrowClass } from "./CjmEdgesOverlay";
import { CjmScreenTile } from "./CjmScreenTile";
import { ConnectivityLegend } from "./ConnectivityLegend";
import { createCjmRegistry } from "./cjmRegistry";
import { LazyMount } from "./LazyMount";
import { ScenarioSheet } from "./ScenarioSheet";
import { computeCjmLanes, type CjmLaneOrigin, type CjmLayout } from "./lanesLayout";

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

/**
 * Connects the measured centers of two adjacent tiles.
 *
 * Ребро линейной ленты — такой же переход между экранами, что и в дорожках, поэтому
 * говорит на общем языке связности (план 2026-07-31, W3-7): цвет линии и форма
 * наконечника из `ConnectivityLegend`, а не жёсткий `#2D083A`. Раньше один смысл
 * кодировался в двух режимах двумя разными способами.
 */
function CjmConnector({ sourceScreenId, targetScreenId, verified }: { sourceScreenId: string; targetScreenId: string; verified: EdgeVerification }) {
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
      data-verified={verified}
      data-testid="cjm-connector"
      style={{ left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height }}
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      fill="none"
    >
      <path className="cjm-flow-edge" data-testid="cjm-connector-line" d={`M0 ${geometry.sourceY} L${geometry.width} ${geometry.targetY}`} />
      <path className={edgeArrowClass(verified)} d={`M${geometry.width - 8} ${geometry.targetY - 7} L${geometry.width} ${geometry.targetY} L${geometry.width - 8} ${geometry.targetY + 7} Z`} />
    </svg>}
  </>;
}

/**
 * Экраны, не попавшие ни в один сценарий.
 *
 * Плашка статична и живёт в общей части обоих режимов (план 2026-07-31, W2-6):
 * непокрытые экраны — тот самый показатель, ради которого разбор и открывают, и
 * прятать его за раскрытием (да ещё только в дорожках) значило прятать вывод.
 * Стоимость держит `LazyMount`: батчинг по 20 снят ещё в T2a, единственный
 * механизм — IntersectionObserver.
 *
 * Тайлы здесь компактные (`lane`): плашка стоит над картой, и полноразмерная лента
 * на документе с десятками непокрытых экранов уводила бы сам разбор за нижний край
 * окна — вывод остался бы виден, а предмет разговора нет.
 */
function UnassignedLane({ layout, tile, placeholder }: { layout: CjmLayout; tile: (screenId: string) => React.ReactNode; placeholder: { width: number; height: number } }) {
  if (!layout.unassigned.length) return null;
  return <section className={`cjm-unassigned mx-auto mt-5 max-w-[1600px] ${inset} p-4`}>
    <h2 className="text-[13px] font-medium text-eui-ink">{cjm.unassignedCount(layout.unassigned.length)}</h2>
    <div className="mt-4 flex items-start gap-5 overflow-x-auto pb-4" aria-label={cjm.unassignedAria}>
      {layout.unassigned.map((screenId) => <LazyMount
        key={screenId}
        className="shrink-0"
        data-screen-id={screenId}
        placeholderHeight={placeholder.height}
        placeholderWidth={placeholder.width}
      >{tile(screenId)}</LazyMount>)}
    </div>
  </section>;
}

/** Служебная подпись дорожки: как ветка соотносится с главной линией (W3-3). */
function laneOriginLabel(origin: CjmLaneOrigin): string {
  if (origin.kind === "fork") return cjm.laneForkAfter(origin.step);
  if (origin.kind === "merge") return cjm.laneMergeBefore(origin.step);
  return cjm.laneDetached;
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
  // поэтому монтирование не двигает геометрию грида и рёбер. Габарит зависит от
  // режима: в дорожках тайл — `lanesTile` (план 2026-07-31, M4), и плейсхолдер по
  // `previewTileSizes` двигал бы колонки на каждом lazy-mount, а `CjmEdgesOverlay`
  // считал бы pitch по чужому rect.
  const placeholder = useMemo(() => ({ width: previewTileSizes[doc.device].width + 24, height: previewTileSizes[doc.device].fallbackHeight }), [doc.device]);
  const lanePlaceholder = { width: lanesTile.width, height: lanesTile.fallbackHeight };
  // Чипы-дубли метаданных сняты (план 2026-07-31, W1-4): те же числа живут в ряду
  // счётчиков, а хром отдан действиям. Презентация подписана явно — она срезает
  // `flow`/`step`, и подпись «без сценария» запрещает тихую потерю контекста.
  const actions = <>
    <button type="button" className={pillGhost} onClick={() => setShareOpen(true)}>{cjm.share}</button>
    <Link className={pillPrimary} to={`${routeBase}/present${presentSearch(location.search)}`}>{cjm.present}</Link>
  </>;
  const renderTile = (screenId: string, flowId?: string, stepIndex?: number, noteOverride?: string, variant?: "full" | "sheet" | "stage" | "lane", onOpen?: () => void) => {
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
      {/* Тулбар канвы: режим разбора, легенда связности и печать. Легенда здесь
          только в дорожках — в режиме «Сценарии» её рендерит сама простыня рядом
          с метками шагов (S3), и вторая копия была бы шумом. */}
      <div className="cjm-canvas-toolbar mx-auto mb-5 flex max-w-[1600px] flex-wrap items-center gap-4">
        {layout.linear ? null : <ViewSwitch mode={mode} search={location.search} />}
        {mode === "lanes" && !layout.linear ? <ConnectivityLegend /> : null}
        <button type="button" className={`${pillGhost} ml-auto px-3 py-1.5 text-xs`} onClick={() => window.print()}>{cjm.print}</button>
      </div>
      {/* Счётчики — общая шапка обоих режимов: сюда переехали числа из снятых
          чипов хрома, поэтому ряд рендерится и на линейном документе. */}
      <CjmCounters doc={doc} graph={graph} />
      {/* Непокрытые экраны — общая часть обоих режимов (W2-6). На линейном документе
          `unassigned` всегда пуст, и секция сама себя не рендерит. */}
      <UnassignedLane layout={layout} tile={(screenId) => renderTile(screenId, undefined, undefined, undefined, "lane")} placeholder={lanePlaceholder} />
      {layout.linear ? <section className="mx-auto mt-8 max-w-[1600px]">
        {/* Сегодня это 100 % прода: у документа нет `flows`, и лента экранов — не
            «сценарий», а просто порядок документа. Заголовок и пояснение говорят это
            прямо; CTA нет, потому что UI-правки `flows` не существует (m3(ux)). */}
        <h2 className="text-xl font-medium text-eui-ink">{cjm.sheetEmptyTitle}</h2>
        <p className="mt-1 max-w-[80ch] text-[13px] text-eui-slate-500">{cjm.sheetEmptyBody}</p>
        <ol className="cjm-list mt-5 flex items-start gap-16 overflow-x-auto pb-8" aria-label={cjm.screensAria}>
          {doc.screens.map((screen, index) => <li className="relative shrink-0" key={screen.id} data-screen-id={screen.id}>
            <LazyMount placeholderHeight={placeholder.height} placeholderWidth={placeholder.width}>{renderTile(screen.id)}</LazyMount>
            {index < doc.screens.length - 1 ? <CjmConnector
              sourceScreenId={screen.id}
              targetScreenId={doc.screens[index + 1]!.id}
              verified={layout.edges[index]?.verified ?? "missing"}
            /> : null}
          </li>)}
        </ol>
        {/* Клик по кадру ничем не обозначен — подпись одна на ленту, а не под каждым тайлом. */}
        <p className="text-[11px] text-eui-slate-500">{cjm.laneTileHint}</p>
      </section> : mode === "scenarios" ? <div data-cjm-mode="scenarios" className="mt-5 flex flex-col gap-5">
        <ScenarioSheet
          doc={doc}
          graph={graph}
          routeBase={routeBase}
          renderTile={(screenId, flowId, stepIndex, noteOverride, onOpen) => renderTile(screenId, flowId, stepIndex, noteOverride, "sheet", onOpen)}
          renderStage={(screenId) => renderTile(screenId, undefined, undefined, undefined, "stage")}
        />
      </div> : <div className="mt-5">
        <div className={`cjm-grid-scroll ${panel} overflow-x-auto p-5`}>
          <div
            className="cjm-grid relative mx-auto grid w-max items-start"
            aria-label={cjm.lanesAria}
            style={{
              columnGap: routing.columnGap,
              rowGap: routing.rowGap,
              // Шаг колонки = ширина тайла + `routing.columnGap`. Жёстких 146px тут
              // быть не может: `columnGap = 40 + 8×каналов` — часть роутинга рёбер,
              // и `CjmEdgesOverlay` разводит каналы по ±8px внутри этого же гаттера
              // (план 2026-07-31, B3). Лейбл дорожки — фиксированные 150px.
              gridTemplateColumns: `150px repeat(${layout.columns}, ${lanesTile.width}px)`,
            }}
          >
            <CjmEdgesOverlay layout={layout} routing={routing} />
            {layout.lanes.map((lane, laneIndex) => <div
              key={`${lane.key}:label`}
              // `-left-5`/`-ml-5` — ширина паддинга скролл-панели: без них при
              // горизонтальном скролле тайлы просвечивали в 20px слева от лейбла.
              // Отрицательный sticky-офсет равен натуральной позиции, поэтому в
              // покое лейбл не сдвигается.
              className="cjm-lane-label sticky -left-5 z-30 -ml-5 self-stretch bg-white py-3 pr-4 pl-5"
              data-cjm-lane={laneIndex}
              data-testid="cjm-lane-label"
              style={{ gridColumn: 1, gridRow: laneIndex + 1 }}
            >
              <h2 className="text-sm font-medium text-eui-ink">{lane.name ?? cjm.mainLaneName}</h2>
              {/* Подпись служебная: авторское `flow.description` — про смысл сценария,
                  и в дорожках оно повторяло текст простыни, ничего не говоря о том,
                  где ветка отходит от главной линии (W3-3). */}
              {lane.origin ? <p className="mt-1 text-xs text-eui-slate-500">{laneOriginLabel(lane.origin)}</p> : null}
            </div>)}
            {layout.lanes.flatMap((lane) => lane.nodes.map((node) => {
              const stepIndex = Number(node.key.slice(node.key.lastIndexOf(":") + 1));
              const flowId = lane.key.slice("flow:".length);
              return <LazyMount
                key={node.key}
                className="relative z-20"
                data-cjm-node={node.key}
                data-screen-id={node.screenId}
                placeholderHeight={lanePlaceholder.height}
                placeholderWidth={lanePlaceholder.width}
                style={{ gridColumn: node.column + 2, gridRow: node.lane + 1 }}
              >
                {renderTile(node.screenId, flowId, stepIndex, node.note, "lane")}
              </LazyMount>;
            }))}
          </div>
        </div>
        {/* Одна подпись на всю карту, а не под каждым из сотен тайлов. */}
        <p className="mt-3 text-[11px] text-eui-slate-500">{cjm.laneTileHint}</p>
      </div>}
    </div>
    {/* В draft-контексте версии нет: 0 не совпадёт ни с одной опубликованной,
        и диалог выберет последнюю — ровно то поведение, что нужно. */}
    {shareOpen ? <GalleryShareDialog prototypeId={doc.id} latestVersion={version ?? 0} onClose={() => setShareOpen(false)} /> : null}
  </main>;
}
