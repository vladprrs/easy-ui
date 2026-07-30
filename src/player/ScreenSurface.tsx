import { Renderer } from "@json-render/react";
import { type MouseEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EUI_KEY_ATTRIBUTE } from "../catalog/runtime";
import type { ComponentDefinition } from "../catalog/definitions";
import type { createPlayerRuntime } from "../catalog/runtime";
import { REGION_KINDS } from "../prototype/schema";
import { parseNavigateBinding, type NavigateTarget } from "../prototype/navigateBinding";
import { player } from "../app/strings/player";
import { buildScreenRenderPlan, type ElementMetadata, type RuntimeTree } from "../prototype/runtimeSpec";
import type { EasyUiActionRuntime } from "./actionRuntime";
import { CanvasLayers } from "./CanvasLayers";
import { EasyUiRuntimeProvider } from "./easyUiRuntime";
import { useScreenRegions } from "./ScreenRegions";

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
  /**
   * Включает плеерный оверлей интерактивных зон (T3). Проп опциональный: капчер и
   * презентация его не передают и рендерятся ровно как раньше.
   */
  interactiveZones?: InteractiveZonesOptions | undefined;
}

/** Данные для подписей оверлея зон; собираются вызывающим по документу. */
export interface InteractiveZonesOptions {
  /** `screenId → screen.name` для подписи цели перехода. */
  screenNames: ReadonlyMap<string, string>;
  /** Пояснение про сценарий цели: «в текущем сценарии» / «сценарий: …» / ничего. */
  flowNote?: ((screenId: string) => string | undefined) | undefined;
}

/** Экранный прямоугольник одного вхождения элемента (repeat даёт несколько). */
export interface HighlightRect {
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

/**
 * Замеряет экранные прямоугольники всех `[data-eui-key]`-маркеров с указанными
 * ключами внутри `root`. Общая механика подсветки: используется и misclick-хинтами,
 * и вкладкой «Дерево» debug-инспектора (волна 1).
 */
export function measureMarkerRects(root: ParentNode, keys: ReadonlySet<string>): HighlightRect[] {
  const instances = new Map<string, number>();
  return Array.from(root.querySelectorAll<HTMLElement>(markerSelector)).flatMap((marker) => {
    const key = marker.getAttribute(EUI_KEY_ATTRIBUTE);
    if (key === null || !keys.has(key)) return [];
    const rect = unionMarkerRect(marker);
    if (rect === null) return [];
    const instance = instances.get(key) ?? 0;
    instances.set(key, instance + 1);
    return [{ key, instance, ...rect }];
  });
}

/**
 * Слой подсветки поверх сцены: fixed-портал в `document.body`, без событий мыши.
 * Порталится, чтобы координаты `getBoundingClientRect` не зависели от трансформов
 * и скролла стейджа.
 */
export function HighlightLayer({ rects, visible = true, testId, className }: {
  rects: readonly HighlightRect[];
  visible?: boolean;
  testId: string;
  className: string;
}) {
  if (rects.length === 0) return null;
  return createPortal(
    <div className="pointer-events-none fixed inset-0" style={{ zIndex: 60 }} aria-hidden="true" data-testid={testId}>
      {rects.map((rect) => <div
        key={`${rect.key}:${rect.instance}`}
        data-eui-highlight-key={rect.key}
        className={`fixed ${className}`}
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
  );
}

/**
 * Подпись одной зоны по её `navigate`-целям. Несколько действий — берётся первая
 * статическая цель (иначе первая по порядку) плюс «+N» про остальные. `conditional`
 * добавляет «цель вычисляется» и не отменяет статического имени экрана: ярлыки CJM
 * и граф переходов от `$if` не меняются.
 */
export function zoneLabel(targets: readonly NavigateTarget[], flowNote?: ((screenId: string) => string | undefined) | undefined): string {
  const primary = targets.find((target) => target.kind === "static") ?? targets[0];
  if (primary === undefined) return player.zoneNoTarget;
  const parts = primary.kind === "static"
    ? [player.zoneTo(primary.screenName), flowNote?.(primary.screenId), primary.conditional ? player.zoneComputed : undefined]
    : [player.zoneDynamic];
  const label = parts.filter((part) => part !== undefined && part !== "").join(" · ");
  return targets.length > 1 ? `${label} ${player.zoneMore(targets.length - 1)}` : label;
}

/** Подписи всех интерактивных зон экрана по сырым `on`-биндингам из `specs.metadata`. */
export function zoneLabels(metadata: Record<string, ElementMetadata>, options: InteractiveZonesOptions): Map<string, string> {
  const labels = new Map<string, string>();
  for (const key of interactiveKeys(metadata)) {
    const binding = metadata[key]?.on?.press;
    const targets = binding === undefined ? [] : parseNavigateBinding(binding, options.screenNames);
    labels.set(key, zoneLabel(targets, options.flowNote));
  }
  return labels;
}

interface ClipRect { left: number; top: number; right: number; bottom: number }

/**
 * Клиппинг оверлея считается в JS: слой портален в `document.body` и позиционирован
 * `fixed`, поэтому `overflow: hidden` предков его не обрезает, а ставить им
 * containing block нельзя (сломает misclick-подсветку и вкладку «Дерево»).
 *
 * Клиппер — пересечение прямоугольников **всех** предков-скроллеров и stage-вьюпортов:
 * это разом покрывает два вложенных `[data-eui-stage-viewport]` плеера
 * (`player` и `player-stage`), canvas-скроллер и внешний `player`-скроллер.
 * В fluid-ветке (desktop без canvas) stage-вьюпорта нет вовсе — остаётся один
 * `[data-eui-content-scroller="player"]`; если нет и его (тесты, чужие хосты),
 * клиппера нет и зоны рисуются как есть.
 */
export function zoneClipAncestors(root: Element): HTMLElement[] {
  const selector = "[data-eui-content-scroller], [data-eui-stage-viewport]";
  const found: HTMLElement[] = [];
  for (let node = root.parentElement; node !== null; node = node.parentElement) {
    if (node.matches(selector)) found.push(node);
  }
  return found;
}

function clipOf(root: Element): ClipRect | null {
  let clip: ClipRect | null = null;
  for (const node of zoneClipAncestors(root)) {
    const rect = node.getBoundingClientRect();
    clip = clip === null
      ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
      : {
          left: Math.max(clip.left, rect.left),
          top: Math.max(clip.top, rect.top),
          right: Math.min(clip.right, rect.right),
          bottom: Math.min(clip.bottom, rect.bottom),
        };
  }
  return clip;
}

export interface ZoneRect extends HighlightRect {
  label: string;
  /** Подпись подавлена: зона слишком мала при текущем масштабе или подписи столкнулись. */
  labelVisible: boolean;
}

// Пороги читаемости: прямоугольники пост-трансформные (fit-zoom масштабирует stage
// через `transform: scale()`), поэтому мелкая зона получает только рамку без подписи.
const minLabelWidth = 56;
const minLabelHeight = 18;
const labelBoxHeight = 16;
const labelCharWidth = 6.5;
const labelPadding = 10;

/** Замер зон: экранные прямоугольники + клиппинг + правила подавления подписей. */
export function measureZones(root: ParentNode & Element, keys: ReadonlySet<string>, labels: ReadonlyMap<string, string>): ZoneRect[] {
  const clip = clipOf(root);
  const measured = measureMarkerRects(root, keys).flatMap<ZoneRect>((rect) => {
    const left = clip === null ? rect.left : Math.max(rect.left, clip.left);
    const top = clip === null ? rect.top : Math.max(rect.top, clip.top);
    const right = clip === null ? rect.left + rect.width : Math.min(rect.left + rect.width, clip.right);
    const bottom = clip === null ? rect.top + rect.height : Math.min(rect.top + rect.height, clip.bottom);
    if (right - left <= 0 || bottom - top <= 0) return [];
    return [{
      key: rect.key,
      instance: rect.instance,
      left,
      top,
      width: right - left,
      height: bottom - top,
      label: labels.get(rect.key) ?? player.zoneNoTarget,
      labelVisible: false,
    }];
  });
  const placed: ClipRect[] = [];
  for (const zone of [...measured].sort((a, b) => a.top - b.top || a.left - b.left)) {
    if (zone.width < minLabelWidth || zone.height < minLabelHeight) continue;
    const box: ClipRect = {
      left: zone.left,
      top: zone.top,
      right: zone.left + Math.min(zone.width, labelPadding + zone.label.length * labelCharWidth),
      bottom: zone.top + labelBoxHeight,
    };
    if (placed.some((item) => box.left < item.right && item.left < box.right && box.top < item.bottom && item.top < box.bottom)) continue;
    placed.push(box);
    zone.labelVisible = true;
  }
  return measured;
}

/**
 * Слой интерактивных зон: рамка вокруг каждой зоны и подпись цели перехода.
 * Живёт до выключения тумблера, поэтому стратегия misclick-подсветки (замер один
 * раз на 400 ms) не годится — геометрия перезамеряется на каждый коммит и на
 * внешние изменения (см. `InteractiveZonesSurface`).
 */
function ZoneLayer({ zones }: { zones: readonly ZoneRect[] }) {
  if (zones.length === 0) return null;
  return createPortal(
    <div className="pointer-events-none fixed inset-0" style={{ zIndex: 55 }} aria-hidden="true" data-testid="interactive-zones">
      {zones.map((zone) => <div
        key={`${zone.key}:${zone.instance}`}
        data-eui-zone-key={zone.key}
        className="pointer-events-none fixed rounded-md border-2 border-eui-brand bg-eui-brand/10"
        style={{ left: zone.left, top: zone.top, width: zone.width, height: zone.height }}
      >
        {zone.labelVisible ? <span
          data-eui-zone-label={zone.key}
          className="pointer-events-none absolute left-0 top-0 max-w-full truncate rounded-br-md rounded-tl-sm bg-eui-brand px-1 py-px font-eui-ui text-[11px] leading-none text-white"
        >{zone.label}</span> : null}
      </div>)}
    </div>,
    document.body,
  );
}

function InteractiveZonesSurface({ metadata, options, children }: {
  metadata: Record<string, ElementMetadata>;
  options: InteractiveZonesOptions;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const signatureRef = useRef<string>("");
  const [zones, setZones] = useState<ZoneRect[]>([]);
  const keys = useMemo(() => interactiveKeys(metadata), [metadata]);
  const labels = useMemo(() => zoneLabels(metadata, options), [metadata, options]);

  const measure = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const next = measureZones(root, keys, labels);
    const signature = JSON.stringify(next);
    if (signature === signatureRef.current) return;
    signatureRef.current = signature;
    setZones(next);
  }, [keys, labels]);

  // Перезамер на каждый коммит: смена экрана, состояния, устройства, zoom, сайдбара
  // и инспектора приходит как ре-рендер плеера. Идемпотентен — setState только при
  // фактическом изменении геометрии, поэтому цикла нет.
  useLayoutEffect(measure);
  // Внешние изменения без ре-рендера ScreenSurface: скролл любого предка (capture),
  // resize окна, пересчёт fit-масштаба внутри DeviceFrame (ResizeObserver предков) и
  // смена `transform: scale()` на stage-вьюпорте (MutationObserver по style/class).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const ancestors = zoneClipAncestors(root);
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure());
    const mutationObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => measure());
    for (const node of ancestors) {
      resizeObserver?.observe(node);
      mutationObserver?.observe(node, { attributes: true, attributeFilter: ["style", "class"] });
    }
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [measure]);

  return <div ref={rootRef} style={{ display: "contents" }}>
    {children}
    <ZoneLayer zones={zones} />
  </div>;
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

    const next = measureMarkerRects(root, keys);
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
    <HighlightLayer
      rects={rects}
      visible={visible}
      testId="misclick-highlights"
      className="rounded-md border-2 border-eui-orange bg-eui-orange/15 shadow-[0_0_0_1px_rgba(255,255,255,0.65)]"
    />
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
export function ScreenSurface({ registry, runtime, customDefinitions, onError, tree, canvas, misclickHighlights = false, hostPrimitivesAllowed = true, interactiveZones }: ScreenSurfaceProps) {
  const screenRegions = useScreenRegions();
  const regionPolicy = screenRegions?.disposition;
  const specs = useMemo(() => {
    return buildScreenRenderPlan(tree, { canvas, regionPolicy, renderHostPrimitives: hostPrimitivesAllowed });
  }, [canvas, hostPrimitivesAllowed, regionPolicy, tree]);

  useEffect(() => { runtime.setScreenSpec(tree.spec); return () => runtime.setScreenSpec(null); }, [runtime, tree.spec]);
  useEffect(() => {
    if (specs.hasBlockedHostPrimitives) console.warn("[overlay] Overlay is not rendered on a desktop flow screen without a canvas");
  }, [specs.hasBlockedHostPrimitives, tree]);

  const regionPortals = screenRegions ? REGION_KINDS.map((kind) => {
    const spec = specs.regions[kind];
    const target = screenRegions.targets[kind];
    return spec && target ? createPortal(<Renderer registry={registry} spec={spec} />, target, kind) : null;
  }) : null;
  const body = canvas
    ? <CanvasLayers canvas={canvas} specs={specs} registry={registry} />
    : specs.content
      ? <><Renderer registry={registry} spec={specs.content} />{specs.overlays.map((spec) => <Renderer registry={registry} spec={spec} key={spec.root} />)}{regionPortals}</>
      : <>{specs.overlays.map((spec) => <Renderer registry={registry} spec={spec} key={spec.root} />)}{regionPortals}</>;
  const zoned = interactiveZones
    ? <InteractiveZonesSurface metadata={specs.metadata} options={interactiveZones}>{body}</InteractiveZonesSurface>
    : body;
  const surface = misclickHighlights
    ? <MisclickHighlightSurface metadata={specs.metadata}>{zoned}</MisclickHighlightSurface>
    : zoned;

  return <EasyUiRuntimeProvider value={{ metadata: specs.metadata, runtime, definitions: customDefinitions, onError }}>
    {surface}
  </EasyUiRuntimeProvider>;
}
