import { Renderer } from "@json-render/react";
import { type MouseEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EUI_KEY_ATTRIBUTE } from "../catalog/runtime";
import type { ComponentDefinition } from "../catalog/definitions";
import type { createPlayerRuntime } from "../catalog/runtime";
import { buildScreenRenderPlan, type ElementMetadata, type RuntimeTree } from "../prototype/runtimeSpec";
import type { EasyUiActionRuntime } from "./actionRuntime";
import { CanvasLayers } from "./CanvasLayers";
import { EasyUiRuntimeProvider } from "./easyUiRuntime";

export interface ScreenSurfaceProps {
  registry: ReturnType<typeof createPlayerRuntime>["registry"];
  runtime: EasyUiActionRuntime;
  customDefinitions: Record<string, ComponentDefinition>;
  onError: (message: string, detail?: Record<string, unknown>) => void;
  tree: RuntimeTree;
  canvas?: { width: number; height: number } | undefined;
  /** Enables player-only 400ms hotspot/on.press hints after a click on inert space. */
  misclickHighlights?: boolean;
  /** Runtime guard for legacy desktop-flow documents that predate Overlay validation. */
  hostPrimitivesAllowed?: boolean;
}

interface HighlightRect {
  key: string;
  instance: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

const markerSelector = `[${EUI_KEY_ATTRIBUTE}]`;

function interactiveKeys(metadata: Record<string, ElementMetadata>): ReadonlySet<string> {
  return new Set(Object.entries(metadata)
    .filter(([, meta]) => meta.type === "Hotspot" || (meta.on !== undefined && Object.hasOwn(meta.on, "press")))
    .map(([key]) => key));
}

function unionMarkerRect(marker: HTMLElement): Omit<HighlightRect, "key" | "instance"> | null {
  const own = marker.getBoundingClientRect();
  const candidates = own.width > 0 || own.height > 0
    ? [own]
    : Array.from(marker.querySelectorAll<HTMLElement>("*")).map((node) => node.getBoundingClientRect());
  const visible = candidates.filter((rect) => rect.width > 0 && rect.height > 0);
  if (!visible.length) return null;
  const left = Math.min(...visible.map((rect) => rect.left));
  const top = Math.min(...visible.map((rect) => rect.top));
  const right = Math.max(...visible.map((rect) => rect.right));
  const bottom = Math.max(...visible.map((rect) => rect.bottom));
  return { left, top, width: right - left, height: bottom - top };
}

function hasSelectedText(): boolean {
  const selection = window.getSelection?.();
  return selection !== null && !selection.isCollapsed && selection.toString().length > 0;
}

function MisclickHighlightSurface({ metadata, children }: { metadata: Record<string, ElementMetadata>; children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [rects, setRects] = useState<HighlightRect[]>([]);
  const [visible, setVisible] = useState(false);
  const keys = useMemo(() => interactiveKeys(metadata), [metadata]);

  const cancelAnimation = () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    if (fadeTimerRef.current !== null) clearTimeout(fadeTimerRef.current);
    if (clearTimerRef.current !== null) clearTimeout(clearTimerRef.current);
    frameRef.current = null;
    fadeTimerRef.current = null;
    clearTimerRef.current = null;
  };

  useEffect(() => () => cancelAnimation(), []);

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (!root || hasSelectedText()) return;
    for (const item of event.nativeEvent.composedPath()) {
      if (!(item instanceof HTMLElement) || !root.contains(item)) continue;
      const key = item.getAttribute(EUI_KEY_ATTRIBUTE);
      if (key !== null && keys.has(key)) return;
    }

    const instances = new Map<string, number>();
    const next = Array.from(root.querySelectorAll<HTMLElement>(markerSelector)).flatMap((marker) => {
      const key = marker.getAttribute(EUI_KEY_ATTRIBUTE);
      if (key === null || !keys.has(key)) return [];
      const rect = unionMarkerRect(marker);
      if (rect === null) return [];
      const instance = instances.get(key) ?? 0;
      instances.set(key, instance + 1);
      return [{ key, instance, ...rect }];
    });
    if (!next.length) return;

    cancelAnimation();
    setVisible(false);
    setRects(next);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      setVisible(true);
    });
    fadeTimerRef.current = setTimeout(() => {
      fadeTimerRef.current = null;
      setVisible(false);
    }, 300);
    clearTimerRef.current = setTimeout(() => {
      clearTimerRef.current = null;
      setRects([]);
    }, 400);
  };

  return <div ref={rootRef} style={{ display: "contents" }} onClick={handleClick}>
    {children}
    {rects.length > 0 ? createPortal(
      <div className="pointer-events-none fixed inset-0" style={{ zIndex: 60 }} aria-hidden="true" data-testid="misclick-highlights">
        {rects.map((rect) => <div
          key={`${rect.key}:${rect.instance}`}
          data-eui-highlight-key={rect.key}
          className="fixed rounded-md border-2 border-eui-orange bg-eui-orange/15 shadow-[0_0_0_1px_rgba(255,255,255,0.65)]"
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            opacity: visible ? 1 : 0,
            transition: "opacity 100ms ease-out",
          }}
        />)}
      </div>,
      document.body,
    ) : null}
  </div>;
}

/**
 * Общая render-поверхность экрана прототипа (W1-2): единственное место, где
 * RuntimeTree превращается в canvas-слои или плоский Renderer и привязывается
 * к action runtime (`setScreenSpec` + EasyUiRuntimeProvider).
 *
 * Потребители — плеер (ScreenView), презентация (PresentShell) и капчер
 * (CaptureSurface). Интерактивность определяется переданным `runtime`:
 * капчер создаёт его с inert-deps, плеер/презентация — с живой навигацией.
 * Хром, стейдж и провайдеры store (JSONUIProvider) остаются у вызывающего.
 */
export function ScreenSurface({ registry, runtime, customDefinitions, onError, tree, canvas, misclickHighlights = false, hostPrimitivesAllowed = true }: ScreenSurfaceProps) {
  const specs = useMemo(() => {
    return buildScreenRenderPlan(tree, { canvas, renderHostPrimitives: hostPrimitivesAllowed });
  }, [canvas, hostPrimitivesAllowed, tree]);

  useEffect(() => { runtime.setScreenSpec(tree.spec); return () => runtime.setScreenSpec(null); }, [runtime, tree.spec]);
  useEffect(() => {
    if (specs.hasBlockedHostPrimitives) console.warn("[overlay] Overlay is not rendered on a desktop flow screen without a canvas");
  }, [specs.hasBlockedHostPrimitives, tree]);

  const body = canvas
    ? <CanvasLayers canvas={canvas} specs={specs} registry={registry} />
    : specs.content
      ? <><Renderer registry={registry} spec={specs.content} />{specs.overlays.map((spec) => <Renderer registry={registry} spec={spec} key={spec.root} />)}</>
      : specs.overlays.map((spec) => <Renderer registry={registry} spec={spec} key={spec.root} />);
  const surface = misclickHighlights
    ? <MisclickHighlightSurface metadata={specs.metadata}>{body}</MisclickHighlightSurface>
    : body;

  return <EasyUiRuntimeProvider value={{ metadata: specs.metadata, runtime, definitions: customDefinitions, onError }}>
    {surface}
  </EasyUiRuntimeProvider>;
}
