import type { Spec } from "@json-render/core";
import { Renderer, type ComponentRegistry } from "@json-render/react";

export interface CanvasLayersProps {
  canvas: { width: number; height: number };
  specs: { content: Spec | null; hotspots: Spec[] };
  registry: ComponentRegistry;
}

export function CanvasLayers({ canvas, specs: { content, hotspots }, registry }: CanvasLayersProps) {
  return <div className="relative" style={{ width: canvas.width, height: canvas.height }}>
    <div className="absolute inset-0">{content ? <Renderer registry={registry} spec={content} /> : null}</div>
    <div className="pointer-events-none absolute inset-0" aria-label="Hotspots">
      {hotspots.map((spec) => <div className="pointer-events-auto" key={spec.root}><Renderer registry={registry} spec={spec} /></div>)}
    </div>
  </div>;
}
