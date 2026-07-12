import { describe, expect, it } from "vitest";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { z } from "zod";
import { componentDefinitions } from "../catalog/definitions";
import { fixtures } from "../catalog/fixtures";
import { createPlayerRuntime } from "../catalog/runtime";
import { prototypeDocSchema } from "../prototype/schema";
import { validatePrototype } from "../prototype/validate";
import { designSystems, getDesignSystem, resolveBuiltinSystem, resolveDefinitions } from ".";
import { shadcnSystem } from "./shadcn";

describe("design system import smoke test", () => {
  it("imports compat modules, registry, and shadcn system together", () => {
    expect(designSystems.shadcn).toBe(shadcnSystem);
    expect(getDesignSystem("shadcn")).toBe(shadcnSystem);
    expect(resolveDefinitions("shadcn")).toBe(shadcnSystem.definitions);
    expect(componentDefinitions).toBe(shadcnSystem.definitions);
    expect(fixtures).toBe(shadcnSystem.fixtures);
    expect(Object.keys(shadcnSystem.components)).toEqual(Object.keys(componentDefinitions));
  });

  it("rejects unknown systems", () => {
    expect(() => getDesignSystem("unknown")).toThrow("Unknown design system: unknown");
  });

  it("resolves provider systems and returns an empty system for other IDs", () => {
    expect(resolveBuiltinSystem("shadcn")).toBe(shadcnSystem);
    expect(resolveBuiltinSystem("wireframe")).toBe(designSystems.wireframe);
    expect(resolveBuiltinSystem("yandex-pay")).toMatchObject({
      id: "yandex-pay",
      name: "yandex-pay",
      definitions: {},
      components: {},
    });
  });

  it("creates a runtime with custom pins for a system without a provider", () => {
    const CustomPin = () => createElement("div", { "data-custom-pin": true });
    const runtime = createPlayerRuntime(
      { navigate() {}, back() {}, openUrl() {}, restart() {} },
      {
        definitions: { CustomPin: { description: "custom pin", props: z.object({}) } },
        components: { CustomPin },
      },
      "yandex-pay",
    );

    // Custom components are registered through the event adapter (which uses hooks),
    // so render it through React rather than calling it as a plain function.
    const Registered = runtime.registry.CustomPin as unknown as ComponentType<Record<string, unknown>>;
    const html = renderToStaticMarkup(createElement(Registered, {
      element: { type: "CustomPin", props: {} },
      children: undefined,
      emit: () => undefined,
      on: () => ({ shouldPreventDefault: false, bound: false, emit: () => undefined }),
    }));
    expect(html).toContain("data-custom-pin");
  });

  it("validates against explicitly supplied definitions for a custom system", () => {
    const doc = prototypeDocSchema.parse({
      version: 1,
      id: "custom-system-doc",
      name: "Custom system",
      designSystem: "not-a-provider",
      device: "mobile",
      startScreen: "main",
      state: {},
      screens: [{ id: "main", name: "Main", spec: { root: "pin", elements: { pin: { type: "CustomPin", props: {} } } } }],
    });
    const definitions = { CustomPin: { description: "custom pin", props: z.object({}) } };

    expect(validatePrototype(doc, { definitions }).errors).toEqual([]);
  });
});
