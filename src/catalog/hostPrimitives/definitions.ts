import type { ComponentDefinition } from "../definitions";
import { overlayDefinition } from "./overlay.definition";

export const hostPrimitiveDefinitions = {
  Overlay: overlayDefinition,
} satisfies Record<string, ComponentDefinition>;

export type HostPrimitiveName = keyof typeof hostPrimitiveDefinitions;
export const hostPrimitiveNames: ReadonlySet<string> = new Set(Object.keys(hostPrimitiveDefinitions));
