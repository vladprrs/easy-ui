import { hostPrimitiveDefinitions as componentDefinitions } from "./hostPrimitives/definitions";

export const componentEvents = Object.fromEntries(
  Object.entries(componentDefinitions).map(([name, rawDefinition]) => {
    const definition = rawDefinition as { events?: readonly string[] };
    return [
    name,
    [...(definition.events ?? [])],
    ];
  }),
) as Record<keyof typeof componentDefinitions, string[]>;
