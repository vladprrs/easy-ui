import { JSONUIProvider, Renderer, type ComponentRegistry, type JSONUIProviderProps } from "@json-render/react";
import { useMemo } from "react";
import { chip, chipActive } from "../app/chrome";
import { editor } from "../app/strings/editor";
import type { PrototypeDoc } from "../prototype/schema";
import { mergeScreenState } from "../prototype/stateOverrides";
import { toRuntimeSpec } from "../prototype/runtimeSpec";
import { CjmFrame, TileErrorBoundary } from "../cjm/CjmScreenTile";
import { createCjmRegistry } from "../cjm/cjmRegistry";
import { splitCanvasSpec } from "../player/canvasSpec";
import { stripSpecEvents } from "./stripSpecEvents";

const DEVICE_WIDTH = { mobile: 390, tablet: 834, desktop: 1280 } as const;
type Screen = PrototypeDoc["screens"][number];

function ScreenTile({ doc, screen, registry, handlers, runtimeKey, stateEpoch, selected, onSelect }: {
  doc: PrototypeDoc; screen: Screen; registry: ComponentRegistry; handlers: JSONUIProviderProps["handlers"];
  runtimeKey: string; stateEpoch: number; selected: boolean; onSelect: () => void;
}) {
  const spec = useMemo(() => {
    const stripped = stripSpecEvents(toRuntimeSpec(screen.spec).spec);
    if (!stripped.root || !stripped.elements[stripped.root]) return null;
    return screen.canvas ? splitCanvasSpec(stripped).content : stripped;
  }, [screen.canvas, screen.spec]);
  const initialState = useMemo(() => mergeScreenState(doc.state, screen.stateOverrides), [doc.state, screen.stateOverrides]);
  const key = `${runtimeKey}:${screen.id}:${stateEpoch}`;
  return <article className="w-[280px]">
    <div className="relative">
      <TileErrorBoundary key={key} prototypeId={doc.id} screenId={screen.id}>
        <JSONUIProvider key={key} registry={registry} handlers={handlers} initialState={initialState}>
          <div inert>{spec ? <CjmFrame nativeWidth={screen.canvas?.width ?? DEVICE_WIDTH[doc.device]} nativeHeight={screen.canvas?.height} resetKey={key}><Renderer registry={registry} spec={spec} /></CjmFrame> : <div className="flex h-64 w-[280px] items-center justify-center rounded-lg border border-eui-ink/10 bg-white text-sm text-eui-slate-500">{editor.noContent}</div>}</div>
        </JSONUIProvider>
      </TileErrorBoundary>
      <button type="button" aria-label={editor.selectScreenAria(screen.name)} aria-pressed={selected} onClick={onSelect} className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring aria-pressed:ring-4 aria-pressed:ring-primary" />
    </div>
    <h2 className={`${selected ? chipActive : `${chip} border-eui-ink/10 bg-white`} mt-3 font-eui-ui`}>{screen.name}</h2>
  </article>;
}

export function EditorScreenStrip({ doc, registry, handlers, runtimeKey, stateEpoch, selectedScreenId, onSelect }: {
  doc: PrototypeDoc; registry: ComponentRegistry; handlers: JSONUIProviderProps["handlers"]; runtimeKey: string;
  stateEpoch: number; selectedScreenId: string; onSelect: (screenId: string) => void;
}) {
  const staticRegistry = useMemo(() => createCjmRegistry(registry), [registry]);
  return <ol className="flex items-start gap-6 overflow-x-auto border-b border-eui-ink/10 bg-white px-6 py-4" aria-label={editor.screensStripAria}>
    {doc.screens.map((screen) => <li className="shrink-0" key={screen.id}><ScreenTile doc={doc} screen={screen} registry={staticRegistry} handlers={handlers} runtimeKey={runtimeKey} stateEpoch={stateEpoch} selected={screen.id === selectedScreenId} onSelect={() => onSelect(screen.id)} /></li>)}
  </ol>;
}
