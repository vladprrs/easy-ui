import { JSONUIProvider, Renderer, type ComponentRegistry, type JSONUIProviderProps } from "@json-render/react";
import { useMemo } from "react";
import { chip, chipActive } from "../app/chrome";
import { editor } from "../app/strings/editor";
import type { ComponentDefinition } from "../catalog/definitions";
import type { PrototypeDoc } from "../prototype/schema";
import { mergeScreenState } from "../prototype/stateOverrides";
import { splitCanvas, stripEvents, toRuntimeSpec, type RuntimeTree } from "../prototype/runtimeSpec";
import { CjmFrame, TileErrorBoundary } from "../cjm/CjmScreenTile";
import { createCjmRegistry } from "../cjm/cjmRegistry";
import { EasyUiRuntimeProvider, type EasyUiRuntimeValue } from "../player/easyUiRuntime";
import { previewNativeWidth } from "../designSystems/deviceMetrics";

type Screen = PrototypeDoc["screens"][number];

function ScreenTile({ doc, screen, registry, handlers, runtimeKey, stateEpoch, selected, onSelect, customTypes, customDefinitions }: {
  doc: PrototypeDoc; screen: Screen; registry: ComponentRegistry; handlers: JSONUIProviderProps["handlers"];
  runtimeKey: string; stateEpoch: number; selected: boolean; onSelect: () => void;
  customTypes?: ReadonlySet<string>; customDefinitions?: Record<string, ComponentDefinition>;
}) {
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
  const key = `${runtimeKey}:${screen.id}:${stateEpoch}`;
  return <article className="w-[280px]">
    <div className="relative">
      <TileErrorBoundary key={key} prototypeId={doc.id} screenId={screen.id}>
        <JSONUIProvider key={key} registry={registry} handlers={handlers} initialState={initialState}>
          <div inert>{tree ? <CjmFrame nativeWidth={screen.canvas?.width ?? previewNativeWidth[doc.device]} nativeHeight={screen.canvas?.height} resetKey={key}><EasyUiRuntimeProvider value={runtimeValue}><Renderer registry={registry} spec={tree.spec} /></EasyUiRuntimeProvider></CjmFrame> : <div className="flex h-64 w-[280px] items-center justify-center rounded-lg border border-eui-ink/10 bg-white text-sm text-eui-slate-500">{editor.noContent}</div>}</div>
        </JSONUIProvider>
      </TileErrorBoundary>
      <button type="button" aria-label={editor.selectScreenAria(screen.name)} aria-pressed={selected} onClick={onSelect} className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring aria-pressed:ring-4 aria-pressed:ring-primary" />
    </div>
    <h2 className={`${selected ? chipActive : `${chip} border-eui-ink/10 bg-white`} mt-3 font-eui-ui`}>{screen.name}</h2>
  </article>;
}

export function EditorScreenStrip({ doc, registry, handlers, runtimeKey, stateEpoch, selectedScreenId, onSelect, customTypes, customDefinitions }: {
  doc: PrototypeDoc; registry: ComponentRegistry; handlers: JSONUIProviderProps["handlers"]; runtimeKey: string;
  stateEpoch: number; selectedScreenId: string; onSelect: (screenId: string) => void;
  customTypes?: ReadonlySet<string>; customDefinitions?: Record<string, ComponentDefinition>;
}) {
  const staticRegistry = useMemo(() => createCjmRegistry(registry), [registry]);
  return <ol className="flex items-start gap-6 overflow-x-auto border-b border-eui-ink/10 bg-white px-6 py-4" aria-label={editor.screensStripAria}>
    {doc.screens.map((screen) => <li className="shrink-0" key={screen.id}><ScreenTile doc={doc} screen={screen} registry={staticRegistry} handlers={handlers} runtimeKey={runtimeKey} stateEpoch={stateEpoch} selected={screen.id === selectedScreenId} onSelect={() => onSelect(screen.id)} customTypes={customTypes} customDefinitions={customDefinitions} /></li>)}
  </ol>;
}
