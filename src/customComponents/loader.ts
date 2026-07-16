import type { ComponentType } from "react";
import { z } from "zod";
import type { ComponentDefinition } from "../catalog/definitions";
import { normalizeEvents, type ComponentCapabilities } from "../catalog/normalize";
import { atomicLevels } from "../designSystems/types";

export interface CustomComponentRef {
  id: string;
  name: string;
  version: number;
  bundleUrl: string;
  bundleHash: string;
}

export interface LoadedCustomComponents {
  definitions: Record<string, ComponentDefinition>;
  components: Record<string, ComponentType>;
}

type ImportModule = (url: string) => Promise<unknown>;
const moduleCache = new Map<string, Promise<unknown>>();
const dynamicImport: ImportModule = (url) => import(/* @vite-ignore */ url);

function validateBundleUrl(url: string) {
  if (!url.startsWith("/api/") || url.startsWith("//") || url.includes("\\")) {
    throw new Error("bundle URL must be a same-origin /api/ path");
  }
  const parsed = new URL(url, globalThis.location?.origin ?? "http://localhost");
  if (parsed.origin !== (globalThis.location?.origin ?? "http://localhost") || !parsed.pathname.startsWith("/api/")) {
    throw new Error("bundle URL must be a same-origin /api/ path");
  }
}

export async function loadCustomComponents(refs: CustomComponentRef[], importModule: ImportModule = dynamicImport): Promise<LoadedCustomComponents> {
  await import("./shared");
  const definitions: Record<string, ComponentDefinition> = {};
  const components: Record<string, ComponentType> = {};

  await Promise.all(refs.map(async (ref) => {
    try {
      validateBundleUrl(ref.bundleUrl);
      let pending = moduleCache.get(ref.bundleUrl);
      if (!pending) {
        pending = importModule(ref.bundleUrl);
        moduleCache.set(ref.bundleUrl, pending);
      }
      const value = await pending;
      if (!value || typeof value !== "object") throw new Error("module did not export an object");
      const module = value as Record<string, unknown>;
      if (!module.definition || typeof module.definition !== "object") throw new Error("missing definition export");
      const definition = module.definition as Record<string, unknown>;
      if (!(definition.props instanceof z.ZodType)) throw new Error("definition.props is not a host zod schema");
      if (typeof definition.description !== "string") throw new Error("definition.description must be a string");
      if (definition.atomicLevel !== undefined && !atomicLevels.includes(definition.atomicLevel as (typeof atomicLevels)[number])) throw new Error("definition.atomicLevel is invalid");
      if (typeof module.default !== "function") throw new Error("default export must be a function component");
      const { events, eventPayloadSchemas } = normalizeEvents(definition.events as Parameters<typeof normalizeEvents>[0]);
      const capabilities = definition.capabilities && typeof definition.capabilities === "object"
        ? (definition.capabilities as ComponentCapabilities) : undefined;
      definitions[ref.name] = {
        props: definition.props as z.ZodType,
        description: definition.description,
        ...(events.length ? { events } : {}),
        ...(eventPayloadSchemas ? { eventPayloadSchemas } : {}),
        ...(capabilities ? { capabilities } : {}),
        ...(Array.isArray(definition.slots) ? { slots: definition.slots as string[] } : {}),
        ...(definition.example && typeof definition.example === "object" ? { example: definition.example as Record<string, unknown> } : {}),
        ...(definition.atomicLevel ? { atomicLevel: definition.atomicLevel as ComponentDefinition["atomicLevel"] } : {}),
        ...(typeof definition.layoutNeutral === "boolean" ? { layoutNeutral: definition.layoutNeutral } : {}),
        ...(definition.layout && typeof definition.layout === "object" ? { layout: definition.layout as ComponentDefinition["layout"] } : {}),
        ...(typeof definition.interactive === "boolean" ? { interactive: definition.interactive } : {}),
        ...(Array.isArray(definition.accessibleLabelProps) ? { accessibleLabelProps: definition.accessibleLabelProps as string[] } : {}),
        ...(Array.isArray(definition.urlProps) ? { urlProps: definition.urlProps as string[] } : {}),
      };
      components[ref.name] = module.default as ComponentType;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Custom component ${ref.name} v${ref.version}: ${reason}`, { cause: error });
    }
  }));
  return { definitions, components };
}

export function clearCustomComponentCacheForTests() {
  moduleCache.clear();
}
