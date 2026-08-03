import { useMemo, type ReactNode } from "react";
import type { ThemeContent } from "../api/client";
import type { ComponentDefinition } from "../catalog/definitions";
import type { createPlayerRuntime } from "../catalog/runtime";
import type { PrototypeDoc, Surface } from "../prototype/schema";
import { toRuntimeSpec } from "../prototype/runtimeSpec";
import { docSurfaces } from "../prototype/surfaces";
import { player } from "../app/strings/player";
import type { EasyUiActionRuntime } from "./actionRuntime";
import { DeviceFrame, type StageZoom } from "./DeviceFrame";
import { FluidStage } from "./FluidStage";
import { ScreenSurface, type InteractiveZonesOptions } from "./ScreenSurface";
import { ScreenErrorBoundary } from "./ScreenView";

/**
 * Дуо-сцена плеера (план `docs/plans/2026-08-02-multi-surface-flows.md`, D10–D11).
 *
 * По одному стейджу на поверхность документа: горизонтальная пара панелей в плеере и
 * презентации на десктопе (`layout="row"`), одна видимая панель на телефоне
 * (`layout="focused"`). **Все поверхности всегда смонтированы** — скрытая панель
 * получает `display: none`, а не размонтирование: на её таймерах и эффектах держатся
 * внутренние состояния второй поверхности (D11), ради которых фича и делается.
 *
 * Сцена не владеет ни стором, ни рантаймом действий: они общие на сессию и приходят
 * пропами — КСО пишет `/order/status`, экран приложения читает его тем же снапшотом.
 */

/** Презентация вписывает панель во вьюпорт: собственных зум-контролов у неё нет. */
const fitZoom: StageZoom = { mode: "fit", zoom: 1 };

export interface DuoStageProps {
  doc: PrototypeDoc;
  /** Карта «поверхность → экран» из URL (`usePlayerNavigation().screenBySurface`). */
  screenBySurface: Readonly<Record<string, string>>;
  focusedSurfaceId: string;
  /** Перенос фокуса по клику на заголовок панели. */
  onFocusSurface: (surfaceId: string) => void;
  registry: ReturnType<typeof createPlayerRuntime>["registry"];
  runtime: EasyUiActionRuntime;
  customDefinitions: Record<string, ComponentDefinition>;
  customTypes: ReadonlySet<string>;
  onError: (message: string, detail?: Record<string, unknown>) => void;
  designSystem: string;
  themeTokens?: ThemeContent["tokens"] | undefined;
  statusBarHidden: boolean;
  restart: () => void;
  /** Ручной зум применяется к сфокусированной панели; остальные всегда вписаны (D10). */
  zoom?: StageZoom | undefined;
  onEffectiveScale?: ((scale: number) => void) | undefined;
  misclickHighlights?: boolean;
  interactiveZones?: InteractiveZonesOptions | undefined;
  /** `frame` — рамка устройства (плеер, десктопная презентация), `fluid` — телефон. */
  stage?: "frame" | "fluid";
  layout?: "row" | "focused";
}

export function DuoStage({
  doc,
  screenBySurface,
  focusedSurfaceId,
  onFocusSurface,
  registry,
  runtime,
  customDefinitions,
  customTypes,
  onError,
  designSystem,
  themeTokens,
  statusBarHidden,
  restart,
  zoom,
  onEffectiveScale,
  misclickHighlights = false,
  interactiveZones,
  stage = "frame",
  layout = "row",
}: DuoStageProps) {
  const surfaces = docSurfaces(doc);
  return <div data-testid="duo-stage" className="flex min-h-0 min-w-0 flex-1 items-stretch">
    {surfaces.map((surface) => {
      const focused = surface.id === focusedSurfaceId;
      const visible = layout === "row" || focused;
      return <SurfacePanel
        key={surface.id}
        doc={doc}
        surface={surface}
        screenId={screenBySurface[surface.id] ?? surface.startScreen}
        focused={focused}
        visible={visible}
        showHeader={layout === "row"}
        onFocusSurface={onFocusSurface}
        registry={registry}
        runtime={runtime}
        customDefinitions={customDefinitions}
        customTypes={customTypes}
        onError={onError}
        designSystem={designSystem}
        themeTokens={themeTokens}
        statusBarHidden={statusBarHidden}
        restart={restart}
        zoom={focused ? (zoom ?? fitZoom) : fitZoom}
        onEffectiveScale={focused ? onEffectiveScale : undefined}
        misclickHighlights={misclickHighlights}
        interactiveZones={focused ? interactiveZones : undefined}
        stage={stage}
      />;
    })}
  </div>;
}

interface SurfacePanelProps extends Omit<DuoStageProps, "screenBySurface" | "focusedSurfaceId" | "layout"> {
  surface: Surface;
  screenId: string;
  focused: boolean;
  visible: boolean;
  showHeader: boolean;
}

/** Заголовок панели: имя поверхности и перенос фокуса на неё. */
const panelHeader = "flex items-center gap-2 rounded-full px-3 py-1 text-[13px] font-medium transition-colors duration-100";

function SurfacePanel({
  doc,
  surface,
  screenId,
  focused,
  visible,
  showHeader,
  onFocusSurface,
  registry,
  runtime,
  customDefinitions,
  customTypes,
  onError,
  designSystem,
  themeTokens,
  statusBarHidden,
  restart,
  zoom,
  onEffectiveScale,
  misclickHighlights = false,
  interactiveZones,
  stage = "frame",
}: SurfacePanelProps) {
  const screen = doc.screens.find((item) => item.id === screenId);
  const spec = screen?.spec;
  // customTypes — стабильный Set загрузчика: дерево пересобирается вместе со спекой.
  const tree = useMemo(() => (spec ? toRuntimeSpec(spec, { customTypes }) : null), [spec, customTypes]);
  // D10: примитивы хоста (Overlay/Hotspot) разрешены по устройству **поверхности** экрана,
  // а не по `doc.device` — на дуо-доке это разные значения.
  const hostPrimitivesAllowed = surface.device !== "desktop" || screen?.canvas !== undefined;

  const content: ReactNode = screen && tree
    ? <ScreenErrorBoundary key={screen.id} prototypeId={doc.id} screenId={screen.id} restart={restart}>
        <ScreenSurface
          registry={registry}
          runtime={runtime}
          customDefinitions={customDefinitions}
          onError={onError}
          tree={tree}
          surfaceId={surface.id}
          canvas={screen.canvas}
          misclickHighlights={misclickHighlights}
          hostPrimitivesAllowed={hostPrimitivesAllowed}
          interactiveZones={interactiveZones}
        />
      </ScreenErrorBoundary>
    : <p role="status" className="p-6 text-sm text-eui-slate-500">{player.screenMissingTitle}</p>;

  const body = stage === "fluid"
    ? <FluidStage canvas={screen?.canvas} designSystem={designSystem} themeTokens={themeTokens} resetKey={screen?.id}>{content}</FluidStage>
    : <DeviceFrame
        device={surface.device}
        canvas={screen?.canvas}
        zoom={zoom ?? fitZoom}
        onEffectiveScale={onEffectiveScale}
        designSystem={designSystem}
        themeTokens={themeTokens}
        statusBarHidden={statusBarHidden}
        scrollResetKey={screen?.id}
      >{content}</DeviceFrame>;

  return <section
    data-testid="surface-panel"
    data-surface={surface.id}
    data-focused={focused ? "true" : "false"}
    aria-label={surface.name}
    // Скрытая панель остаётся в дереве (D11): `display: none` вместо размонтирования.
    className={visible
      ? `flex min-h-0 min-w-0 flex-1 flex-col ${focused ? "outline outline-2 -outline-offset-2 outline-pay-red" : ""}`
      : "hidden"}
  >
    {showHeader ? <div className="flex shrink-0 items-center justify-center px-2 pt-2">
      <button
        type="button"
        aria-pressed={focused}
        onClick={() => onFocusSurface(surface.id)}
        className={`${panelHeader} ${focused ? "bg-pay-deep text-white" : "bg-white text-eui-slate-700 hover:bg-pay-lavender-tint"}`}
      >{surface.name}</button>
    </div> : null}
    {body}
  </section>;
}
