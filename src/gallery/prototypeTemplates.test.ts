import { describe, expect, it } from "vitest";
import { inputPrototypeDocSchema } from "../prototype/schema";
import { validatePrototype } from "../prototype/validate";
import { TEMPLATE_VERSION, buildPrototypeTemplate, hasUsableComponents } from "./prototypeTemplates";

describe("prototype onboarding template", () => {
  it("builds a strict host-only Image + Hotspot document", () => {
    const doc = buildPrototypeTemplate("custom", "new-custom", "Новый");
    expect(TEMPLATE_VERSION).toBe(2);
    expect(inputPrototypeDocSchema.safeParse(doc).success).toBe(true);
    expect(Object.values(doc.screens[0]!.spec.elements).map((element) => element.type).sort()).toEqual(["Hotspot", "Image"]);
    expect(validatePrototype(doc).errors).toEqual([]);
  });

  it("requires an active manifest component before offering a design system", () => {
    const components = [{ id: "rating", name: "Rating", designSystem: "custom", version: 1, bundleUrl: "/rating.js", bundleHash: "hash", description: "", events: [], slots: [], hostAbiVersion: 3 }];
    expect(hasUsableComponents("custom", components)).toBe(true);
    expect(hasUsableComponents("empty", components)).toBe(false);
  });
});
