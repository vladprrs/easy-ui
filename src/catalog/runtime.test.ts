import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createPlayerRuntime } from "./runtime";

const deps = { navigate: () => {}, back: () => {}, openUrl: () => {}, restart: () => {} };

describe("createPlayerRuntime custom-only", () => {
  it("provides host Image without a builtin provider", () => {
    const runtime = createPlayerRuntime(deps, undefined, "wireframe");
    const rendered = renderToStaticMarkup(createElement(runtime.registry.Image, {
      element: { type: "Image", props: { src: "/fixture.png", alt: "Fixture" } }, children: undefined, emit: () => undefined, on: () => ({ shouldPreventDefault: false, bound: false, emit: () => undefined }),
    }));
    expect(rendered).toContain("<img");
  });

  it("renders a pinned custom component for a retired wireframe revision", () => {
    const LegacyButton = () => createElement("button", null, "Legacy custom");
    const runtime = createPlayerRuntime(deps, {
      definitions: { LegacyButton: { description: "custom", props: z.object({}) } },
      components: { LegacyButton },
    }, "custom-only");
    expect(runtime.registry.LegacyButton).toBeTypeOf("function");
    expect(runtime.registry.Button).toBeUndefined();
  });

  it("rejects mismatched definition and component keys", () => {
    expect(() => createPlayerRuntime(deps, { definitions: { RatingStars: { description: "rating", props: z.object({ value: z.number() }) } }, components: {} })).toThrow(/keys must match/);
  });
});
