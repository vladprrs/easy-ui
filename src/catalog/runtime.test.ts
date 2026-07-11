import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createPlayerRuntime } from "./runtime";

const deps = { navigate: () => {}, back: () => {}, openUrl: () => {}, restart: () => {} };

describe("createPlayerRuntime custom manifest", () => {
  it("resolves the wireframe Button instead of the shadcn Button", () => {
    const runtime = createPlayerRuntime(deps, undefined, "wireframe");
    const rendered = (runtime.registry.Button as unknown as (props: Record<string, unknown>) => { type: unknown; props: { className: string } })({
      element: { type: "Button", props: { label: "Continue", disabled: false } },
      children: undefined,
      emit: () => undefined,
      on: () => ({ shouldPreventDefault: false, bound: false, emit: () => undefined }),
    });

    expect(rendered.type).toBe("button");
    expect(rendered.props.className).toContain("border-dashed");
    expect(rendered.props.className).toContain("font-mono");
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
