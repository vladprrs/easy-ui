// Regenerates the /author skill's builtin catalog reference from the live
// design-system definitions. Run with bun (imports TS + React components):
//   ~/.bun/bin/bun run scripts/generate-builtin-catalog.ts
import { z } from "zod";
import { designSystems } from "../src/designSystems";
import { resolveSpacingScale } from "../src/designSystems/spacingScale";
import { hostPrimitiveDefinitions } from "../src/catalog/hostPrimitives/definitions";

function serializeDefinitions(definitions: typeof hostPrimitiveDefinitions | (typeof designSystems)[keyof typeof designSystems]["definitions"]) {
  const result: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(definitions)) {
    result[name] = {
      description: definition.description,
      ...(definition.atomicLevel ? { atomicLevel: definition.atomicLevel } : {}),
      layoutNeutral: definition.layoutNeutral ?? false,
      ...(definition.layout ? { layout: definition.layout } : {}),
      propsJsonSchema: z.toJSONSchema(definition.props, { io: "input" }),
      ...(definition.events?.length ? { events: definition.events } : {}),
      ...(definition.slots?.length ? { slots: definition.slots } : {}),
      ...(definition.example ? { example: definition.example } : {}),
    };
  }
  return result;
}

function serializeHostPrimitives() {
  const definitions = serializeDefinitions(hostPrimitiveDefinitions);
  return Object.entries(definitions).map(([name, descriptor]) => ({ name, ...(descriptor as Record<string, unknown>) }));
}

const out: Record<string, unknown> = {};
for (const system of Object.values(designSystems)) {
  const components = serializeDefinitions(system.definitions);
  out[system.id] = {
    name: system.name,
    description: system.description,
    resolvedSpaceScale: resolveSpacingScale(system.id),
    hostPrimitives: serializeHostPrimitives(),
    components,
  };
}

const path = new URL("../.claude/skills/author/reference/builtin-catalog.json", import.meta.url).pathname;
await Bun.write(path, `${JSON.stringify(out, null, 1)}\n`);
const counts = Object.entries(out)
  .map(([id, system]) => `${id}: ${Object.keys((system as { components: object }).components).length}`)
  .join(", ");
console.log(`wrote ${path} (${counts})`);
