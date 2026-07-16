import type { BaseComponentProps } from "@json-render/react";
import { createPortal } from "react-dom";
import { canonicalSpacingScale } from "../../designSystems/spacingScale";
import type { SpaceToken } from "../../designSystems/types";
import { useHostStageSurface } from "./HostStageSurface";
import type { OverlayProps } from "./overlay.definition";

const insetValue = (token: SpaceToken) => `var(--eui-space-${token}, ${canonicalSpacingScale[token]})`;

function placementStyle(placement: OverlayProps["placement"], inset: string): React.CSSProperties {
  const horizontalBounds = { left: inset, right: inset };
  switch (placement) {
    case "top": return { ...horizontalBounds, top: inset };
    case "bottom": return { ...horizontalBounds, bottom: inset };
    case "center": return { left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: "max-content", maxWidth: `calc(100% - ${inset} - ${inset})` };
    case "top-left": return { left: inset, top: inset, width: "max-content", maxWidth: `calc(100% - ${inset} - ${inset})` };
    case "top-right": return { right: inset, top: inset, width: "max-content", maxWidth: `calc(100% - ${inset} - ${inset})` };
    case "bottom-left": return { left: inset, bottom: inset, width: "max-content", maxWidth: `calc(100% - ${inset} - ${inset})` };
    case "bottom-right": return { right: inset, bottom: inset, width: "max-content", maxWidth: `calc(100% - ${inset} - ${inset})` };
  }
}

export function Overlay({ props, children }: BaseComponentProps<OverlayProps>) {
  const surface = useHostStageSurface();
  const host = surface?.stageHostRef.current;
  if (!host) return null;
  const inset = insetValue(props.inset);
  return createPortal(
    <div data-eui-host-primitive="Overlay" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {props.scrim ? <div aria-hidden="true" data-eui-overlay-scrim="" style={{ position: "absolute", inset: 0, pointerEvents: "auto", background: "rgba(0, 0, 0, 0.4)" }} /> : null}
      <div data-eui-overlay-content="" style={{ position: "absolute", pointerEvents: "auto", ...placementStyle(props.placement, inset) }}>
        {children}
      </div>
    </div>,
    host,
  );
}
