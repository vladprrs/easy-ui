import type { Spec } from "@json-render/core";

export function stripSpecEvents(spec: Spec): Spec {
  let changed = false;
  const elements = Object.fromEntries(Object.entries(spec.elements).map(([key, element]) => {
    if (!("on" in element)) return [key, element];
    changed = true;
    const withoutEvents = { ...element };
    delete withoutEvents.on;
    return [key, withoutEvents];
  })) as Spec["elements"];

  return changed ? { ...spec, elements } : spec;
}
