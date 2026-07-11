import { JSONUIProvider, Renderer, type ComponentRegistry, type JSONUIProviderProps } from "@json-render/react";
import { Component, createRef, type ErrorInfo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { PrototypeDoc } from "../prototype/schema";
import { mergeScreenState } from "../prototype/stateOverrides";
import { toRuntimeSpec } from "../prototype/runtimeSpec";
import { splitCanvasSpec } from "../player/canvasSpec";
import { buildPlayerPath } from "../player/navigation";

const TILE_WIDTH = 280;
const HEIGHT_CAP = 420;
const FALLBACK_HEIGHT = 360;
const DEVICE_WIDTH = { mobile: 390, tablet: 834, desktop: 1280 } as const;

export function CjmFrame({ nativeWidth, nativeHeight, resetKey, children }: { nativeWidth: number; nativeHeight?: number; resetKey: string; children: ReactNode }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const scale = TILE_WIDTH / nativeWidth;
  const [measuredHeight, setMeasuredHeight] = useState(FALLBACK_HEIGHT);
  useEffect(() => {
    if (nativeHeight !== undefined) return;
    const element = innerRef.current;
    if (!element) return;
    if (typeof ResizeObserver === "undefined") return;
    const measure = () => setMeasuredHeight(Math.min(element.scrollHeight * scale, HEIGHT_CAP));
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [nativeHeight, resetKey, scale]);
  const height = nativeHeight === undefined ? measuredHeight : nativeHeight * scale;
  return <div className="overflow-hidden rounded-lg border bg-background shadow-sm" style={{ width: TILE_WIDTH, height }}>
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
    return <div className="flex h-72 w-[280px] items-center justify-center rounded-lg border border-destructive bg-background p-6 text-center" role="alert" data-testid="tile-error"><div><h3 ref={this.heading} className="font-semibold">Экран не удалось отобразить</h3><p className="mt-2 text-xs text-muted-foreground">{this.state.error.message}</p></div></div>;
  }
}

export function CjmScreenTile({ doc, screen, registry, handlers, runtimeKey, routeBase }: { doc: PrototypeDoc; screen: PrototypeDoc["screens"][number]; registry: ComponentRegistry; handlers: NonNullable<JSONUIProviderProps["handlers"]>; runtimeKey: string; routeBase: string }) {
  const spec = useMemo(() => {
    const runtimeSpec = toRuntimeSpec(screen.spec);
    return screen.canvas ? splitCanvasSpec(runtimeSpec).content : runtimeSpec;
  }, [screen.canvas, screen.spec]);
  const initialState = useMemo(() => mergeScreenState(doc.state, screen.stateOverrides), [doc.state, screen.stateOverrides]);
  const nativeWidth = screen.canvas?.width ?? DEVICE_WIDTH[doc.device];
  return <article className="w-[280px]">
    <div className="relative">
      <TileErrorBoundary key={`${runtimeKey}:${screen.id}`} prototypeId={doc.id} screenId={screen.id}>
        <JSONUIProvider key={`${runtimeKey}:${screen.id}`} registry={registry} handlers={handlers} initialState={initialState}>
          <div inert>{spec ? <CjmFrame nativeWidth={nativeWidth} nativeHeight={screen.canvas?.height} resetKey={`${runtimeKey}:${screen.id}`}><Renderer registry={registry} spec={spec} /></CjmFrame> : <div className="flex h-64 w-[280px] items-center justify-center rounded-lg border bg-background text-sm text-muted-foreground">Нет содержимого</div>}</div>
        </JSONUIProvider>
      </TileErrorBoundary>
      <Link to={buildPlayerPath(routeBase, screen.id)} className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring" aria-label={`Открыть экран “${screen.name}” прототипа “${doc.name}” в плеере`} />
    </div>
    <h2 className="mt-4 text-lg font-semibold">{screen.name}</h2>
    {screen.note ? <p className="mt-1 text-sm text-muted-foreground">{screen.note}</p> : null}
  </article>;
}
