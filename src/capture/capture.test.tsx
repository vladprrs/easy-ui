import { render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { prototypeDocSchema } from "../prototype/schema";
import { CapturePrototype } from "./CapturePrototype";
import { CaptureComponent } from "./CaptureComponent";

const doc = prototypeDocSchema.parse({
  version: 1, id: "cap", name: "Cap", device: "mobile", startScreen: "welcome", state: {},
  screens: [{ id: "welcome", name: "Welcome", spec: { root: "r", elements: { r: { type: "Text", props: { text: "Hi" } } } } }],
});

vi.mock("../api/client", () => ({
  getPrototypeDraft: vi.fn(async () => ({ doc, rev: 3, componentManifestHash: "m", builtinCatalogHash: "b", components: [] })),
  getPrototypeRevisionFull: vi.fn(),
  getPrototypeVersion: vi.fn(),
  getComponentMeta: vi.fn(async () => ({ id: "widget", name: "Widget", designSystem: "shadcn", headRev: 1, versions: [], updatedAt: "" })),
  getComponentVersion: vi.fn(async () => ({ version: 2, rev: 1, source: "", designSystem: "shadcn", bundleHash: "bh", hostAbiVersion: 2, events: [], slots: [], example: { label: "x" }, assets: [], publishedAt: "" })),
}));

vi.mock("../customComponents/loader", () => ({
  loadCustomComponents: vi.fn(async () => ({
    definitions: { Widget: { props: z.object({ label: z.string().optional() }), description: "w" } },
    components: { Widget: (p: { props: { label?: string } }) => <div data-testid="widget">{p.props.label}</div> },
  })),
}));

afterEach(() => { delete window.__EUI_CAPTURE_READY__; delete window.__EUI_CAPTURE_BOOTSTRAP__; });

describe("capture shell", () => {
  it("publishes a prototype readiness object and renders without app chrome", async () => {
    const router = createMemoryRouter([{ path: "/capture/:protoId/s/:screenId", element: <CapturePrototype /> }], { initialEntries: ["/capture/cap/s/welcome"] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(window.__EUI_CAPTURE_READY__).toBeDefined());
    expect(window.__EUI_CAPTURE_READY__).toMatchObject({
      status: "ready", kind: "prototype", revision: 3,
      componentManifestHash: "m", builtinCatalogHash: "b", dsMetaVersion: null, rendererBuild: null,
    });
    expect(document.querySelector("#eui-capture-surface")).not.toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("banner")).toBeNull();
  });

  it("publishes a component readiness object with a props hash", async () => {
    const router = createMemoryRouter([{ path: "/capture/component/:id/:version", element: <CaptureComponent /> }], { initialEntries: ["/capture/component/widget/2?props=example"] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(window.__EUI_CAPTURE_READY__).toBeDefined());
    const ready = window.__EUI_CAPTURE_READY__!;
    expect(ready.status).toBe("ready");
    if (ready.status === "ready" && ready.kind === "component") {
      expect(ready.componentId).toBe("widget");
      expect(ready.version).toBe(2);
      expect(ready.bundleHash).toBe("bh");
      expect(ready.propsHash).toMatch(/^[0-9a-f]{64}$/);
      expect(ready.rendererBuild).toBeNull();
    } else {
      throw new Error(`unexpected readiness: ${JSON.stringify(ready)}`);
    }
    expect(screen.getByTestId("widget").textContent).toBe("x");
  });
});
