import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react";
import { customCatalogActions } from "./actions";
import { componentDefinitions, normalizeDefinitions, type ComponentDefinition } from "./definitions";

export function createCatalog(definitions: Record<string, ComponentDefinition>) {
  return defineCatalog(schema, {
    components: normalizeDefinitions(definitions),
    actions: customCatalogActions,
  });
}

export const catalog = defineCatalog(schema, {
  components: componentDefinitions,
  actions: customCatalogActions,
});
