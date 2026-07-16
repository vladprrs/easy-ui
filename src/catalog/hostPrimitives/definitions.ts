import type { ComponentDefinition } from "../definitions";
import { hostContentTypeDefinitions } from "./content/definitions";
import { extractionPrimitiveDefinitions } from "./extraction/definitions";

/**
 * Complete host-owned catalog. The legacy name is retained for the discovery API,
 * but callers that split trees must use extractionPrimitiveNames instead.
 */
export const hostPrimitiveDefinitions = {
  ...extractionPrimitiveDefinitions,
  ...hostContentTypeDefinitions,
} satisfies Record<string, ComponentDefinition>;

export type HostPrimitiveName = keyof typeof hostPrimitiveDefinitions;
/** All host-owned names are reserved from user component publication. */
export const hostPrimitiveNames: ReadonlySet<string> = new Set(Object.keys(hostPrimitiveDefinitions));

export { extractionPrimitiveDefinitions, extractionPrimitiveNames, type ExtractionPrimitiveName } from "./extraction/definitions";
export { hostContentTypeDefinitions, hostContentTypeNames, type HostContentTypeName } from "./content/definitions";
