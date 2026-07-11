import type { Spec } from "@json-render/core";
import type { ComponentDefinition } from "../catalog/normalize";

export type CatalogFixture = Spec["elements"][string];

export function createFixtures<T extends Record<string, ComponentDefinition>>(
  definitions: T,
  overrides: Record<string, Record<string, unknown>> = {},
) {
  return Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => [
      name,
      {
        type: name,
        props: definition.example ?? overrides[name],
        children: [],
      },
    ]),
  ) as unknown as Record<keyof T, CatalogFixture>;
}
