import { defineRegistry, type Components } from "@json-render/react";
import type { ComponentType } from "react";
import { shadcnComponents } from "@json-render/shadcn";
import { catalog, createCatalog } from "./catalog";
import { componentDefinitions, type ComponentDefinition } from "./definitions";
import { Hotspot } from "./hotspot";

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

export function createPlayerRuntime(deps: PlayerRuntimeDeps, custom?: CustomPlayerRuntime) {
  const builtinComponents = { ...shadcnComponents, Hotspot };
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
    const runtimeCatalog = createCatalog({ ...componentDefinitions, ...custom.definitions });
    const runtimeComponents = { ...builtinComponents, ...custom.components } as Components<typeof runtimeCatalog>;
    result = defineRegistry(runtimeCatalog, { components: runtimeComponents, actions });
  } else {
    result = defineRegistry(catalog, { components: builtinComponents, actions });
  }

  // In @json-render/react 0.19.0 `handlers` is a factory, not a handler map.
  // The factory gates every action on a SetState value even when an action does
  // not use it, so provide a stable no-op setter. Built-in state actions are
  // intercepted and handled directly by JSONUIProvider.
  const handlers = result.handlers(() => () => undefined, () => ({}));
  return { registry: result.registry, handlers, executeAction: result.executeAction };
}
