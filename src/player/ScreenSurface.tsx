import { Renderer } from "@json-render/react";
import { useEffect, useMemo } from "react";
import type { ComponentDefinition } from "../catalog/definitions";
import type { createPlayerRuntime } from "../catalog/runtime";
import { splitCanvas, type RuntimeTree } from "../prototype/runtimeSpec";
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
export function ScreenSurface({ registry, runtime, customDefinitions, onError, tree, canvas }: ScreenSurfaceProps) {
  const specs = useMemo(() => {
    if (canvas) {
      const { content, hotspots } = splitCanvas(tree);
      return { content: content?.spec ?? null, hotspots: hotspots.map((h) => h.spec) };
    }
    return { content: tree.spec, hotspots: [] };
  }, [canvas, tree]);

  useEffect(() => { runtime.setScreenSpec(specs.content); return () => runtime.setScreenSpec(null); }, [runtime, specs]);

  const body = canvas
    ? <CanvasLayers canvas={canvas} specs={specs} registry={registry} />
    : specs.content
      ? <Renderer registry={registry} spec={specs.content} />
      : null;

  return <EasyUiRuntimeProvider value={{ metadata: tree.metadata, runtime, definitions: customDefinitions, onError }}>
    {body}
  </EasyUiRuntimeProvider>;
}
