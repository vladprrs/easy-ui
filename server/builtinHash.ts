import { createHash } from "node:crypto";
import { z } from "zod";
import type { ComponentDefinition } from "../src/catalog/definitions";
import { prototypeActionSchemas } from "../src/catalog/actions";
import { getDesignSystem } from "../src/designSystems";
import { resolveSpacingScale } from "../src/designSystems/spacingScale";
import type { SpaceToken } from "../src/designSystems/types";

export const RENDER_CONTRACT_VERSION = 1;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

// Compatibility detector for all builtin inputs that can affect validation or rendering.
// It deliberately hashes portable input JSON Schemas rather than unstable Zod internals.
export function builtinCatalogHashFor(
  systemId: string,
  definitions?: Record<string, ComponentDefinition>,
  resolvedSpaceScale: Record<SpaceToken, string> = resolveSpacingScale(systemId),
): string {
  const descriptor = {
    renderContractVersion: RENDER_CONTRACT_VERSION,
    actions: Object.keys(prototypeActionSchemas).sort(),
    definitions: (Object.entries(definitions??getDesignSystem(systemId).definitions) as [string,ComponentDefinition][]).sort(([a],[b]) => a.localeCompare(b)).map(([name, d]) => ({
      name,
      description: d.description,
      events: [...(d.events ?? [])].sort(),
      slots: [...(d.slots ?? [])].sort(),
      propsJsonSchema: z.toJSONSchema(d.props, { io: "input" }),
      layoutNeutral: d.layoutNeutral ?? false,
      layout: d.layout ?? null,
    })),
    resolvedSpaceScale,
  };
  return createHash("sha256").update(canonical(descriptor)).digest("hex");
}

export const builtinCatalogHash = builtinCatalogHashFor("shadcn");
export const emptyComponentManifestHash = createHash("sha256").update(canonical([])).digest("hex");
