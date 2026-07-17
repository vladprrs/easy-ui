import type { Spec } from "@json-render/core";
import { splitCanvas } from "../prototype/runtimeSpec";

export function splitCanvasSpec(spec: Spec) {
  const { content, hotspots } = splitCanvas({ spec, metadata: {} });
  return { content: content?.spec ?? null, hotspots: hotspots.map((item) => item.spec) };
}
