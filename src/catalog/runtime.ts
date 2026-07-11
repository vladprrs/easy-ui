import { defineRegistry, type Components } from "@json-render/react";
import type { ComponentType } from "react";
import { createCatalog } from "./catalog";
import type { ComponentDefinition } from "./definitions";
import { getDesignSystem } from "../designSystems";

const builtinCatalogs = new Map<string, ReturnType<typeof createCatalog>>();

function getBuiltinCatalog(designSystemId: string, definitions: Record<string, ComponentDefinition>) {
  let runtimeCatalog = builtinCatalogs.get(designSystemId);
  if (!runtimeCatalog) {
    runtimeCatalog = createCatalog(definitions);
    builtinCatalogs.set(designSystemId, runtimeCatalog);
  }
  return runtimeCatalog;
}

export interface PlayerRuntimeDeps {
  navigate: (screenId: string) => void | Promise<void>;
  back: () => void | Promise<void>;
  openUrl: (url: string) => void | Promise<void>;
  restart: () => void | Promise<void>;
}

export interface CustomPlayerRuntime {
  definitions: Record<string, ComponentDefinition>;
  components: Record<string, ComponentType>;
}

export function createPlayerRuntime(deps: PlayerRuntimeDeps, custom?: CustomPlayerRuntime, designSystemId = "shadcn") {
  const system = getDesignSystem(designSystemId);
  const builtinComponents = system.components;
  const actions = {
    navigate: async (params: { screenId: string } | undefined) => deps.navigate(params!.screenId),
    back: async () => deps.back(),
    openUrl: async (params: { url: string } | undefined) => deps.openUrl(params!.url),
    restart: async () => deps.restart(),
  };
  let result;
  if (custom) {
    const definitionKeys = Object.keys(custom.definitions).sort();
    const componentKeys = Object.keys(custom.components).sort();
    if (definitionKeys.length !== componentKeys.length || definitionKeys.some((key, index) => key !== componentKeys[index])) {
      throw new Error("Custom definition and component keys must match");
    }
    const runtimeCatalog = createCatalog({ ...system.definitions, ...custom.definitions });
    const runtimeComponents = { ...builtinComponents, ...custom.components } as Components<typeof runtimeCatalog>;
    result = defineRegistry(runtimeCatalog, { components: runtimeComponents, actions });
  } else {
    const runtimeCatalog = getBuiltinCatalog(system.id, system.definitions);
    result = defineRegistry(runtimeCatalog, { components: builtinComponents as Components<typeof runtimeCatalog>, actions });
  }

  // In @json-render/react 0.19.0 `handlers` is a factory, not a handler map.
  // The factory gates every action on a SetState value even when an action does
  // not use it, so provide a stable no-op setter. Built-in state actions are
  // intercepted and handled directly by JSONUIProvider.
  const handlers = result.handlers(() => () => undefined, () => ({}));
  return { registry: result.registry, handlers, executeAction: result.executeAction };
}
