import { markDevtoolsActive } from "@json-render/core";
import { JSONUIProvider, Renderer, type ComponentRegistry, type JSONUIProviderProps } from "@json-render/react";
import { Component, type ErrorInfo, type MouseEvent, type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentDefinition } from "../catalog/definitions";
import { HostStageSurface } from "../catalog/hostPrimitives";
import type { ThemeContent } from "../api/client";
import type { PrototypeDoc } from "../prototype/schema";
import { buildScreenRenderPlan, stripEvents, toRuntimeSpec } from "../prototype/runtimeSpec";
import { mergeScreenState } from "../prototype/stateOverrides";
import { CanvasLayers } from "../player/CanvasLayers";
import { EasyUiRuntimeProvider, type EasyUiRuntimeValue } from "../player/easyUiRuntime";
import { previewNativeWidth } from "../designSystems/deviceMetrics";
import { SurfaceSpacingScope } from "../designSystems/SurfaceSpacingScope";

type Screen = PrototypeDoc["screens"][number];
type SelectionRect = { left: number; top: number; width: number; height: number };
const markerSelector = "span[data-jr-key]";

function unionNodeRect(tagged: HTMLElement, viewport: HTMLElement): SelectionRect | null {
  const range = document.createRange();
  range.selectNodeContents(tagged);
  const rects = [...Array.from(range.getClientRects())];
  for (const descendant of tagged.querySelectorAll<HTMLElement>("*")) rects.push(descendant.getBoundingClientRect());
  const visible = rects.filter((rect) => rect.width > 0 || rect.height > 0);
  if (!visible.length) return null;
  const left = Math.min(...visible.map((rect) => rect.left));
  const top = Math.min(...visible.map((rect) => rect.top));
  const right = Math.max(...visible.map((rect) => rect.right));
  const bottom = Math.max(...visible.map((rect) => rect.bottom));
  const viewportRect = viewport.getBoundingClientRect();
  return {
    left: left - viewportRect.left + viewport.scrollLeft,
    top: top - viewportRect.top + viewport.scrollTop,
    width: right - left,
    height: bottom - top,
  };
}

export interface EditorCanvasProps {
  doc: PrototypeDoc;
  screen: Screen;
  registry: ComponentRegistry;
  handlers?: JSONUIProviderProps["handlers"];
  runtimeKey: string;
  stateEpoch: number;
  selectedKey: string | null;
  onSelect: (elementKey: string | null) => void;
  /** Custom component types of the prototype (their `on` moves to metadata). */
  customTypes?: ReadonlySet<string>;
  /** Custom component definitions, exposed to the runtime side-channel. */
  customDefinitions?: Record<string, ComponentDefinition>;
  themeContent?: ThemeContent | null;
}

export function EditorFrame({ nativeWidth, nativeHeight, designSystem, themeTokens, viewportRef, previewRootRef, children, overlay, frames, onClick, onMouseMove, onMouseLeave }: {
  nativeWidth: number;
  nativeHeight?: number;
  designSystem: string;
  themeTokens?: ThemeContent["tokens"];
  viewportRef: RefObject<HTMLDivElement | null>;
  previewRootRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
  overlay: ReactNode;
  frames: ReactNode;
  onClick?: (event: MouseEvent<HTMLDivElement>) => void;
  onMouseMove?: (event: MouseEvent<HTMLDivElement>) => void;
  onMouseLeave?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [stageHost, setStageHost] = useState<HTMLDivElement | null>(null);
  const stageHostRef = useMemo(() => ({ current: stageHost }), [stageHost]);
  const setStageRef = useCallback((node: HTMLDivElement | null) => { previewRootRef.current = node; setStageHost(node); }, [previewRootRef]);
  const [availableWidth, setAvailableWidth] = useState(nativeWidth);
  const [measuredHeight, setMeasuredHeight] = useState(0);
  const scale = Math.min(1, availableWidth / nativeWidth);
  const contentHeight = nativeHeight ?? measuredHeight;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setAvailableWidth(entry.contentRect.width));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (nativeHeight !== undefined) return;
    const preview = previewRootRef.current;
    if (!preview) return;
    const measure = () => setMeasuredHeight(preview.scrollHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(preview);
    return () => observer.disconnect();
  }, [nativeHeight, previewRootRef]);

  return <div ref={hostRef} className="min-w-0 w-full">
    <div ref={viewportRef} className="relative overflow-hidden rounded-xl border bg-background text-foreground shadow-sm" style={{ width: nativeWidth * scale, height: contentHeight * scale }} onClick={onClick} onMouseMove={onMouseMove} onMouseLeave={onMouseLeave}>
      <SurfaceSpacingScope systemId={designSystem} themeTokens={themeTokens}>
        <div ref={setStageRef} inert data-eui-stage-viewport="editor" style={{ position: "relative", width: nativeWidth, ...(nativeHeight === undefined ? {} : { height: nativeHeight }), transform: `scale(${scale})`, transformOrigin: "top left" }}>
          <HostStageSurface stageHostRef={stageHostRef}><div>{children}</div></HostStageSurface>
        </div>
      </SurfaceSpacingScope>
      {overlay}
      {frames}
    </div>
  </div>;
}

class EditorCanvasErrorBoundary extends Component<{ prototypeId: string; screenId: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) console.error(`[editor] ${this.props.prototypeId}/${this.props.screenId}`, error, info);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return <section role="alert" className="rounded-2xl bg-eui-lilac-100 p-6 text-eui-magenta">
      <h2 className="font-semibold">Экран не удалось отобразить</h2>
      <p className="mt-2 text-sm">{this.state.error.message}</p>
    </section>;
  }
}

export function EditorCanvas({ doc, screen, registry, handlers, runtimeKey, stateEpoch, selectedKey, onSelect, customTypes, customDefinitions, themeContent }: EditorCanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const previewRootRef = useRef<HTMLDivElement>(null);
  const markerCacheRef = useRef(new Map<string, HTMLElement>());
  const hoverFrameRef = useRef<number | null>(null);
  const hoveredKeyRef = useRef<string | null>(null);
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);
  const [hoverRect, setHoverRect] = useState<SelectionRect | null>(null);

  useEffect(() => markDevtoolsActive(), []);

  // Inert runtime tree: events are stripped from both the spec and the metadata,
  // so neither builtin `on` nor custom `emit` can dispatch actions from the canvas.
  const tree = useMemo(() => stripEvents(toRuntimeSpec(screen.spec, { customTypes })), [customTypes, screen.spec]);
  const spec = tree.spec;
  const hasRoot = Boolean(spec.root && spec.elements[spec.root]);
  const specs = useMemo(() => {
    if (!hasRoot) return null;
    return buildScreenRenderPlan(tree, { canvas: screen.canvas });
  }, [hasRoot, screen.canvas, tree]);
  const runtimeValue = useMemo<EasyUiRuntimeValue>(
    () => ({ metadata: specs?.metadata ?? {}, runtime: null, definitions: customDefinitions ?? {} }),
    [customDefinitions, specs],
  );
  const initialState = useMemo(() => mergeScreenState(doc.state, screen.stateOverrides), [doc.state, screen.stateOverrides]);

  const findMarker = useCallback((key: string) => {
    const cached = markerCacheRef.current.get(key);
    if (cached?.isConnected) return cached;
    const marker = Array.from(previewRootRef.current?.querySelectorAll<HTMLElement>(markerSelector) ?? [])
      .find((node) => node.dataset.jrKey === key) ?? null;
    if (marker) markerCacheRef.current.set(key, marker);
    return marker;
  }, []);

  const measureSelection = useCallback(() => {
    const viewport = viewportRef.current;
    if (!selectedKey || !viewport) {
      setSelectionRect(null);
      return;
    }
    const tagged = findMarker(selectedKey);
    if (!tagged) {
      setSelectionRect(null);
      return;
    }
    setSelectionRect(unionNodeRect(tagged, viewport));
  }, [findMarker, selectedKey]);

  useLayoutEffect(() => {
    markerCacheRef.current.clear();
    hoveredKeyRef.current = null;
    // Geometry belongs to the previous runtime tree and must disappear before paint.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHoverRect(null);
  }, [runtimeKey, screen.id, stateEpoch]);

  useLayoutEffect(() => {
    // Selection geometry is an external DOM measurement, synchronized before paint.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    measureSelection();
    if (!selectedKey) return;
    const previewRoot = previewRootRef.current;
    const viewport = viewportRef.current;
    if (!previewRoot || !viewport) return;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measureSelection);
    observer?.observe(previewRoot);
    observer?.observe(viewport);
    viewport.addEventListener("scroll", measureSelection, { passive: true });
    window.addEventListener("resize", measureSelection);
    return () => {
      observer?.disconnect();
      viewport.removeEventListener("scroll", measureSelection);
      window.removeEventListener("resize", measureSelection);
    };
  }, [measureSelection, runtimeKey, screen.id, selectedKey, stateEpoch]);

  useEffect(() => () => {
    if (hoverFrameRef.current !== null) cancelAnimationFrame(hoverFrameRef.current);
  }, []);

  const markerFromEvent = (event: MouseEvent<HTMLDivElement>) => {
    const previewRoot = previewRootRef.current;
    if (!previewRoot) return null;
    const findClosest = (items: EventTarget[]) => {
      for (const item of items) {
        if (!(item instanceof Element)) continue;
        const tagged = item.matches(markerSelector) ? item : item.closest(markerSelector);
        if (!(tagged instanceof HTMLElement) || !previewRoot.contains(tagged)) continue;
        const key = tagged.dataset.jrKey;
        if (!key) return null;
        markerCacheRef.current.set(key, tagged);
        return tagged;
      }
      return null;
    };
    const fromPath = findClosest(event.nativeEvent.composedPath());
    if (fromPath || typeof document.elementFromPoint !== "function") return fromPath;

    // Native inert hit-testing retargets pointer events to the viewport. Disable
    // it only for this synchronous lookup; the preview never receives an event.
    const wasInert = previewRoot.hasAttribute("inert");
    previewRoot.removeAttribute("inert");
    try {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      return target ? findClosest([target]) : null;
    } finally {
      if (wasInert) previewRoot.setAttribute("inert", "");
    }
  };

  const handleMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    const tagged = markerFromEvent(event);
    const key = tagged?.dataset.jrKey ?? null;
    hoveredKeyRef.current = key;
    if (hoverFrameRef.current !== null) cancelAnimationFrame(hoverFrameRef.current);
    hoverFrameRef.current = requestAnimationFrame(() => {
      hoverFrameRef.current = null;
      const viewport = viewportRef.current;
      const current = hoveredKeyRef.current;
      const marker = current ? findMarker(current) : null;
      setHoverRect(viewport && marker ? unionNodeRect(marker, viewport) : null);
    });
  };

  const handleMouseLeave = () => {
    hoveredKeyRef.current = null;
    if (hoverFrameRef.current !== null) {
      cancelAnimationFrame(hoverFrameRef.current);
      hoverFrameRef.current = null;
    }
    setHoverRect(null);
  };

  const handleSelect = (event: MouseEvent<HTMLDivElement>) => {
    onSelect(markerFromEvent(event)?.dataset.jrKey ?? hoveredKeyRef.current);
  };

  const rendered = !hasRoot
    ? <div className="flex h-64 items-center justify-center text-sm text-eui-slate-500">Нет содержимого</div>
    : <EasyUiRuntimeProvider value={runtimeValue}>
      {screen.canvas && specs
        ? <CanvasLayers canvas={screen.canvas} specs={specs} registry={registry} />
        : <>{specs?.content ? <Renderer registry={registry} spec={specs.content} /> : null}{specs?.overlays.map((overlaySpec) => <Renderer registry={registry} spec={overlaySpec} key={overlaySpec.root} />)}</>}
    </EasyUiRuntimeProvider>;

  return <EditorCanvasErrorBoundary key={screen.id} prototypeId={doc.id} screenId={screen.id}>
    <JSONUIProvider key={`${runtimeKey}:${screen.id}:${stateEpoch}`} registry={registry} handlers={handlers} initialState={initialState}>
      <EditorFrame
        nativeWidth={screen.canvas?.width ?? previewNativeWidth[doc.device]}
        nativeHeight={screen.canvas?.height}
        designSystem={doc.designSystem}
        themeTokens={themeContent?.tokens}
        viewportRef={viewportRef}
        previewRootRef={previewRootRef}
        onClick={handleSelect}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        overlay={<div className="pointer-events-none absolute inset-0 z-40 cursor-default" data-testid="editor-hit-overlay" />}
        frames={<div className="pointer-events-none absolute inset-0 z-50" aria-hidden="true">
          {hoverRect && <div data-testid="editor-hover-frame" className="absolute border border-eui-magenta/60" style={hoverRect} />}
          {selectionRect && <div data-testid="editor-selection-frame" className="absolute border-2 border-eui-magenta" style={selectionRect} />}
        </div>}
      >{rendered}</EditorFrame>
    </JSONUIProvider>
  </EditorCanvasErrorBoundary>;
}
