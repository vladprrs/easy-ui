import { JSONUIProvider } from "@json-render/react";
import { useMemo } from "react";
import type { StateModel } from "@json-render/react";
import { createPlayerRuntime, type CustomPlayerRuntime, type PlayerRuntimeDeps } from "../catalog/runtime";
import type { ComponentDefinition } from "../catalog/definitions";
import { EasyUiActionRuntime } from "../player/actionRuntime";
import { ScreenSurface } from "../player/ScreenSurface";
import type { RuntimeTree } from "../prototype/runtimeSpec";

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
 * The rendering itself is the shared {@link ScreenSurface} (W1-2) — the same
 * surface the player and presentation mode use with live navigation deps.
 */
export function CaptureSurface({ designSystem, custom, tree, initialState, screenIds, canvas, onError }: CaptureSurfaceProps) {
  const runtime = useMemo(() => createPlayerRuntime(inertDeps, custom, designSystem), [custom, designSystem]);
  const customDefinitions = useMemo<Record<string, ComponentDefinition>>(() => custom?.definitions ?? {}, [custom]);
  const report = useMemo(() => onError ?? noop, [onError]);
  const actionRuntime = useMemo(() => new EasyUiActionRuntime({ initialState, screenIds, deps: inertDeps, onError: report }), [initialState, screenIds, report]);

  return <JSONUIProvider registry={runtime.registry} handlers={runtime.handlers} store={actionRuntime.store}>
    <ScreenSurface registry={runtime.registry} runtime={actionRuntime} customDefinitions={customDefinitions} onError={report} tree={tree} canvas={canvas} />
  </JSONUIProvider>;
}
