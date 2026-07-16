import { createHash } from "node:crypto";
import { z } from "zod";
import type { ComponentDefinition } from "../src/catalog/definitions";
import { prototypeActionSchemas } from "../src/catalog/actions";
import { extractionPrimitiveDefinitions, hostPrimitiveDefinitions } from "../src/catalog/hostPrimitives/definitions";
import { resolveSpacingScale } from "../src/designSystems/spacingScale";
import type { SpaceToken } from "../src/designSystems/types";

export const RENDER_CONTRACT_VERSION = 3;
const LEGACY_RENDER_CONTRACT_VERSION = 2;
const retiredBuiltinV2Hashes: Readonly<Record<string, string>> = Object.freeze({
  shadcn: "5d28a8faa2c8fb2016c78f52cfdf3cda1606e37f6d0c81a692a6410ecec77e41",
  wireframe: "790b74a019635c4807b303b582bcbb3e4a5d9b5b556b6a80b3b87df7e4b5308d",
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

// Compatibility detector for all builtin inputs that can affect validation or rendering.
// It deliberately hashes portable input JSON Schemas rather than unstable Zod internals.
function calculateBuiltinCatalogHash(
  systemId: string,
  definitions: Record<string, ComponentDefinition> | undefined,
  resolvedSpaceScale: Record<SpaceToken, string>,
  hostDefinitions: Record<string, ComponentDefinition>,
  renderContractVersion: number,
): string {
  const descriptors = (source: Record<string, ComponentDefinition>) =>
    (Object.entries(source) as [string,ComponentDefinition][]).sort(([a],[b]) => a.localeCompare(b)).map(([name, d]) => ({
      name,
      description: d.description,
      atomicLevel: d.atomicLevel ?? null,
      events: [...(d.events ?? [])].sort(),
      slots: [...(d.slots ?? [])].sort(),
      propsJsonSchema: z.toJSONSchema(d.props, { io: "input" }),
      layoutNeutral: d.layoutNeutral ?? false,
      layout: d.layout ?? null,
    }));
  const descriptor = {
    renderContractVersion,
    actions: Object.keys(prototypeActionSchemas).sort(),
    definitions: descriptors(definitions ?? {}),
    hostPrimitives: descriptors(hostDefinitions),
    resolvedSpaceScale,
  };
  return createHash("sha256").update(canonical(descriptor)).digest("hex");
}

/**
 * Hash for newly written revisions. Contract v3 adds host content types to the
 * portable render inputs. Stored revision hashes are immutable database values:
 * callers must never recompute or rewrite them during reads or migrations.
 */
export function builtinCatalogHashFor(
  systemId: string,
  definitions?: Record<string, ComponentDefinition>,
  resolvedSpaceScale: Record<SpaceToken, string> = resolveSpacingScale(systemId),
  hostDefinitions: Record<string, ComponentDefinition> = hostPrimitiveDefinitions,
): string {
  return calculateBuiltinCatalogHash(systemId, definitions, resolvedSpaceScale, hostDefinitions, RENDER_CONTRACT_VERSION);
}

/** Reproduces the B0/B1-precutover v2 value for compatibility diagnostics only. */
export function legacyBuiltinCatalogHashFor(
  systemId: string,
  definitions?: Record<string, ComponentDefinition>,
  resolvedSpaceScale: Record<SpaceToken, string> = resolveSpacingScale(systemId),
): string {
  if (definitions === undefined && retiredBuiltinV2Hashes[systemId]) return retiredBuiltinV2Hashes[systemId];
  return calculateBuiltinCatalogHash(systemId, definitions, resolvedSpaceScale, extractionPrimitiveDefinitions, LEGACY_RENDER_CONTRACT_VERSION);
}

export const builtinCatalogHash = builtinCatalogHashFor("shadcn");
export const emptyComponentManifestHash = createHash("sha256").update(canonical([])).digest("hex");
