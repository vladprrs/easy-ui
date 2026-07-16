import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ThemeContent } from "../api/client";
import { HostStageSurface } from "../catalog/hostPrimitives";
import { SurfaceSpacingScope } from "../designSystems/SurfaceSpacingScope";

interface FluidStageProps {
  canvas?: { width: number; height: number } | undefined;
  designSystem: string;
  themeTokens?: ThemeContent["tokens"] | undefined;
  children: ReactNode;
}

const scrollerClassName = "h-full w-full overflow-x-auto overflow-y-auto overscroll-y-contain";

/**
 * Мобильная сцена презентации: flow занимает реальный viewport, а авторский
 * canvas масштабируется по ширине вместе со своим Overlay-якорем.
 */
export function FluidStage({ canvas, designSystem, themeTokens, children }: FluidStageProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [stageHost, setStageHost] = useState<HTMLDivElement | null>(null);
  const stageHostRef = useMemo(() => ({ current: stageHost }), [stageHost]);
  const [hostWidth, setHostWidth] = useState<number | null>(null);

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
    return <SurfaceSpacingScope systemId={designSystem} themeTokens={themeTokens}>
      <div
        ref={setStageHost}
        className="relative h-dvh w-full overflow-hidden isolate"
        data-eui-stage-viewport="present-fluid"
      >
        <HostStageSurface stageHostRef={stageHostRef}>
          <div className={scrollerClassName} data-eui-content-scroller="present-fluid" style={{ scrollbarGutter: "stable" }}>
            <div className="min-h-full">{children}</div>
          </div>
        </HostStageSurface>
      </div>
    </SurfaceSpacingScope>;
  }

  const scale = hostWidth === null ? 1 : hostWidth / canvas.width;
  return <div ref={hostRef} className="relative h-dvh min-h-0 w-full overflow-hidden">
    <div className={scrollerClassName} data-eui-content-scroller="present-fluid" style={{ scrollbarGutter: "stable" }}>
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
