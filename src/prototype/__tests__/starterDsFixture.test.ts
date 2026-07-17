import { describe, expect, it } from "vitest";
import { STARTER_TEXT, starterizePrototype } from "../../../e2e/starter-ds.fixture";

describe("starterizePrototype", () => {
  it("preserves the host-owned FlowRoot type and region markers", () => {
    const result = starterizePrototype({
      version: 1,
      id: "regions",
      name: "Regions",
      designSystem: "legacy",
      device: "mobile",
      startScreen: "main",
      state: {},
      screens: [{
        id: "main",
        name: "Main",
        spec: {
          root: "root",
          elements: {
            root: { type: "@eui/FlowRoot", props: {}, children: ["header"] },
            header: { type: "Text", props: { text: "Header" }, region: "header" },
          },
        },
      }],
    });

    const screen = (result.screens as Array<Record<string, unknown>>)[0]!;
    const spec = screen.spec as Record<string, unknown>;
    const elements = spec.elements as Record<string, Record<string, unknown>>;
    expect(elements.root).toMatchObject({ type: "@eui/FlowRoot", children: ["header"] });
    expect(elements.header).toMatchObject({ type: STARTER_TEXT, region: "header" });
  });
});
