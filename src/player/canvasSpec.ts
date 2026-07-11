import type { Spec } from "@json-render/core";

export function splitCanvasSpec(spec: Spec) {
  const hotspotIds = new Set(Object.entries(spec.elements).filter(([, element]) => element.type === "Hotspot").map(([id]) => id));
  const contentElements = Object.fromEntries(Object.entries(spec.elements)
    .filter(([id]) => !hotspotIds.has(id))
    .map(([id, element]) => [id, element.children ? { ...element, children: element.children.filter((child) => !hotspotIds.has(child)) } : element]));
  const content = contentElements[spec.root] ? { ...spec, elements: contentElements } as Spec : null;
  const hotspots = [...hotspotIds].map((id) => ({ root: id, elements: { [id]: spec.elements[id] } }) as Spec);
  return { content, hotspots };
}
