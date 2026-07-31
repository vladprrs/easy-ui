import { Component, createElement, useEffect, useMemo, useRef, type ComponentType, type ReactNode } from "react";
import { z } from "zod";
import { componentPage as strings } from "../../app/strings/componentPage";
import type { ComponentDefinition } from "../../catalog/definitions";
import type { CustomPlayerRuntime } from "../../catalog/runtime";
import { CaptureSurface } from "../../capture/CaptureSurface";
import { toRuntimeSpec } from "../../prototype/runtimeSpec";
import { buildPreviewSpec, type PreviewSlotSource } from "../componentPage/model";

// Единственный путь рендера опубликованного компонента вне плеера: страница компонента и инлайн-превью
// библиотеки (план 2026-07-31 §4.4.3). Копии этого кода не должно быть — иначе слот-плейсхолдеры,
// перехват ошибок и набор custom-типов разъедутся между двумя поверхностями.

export const PLACEHOLDER_NAME = "__preview_placeholder__";

const EMPTY_SCREEN_IDS = new Set<string>();
const EMPTY_STATE = {};

const placeholderDefinition: ComponentDefinition = {
  props: z.object({ slot: z.string() }),
  description: "Preview-only slot placeholder",
  slots: [],
};

const SlotPlaceholder = (({ props }: { props: { slot: string } }) =>
  <span data-preview-placeholder={props.slot} className="inline-flex min-h-10 min-w-28 items-center justify-center rounded-inset border border-dashed border-eui-brand/50 bg-eui-lilac-100 px-3 py-2 font-eui-ui text-xs text-eui-brand">
    {strings.placeholder(props.slot)}
  </span>) as ComponentType;

/**
 * Ошибка внутри самого компонента не имеет права снять превью молча: React-граница ловит бросок,
 * рисует пустоту вместо поддерева и сообщает наверх, чтобы поверхность показала свою плашку.
 */
export class RuntimeComponentErrorReporter extends Component<{ children: ReactNode; onError: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError(); }
  render() { return this.state.failed ? null : this.props.children; }
}

/**
 * Рантайм превью: загруженные компоненты, обёрнутые репортером ошибок, плюс плейсхолдер слотов.
 * Мемо держится **только** за `loaded`: новый колбэк на каждый рендер поверхности не имеет права
 * пересобрать рантайм — это ремонтировало бы дерево компонента вместе с его локальным состоянием.
 * Поэтому актуальный `onError` живёт в ref (useEffectEvent здесь нельзя: его нельзя звать из рендера
 * компонента рантайма).
 */
export function usePreviewRuntime(loaded: CustomPlayerRuntime, onError: () => void): CustomPlayerRuntime {
  const report = useRef(onError);
  useEffect(() => { report.current = onError; });
  return useMemo<CustomPlayerRuntime>(() => ({
    definitions: { ...loaded.definitions, [PLACEHOLDER_NAME]: placeholderDefinition },
    components: {
      ...Object.fromEntries(Object.entries(loaded.components).map(([name, LoadedComponent]) => [name, (props: object) =>
        <RuntimeComponentErrorReporter onError={() => report.current()}>{createElement(LoadedComponent, props)}</RuntimeComponentErrorReporter>])),
      [PLACEHOLDER_NAME]: SlotPlaceholder,
    },
  }), [loaded]);
}

export interface RuntimePreviewProps {
  componentName: string;
  designSystem: string;
  /** Слоты и capabilities версии — из них строятся плейсхолдеры (`buildPreviewSpec`). */
  source: PreviewSlotSource;
  props: Record<string, unknown>;
  runtime: CustomPlayerRuntime;
  onError: () => void;
}

export function RuntimePreview({ componentName, designSystem, source, props, runtime, onError }: RuntimePreviewProps) {
  const tree = useMemo(() => toRuntimeSpec(
    buildPreviewSpec(componentName, props, source, PLACEHOLDER_NAME) as Parameters<typeof toRuntimeSpec>[0],
    { customTypes: new Set([componentName, PLACEHOLDER_NAME]) },
  ), [componentName, props, source]);
  return <CaptureSurface designSystem={designSystem} custom={runtime} tree={tree} initialState={EMPTY_STATE} screenIds={EMPTY_SCREEN_IDS} onError={onError} />;
}
