import type { ComponentDefinition } from "../../definitions";
import { overlayDefinition } from "../overlay.definition";

/** Host-owned types that are extracted from the authored tree into a stage layer. */
export const extractionPrimitiveDefinitions = {
  Overlay: overlayDefinition,
} satisfies Record<string, ComponentDefinition>;

export type ExtractionPrimitiveName = keyof typeof extractionPrimitiveDefinitions;
export const extractionPrimitiveNames: ReadonlySet<string> = new Set(Object.keys(extractionPrimitiveDefinitions));
