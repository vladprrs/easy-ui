import { JSONUIProvider, Renderer, type ComponentRegistry, type JSONUIProviderProps } from "@json-render/react";
import { Component, createRef, type ErrorInfo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { ComponentDefinition } from "../catalog/definitions";
import type { PrototypeDoc } from "../prototype/schema";
import { mergeScreenState } from "../prototype/stateOverrides";
import { splitCanvas, stripEvents, toRuntimeSpec, type RuntimeTree } from "../prototype/runtimeSpec";
import { EasyUiRuntimeProvider, type EasyUiRuntimeValue } from "../player/easyUiRuntime";
import { buildPlayerPath } from "../player/navigation";
import { cjm } from "../app/strings/cjm";
import { previewNativeWidth, previewTile } from "../designSystems/deviceMetrics";

export type CjmTransition =
  | { kind: "static"; screenId: string; screenName: string }
  | { kind: "dynamic" };

/** Reads authored press bindings only. These labels never add or reorder CJM tiles. */
export function getCjmTransitions(screen: PrototypeDoc["screens"][number], screens: PrototypeDoc["screens"]): CjmTransition[] {
  const screenNames = new Map(screens.map((item) => [item.id, item.name]));
  const transitions: CjmTransition[] = [];
  const seen = new Set<string>();
  for (const element of Object.values(screen.spec.elements)) {
    const binding = element.on?.press;
    if (binding === undefined) continue;
    const actions = Array.isArray(binding) ? binding : [binding];
    for (const action of actions) {
      if (action.action !== "navigate") continue;
      const target = action.params?.screenId;
      if (typeof target === "string") {
        const key = `static:${target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        transitions.push({ kind: "static", screenId: target, screenName: screenNames.get(target) ?? target });
      } else if (target !== undefined && !seen.has("dynamic")) {
        seen.add("dynamic");
        transitions.push({ kind: "dynamic" });
      }
    }
  }
  return transitions;
}

export function CjmFrame({ nativeWidth, nativeHeight, resetKey, children }: { nativeWidth: number; nativeHeight?: number; resetKey: string; children: ReactNode }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const scale = previewTile.width / nativeWidth;
  const [measuredHeight, setMeasuredHeight] = useState<number>(previewTile.fallbackHeight);
  useEffect(() => {
    if (nativeHeight !== undefined) return;
    const element = innerRef.current;
    if (!element) return;
    if (typeof ResizeObserver === "undefined") return;
    const measure = () => setMeasuredHeight(Math.min(element.scrollHeight * scale, previewTile.heightCap));
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [nativeHeight, resetKey, scale]);
  const height = nativeHeight === undefined ? measuredHeight : nativeHeight * scale;
  return <div className="overflow-hidden rounded-xl bg-background text-foreground" style={{ width: previewTile.width, height }}>
    <div ref={innerRef} style={{ width: nativeWidth, ...(nativeHeight === undefined ? {} : { height: nativeHeight }), transform: `scale(${scale})`, transformOrigin: "top left" }}>{children}</div>
  </div>;
}

export class TileErrorBoundary extends Component<{ prototypeId: string; screenId: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  private heading = createRef<HTMLHeadingElement>();
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { if (import.meta.env.DEV) console.error(`[cjm] ${this.props.prototypeId}/${this.props.screenId}`, error, info); }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="flex h-72 w-[280px] items-center justify-center rounded-xl border border-destructive bg-background p-6 text-center" role="alert" data-testid="tile-error"><div><h3 ref={this.heading} className="font-eui-ui font-semibold">{cjm.tileErrorTitle}</h3><p className="mt-2 font-eui-ui text-xs text-eui-slate-500">{this.state.error.message}</p></div></div>;
  }
}

export function CjmScreenTile({ doc, screen, registry, handlers, runtimeKey, routeBase, customTypes, customDefinitions }: { doc: PrototypeDoc; screen: PrototypeDoc["screens"][number]; registry: ComponentRegistry; handlers: NonNullable<JSONUIProviderProps["handlers"]>; runtimeKey: string; routeBase: string; customTypes?: ReadonlySet<string>; customDefinitions?: Record<string, ComponentDefinition> }) {
  // Inert runtime tree: events are stripped from spec and metadata alike.
  const tree = useMemo<RuntimeTree | null>(() => {
    const inert = stripEvents(toRuntimeSpec(screen.spec, { customTypes }));
    if (!inert.spec.root || !inert.spec.elements[inert.spec.root]) return null;
    return screen.canvas ? splitCanvas(inert).content : inert;
  }, [customTypes, screen.canvas, screen.spec]);
  const runtimeValue = useMemo<EasyUiRuntimeValue>(
    () => ({ metadata: tree?.metadata ?? {}, runtime: null, definitions: customDefinitions ?? {} }),
    [customDefinitions, tree],
  );
  const initialState = useMemo(() => mergeScreenState(doc.state, screen.stateOverrides), [doc.state, screen.stateOverrides]);
  const transitions = useMemo(() => getCjmTransitions(screen, doc.screens), [doc.screens, screen]);
  const nativeWidth = screen.canvas?.width ?? previewNativeWidth[doc.device];
  return <article className="w-[304px] rounded-[20px] bg-white p-3 shadow-sm">
    <div className="relative">
      <TileErrorBoundary key={`${runtimeKey}:${screen.id}`} prototypeId={doc.id} screenId={screen.id}>
        <JSONUIProvider key={`${runtimeKey}:${screen.id}`} registry={registry} handlers={handlers} initialState={initialState}>
          <div inert>{tree ? <CjmFrame nativeWidth={nativeWidth} nativeHeight={screen.canvas?.height} resetKey={`${runtimeKey}:${screen.id}`}><EasyUiRuntimeProvider value={runtimeValue}><Renderer registry={registry} spec={tree.spec} /></EasyUiRuntimeProvider></CjmFrame> : <div className="flex h-64 w-[280px] items-center justify-center rounded-xl border bg-background font-eui-ui text-sm text-eui-slate-500">{cjm.noContent}</div>}</div>
        </JSONUIProvider>
      </TileErrorBoundary>
      <Link to={buildPlayerPath(routeBase, screen.id)} className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring" aria-label={cjm.openScreenAria(screen.name, doc.name)} />
    </div>
    <div className="mt-4 flex items-start justify-between gap-2">
      <h2 className="font-eui-ui text-lg font-semibold">{screen.name}</h2>
      {screen.stateOverrides === undefined ? null : <span className="shrink-0 rounded-full bg-eui-lilac-100 px-2 py-1 font-eui-ui text-[11px] font-medium text-eui-brand">{cjm.demoState}</span>}
    </div>
    {screen.note ? <p className="mt-1 font-eui-ui text-sm text-eui-slate-500">{screen.note}</p> : null}
    {transitions.length ? <ul className="mt-3 flex flex-wrap gap-2" aria-label={cjm.transitionsAria}>
      {transitions.map((transition) => <li key={transition.kind === "static" ? `static:${transition.screenId}` : "dynamic"} className="rounded-full border border-eui-brand/20 bg-eui-lilac-100 px-2.5 py-1 font-eui-ui text-xs text-eui-brand">
        {transition.kind === "static" ? cjm.transitionTo(transition.screenName) : cjm.dynamicTransition}
      </li>)}
    </ul> : null}
  </article>;
}
