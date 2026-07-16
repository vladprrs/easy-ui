import type { ComponentRegistry } from "@json-render/react";

export function createCjmRegistry(registry: ComponentRegistry): ComponentRegistry {
  return { ...registry };
}
