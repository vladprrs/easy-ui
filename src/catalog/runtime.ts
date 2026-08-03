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

/** Поверхность в терминах рантайма: id и ДС, в которой резолвятся типы её экранов. */
export interface RuntimeSurface { id: string; designSystem?: string | undefined }

export interface SurfacePlayerRuntime extends ReturnType<typeof createPlayerRuntime> {
  /** `surfaceId → реестр`. Одно-поверхностный документ отдаёт тот же объект, что `registry`. */
  registries: Readonly<Record<string, ComponentRegistry>>;
}

/**
 * Сужает загруженный custom-рантайм до компонентов одной ДС (план multi-surface, D8).
 *
 * Карта `componentDesignSystems` строится из пинов ревизии и **может быть неполной**:
 * имена компонентов глобально уникальны (`components.name UNIQUE`), поэтому плоская
 * name-keyed карта корректна и без сужения, а компонент неизвестной ДС остаётся во всех
 * реестрах — рендер stored-документа никогда не ломается из-за отсутствия метаданных.
 * Возвращает исходный объект, если выкидывать нечего: тогда реестр не пересоздаётся.
 */
export function scopeCustomRuntime(
  custom: CustomPlayerRuntime | undefined,
  designSystem: string | undefined,
  componentDesignSystems: Readonly<Record<string, string>> = {},
): CustomPlayerRuntime | undefined {
  if (!custom || designSystem === undefined) return custom;
  const foreign = Object.keys(custom.definitions).filter((name) => {
    const owner = componentDesignSystems[name];
    return owner !== undefined && owner !== designSystem;
  });
  if (foreign.length === 0) return custom;
  const drop = new Set(foreign);
  const keep = <T,>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(record).filter(([name]) => !drop.has(name)));
  return { definitions: keep(custom.definitions), components: keep(custom.components) };
}

/**
 * Плеерный рантайм с **реестром на поверхность** (D8). Стор, экшены и хендлеры общие на
 * сессию (одна воронка записи — D7), различается только резолв типов: экран поверхности
 * видит компоненты своей ДС. Документ без `surfaces` (и любой документ, чьи ДС совпадают)
 * получает ровно один реестр — тот же объект, что и раньше.
 */
export function createSurfacePlayerRuntime(
  deps: PlayerRuntimeDeps,
  custom: CustomPlayerRuntime | undefined,
  surfaces: readonly RuntimeSurface[],
  componentDesignSystems: Readonly<Record<string, string>> = {},
): SurfacePlayerRuntime {
  const primary = surfaces[0];
  const base = createPlayerRuntime(deps, scopeCustomRuntime(custom, primary?.designSystem, componentDesignSystems), primary?.designSystem);
  const registries: Record<string, ComponentRegistry> = {};
  const cache = new Map<string, ComponentRegistry>();
  for (const surface of surfaces) {
    const key = surface.designSystem ?? "";
    if (surface.id === primary?.id || key === (primary?.designSystem ?? "")) {
      registries[surface.id] = base.registry;
      continue;
    }
    const cached = cache.get(key);
    registries[surface.id] = cached
      ?? createPlayerRuntime(deps, scopeCustomRuntime(custom, surface.designSystem, componentDesignSystems), surface.designSystem).registry;
    cache.set(key, registries[surface.id]!);
  }
  return { ...base, registries };
}
