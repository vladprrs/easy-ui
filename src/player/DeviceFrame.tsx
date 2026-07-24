import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ThemeContent } from "../api/client";
import { HostStageSurface } from "../catalog/hostPrimitives";
import type { PrototypeDoc } from "../prototype/schema";
import { player } from "../app/strings/player";
import { canonicalViewport, playerDesktopMinStageHeight } from "../designSystems/deviceMetrics";
import { SurfaceSpacingScope } from "../designSystems/SurfaceSpacingScope";
import { RegionStage } from "./RegionStage";
import { ScreenRegionsProvider } from "./ScreenRegions";

type Device = PrototypeDoc["device"];

/** Внутренний отступ stage-вьюпорта вокруг фрейма (px, с каждой стороны). */
const stagePadding = 24;
/** Мультипликативный шаг кнопок ±. */
const zoomStep = 1.25;
const zoomLimits = { min: 0.25, max: 4 } as const;
const clampZoom = (zoom: number) => Math.min(zoomLimits.max, Math.max(zoomLimits.min, zoom));

/**
 * Состояние масштаба stage (W1-1). «fit» — вписать во вьюпорт
 * (`scale = min(1, availW/w, availH/h)`), «manual» — фиксированный zoom
 * (1 = «100%», контент скроллится внутри stage).
 */
export interface StageZoom {
  mode: "fit" | "manual";
  /** Действует только в mode="manual". */
  zoom: number;
}

/** Контроллер масштаба: состояние + команды для контролов в actions-слоте хрома. */
export interface StageZoomController {
  value: StageZoom;
  /** Фактический применённый scale (в fit-режиме — вычисленный DeviceFrame). */
  effectiveScale: number;
  fit: () => void;
  actualSize: () => void;
  toggleFitActual: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  /** Обратный канал DeviceFrame → контроллер: фактический scale после вычисления. */
  onEffectiveScale: (scale: number) => void;
}

export function useStageZoom(): StageZoomController {
  const [value, setValue] = useState<StageZoom>({ mode: "fit", zoom: 1 });
  const [effectiveScale, setEffectiveScale] = useState(1);
  const scaleRef = useRef(1);
  const onEffectiveScale = useCallback((scale: number) => {
    scaleRef.current = scale;
    setEffectiveScale(scale);
  }, []);
  const zoomBy = useCallback((factor: number) => {
    setValue((prev) => ({
      mode: "manual",
      zoom: clampZoom((prev.mode === "fit" ? scaleRef.current : prev.zoom) * factor),
    }));
  }, []);
  const fit = useCallback(() => setValue({ mode: "fit", zoom: 1 }), []);
  const actualSize = useCallback(() => setValue({ mode: "manual", zoom: 1 }), []);
  const toggleFitActual = useCallback(() => setValue((prev) => prev.mode === "fit"
    ? { mode: "manual", zoom: 1 }
    : { mode: "fit", zoom: 1 }), []);
  const zoomIn = useCallback(() => zoomBy(zoomStep), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(1 / zoomStep), [zoomBy]);
  return { value, effectiveScale, fit, actualSize, toggleFitActual, zoomIn, zoomOut, onEffectiveScale };
}

const hotkeyInteractiveSelector = "input, textarea, select, button, a, [contenteditable]:not([contenteditable=\"false\"])";

/** Общий гейт хоткеев для плеера и презентации, включая shadow/composed tree. */
export function isPlayerHotkeyEvent(event: KeyboardEvent) {
  if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return false;
  const isInteractive = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest(hotkeyInteractiveSelector));
  if (event.composedPath().some(isInteractive)) return false;
  return !isInteractive(document.activeElement);
}

export function isPlayerHelpHotkey(event: KeyboardEvent) {
  return event.key === "?" || (event.code === "Slash" && event.shiftKey);
}

const frameCard = "overflow-hidden bg-background text-foreground shadow-[0_20px_60px_rgba(2,2,5,0.35)]";

/**
 * Stage плеера (W1-1). Стабильный stage-вьюпорт занимает всю высоту под хромом;
 * фрейм с фиксированным viewport (mobile/tablet или canvas-экран) рендерится в
 * scaled-обёртке: внешний контейнер размером `w×scale / h×scale`, transformed-inner
 * с `transform: scale()`. Размер обёртки считается от scale (не наоборот) —
 * ResizeObserver наблюдает только сам stage-вьюпорт (overflow-hidden, на его
 * размер scale не влияет), фидбэк-лупа нет.
 *
 * Габариты фрейма (до scale) — всегда телефонной длины: у устройств с
 * каноническим viewport высота фрейма **всегда каноническая** (mobile 844,
 * tablet 1112), ширина — авторская (`canvas.width`) или каноническая. Desktop —
 * fluid-ветка (auto-height, min-height из `playerDesktopMinStageHeight`).
 *
 * Внутри фрейма — телефонная сцена регионов:
 * - **no-canvas** (mobile/tablet): {@link RegionStage} извлекает header/footer
 *   (и statusBar по `statusBarHidden`) в пиннед-слоты, контент скроллится в
 *   `player-stage`, Overlay заякорен на вьюпорт фрейма и не уезжает при скролле;
 * - **canvas**: вертикальный скроллер `player-canvas` с canvas-размерным div
 *   (`stageHost`, якорь Overlay, скроллится вместе с canvas);
 * - **desktop-fluid**: минимальный провайдер регионов (`statusBar` по тумблеру,
 *   header/footer inline) — тумблер статусбара сохраняет смысл.
 */
export function DeviceFrame({ device, canvas, zoom, onEffectiveScale, designSystem, themeTokens, statusBarHidden, scrollResetKey, children }: {
  device: Device;
  canvas?: { width: number; height: number } | undefined;
  zoom: StageZoom;
  onEffectiveScale?: ((scale: number) => void) | undefined;
  designSystem: string;
  themeTokens?: ThemeContent["tokens"] | undefined;
  /** Тумблер «скрыть статус-бар»: `true` → statusBar `drop`, `false` → `extract`. */
  statusBarHidden: boolean;
  /** Смена ключа сбрасывает внутренний скролл сцены в 0 (навигация/Back). */
  scrollResetKey?: string | undefined;
  children: ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [stageHost, setStageHost] = useState<HTMLDivElement | null>(null);
  const stageHostRef = useMemo(() => ({ current: stageHost }), [stageHost]);
  const [avail, setAvail] = useState<{ width: number; height: number } | null>(null);
  const canvasScrollerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setAvail({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  // Canvas-скроллер сбрасывается на верх при навигации/Back (no-canvas сцена — сама
  // в RegionStage; desktop-fluid без внутреннего скроллера).
  useLayoutEffect(() => {
    const scroller = canvasScrollerRef.current;
    if (!scroller) return;
    scroller.scrollTop = 0;
    scroller.scrollLeft = 0;
  }, [scrollResetKey]);

  const frame = canonicalViewport[device];
  // Фрейм — всегда телефонной длины: каноническая высота (844/1112) для устройств с
  // viewport, иначе (desktop+canvas) — высота canvas. Ширина — авторская либо каноник.
  const frameWidth = canvas?.width ?? frame?.width;
  const frameHeight = frame?.height ?? canvas?.height;
  const hasFixedViewport = frameWidth !== undefined && frameHeight !== undefined;
  const fitScale = hasFixedViewport && avail
    ? Math.min(
        1,
        Math.max(avail.width - stagePadding * 2, 1) / frameWidth,
        Math.max(avail.height - stagePadding * 2, 1) / frameHeight,
      )
    : 1;
  const scale = hasFixedViewport ? (zoom.mode === "fit" ? fitScale : zoom.zoom) : 1;
  useEffect(() => { onEffectiveScale?.(scale); }, [scale, onEffectiveScale]);

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label={player.devicePreviewAria}
      style={{ background: "radial-gradient(ellipse at 50% 0%, rgba(132,78,220,0.18), transparent 70%)" }}
    >
      <div ref={hostRef} className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="h-full w-full overflow-auto" data-eui-content-scroller="player">
          {hasFixedViewport ? (
            <div className="flex w-max min-w-full min-h-full items-center justify-center" style={{ padding: stagePadding }}>
              <div className={`${frameCard} rounded-[28px]`} style={{ width: frameWidth * scale, height: frameHeight * scale }}>
                <SurfaceSpacingScope systemId={designSystem} themeTokens={themeTokens}>
                  <div data-eui-stage-viewport="player" style={{ width: frameWidth, height: frameHeight, transform: `scale(${scale})`, transformOrigin: "top left" }}>
                    {canvas ? (
                      <div ref={canvasScrollerRef} className="h-full w-full overflow-x-hidden overflow-y-auto overscroll-y-contain" data-eui-content-scroller="player-canvas" style={{ scrollbarGutter: "stable" }}>
                        <div ref={setStageHost} className="relative isolate" style={{ width: canvas.width, height: canvas.height }}>
                          <HostStageSurface stageHostRef={stageHostRef}>{children}</HostStageSurface>
                        </div>
                      </div>
                    ) : (
                      <RegionStage statusBarDisposition={statusBarHidden ? "drop" : "extract"} scrollResetKey={scrollResetKey} surfaceName="player-stage">
                        {children}
                      </RegionStage>
                    )}
                  </div>
                </SurfaceSpacingScope>
              </div>
            </div>
          ) : (
            <div className="flex min-h-full" style={{ padding: stagePadding }}>
              <div className={`${frameCard} w-full rounded-3xl`} style={{ minHeight: playerDesktopMinStageHeight }}>
                <ScreenRegionsProvider disposition={{ statusBar: statusBarHidden ? "drop" : "inline", header: "inline", footer: "inline" }} targets={{}}>
                  {children}
                </ScreenRegionsProvider>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
