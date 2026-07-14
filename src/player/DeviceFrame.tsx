import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { PrototypeDoc } from "../prototype/schema";
import { player } from "../app/strings/player";
import { canonicalViewport, playerDesktopMinStageHeight } from "../designSystems/deviceMetrics";

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
  const zoomIn = useCallback(() => zoomBy(zoomStep), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(1 / zoomStep), [zoomBy]);
  return { value, effectiveScale, fit, actualSize, zoomIn, zoomOut, onEffectiveScale };
}

const frameCard = "overflow-hidden bg-background text-foreground shadow-[0_20px_60px_rgba(2,2,5,0.35)]";

/**
 * Stage плеера (W1-1). Стабильный stage-вьюпорт занимает всю высоту под хромом;
 * фрейм с фиксированным viewport (mobile/tablet или canvas-экран) рендерится в
 * scaled-обёртке: внешний контейнер размером `w×scale / h×scale`, transformed-inner
 * с `transform: scale()`. Размер обёртки считается от scale (не наоборот) —
 * ResizeObserver наблюдает только сам stage-вьюпорт (overflow-hidden, на его
 * размер scale не влияет), фидбэк-лупа нет. Desktop (auto-height) — fluid-ветка
 * с min-height из `playerDesktopMinStageHeight`.
 */
export function DeviceFrame({ device, canvas, zoom, onEffectiveScale, children }: {
  device: Device;
  canvas?: { width: number; height: number } | undefined;
  zoom: StageZoom;
  onEffectiveScale?: ((scale: number) => void) | undefined;
  children: ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setAvail({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const frame = canonicalViewport[device];
  const contentWidth = canvas?.width ?? frame?.width;
  const contentHeight = canvas?.height ?? frame?.height;
  const hasFixedViewport = contentWidth !== undefined && contentHeight !== undefined;
  const fitScale = hasFixedViewport && avail
    ? Math.min(
        1,
        Math.max(avail.width - stagePadding * 2, 1) / contentWidth,
        Math.max(avail.height - stagePadding * 2, 1) / contentHeight,
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
        <div className="h-full w-full overflow-auto">
          {hasFixedViewport ? (
            <div className="flex w-max min-w-full min-h-full items-center justify-center" style={{ padding: stagePadding }}>
              <div className={`${frameCard} rounded-[28px]`} style={{ width: contentWidth * scale, height: contentHeight * scale }}>
                <div style={{ width: contentWidth, height: contentHeight, transform: `scale(${scale})`, transformOrigin: "top left" }}>
                  {children}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex min-h-full" style={{ padding: stagePadding }}>
              <div className={`${frameCard} w-full rounded-3xl`} style={{ minHeight: playerDesktopMinStageHeight }}>
                {children}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
