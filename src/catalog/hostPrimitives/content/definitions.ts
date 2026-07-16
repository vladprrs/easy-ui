import type { ComponentDefinition } from "../../definitions";
import { hotspotDefinition } from "./hotspot.definition";
import { imageDefinition } from "./image.definition";

/** Host-owned ordinary tree components. These are never extracted into a host layer. */
export const hostContentTypeDefinitions = {
  Image: imageDefinition,
  Hotspot: hotspotDefinition,
} satisfies Record<string, ComponentDefinition>;

export type HostContentTypeName = keyof typeof hostContentTypeDefinitions;
export const hostContentTypeNames: ReadonlySet<string> = new Set(Object.keys(hostContentTypeDefinitions));
