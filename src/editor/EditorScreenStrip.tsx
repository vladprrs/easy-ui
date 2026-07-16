import { JSONUIProvider, Renderer, type ComponentRegistry, type JSONUIProviderProps } from "@json-render/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { chip, chipActive } from "../app/chrome";
import { editor } from "../app/strings/editor";
import type { ComponentDefinition } from "../catalog/definitions";
import { HostStageSurface } from "../catalog/hostPrimitives";
import type { ThemeContent } from "../api/client";
import type { PrototypeDoc } from "../prototype/schema";
import { mergeScreenState } from "../prototype/stateOverrides";
import { splitCanvas, splitHostPrimitives, stripEvents, toRuntimeSpec, type RuntimeTree } from "../prototype/runtimeSpec";
import { TileErrorBoundary } from "../cjm/CjmScreenTile";
import { createCjmRegistry } from "../cjm/cjmRegistry";
import { EasyUiRuntimeProvider, type EasyUiRuntimeValue } from "../player/easyUiRuntime";
import { editorStripTile, previewNativeWidth } from "../designSystems/deviceMetrics";
import { SurfaceSpacingScope } from "../designSystems/SurfaceSpacingScope";
import { CanvasLayers } from "../player/CanvasLayers";

type Screen = PrototypeDoc["screens"][number];

/**
 * Компактный фрейм тайла ленты (W2-1): как CjmFrame, но с cap высоты
 * `editorStripTile.heightCap`, чтобы лента не съедала вьюпорт редактора.
 * Экран рендерится на native-ширине и масштабируется до ширины тайла;
 * лишняя высота обрезается (overflow-hidden).
 */
function StripFrame({ nativeWidth, nativeHeight, resetKey, designSystem, themeTokens, children }: { nativeWidth: number; nativeHeight?: number; resetKey: string; designSystem: string; themeTokens?: ThemeContent["tokens"]; children: ReactNode }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [stageHost, setStageHost] = useState<HTMLDivElement | null>(null);
  const stageHostRef = useMemo(() => ({ current: stageHost }), [stageHost]);
  const setInnerRef = useCallback((node: HTMLDivElement | null) => { innerRef.current = node; setStageHost(node); }, []);
  const scale = editorStripTile.width / nativeWidth;
  const [measuredHeight, setMeasuredHeight] = useState<number>(editorStripTile.fallbackHeight);
  useEffect(() => {
    if (nativeHeight !== undefined) return;
    const element = innerRef.current;
    if (!element) return;
    if (typeof ResizeObserver === "undefined") return;
    const measure = () => setMeasuredHeight(Math.min(element.scrollHeight * scale, editorStripTile.heightCap));
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [nativeHeight, resetKey, scale]);
  const height = nativeHeight === undefined ? measuredHeight : Math.min(nativeHeight * scale, editorStripTile.heightCap);
  return <div className="overflow-hidden rounded-lg bg-background text-foreground" style={{ width: editorStripTile.width, height }}>
    <SurfaceSpacingScope systemId={designSystem} themeTokens={themeTokens}>
      <div ref={setInnerRef} data-eui-stage-viewport="editor-strip" style={{ position: "relative", width: nativeWidth, ...(nativeHeight === undefined ? {} : { height: nativeHeight }), transform: `scale(${scale})`, transformOrigin: "top left" }}><HostStageSurface stageHostRef={stageHostRef}>{children}</HostStageSurface></div>
    </SurfaceSpacingScope>
  </div>;
}

function ScreenTile({ doc, screen, registry, handlers, runtimeKey, stateEpoch, selected, onSelect, customTypes, customDefinitions, themeContent }: {
  doc: PrototypeDoc; screen: Screen; registry: ComponentRegistry; handlers: JSONUIProviderProps["handlers"];
  runtimeKey: string; stateEpoch: number; selected: boolean; onSelect: () => void;
  customTypes?: ReadonlySet<string>; customDefinitions?: Record<string, ComponentDefinition>;
  themeContent?: ThemeContent | null;
}) {
  // Inert runtime tree: events are stripped from spec and metadata alike.
  const tree = useMemo<RuntimeTree | null>(() => {
    const inert = stripEvents(toRuntimeSpec(screen.spec, { customTypes }));
    if (!inert.spec.root || !inert.spec.elements[inert.spec.root]) return null;
    return inert;
  }, [customTypes, screen.spec]);
  const specs = useMemo(() => {
    if (!tree) return null;
    const { content: withoutHostPrimitives, hostPrimitives } = splitHostPrimitives(tree);
    const overlays = hostPrimitives.map((item) => item.spec);
    if (!screen.canvas) return { content: withoutHostPrimitives?.spec ?? null, hotspots: [], overlays };
    const { content } = withoutHostPrimitives ? splitCanvas(withoutHostPrimitives) : { content: null };
    return { content: content?.spec ?? null, hotspots: [], overlays };
  }, [screen.canvas, tree]);
  const runtimeValue = useMemo<EasyUiRuntimeValue>(
    () => ({ metadata: tree?.metadata ?? {}, runtime: null, definitions: customDefinitions ?? {} }),
    [customDefinitions, tree],
  );
  const initialState = useMemo(() => mergeScreenState(doc.state, screen.stateOverrides), [doc.state, screen.stateOverrides]);
  const key = `${runtimeKey}:${screen.id}:${stateEpoch}`;
  return <article style={{ width: editorStripTile.width }}>
    <div className="relative">
      <TileErrorBoundary key={key} prototypeId={doc.id} screenId={screen.id}>
        <JSONUIProvider key={key} registry={registry} handlers={handlers} initialState={initialState}>
          <div inert>{tree && specs ? <StripFrame nativeWidth={screen.canvas?.width ?? previewNativeWidth[doc.device]} nativeHeight={screen.canvas?.height} resetKey={key} designSystem={doc.designSystem} themeTokens={themeContent?.tokens}><EasyUiRuntimeProvider value={runtimeValue}>{screen.canvas ? <CanvasLayers canvas={screen.canvas} specs={specs} registry={registry} /> : <>{specs.content ? <Renderer registry={registry} spec={specs.content} /> : null}{specs.overlays.map((overlaySpec) => <Renderer registry={registry} spec={overlaySpec} key={overlaySpec.root} />)}</>}</EasyUiRuntimeProvider></StripFrame> : <div className="flex items-center justify-center rounded-lg border border-eui-ink/10 bg-white text-sm text-eui-slate-500" style={{ width: editorStripTile.width, height: editorStripTile.heightCap }}>{editor.noContent}</div>}</div>
        </JSONUIProvider>
      </TileErrorBoundary>
      <button type="button" aria-label={editor.selectScreenAria(screen.name)} aria-pressed={selected} onClick={onSelect} className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring aria-pressed:ring-4 aria-pressed:ring-primary" />
    </div>
    <h3 className={`${selected ? chipActive : `${chip} border-eui-ink/10 bg-white`} mt-2 max-w-full font-eui-ui`}><span className="truncate">{screen.name}</span></h3>
  </article>;
}

export function EditorScreenStrip({ doc, registry, handlers, runtimeKey, stateEpoch, selectedScreenId, onSelect, customTypes, customDefinitions, themeContent }: {
  doc: PrototypeDoc; registry: ComponentRegistry; handlers: JSONUIProviderProps["handlers"]; runtimeKey: string;
  stateEpoch: number; selectedScreenId: string; onSelect: (screenId: string) => void;
  customTypes?: ReadonlySet<string>; customDefinitions?: Record<string, ComponentDefinition>;
  themeContent?: ThemeContent | null;
}) {
  const staticRegistry = useMemo(() => createCjmRegistry(registry), [registry]);
  const [collapsed, setCollapsed] = useState(false);
  // font-eui-ui не выставляется на секции целиком: тайлы рендерят живой контент
  // прототипа, который не должен наследовать шрифт хрома (restyle-инвариант).
  return <section className="shrink-0 border-b border-eui-ink/10 bg-white" aria-label={editor.screensStripAria}>
    {/* Хедер вне горизонтального скролла: заголовок и тоггл всегда видимы (W2-1). */}
    <header className="sticky top-0 left-0 z-10 flex items-center justify-between gap-3 bg-white px-6 pt-3 font-eui-ui">
      <h2 className="text-sm font-medium text-eui-slate-500">{editor.screensTitle(doc.screens.length)}</h2>
      <button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)} className={`${chip} border-eui-ink/10 bg-white hover:bg-eui-lilac-100`}>{collapsed ? editor.expandStrip : editor.collapseStrip}</button>
    </header>
    {collapsed
      ? <ol className="flex items-center gap-2 overflow-x-auto px-6 py-3 font-eui-ui">
        {doc.screens.map((screen) => <li className="shrink-0" key={screen.id}>
          <button type="button" aria-label={editor.selectScreenAria(screen.name)} aria-pressed={screen.id === selectedScreenId} onClick={() => onSelect(screen.id)} className={screen.id === selectedScreenId ? chipActive : `${chip} bg-white hover:bg-eui-lilac-100`}>{screen.name}</button>
        </li>)}
      </ol>
      : <ol className="flex items-start gap-6 overflow-x-auto px-6 py-3">
        {doc.screens.map((screen) => <li className="shrink-0" key={screen.id}><ScreenTile doc={doc} screen={screen} registry={staticRegistry} handlers={handlers} runtimeKey={runtimeKey} stateEpoch={stateEpoch} selected={screen.id === selectedScreenId} onSelect={() => onSelect(screen.id)} customTypes={customTypes} customDefinitions={customDefinitions} themeContent={themeContent} /></li>)}
      </ol>}
  </section>;
}
