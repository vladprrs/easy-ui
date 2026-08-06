import type { BaseComponentProps } from "@json-render/react";
import { createPortal } from "react-dom";
import { canonicalSpacingScale } from "../../designSystems/spacingScale";
import type { SpaceToken } from "../../designSystems/types";
import { useHostStageSurface } from "./HostStageSurface";
import type { OverlayProps } from "./overlay.definition";

const insetValue = (token: SpaceToken) => `var(--eui-space-${token}, ${canonicalSpacingScale[token]})`;

/**
 * Высотный инвариант (план 2026-08-06 §W5 T5a): **каждое** placement ограничено высотой
 * StageViewport минус вертикальные insets. До волны оверлей, чей контент выше вьюпорта, вытекал за
 * сцену — кадр приёмки мерил ленту, а не модалку, и «вылезло» было неотличимо от дизайна.
 * Insets симметричны так же, как у `maxWidth`: якорь по одной стороне не отменяет поля у другой.
 */
const placementStyle = (placement: OverlayProps["placement"], inset: string): React.CSSProperties => {
  const bounds = { maxHeight: `calc(100% - ${inset} - ${inset})` };
  const hug = { ...bounds, width: "max-content", maxWidth: `calc(100% - ${inset} - ${inset})` };
  switch (placement) {
    case "top": return { ...bounds, left: inset, right: inset, top: inset };
    case "bottom": return { ...bounds, left: inset, right: inset, bottom: inset };
    case "center": return { ...hug, left: "50%", top: "50%", transform: "translate(-50%, -50%)" };
    case "top-left": return { ...hug, left: inset, top: inset };
    case "top-right": return { ...hug, right: inset, top: inset };
    case "bottom-left": return { ...hug, left: inset, bottom: inset };
    case "bottom-right": return { ...hug, right: inset, bottom: inset };
  }
};

/**
 * Прокрутка контента оверлея. `scroll:false` — клип (контент не вытекает за высотную границу);
 * `overscroll-behavior:contain` держит цепочку прокрутки внутри модалки, иначе жест докручивал бы
 * сцену за ней.
 */
const scrollStyle = (scroll: boolean): React.CSSProperties =>
  scroll ? { overflowY: "auto", overscrollBehavior: "contain" } : { overflow: "hidden" };

export function Overlay({ props, children }: BaseComponentProps<OverlayProps>) {
  const surface = useHostStageSurface();
  const host = surface?.stageHostRef.current;
  if (!host) return null;
  const inset = insetValue(props.inset);
  return createPortal(
    <div data-eui-host-primitive="Overlay" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {props.scrim ? <div aria-hidden="true" data-eui-overlay-scrim="" style={{ position: "absolute", inset: 0, pointerEvents: "auto", background: "rgba(0, 0, 0, 0.4)" }} /> : null}
      {/*
        `data-eui-overlay-content` — **стабильный контракт** (план 2026-08-06 §W5 T5c.3): по нему
        geometry-сбор находит layout-корень оверлея на viewport-поверхности приёмки. Переименование
        атрибута молча превратило бы измерение модалки в измерение пустой сцены.
      */}
      <div data-eui-overlay-content="" style={{ position: "absolute", pointerEvents: "auto", ...placementStyle(props.placement, inset), ...scrollStyle(props.scroll) }}>
        {children}
      </div>
    </div>,
    host,
  );
}
