import { createHash } from "node:crypto";
import { componentDefinitions, type ComponentDefinition } from "../src/catalog/definitions";
import { prototypeActionSchemas } from "../src/catalog/actions";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

// The v1 descriptor deliberately excludes Zod internals. It includes sorted builtin
// names and their stable human metadata (description/events/slots), plus action names.
const descriptor = {
  actions: Object.keys(prototypeActionSchemas).sort(),
  definitions: (Object.entries(componentDefinitions) as [string,ComponentDefinition][]).sort(([a],[b]) => a.localeCompare(b)).map(([name, d]) => ({
    name, description: d.description, events: [...(d.events ?? [])].sort(), slots: [...(d.slots ?? [])].sort(),
  })),
};

export const builtinCatalogHash = createHash("sha256").update(canonical(descriptor)).digest("hex");
export const emptyComponentManifestHash = createHash("sha256").update(canonical([])).digest("hex");
