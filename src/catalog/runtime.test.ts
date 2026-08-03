import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createPlayerRuntime, createSurfacePlayerRuntime } from "./runtime";

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

describe("createSurfacePlayerRuntime (multi-surface D8)", () => {
  const custom = {
    definitions: {
      KsoTile: { description: "kso", props: z.object({}) },
      AppCard: { description: "app", props: z.object({}) },
    },
    components: {
      KsoTile: () => createElement("div", null, "kso"),
      AppCard: () => createElement("div", null, "app"),
    },
  };
  const componentDesignSystems = { KsoTile: "kiosk", AppCard: "pay" };

  it("builds one registry per surface and resolves types in the surface design system", () => {
    const runtime = createSurfacePlayerRuntime(deps, custom, [
      { id: "kso", designSystem: "kiosk" },
      { id: "app", designSystem: "pay" },
    ], componentDesignSystems);
    expect(Object.keys(runtime.registries).sort()).toEqual(["app", "kso"]);
    expect(runtime.registries.kso!.KsoTile).toBeTypeOf("function");
    expect(runtime.registries.kso!.AppCard).toBeUndefined();
    expect(runtime.registries.app!.AppCard).toBeTypeOf("function");
    expect(runtime.registries.app!.KsoTile).toBeUndefined();
    // Primary-реестр — тот же объект, что общий `registry`: один JSONUIProvider на сессию.
    expect(runtime.registries.kso).toBe(runtime.registry);
  });

  it("keeps a single shared registry when both surfaces use the same design system", () => {
    const runtime = createSurfacePlayerRuntime(deps, custom, [
      { id: "kso", designSystem: "kiosk" },
      { id: "app", designSystem: "kiosk" },
    ], componentDesignSystems);
    expect(runtime.registries.app).toBe(runtime.registry);
  });

  it("does not narrow anything when component design systems are unknown", () => {
    // Сервер не обязан отдавать `designSystem` на пинах — тогда карта пуста, и реестр
    // остаётся плоским: имена компонентов глобально уникальны, рендер stored-дока не ломается.
    const runtime = createSurfacePlayerRuntime(deps, custom, [
      { id: "kso", designSystem: "kiosk" },
      { id: "app", designSystem: "pay" },
    ]);
    expect(runtime.registries.app!.KsoTile).toBeTypeOf("function");
    expect(runtime.registries.kso!.AppCard).toBeTypeOf("function");
  });

  it("degrades to a single registry for a document without surfaces", () => {
    const runtime = createSurfacePlayerRuntime(deps, custom, [{ id: "primary", designSystem: "kiosk" }], componentDesignSystems);
    expect(Object.keys(runtime.registries)).toEqual(["primary"]);
    expect(runtime.registries.primary).toBe(runtime.registry);
  });
});
