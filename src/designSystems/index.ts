import type { DesignSystem } from "./types";

/** No builtin providers remain; exact custom definitions come from revision pins. */
export const designSystems: Readonly<Record<string, DesignSystem>> = Object.freeze({});

/** Compatibility-only empty descriptor for hashing legacy stored identifiers. */
export function getDesignSystem(id: string): DesignSystem {
  return { id, name: id, description: "", definitions: {}, components: {}, fixtures: {} };
}
