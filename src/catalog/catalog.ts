import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react";
import { customCatalogActions } from "./actions";
import { componentDefinitions } from "./definitions";

export const catalog = defineCatalog(schema, {
  components: componentDefinitions,
  actions: customCatalogActions,
});
