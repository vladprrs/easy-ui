import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { ComponentDefinition } from "../src/catalog/definitions";
import { buildPrototypeTemplate } from "../src/gallery/prototypeTemplates";
import { inputPrototypeDocSchema } from "../src/prototype/schema";
import { validatePrototype } from "../src/prototype/validate";

const starterDir = resolve("test/fixtures/starter");
const fixtureSchema = z.strictObject({
  id: z.string(), name: z.string(), description: z.string(),
  components: z.array(z.strictObject({ id: z.string(), name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/), source: z.string().regex(/\.tsx$/) })).min(3).max(4),
});

const fixture = fixtureSchema.parse(JSON.parse(await readFile(resolve(starterDir, "design-system.json"), "utf8")));
const definitions: Record<string, ComponentDefinition> = {};
for (const component of fixture.components) {
  const module = await import(pathToFileURL(resolve(starterDir, component.source)).href) as { definition?: ComponentDefinition; default?: unknown };
  if (!module.definition || typeof module.default !== "function") throw new Error(`${component.source} must export definition and a default component`);
  definitions[component.name] = module.definition;
}

const starterInput = JSON.parse(await readFile(resolve(starterDir, "prototype.json"), "utf8"));
const starter = inputPrototypeDocSchema.parse(starterInput);
if (starter.designSystem !== fixture.id) throw new Error("Starter prototype designSystem must equal the fixture id");
const referencedCustomTypes = new Set(Object.values(starter.screens[0]!.spec.elements).map((element) => element.type).filter((type) => !["Image", "Hotspot", "Overlay"].includes(type)));
if (referencedCustomTypes.size !== fixture.components.length || fixture.components.some((component) => !referencedCustomTypes.has(component.name))) {
  throw new Error("Starter prototype must reference the exact fixture definitions");
}

const gallery = buildPrototypeTemplate(fixture.id, "gallery-template", "Gallery template");
for (const [label, doc, exactDefinitions] of [["gallery", gallery, {}], ["starter", starter, definitions]] as const) {
  const strict = inputPrototypeDocSchema.safeParse(doc);
  if (!strict.success) throw new Error(`${label} template failed strict input schema: ${strict.error.message}`);
  const result = validatePrototype(strict.data, { definitions: exactDefinitions });
  if (result.errors.length) throw new Error(`${label} template failed exact-definition validation: ${JSON.stringify(result.errors)}`);
  console.log(`OK   ${label} template`);
}
