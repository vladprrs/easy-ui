import { defineRegistry } from "@json-render/react";
import { shadcnComponents } from "@json-render/shadcn";
import { catalog } from "./catalog";
import { Hotspot } from "./hotspot";

export interface PlayerRuntimeDeps {
  navigate: (screenId: string) => void | Promise<void>;
  back: () => void | Promise<void>;
  openUrl: (url: string) => void | Promise<void>;
  restart: () => void | Promise<void>;
}

export function createPlayerRuntime(deps: PlayerRuntimeDeps) {
  const result = defineRegistry(catalog, {
    components: { ...shadcnComponents, Hotspot },
    actions: {
      navigate: async (params) => deps.navigate(params!.screenId),
      back: async () => deps.back(),
      openUrl: async (params) => deps.openUrl(params!.url),
      restart: async () => deps.restart(),
    },
  });

  // In @json-render/react 0.19.0 `handlers` is a factory, not a handler map.
  // The factory gates every action on a SetState value even when an action does
  // not use it, so provide a stable no-op setter. Built-in state actions are
  // intercepted and handled directly by JSONUIProvider.
  const handlers = result.handlers(() => () => undefined, () => ({}));
  return { registry: result.registry, handlers, executeAction: result.executeAction };
}
