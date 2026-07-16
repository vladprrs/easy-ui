import type { Spec } from "@json-render/core";
import { Renderer, type ComponentRegistry } from "@json-render/react";

export interface CanvasLayersProps {
  canvas: { width: number; height: number };
  specs: { content: Spec | null; hotspots: Spec[]; overlays?: Spec[] };
  registry: ComponentRegistry;
}

export function CanvasLayers({ canvas, specs: { content, hotspots, overlays = [] }, registry }: CanvasLayersProps) {
  return <div className="relative" style={{ width: canvas.width, height: canvas.height }}>
    <div className="absolute inset-0">{content ? <Renderer registry={registry} spec={content} /> : null}</div>
    <div className="pointer-events-none absolute inset-0" aria-label="Хотспоты">
      {hotspots.map((spec) => <div className="pointer-events-auto" key={spec.root}><Renderer registry={registry} spec={spec} /></div>)}
    </div>
    {overlays.length > 0 ? <div className="pointer-events-none absolute inset-0" data-eui-canvas-layer="overlay">
      {overlays.map((spec) => <Renderer registry={registry} spec={spec} key={spec.root} />)}
    </div> : null}
  </div>;
}
