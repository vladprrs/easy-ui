// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import type { Spec } from "@json-render/core";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { afterEach, describe, expect, it } from "vitest";
import { componentDefinitions } from "./definitions";
import { fixtures } from "./fixtures";
import { createPlayerRuntime } from "./runtime";

const runtime = createPlayerRuntime({ navigate: () => undefined, back: () => undefined, openUrl: () => undefined, restart: () => undefined });
afterEach(cleanup);

describe("catalog fixtures", () => {
  it("covers every component definition exactly", () => {
    expect(new Set(Object.keys(fixtures))).toEqual(new Set(Object.keys(componentDefinitions)));
  });

  for (const [name, element] of Object.entries(fixtures)) {
    it(`renders ${name} without throwing`, () => {
      const spec = { root: "demo", elements: { demo: element } } as Spec;
      expect(() => render(<JSONUIProvider registry={runtime.registry} handlers={runtime.handlers} initialState={{ dialogOpen: false, drawerOpen: false }}><Renderer registry={runtime.registry} spec={spec} /></JSONUIProvider>)).not.toThrow();
    });
  }
});
