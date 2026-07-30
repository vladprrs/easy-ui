import { JSONUIProvider, Renderer, type ComponentRegistry, type JSONUIProviderProps } from "@json-render/react";
import { Component, createRef, type ErrorInfo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { ComponentDefinition } from "../catalog/definitions";
import { HostStageSurface } from "../catalog/hostPrimitives";
import type { ThemeContent } from "../api/client";
import type { PrototypeDoc } from "../prototype/schema";
import { mergeScreenState } from "../prototype/stateOverrides";
import { parseNavigateBinding } from "../prototype/navigateBinding";
import { buildScreenRenderPlan, stripEvents, toRuntimeSpec, type RuntimeTree } from "../prototype/runtimeSpec";
import { EasyUiRuntimeProvider, type EasyUiRuntimeValue } from "../player/easyUiRuntime";
import { buildPlayerPath } from "../player/navigation";
import { cjm } from "../app/strings/cjm";
import { lightboxStageTile, previewNativeWidth, previewTileSizes, sheetStripTile } from "../designSystems/deviceMetrics";
import type { DeviceKind } from "../designSystems/deviceMetrics";
import { SurfaceSpacingScope } from "../designSystems/SurfaceSpacingScope";
import { CanvasLayers } from "../player/CanvasLayers";

export type CjmTransition =
  | { kind: "static"; screenId: string; screenName: string }
  | { kind: "dynamic" };

/**
 * Reads authored press bindings only. These labels never add or reorder CJM tiles.
 * Разбор одного биндинга делегирован общему `parseNavigateBinding`; `conditional`
 * здесь намеренно игнорируется — переход под `$if` остаётся статическим (T3).
 */
export function getCjmTransitions(screen: PrototypeDoc["screens"][number], screens: PrototypeDoc["screens"]): CjmTransition[] {
  const screenNames = new Map(screens.map((item) => [item.id, item.name]));
  const transitions: CjmTransition[] = [];
  const seen = new Set<string>();
  for (const element of Object.values(screen.spec.elements)) {
    const binding = element.on?.press;
    if (binding === undefined) continue;
    for (const target of parseNavigateBinding(binding, screenNames)) {
      const key = target.kind === "static" ? `static:${target.screenId}` : "dynamic";
      if (seen.has(key)) continue;
      seen.add(key);
      transitions.push(target.kind === "static"
        ? { kind: "static", screenId: target.screenId, screenName: target.screenName }
        : { kind: "dynamic" });
    }
  }
  return transitions;
}

export function CjmFrame({ device, nativeWidth, nativeHeight, resetKey, designSystem, themeTokens, size, children }: { device: DeviceKind; nativeWidth: number; nativeHeight?: number; resetKey: string; designSystem: string; themeTokens?: ThemeContent["tokens"]; size?: { width: number; heightCap: number; fallbackHeight: number }; children: ReactNode }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [stageHost, setStageHost] = useState<HTMLDivElement | null>(null);
  const stageHostRef = useMemo(() => ({ current: stageHost }), [stageHost]);
  const setInnerRef = useCallback((node: HTMLDivElement | null) => { innerRef.current = node; setStageHost(node); }, []);
  const tileSize = size ?? previewTileSizes[device];
  const scale = tileSize.width / nativeWidth;
  const [measuredHeight, setMeasuredHeight] = useState<number>(tileSize.fallbackHeight);
  const [autoHeightCapped, setAutoHeightCapped] = useState(false);
  useEffect(() => {
    if (nativeHeight !== undefined) return;
    const element = innerRef.current;
    if (!element) return;
    if (typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const scaledHeight = element.scrollHeight * scale;
      setMeasuredHeight(Math.min(scaledHeight, tileSize.heightCap));
      setAutoHeightCapped(scaledHeight > tileSize.heightCap);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [nativeHeight, resetKey, scale, tileSize.heightCap]);
  // Явный `size` (мини-тайл ленты, телефон лайтбокса) — кадр фиксированной формы:
  // в ряду одинаковых «телефонов» авто-высота дала бы рваную ленту (макеты 02/03).
  const height = size !== undefined
    ? size.heightCap
    : nativeHeight === undefined ? measuredHeight : Math.min(nativeHeight * scale, tileSize.heightCap);
  const capped = size !== undefined
    ? (nativeHeight ?? 0) * scale > size.heightCap || (nativeHeight === undefined && autoHeightCapped)
    : nativeHeight === undefined ? autoHeightCapped : nativeHeight * scale > tileSize.heightCap;
  return <div className={`cjm-frame overflow-hidden rounded-field bg-background text-foreground${capped ? " cjm-frame-capped" : ""}`} data-testid="cjm-frame" style={{ width: tileSize.width, height }}>
    <SurfaceSpacingScope systemId={designSystem} themeTokens={themeTokens}>
      <div ref={setInnerRef} data-eui-stage-viewport="cjm" style={{ position: "relative", width: nativeWidth, ...(nativeHeight === undefined ? {} : { height: nativeHeight }), transform: `scale(${scale})`, transformOrigin: "top left" }}><HostStageSurface stageHostRef={stageHostRef}>{children}</HostStageSurface></div>
    </SurfaceSpacingScope>
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

export function CjmScreenTile({ doc, screen, registry, handlers, runtimeKey, routeBase, customTypes, customDefinitions, themeContent, noteOverride, flowId, stepIndex, variant = "full", onOpen }: { doc: PrototypeDoc; screen: PrototypeDoc["screens"][number]; registry: ComponentRegistry; handlers: NonNullable<JSONUIProviderProps["handlers"]>; runtimeKey: string; routeBase: string; customTypes?: ReadonlySet<string>; customDefinitions?: Record<string, ComponentDefinition>; themeContent?: ThemeContent | null; noteOverride?: string; flowId?: string; stepIndex?: number;
  /**
   * `sheet` — мини-тайл ленты «Сценарии» (макет 02): только кадр, подпись рисует лента.
   * `stage` — телефон лайтбокса (макет 03): кадр 330×640 без ссылки поверх.
   */
  variant?: "full" | "sheet" | "stage";
  /** Если задан — тайл открывает лайтбокс (макет 03) вместо перехода в плеер. */
  onOpen?: () => void;
}) {
  // Inert runtime tree: events are stripped from spec and metadata alike.
  const tree = useMemo<RuntimeTree | null>(() => {
    const inert = stripEvents(toRuntimeSpec(screen.spec, { customTypes }));
    if (!inert.spec.root || !inert.spec.elements[inert.spec.root]) return null;
    return inert;
  }, [customTypes, screen.spec]);
  const specs = useMemo(() => {
    if (!tree) return null;
    return buildScreenRenderPlan(tree, { canvas: screen.canvas });
  }, [screen.canvas, tree]);
  const runtimeValue = useMemo<EasyUiRuntimeValue>(
    () => ({ metadata: specs?.metadata ?? {}, runtime: null, definitions: customDefinitions ?? {} }),
    [customDefinitions, specs],
  );
  const initialState = useMemo(() => mergeScreenState(doc.state, screen.stateOverrides), [doc.state, screen.stateOverrides]);
  const transitions = useMemo(() => getCjmTransitions(screen, doc.screens), [doc.screens, screen]);
  const nativeWidth = screen.canvas?.width ?? previewNativeWidth[doc.device];
  const tileWidth = previewTileSizes[doc.device].width;
  const playerPath = buildPlayerPath(routeBase, screen.id);
  const tilePath = flowId === undefined || stepIndex === undefined
    ? playerPath
    : `${playerPath}?${new URLSearchParams({ flow: flowId, step: String(stepIndex) })}`;
  const sheet = variant === "sheet";
  const stage = variant === "stage";
  const frameSize = sheet ? sheetStripTile : stage ? lightboxStageTile : undefined;
  const frame = <>
    <TileErrorBoundary key={`${runtimeKey}:${screen.id}`} prototypeId={doc.id} screenId={screen.id}>
      <JSONUIProvider key={`${runtimeKey}:${screen.id}`} registry={registry} handlers={handlers} initialState={initialState}>
        <div inert>{tree && specs ? <CjmFrame device={doc.device} nativeWidth={nativeWidth} nativeHeight={screen.canvas?.height} resetKey={`${runtimeKey}:${screen.id}`} designSystem={doc.designSystem} themeTokens={themeContent?.tokens} size={frameSize}><EasyUiRuntimeProvider value={runtimeValue}>{screen.canvas ? <CanvasLayers canvas={screen.canvas} specs={specs} registry={registry} /> : <>{specs.content ? <Renderer registry={registry} spec={specs.content} /> : null}{specs.overlays.map((overlaySpec) => <Renderer registry={registry} spec={overlaySpec} key={overlaySpec.root} />)}</>}</EasyUiRuntimeProvider></CjmFrame> : <div className="flex items-center justify-center rounded-field bg-background text-center text-[11px] text-eui-slate-500" style={{ width: sheet ? sheetStripTile.width : tileWidth, height: sheet ? sheetStripTile.fallbackHeight : 256 }}>{cjm.noContent}</div>}</div>
      </JSONUIProvider>
    </TileErrorBoundary>
    {/* Лайтбокс (макет 03) перехватывает клик по тайлу; ссылка в плеер остаётся
        фолбэком, когда обработчика нет — так тайл всегда навигируем. */}
    {stage ? null : onOpen === undefined
      ? <Link to={tilePath} className="cjm-tile-link absolute inset-0 rounded-field" aria-label={cjm.openScreenAria(screen.name, doc.name)} />
      : <button type="button" onClick={onOpen} className="cjm-tile-link absolute inset-0 rounded-field" aria-label={cjm.openScreenAria(screen.name, doc.name)} />}
  </>;

  if (sheet) {
    return <article className="cjm-tile relative rounded-field bg-white p-0" style={{ width: sheetStripTile.width }}>{frame}</article>;
  }

  if (stage) {
    // Телефон не сжимается флексом (`shrink-0`), но и не выше окна: на ноутбучной
    // высоте кадр подрезается снизу, а шапка и лента миниатюр остаются видимыми.
    return <div
      className="relative shrink-0 overflow-hidden rounded-[28px] bg-white"
      style={{ width: lightboxStageTile.width, height: `min(${lightboxStageTile.heightCap}px, calc(100dvh - 300px))` }}
    >{frame}</div>;
  }

  return <article className="cjm-tile rounded-popover bg-white p-3" style={{ width: tileWidth + 24 }}>
    <div className="relative">{frame}</div>
    <div className="mt-4 flex items-start justify-between gap-2">
      <h2 className="min-w-0 truncate text-lg font-medium" title={screen.name}>{screen.name}</h2>
      {screen.stateOverrides === undefined ? null : <span className="shrink-0 rounded-full bg-pay-lavender px-2 py-1 text-[11px] font-medium text-eui-ink">{cjm.demoState}</span>}
    </div>
    {noteOverride ?? screen.note ? <p className="mt-1 text-[13px] text-eui-slate-500">{noteOverride ?? screen.note}</p> : null}
    {transitions.length ? <ul className="mt-3 flex flex-wrap gap-2" aria-label={cjm.transitionsAria}>
      {transitions.map((transition) => <li key={transition.kind === "static" ? `static:${transition.screenId}` : "dynamic"} className="rounded-full bg-pay-lavender px-2.5 py-1 text-xs font-medium text-eui-ink">
        {transition.kind === "static" ? cjm.transitionTo(transition.screenName) : cjm.dynamicTransition}
      </li>)}
    </ul> : null}
  </article>;
}
