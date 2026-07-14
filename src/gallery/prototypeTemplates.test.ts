import { describe, expect, it } from "vitest";
import { designSystems } from "../designSystems";
import { prototypeDocSchema } from "../prototype/schema";
import { validatePrototype } from "../prototype/validate";
import { BUILTIN_TEMPLATE_VERSION, buildBuiltinPrototypeTemplate, buildCustomPrototypeTemplate, findCustomStarterComponent } from "./prototypeTemplates";

describe("prototype onboarding templates", () => {
  it.each(Object.keys(designSystems) as (keyof typeof designSystems)[])("builds a schema-valid %s template with no validation errors", (systemId) => {
    const doc = buildBuiltinPrototypeTemplate(systemId, `new-${systemId}`, `Новый ${systemId}`);
    expect(BUILTIN_TEMPLATE_VERSION).toBe(1);
    expect(prototypeDocSchema.safeParse(doc).success).toBe(true);
    expect(validatePrototype(doc, { definitions: designSystems[systemId].definitions }).errors).toEqual([]);
  });

  it("uses only a published custom component with a definition-validated example", () => {
    const components = [{
      id: "rating", name: "RatingStars", designSystem: "custom", version: 1,
      bundleUrl: "/rating.js", bundleHash: "hash", description: "Rating", events: [], slots: [], hostAbiVersion: 1,
      example: { value: 3 },
    }];
    const starter = findCustomStarterComponent("custom", components);
    expect(starter?.name).toBe("RatingStars");
    expect(buildCustomPrototypeTemplate("custom", starter!, "new-custom", "Новый")).toMatchObject({
      designSystem: "custom",
      screens: [{ spec: { elements: { starter: { type: "RatingStars", props: { value: 3 } } } } }],
    });
    expect(findCustomStarterComponent("other", components)).toBeNull();
    expect(findCustomStarterComponent("custom", [{ ...components[0]!, example: undefined }])).toBeNull();
  });
});
