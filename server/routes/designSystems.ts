import { builtinCatalogHashFor } from "../builtinHash";
import { designSystems } from "../../src/designSystems";

export function listDesignSystems() {
  return {
    designSystems: Object.values(designSystems).map(system => ({
      id: system.id,
      name: system.name,
      description: system.description,
      builtinCatalogHash: builtinCatalogHashFor(system.id),
      components: Object.entries(system.definitions).map(([name, definition]) => ({
        name,
        atomicLevel: definition.atomicLevel,
        layoutNeutral: definition.layoutNeutral ?? false,
        description: definition.description,
        events: definition.events ?? [],
        slots: definition.slots ?? [],
      })),
    })),
  };
}
