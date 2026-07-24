import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ThemeContent } from "../api/client";
import { HostStageSurface } from "../catalog/hostPrimitives";
import { SurfaceSpacingScope } from "../designSystems/SurfaceSpacingScope";
import { RegionStage } from "./RegionStage";

interface FluidStageProps {
  canvas?: { width: number; height: number } | undefined;
  designSystem: string;
  themeTokens?: ThemeContent["tokens"] | undefined;
  resetKey?: string | undefined;
  children: ReactNode;
}

const scrollerClassName = "h-full w-full overflow-x-auto overflow-y-auto overscroll-y-contain";

/**
 * Мобильная сцена презентации: flow занимает реальный viewport, а авторский
 * canvas масштабируется по ширине вместе со своим Overlay-якорем.
 */
export function FluidStage({ canvas, designSystem, themeTokens, resetKey, children }: FluidStageProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [stageHost, setStageHost] = useState<HTMLDivElement | null>(null);
  const stageHostRef = useMemo(() => ({ current: stageHost }), [stageHost]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [hostWidth, setHostWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollTop = 0;
    scroller.scrollLeft = 0;
  }, [resetKey]);

  useEffect(() => {
    if (!canvas) return;
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    // Внешний host не зависит от canvas-высоты, поэтому scrollbar не запускает цикл измерений.
    const observer = new ResizeObserver(([entry]) => setHostWidth(entry.contentRect.width));
    observer.observe(host);
    return () => observer.disconnect();
  }, [canvas]);

  if (!canvas) {
    // Реальный телефон рисует свой статусбар, поэтому present-flow его `drop`-ает.
    // `h-dvh`-враппер и SurfaceSpacingScope — здесь: RegionStage height-agnostic.
    return <SurfaceSpacingScope systemId={designSystem} themeTokens={themeTokens}>
      <div className="h-dvh w-full">
        <RegionStage statusBarDisposition="drop" scrollResetKey={resetKey} surfaceName="present-fluid">
          {children}
        </RegionStage>
      </div>
    </SurfaceSpacingScope>;
  }

  const scale = hostWidth === null ? 1 : hostWidth / canvas.width;
  return <div ref={hostRef} className="relative h-dvh min-h-0 w-full overflow-hidden">
    <div ref={scrollerRef} className={scrollerClassName} data-eui-content-scroller="present-fluid" style={{ scrollbarGutter: "stable" }}>
      <div className="relative overflow-hidden" style={{ width: canvas.width * scale, height: canvas.height * scale }}>
        <SurfaceSpacingScope systemId={designSystem} themeTokens={themeTokens}>
          <div
            ref={setStageHost}
            className="absolute inset-0 isolate"
            data-eui-stage-viewport="present-fluid"
            style={{ width: canvas.width, height: canvas.height, transform: `scale(${scale})`, transformOrigin: "top left" }}
          >
            <HostStageSurface stageHostRef={stageHostRef}>{children}</HostStageSurface>
          </div>
        </SurfaceSpacingScope>
      </div>
    </div>
  </div>;
}
