// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import type { Spec } from "@json-render/core";
import { JSONUIProvider, Renderer, defineRegistry, type Components } from "@json-render/react";
import { afterEach, describe, expect, it } from "vitest";
import { customCatalogActions } from "../../catalog/actions";
import { createCatalog } from "../../catalog/catalog";
import { wireframeSystem } from ".";
import { Stack } from "./components";
import { vi } from "vitest";

const catalog = createCatalog(wireframeSystem.definitions);
const result = defineRegistry(catalog, {
  components: wireframeSystem.components as unknown as Components<typeof catalog>,
  actions: {
    navigate: async () => undefined,
    back: async () => undefined,
    openUrl: async () => undefined,
    restart: async () => undefined,
  } satisfies Record<keyof typeof customCatalogActions, (...args: never[]) => Promise<void>>,
});
const handlers = result.handlers(() => () => undefined, () => ({}));

afterEach(cleanup);

describe("wireframe fixtures", () => {
  it("preserves the existing sm/md/lg pixel classes while extending the scale", () => {
    const expected = { sm: "gap-2", md: "gap-4", lg: "gap-6" } as const;
    for (const [gap, className] of Object.entries(expected)) {
      const { container, unmount } = render(<Stack props={{ gap: gap as keyof typeof expected }} emit={vi.fn()} on={vi.fn() as never}>x</Stack>);
      expect(container.firstElementChild?.classList.contains(className)).toBe(true);
      unmount();
    }
  });
  it("covers every component definition exactly", () => {
    expect(new Set(Object.keys(wireframeSystem.fixtures))).toEqual(new Set(Object.keys(wireframeSystem.definitions)));
  });

  for (const [name, element] of Object.entries(wireframeSystem.fixtures)) {
    it(`renders ${name} from its example through the registry`, () => {
      const spec = { root: "demo", elements: { demo: element } } as unknown as Spec;
      expect(() => render(
        <JSONUIProvider registry={result.registry} handlers={handlers} initialState={{}}>
          <Renderer registry={result.registry} spec={spec} />
        </JSONUIProvider>,
      )).not.toThrow();
    });
  }
});
