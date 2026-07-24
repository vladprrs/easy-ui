import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { HostStageSurface } from "../catalog/hostPrimitives";
import type { RegionPolicy } from "../prototype/runtimeSpec";
import { ScreenRegionsProvider } from "./ScreenRegions";

interface RegionStageProps {
  /**
   * Судьба статусбара: `"extract"` выносит его в верхний пиннед-слот (над header),
   * `"drop"` выкидывает — тогда слот пуст и скрыт (`[&:empty]:hidden`).
   */
  statusBarDisposition: "extract" | "drop";
  /** Смена ключа сбрасывает scrollTop/scrollLeft скроллера в 0 (навигация/Back). */
  scrollResetKey?: string | undefined;
  /**
   * Значение маркеров `data-eui-stage-viewport`, `data-eui-content-scroller` и
   * `data-eui-overlay-layer` — различает поверхности (`present-fluid`, `player-stage`).
   */
  surfaceName: string;
  children: ReactNode;
}

/**
 * Внутренняя сцена регионов: колонка `[statusBar+header slots] / [scroller flex-1] /
 * [footer slot]` с absolute overlay-слоем поверх. header/footer всегда извлекаются
 * (`extract`) в пиннед-слоты, статусбар — по `statusBarDisposition`; контент скроллится
 * между ними, Overlay заякорен на overlay-слой и не уезжает при скролле.
 *
 * Компонент **height-agnostic**: корень `h-full`, никакого `h-dvh` — высоту задаёт
 * обёртка вызывающего (FluidStage — свой `h-dvh`, DeviceFrame — фрейм 390×844).
 * `SurfaceSpacingScope` тоже остаётся у вызывающих — двойного скоупа нет.
 * `HostStageSurface` компонент оборачивает сам. footer-слот несёт
 * `paddingBottom` safe-area безусловно: на десктопе переменная = 0, вреда нет.
 */
export function RegionStage({ statusBarDisposition, scrollResetKey, surfaceName, children }: RegionStageProps) {
  const [stageHost, setStageHost] = useState<HTMLDivElement | null>(null);
  const stageHostRef = useMemo(() => ({ current: stageHost }), [stageHost]);
  const [statusBarSlot, setStatusBarSlot] = useState<HTMLDivElement | null>(null);
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);
  const [footerSlot, setFooterSlot] = useState<HTMLDivElement | null>(null);
  const regionTargets = useMemo(
    () => ({ statusBar: statusBarSlot, header: headerSlot, footer: footerSlot }),
    [footerSlot, headerSlot, statusBarSlot],
  );
  const disposition = useMemo(
    () => ({ statusBar: statusBarDisposition, header: "extract", footer: "extract" } satisfies RegionPolicy),
    [statusBarDisposition],
  );
  const scrollerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollTop = 0;
    scroller.scrollLeft = 0;
  }, [scrollResetKey]);

  return <div className="relative isolate flex h-full w-full flex-col overflow-hidden" data-eui-stage-viewport={surfaceName}>
    <ScreenRegionsProvider disposition={disposition} targets={regionTargets}>
      <HostStageSurface stageHostRef={stageHostRef}>
        <div ref={setStatusBarSlot} className="relative z-10 shrink-0 [&:empty]:hidden" data-eui-region="statusBar" />
        <div ref={setHeaderSlot} className="relative z-10 shrink-0 [&:empty]:hidden" data-eui-region="header" />
        <div ref={scrollerRef} className="relative z-0 min-h-0 w-full flex-1 overflow-x-auto overflow-y-auto overscroll-y-contain" data-eui-content-scroller={surfaceName} style={{ scrollbarGutter: "stable" }}>
          <div className="min-h-full">{children}</div>
        </div>
        <div
          ref={setFooterSlot}
          className="relative z-10 shrink-0 [&:empty]:hidden"
          data-eui-region="footer"
          style={{ paddingBottom: "var(--eui-safe-area-bottom, env(safe-area-inset-bottom, 0px))" }}
        />
        <div ref={setStageHost} className="pointer-events-none absolute inset-0 z-20" data-eui-overlay-layer={surfaceName} />
      </HostStageSurface>
    </ScreenRegionsProvider>
  </div>;
}
