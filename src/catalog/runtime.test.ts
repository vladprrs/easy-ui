import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { z } from "zod";
import { createPlayerRuntime } from "./runtime";

const deps = { navigate: () => {}, back: () => {}, openUrl: () => {}, restart: () => {} };

describe("createPlayerRuntime custom manifest", () => {
  it("resolves the wireframe Button instead of the shadcn Button", () => {
    const runtime = createPlayerRuntime(deps, undefined, "wireframe");
    const rendered = renderToStaticMarkup(createElement(runtime.registry.Button, {
      element: { type: "Button", props: { label: "Continue", disabled: false } },
      children: undefined,
      emit: () => undefined,
      on: () => ({ shouldPreventDefault: false, bound: false, emit: () => undefined }),
    }));

    expect(rendered).toContain("<button");
    expect(rendered).toContain("border-dashed");
    expect(rendered).toContain("font-mono");
  });

  it("falls back to an empty builtin catalog for a system without provider", () => {
    const runtime = createPlayerRuntime(deps, undefined, "missing");
    expect(runtime.registry).toBeDefined();
  });

  it("merges custom components over wireframe builtins", () => {
    const Custom = () => null;
    const runtime = createPlayerRuntime(deps, {
      definitions: { Custom: { description: "custom", props: z.object({}) } },
      components: { Custom },
    }, "wireframe");

    expect(runtime.registry.Button).toBeTypeOf("function");
    expect(runtime.registry.Custom).toBeTypeOf("function");
  });

  it("rejects mismatched definition and component keys", () => {
    expect(() => createPlayerRuntime(deps, {
      definitions: { RatingStars: { description: "rating", props: z.object({ value: z.number() }) } },
      components: {},
    })).toThrow(/keys must match/);
  });
});
