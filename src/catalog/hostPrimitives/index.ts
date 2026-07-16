import type { ComponentType } from "react";
import { Overlay } from "./Overlay";
import type { HostPrimitiveName } from "./definitions";

export { HostStageSurface, useHostStageSurface, type HostStageSurfaceContract } from "./HostStageSurface";
export { Overlay } from "./Overlay";
export { overlayDefinition, overlayPlacements, type OverlayProps } from "./overlay.definition";
export { hostPrimitiveDefinitions, hostPrimitiveNames, type HostPrimitiveName } from "./definitions";

export const hostPrimitiveComponents = {
  Overlay,
} satisfies Record<HostPrimitiveName, ComponentType<never>>;
