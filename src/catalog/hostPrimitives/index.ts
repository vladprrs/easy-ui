import type { ComponentType } from "react";
import { FlowRoot } from "./FlowRoot";
import { FLOW_ROOT_TYPE } from "./flowRoot.definition";
import { Overlay } from "./Overlay";
import { Hotspot } from "./content/hotspot";
import { Image } from "./content/image";
import type { HostPrimitiveName } from "./definitions";

export { HostStageSurface, useHostStageSurface, type HostStageSurfaceContract } from "./HostStageSurface";
export { FlowRoot } from "./FlowRoot";
export { FLOW_ROOT_TYPE, flowRootDefinition } from "./flowRoot.definition";
export { Overlay } from "./Overlay";
export { overlayDefinition, overlayPlacements, type OverlayProps } from "./overlay.definition";
export { Hotspot } from "./content/hotspot";
export { hotspotDefinition, type HotspotProps } from "./content/hotspot.definition";
export { Image } from "./content/image";
export { imageDefinition, imageObjectFits, type ImageProps } from "./content/image.definition";
export {
  extractionPrimitiveDefinitions, extractionPrimitiveNames,
  hostContentTypeDefinitions, hostContentTypeNames,
  hostPrimitiveDefinitions, hostPrimitiveNames,
  type ExtractionPrimitiveName, type HostContentTypeName, type HostPrimitiveName,
} from "./definitions";

export const hostPrimitiveComponents = {
  Overlay,
  Image,
  Hotspot,
  [FLOW_ROOT_TYPE]: FlowRoot,
} satisfies Record<HostPrimitiveName, ComponentType<never>>;
