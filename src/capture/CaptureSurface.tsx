import { JSONUIProvider, Renderer } from "@json-render/react";
import { useEffect, useMemo } from "react";
import type { StateModel } from "@json-render/react";
import { createPlayerRuntime, type CustomPlayerRuntime, type PlayerRuntimeDeps } from "../catalog/runtime";
import type { ComponentDefinition } from "../catalog/definitions";
import { EasyUiActionRuntime } from "../player/actionRuntime";
import { CanvasLayers } from "../player/CanvasLayers";
import { EasyUiRuntimeProvider } from "../player/easyUiRuntime";
import { splitCanvas, type RuntimeTree } from "../prototype/runtimeSpec";

const noop = () => undefined;
const inertDeps: PlayerRuntimeDeps = { navigate: noop, back: noop, openUrl: noop, restart: noop };

export interface CaptureSurfaceProps {
  designSystem: string;
  custom?: CustomPlayerRuntime;
  tree: RuntimeTree;
  initialState: StateModel;
  screenIds: ReadonlySet<string>;
  canvas?: { width: number; height: number };
  onError?: (message: string, detail?: Record<string, unknown>) => void;
}

/**
 * Renders a single screen (or a single component element) with the exact player
 * runtime — design-system components, the custom-component event adapter, and a
 * hardened action runtime — but without any app chrome. Actions run against
 * inert navigation deps: a capture is a still surface, not an interactive flow.
 */
export function CaptureSurface({ designSystem, custom, tree, initialState, screenIds, canvas, onError }: CaptureSurfaceProps) {
  const runtime = useMemo(() => createPlayerRuntime(inertDeps, custom, designSystem), [custom, designSystem]);
  const customDefinitions = useMemo<Record<string, ComponentDefinition>>(() => custom?.definitions ?? {}, [custom]);
  const report = useMemo(() => onError ?? noop, [onError]);
  const actionRuntime = useMemo(() => new EasyUiActionRuntime({ initialState, screenIds, deps: inertDeps, onError: report }), [initialState, screenIds, report]);

  const specs = useMemo(() => {
    if (canvas) { const { content, hotspots } = splitCanvas(tree); return { content: content?.spec ?? null, hotspots: hotspots.map((h) => h.spec) }; }
    return { content: tree.spec, hotspots: [] };
  }, [canvas, tree]);

  useEffect(() => { actionRuntime.setScreenSpec(specs.content); return () => actionRuntime.setScreenSpec(null); }, [actionRuntime, specs]);

  const body = canvas
    ? <CanvasLayers canvas={canvas} specs={specs} registry={runtime.registry} />
    : specs.content
      ? <Renderer registry={runtime.registry} spec={specs.content} />
      : null;

  return <JSONUIProvider registry={runtime.registry} handlers={runtime.handlers} store={actionRuntime.store}>
    <EasyUiRuntimeProvider value={{ metadata: tree.metadata, runtime: actionRuntime, definitions: customDefinitions, onError: report }}>
      {body}
    </EasyUiRuntimeProvider>
  </JSONUIProvider>;
}
