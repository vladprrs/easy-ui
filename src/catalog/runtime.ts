import { defineRegistry, type ComponentRegistry, type ComponentRenderProps, type Components } from "@json-render/react";
import { createElement, type ComponentType } from "react";
import { createCatalog } from "./catalog";
import type { ComponentDefinition } from "./definitions";
import { wrapCustomComponent, type EasyUIComponentProps } from "../player/easyUiRuntime";
import { EUI_KEY_PROP } from "../prototype/runtimeSpec";
import { hostPrimitiveComponents } from "./hostPrimitives";
import { hostPrimitiveDefinitions } from "./hostPrimitives/definitions";

const hostCatalog = createCatalog(hostPrimitiveDefinitions);

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

/** Stable production DOM attribute used to correlate rendered nodes with RuntimeTree metadata. */
export const EUI_KEY_ATTRIBUTE = "data-eui-key";

/**
 * `@json-render/react` only emits its `data-jr-key` wrapper while devtools are
 * active. Decorate every registry renderer with our own display:contents
 * marker so builtin and custom elements remain discoverable in production
 * without introducing a layout box (capture pixels stay unchanged).
 */
function decorateElementMarkers(registry: ComponentRegistry): ComponentRegistry {
  return Object.fromEntries(Object.entries(registry).map(([name, Component]) => {
    const MarkedComponent = (props: ComponentRenderProps) => {
      const key = props.element.props?.[EUI_KEY_PROP];
      const rendered = createElement(Component, props);
      return typeof key === "string"
        ? createElement("span", { [EUI_KEY_ATTRIBUTE]: key, style: { display: "contents" } }, rendered)
        : rendered;
    };
    MarkedComponent.displayName = `EasyUiElementMarker(${name})`;
    return [name, MarkedComponent];
  }));
}

export function createPlayerRuntime(deps: PlayerRuntimeDeps, custom?: CustomPlayerRuntime, designSystemId?: string) {
  void designSystemId; // retained as a source-compatible diagnostic argument; runtime is host/custom-only
  const legacyTestRuntime = import.meta.env.MODE === "test" && (designSystemId === undefined || designSystemId === "shadcn" || designSystemId === "wireframe")
    ? globalThis.__EUI_LEGACY_TEST_RUNTIME__ : undefined;
  const actions = {
    navigate: async (params: { screenId: string } | undefined) => deps.navigate(params!.screenId),
    back: async () => deps.back(),
    openUrl: async (params: { url: string } | undefined) => deps.openUrl(params!.url),
    restart: async () => deps.restart(),
  };
  let result;
  if (custom || legacyTestRuntime) {
    const definitionKeys = Object.keys(custom?.definitions ?? {}).sort();
    const componentKeys = Object.keys(custom?.components ?? {}).sort();
    if (definitionKeys.length !== componentKeys.length || definitionKeys.some((key, index) => key !== componentKeys[index])) {
      throw new Error("Custom definition and component keys must match");
    }
    // Final custom-only order: custom definitions are followed by host-owned
    // content/extraction types so reserved host names can never be shadowed.
    const runtimeCatalog = createCatalog({ ...legacyTestRuntime?.definitions, ...custom?.definitions, ...hostPrimitiveDefinitions });
    // Custom components are wrapped with the event adapter so they receive
    // emit(name, payload?)/on()/slots and route dispatch through the runtime.
    const wrappedCustom = Object.fromEntries(Object.entries(custom?.components ?? {}).map(([name, component]) =>
      [name, wrapCustomComponent(name, component as ComponentType<EasyUIComponentProps>)]));
    const runtimeComponents = { ...legacyTestRuntime?.components, ...wrappedCustom, ...hostPrimitiveComponents } as Components<typeof runtimeCatalog>;
    result = defineRegistry(runtimeCatalog, { components: runtimeComponents, actions });
  } else {
    result = defineRegistry(hostCatalog, { components: hostPrimitiveComponents as Components<typeof hostCatalog>, actions });
  }

  // In @json-render/react 0.19.0 `handlers` is a factory, not a handler map.
  // The factory gates every action on a SetState value even when an action does
  // not use it, so provide a stable no-op setter. Built-in state actions are
  // intercepted and handled directly by JSONUIProvider.
  const handlers = result.handlers(() => () => undefined, () => ({}));
  return { registry: decorateElementMarkers(result.registry), handlers, executeAction: result.executeAction };
}
