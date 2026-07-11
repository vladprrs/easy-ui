import { markDevtoolsActive } from "@json-render/core";
import { JSONUIProvider, Renderer, type ComponentRegistry, type JSONUIProviderProps } from "@json-render/react";
import { Component, type ErrorInfo, type MouseEvent, type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PrototypeDoc } from "../prototype/schema";
import { toRuntimeSpec } from "../prototype/runtimeSpec";
import { mergeScreenState } from "../prototype/stateOverrides";
import { CanvasLayers } from "../player/CanvasLayers";
import { splitCanvasSpec } from "../player/canvasSpec";
import { stripSpecEvents } from "./stripSpecEvents";

const DEVICE_WIDTH = { mobile: 390, tablet: 834, desktop: 1280 } as const;

type Screen = PrototypeDoc["screens"][number];
type SelectionRect = { left: number; top: number; width: number; height: number };

function containsPoint(rect: DOMRect, x: number, y: number) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function domDepth(element: Element, root: Element) {
  let depth = 0;
  let current: Element | null = element;
  while (current && current !== root) {
    depth += 1;
    current = current.parentElement;
  }
  return depth;
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
}

export function EditorFrame({ nativeWidth, nativeHeight, viewportRef, previewRootRef, children, overlay, frames }: {
  nativeWidth: number;
  nativeHeight?: number;
  viewportRef: RefObject<HTMLDivElement | null>;
  previewRootRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
  overlay: ReactNode;
  frames: ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
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
    <div ref={viewportRef} className="relative overflow-hidden rounded-xl border bg-background shadow-sm" style={{ width: nativeWidth * scale, height: contentHeight * scale }}>
      <div style={{ width: nativeWidth, ...(nativeHeight === undefined ? {} : { height: nativeHeight }), transform: `scale(${scale})`, transformOrigin: "top left" }}>
        <div ref={previewRootRef} inert>{children}</div>
      </div>
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

export function EditorCanvas({ doc, screen, registry, handlers, runtimeKey, stateEpoch, selectedKey, onSelect }: EditorCanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const previewRootRef = useRef<HTMLDivElement>(null);
  const [selectionRects, setSelectionRects] = useState<SelectionRect[]>([]);

  useEffect(() => markDevtoolsActive(), []);

  const spec = useMemo(() => stripSpecEvents(toRuntimeSpec(screen.spec)), [screen.spec]);
  const hasRoot = Boolean(spec.root && spec.elements[spec.root]);
  const specs = useMemo(() => screen.canvas && hasRoot ? splitCanvasSpec(spec) : null, [hasRoot, screen.canvas, spec]);
  const initialState = useMemo(() => mergeScreenState(doc.state, screen.stateOverrides), [doc.state, screen.stateOverrides]);

  const measureSelection = useCallback(() => {
    const previewRoot = previewRootRef.current;
    const viewport = viewportRef.current;
    if (!selectedKey || !previewRoot || !viewport) {
      setSelectionRects([]);
      return;
    }
    const tagged = Array.from(previewRoot.querySelectorAll<HTMLElement>("span[data-jr-key]"))
      .find((element) => element.dataset.jrKey === selectedKey);
    if (!tagged) {
      setSelectionRects([]);
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(tagged);
    const viewportRect = viewport.getBoundingClientRect();
    setSelectionRects(Array.from(range.getClientRects(), (rect) => ({
      left: rect.left - viewportRect.left + viewport.scrollLeft,
      top: rect.top - viewportRect.top + viewport.scrollTop,
      width: rect.width,
      height: rect.height,
    })));
  }, [selectedKey]);

  useLayoutEffect(() => {
    measureSelection();
    const previewRoot = previewRootRef.current;
    const viewport = viewportRef.current;
    if (typeof ResizeObserver === "undefined" || !previewRoot || !viewport) return;
    const observer = new ResizeObserver(measureSelection);
    observer.observe(previewRoot);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [selectedKey, doc, screen.id, measureSelection]);

  const handleHitTest = (event: MouseEvent<HTMLDivElement>) => {
    const previewRoot = previewRootRef.current;
    if (!previewRoot) {
      onSelect(null);
      return;
    }

    let best: { key: string; depth: number; area: number } | null = null;
    for (const tagged of previewRoot.querySelectorAll<HTMLElement>("span[data-jr-key]")) {
      const key = tagged.dataset.jrKey;
      if (!key) continue;
      const range = document.createRange();
      range.selectNodeContents(tagged);
      const clientRects = Array.from(range.getClientRects());
      if (!clientRects.some((rect) => containsPoint(rect, event.clientX, event.clientY))) continue;

      const unionRect = range.getBoundingClientRect();
      const candidate = {
        key,
        depth: domDepth(tagged, previewRoot),
        area: unionRect.width * unionRect.height,
      };
      if (!best || candidate.depth > best.depth || (candidate.depth === best.depth && candidate.area < best.area)) {
        best = candidate;
      }
    }
    onSelect(best?.key ?? null);
  };

  const rendered = !hasRoot
    ? <div className="flex h-64 items-center justify-center text-sm text-eui-slate-500">Нет содержимого</div>
    : screen.canvas && specs
      ? <CanvasLayers canvas={screen.canvas} specs={specs} registry={registry} />
      : <Renderer registry={registry} spec={spec} />;

  return <EditorCanvasErrorBoundary key={screen.id} prototypeId={doc.id} screenId={screen.id}>
    <JSONUIProvider key={`${runtimeKey}:${screen.id}:${stateEpoch}`} registry={registry} handlers={handlers} initialState={initialState}>
      <EditorFrame
        nativeWidth={screen.canvas?.width ?? DEVICE_WIDTH[doc.device]}
        nativeHeight={screen.canvas?.height}
        viewportRef={viewportRef}
        previewRootRef={previewRootRef}
        overlay={<div className="absolute inset-0 z-40 cursor-default" data-testid="editor-hit-overlay" onClick={handleHitTest} />}
        frames={<div className="pointer-events-none absolute inset-0 z-50" aria-hidden="true">{selectionRects.map((rect, index) => <div key={index} data-testid="editor-selection-frame" className="absolute border-2 border-eui-magenta" style={rect} />)}</div>}
      >{rendered}</EditorFrame>
    </JSONUIProvider>
  </EditorCanvasErrorBoundary>;
}
