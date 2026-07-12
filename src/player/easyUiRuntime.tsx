import { Children, createContext, useContext, useMemo, type ComponentType, type ReactNode } from "react";
import { useRepeatScope, type BaseComponentProps } from "@json-render/react";
import type { ComponentDefinition } from "../catalog/definitions";
import type { ElementMetadata } from "../prototype/runtimeSpec";
import { EUI_KEY_PROP } from "../prototype/runtimeSpec";
import { EasyUiActionRuntime, type EmitContext, type RawAction } from "./actionRuntime";

/** Props contract for ABI v2 custom components (mirrors `easy-ui/runtime`). */
export interface EasyUIComponentProps<P = Record<string, unknown>> extends BaseComponentProps<P> {
  emit: (event: string, payload?: unknown) => void;
  slots: Record<string, ReactNode>;
}

export interface EasyUiRuntimeValue {
  metadata: Record<string, ElementMetadata>;
  runtime: EasyUiActionRuntime | null;
  definitions: Record<string, ComponentDefinition>;
  onError?: (message: string, detail?: Record<string, unknown>) => void;
}

const EasyUiRuntimeContext = createContext<EasyUiRuntimeValue | null>(null);

export function EasyUiRuntimeProvider({ value, children }: { value: EasyUiRuntimeValue; children: ReactNode }) {
  return <EasyUiRuntimeContext.Provider value={value}>{children}</EasyUiRuntimeContext.Provider>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

let correlationSeq = 0;
/** Synchronous correlation id assigned per emit, linking the event entry to its action entries. */
const nextCorrelationId = (): string => `e${++correlationSeq}`;

/** Deep-verifies a payload is JSON-safe and contains no `$`-prefixed keys, then deep-freezes it. */
export function freezeJsonSafePayload(value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  const walk = (node: unknown): boolean => {
    if (node === null) return true;
    const t = typeof node;
    if (t === "string" || t === "boolean") return true;
    if (t === "number") return Number.isFinite(node as number);
    if (Array.isArray(node)) return node.every(walk);
    if (isObject(node)) {
      for (const key of Object.keys(node)) {
        if (key.startsWith("$")) return false;
        if (!walk(node[key])) return false;
      }
      return true;
    }
    return false;
  };
  if (value === undefined) return { ok: true, value: undefined };
  if (!walk(value)) return { ok: false, error: "payload must be JSON-safe and free of $-prefixed keys" };
  const clone = deepFreeze(structuredClone(value));
  return { ok: true, value: clone };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

function stripEuiProps(props: Record<string, unknown>): Record<string, unknown> {
  let hasEui = false;
  for (const key of Object.keys(props)) if (key.startsWith("__eui")) { hasEui = true; break; }
  if (!hasEui) return props;
  return Object.fromEntries(Object.entries(props).filter(([key]) => !key.startsWith("__eui")));
}

/**
 * Wraps a custom component so it receives `emit(name, payload?)`, a replaced
 * `on()`, and `slots`. Reads raw `on` bindings and item context from the
 * runtime side-channel (never from props) and routes dispatch through the
 * hardened {@link EasyUiActionRuntime}. Tolerates a missing runtime context
 * (inert canvases such as CJM/editor) by making emit a no-op.
 */
export function wrapCustomComponent(name: string, Component: ComponentType<EasyUIComponentProps>): ComponentType {
  const Adapter = (libraryProps: BaseComponentProps) => {
    const context = useContext(EasyUiRuntimeContext);
    const repeatScope = useRepeatScope();
    const rawProps = libraryProps.props as Record<string, unknown>;
    const euiKey = typeof rawProps[EUI_KEY_PROP] === "string" ? (rawProps[EUI_KEY_PROP] as string) : undefined;
    const props = stripEuiProps(rawProps);

    const meta = euiKey ? context?.metadata[euiKey] : undefined;
    const on = meta?.on;
    const runtime = context?.runtime ?? null;
    const definition = context?.definitions[name];
    const onErrorFromContext = context?.onError;
    const reportError = useMemo(() => onErrorFromContext ?? (() => {}), [onErrorFromContext]);

    const emit = useMemo(() => (event: string, payload?: unknown) => {
      if (!runtime || !on) return;
      const bindings = on[event] as RawAction | RawAction[] | undefined;
      if (!bindings) return;
      const logger = runtime.logger;
      const correlationId = logger ? nextCorrelationId() : "";
      const logEvent = (delivered: unknown, payloadValid: boolean) =>
        logger?.logEvent({ correlationId, elementId: euiKey ?? "", component: name, event, payload: delivered, payloadValid });
      const schema = definition?.eventPayloadSchemas?.[event];
      let deliveredPayload: unknown = undefined;
      if (schema) {
        const parsed = schema.safeParse(payload);
        if (!parsed.success) {
          logEvent(payload, false);
          logger?.logRuntimeError(`event "${event}" payload failed validation`, { component: name, event });
          reportError(`event "${event}" payload failed validation`, { component: name, event });
          return;
        }
        const safe = freezeJsonSafePayload(parsed.data);
        if (!safe.ok) {
          logEvent(payload, false);
          logger?.logRuntimeError(`event "${event}": ${safe.error}`, { component: name, event });
          reportError(`event "${event}": ${safe.error}`, { component: name, event });
          return;
        }
        deliveredPayload = safe.value;
      }
      logEvent(deliveredPayload, true);
      const itemKey = repeatScope && meta?.repeatKey !== undefined && itemField(repeatScope.item, meta.repeatKey);
      const ctx: EmitContext = {
        event,
        payload: deliveredPayload,
        elementId: euiKey ?? "",
        ...(correlationId ? { correlationId } : {}),
        ...(repeatScope ? { itemIndex: repeatScope.index } : {}),
        ...(repeatScope && meta?.repeatKey !== undefined ? { itemKey } : {}),
      };
      void runtime.dispatch(bindings, ctx);
    }, [runtime, on, definition, repeatScope, meta, euiKey, reportError]);

    const onHandle = useMemo(() => (event: string) => {
      const bindings = on?.[event] as RawAction | RawAction[] | undefined;
      return {
        emit: () => emit(event),
        shouldPreventDefault: EasyUiActionRuntime.shouldPreventDefault(bindings),
        bound: Boolean(bindings),
      };
    }, [on, emit]);

    // Named-slot routing (custom components with capabilities.namedSlots). Children arrive from the
    // library in element.children order, so slotIndices (side-channel) map positions to slot names.
    // Contract: for a named-slot component `children === slots.default`; legacy components without the
    // capability keep the prior single-child behavior (slots carries only `default`).
    const namedSlots = definition?.capabilities?.namedSlots === true;
    const slotIndices = meta?.slotIndices;
    const slots = useMemo<Record<string, ReactNode>>(() => {
      if (!namedSlots || !slotIndices) return { default: libraryProps.children };
      const array = Children.toArray(libraryProps.children);
      const result: Record<string, ReactNode> = { default: [] };
      for (const [slotName, indices] of Object.entries(slotIndices)) {
        result[slotName] = indices.map((index) => array[index]).filter((node) => node !== undefined);
      }
      return result;
    }, [namedSlots, slotIndices, libraryProps.children]);

    const componentProps: EasyUIComponentProps = {
      ...libraryProps,
      props,
      emit,
      on: onHandle,
      slots,
      ...(namedSlots ? { children: slots.default } : {}),
    };
    return <Component {...componentProps} />;
  };
  Adapter.displayName = `EasyUiAdapter(${name})`;
  return Adapter as ComponentType;
}

function itemField(item: unknown, field: string): unknown {
  if (item && typeof item === "object" && !Array.isArray(item)) return (item as Record<string, unknown>)[field];
  return undefined;
}
