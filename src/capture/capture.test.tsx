import { render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getComponentVersion } from "../api/client";
import { prototypeDocSchema } from "../prototype/schema";
import { CapturePrototype } from "./CapturePrototype";
import { CaptureComponent } from "./CaptureComponent";

const doc = prototypeDocSchema.parse({
  version: 1, id: "cap", name: "Cap", device: "mobile", startScreen: "welcome", state: {},
  screens: [{ id: "welcome", name: "Welcome", spec: { root: "r", elements: { r: { type: "Text", props: { text: "Hi" } } } } }],
});

vi.mock("../api/client", () => ({
  getPrototypeDraft: vi.fn(async () => ({ doc, rev: 3, prototypeInstanceId:"capture-instance", componentManifestHash: "m", builtinCatalogHash: "b", components: [] })),
  getPrototypeRevisionFull: vi.fn(),
  getPrototypeVersion: vi.fn(),
  getComponentMeta: vi.fn(async () => ({ id: "widget", name: "Widget", designSystem: "shadcn", headRev: 1, versions: [], updatedAt: "" })),
  getComponentVersion: vi.fn(async () => ({ version: 2, rev: 1, source: "", designSystem: "shadcn", bundleHash: "bh", hostAbiVersion: 2, events: [], slots: [], example: { label: "x" }, examples: { compact: { label: "compact" }, wide: { label: "wide" } }, assets: [], publishedAt: "" })),
}));

vi.mock("../customComponents/loader", () => ({
  loadCustomComponents: vi.fn(async () => ({
    definitions: { Widget: { props: z.object({ label: z.string().optional() }), description: "w" } },
    components: { Widget: (p: { props: { label?: string } }) => <div data-testid="widget">{p.props.label}</div> },
  })),
}));

afterEach(() => { delete window.__EUI_CAPTURE_READY__; delete window.__EUI_CAPTURE_BOOTSTRAP__; });

const componentVersion = {
  version: 2, rev: 1, source: "", designSystem: "shadcn", bundleHash: "bh", hostAbiVersion: 2,
  events: [], slots: [], example: { label: "x" }, examples: { compact: { label: "compact" }, wide: { label: "wide" } }, assets: [], publishedAt: "",
};

function renderComponentCapture(query = "") {
  const router = createMemoryRouter([{ path: "/capture/component/:id/:version", element: <CaptureComponent /> }], { initialEntries: [`/capture/component/widget/2${query}`] });
  render(<RouterProvider router={router} />);
}

describe("capture shell", () => {
  beforeEach(() => {
    vi.mocked(getComponentVersion).mockResolvedValue(componentVersion);
  });

  it("publishes a prototype readiness object and renders without app chrome", async () => {
    const router = createMemoryRouter([{ path: "/capture/:protoId/s/:screenId", element: <CapturePrototype /> }], { initialEntries: ["/capture/cap/s/welcome"] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(window.__EUI_CAPTURE_READY__).toBeDefined());
    expect(window.__EUI_CAPTURE_READY__).toMatchObject({
      status: "ready", kind: "prototype", revision: 3,
      prototypeInstanceId:"capture-instance",
      componentManifestHash: "m", builtinCatalogHash: "b", dsMetaVersion: null, rendererBuild: null,
    });
    const surface = document.querySelector<HTMLElement>("#eui-capture-surface");
    expect(surface).not.toBeNull();
    expect(surface!.style.getPropertyValue("--eui-space-md")).toBe("12px");
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("banner")).toBeNull();
  });

  it("publishes a component readiness object with a props hash", async () => {
    renderComponentCapture("?props=example");
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

  it("resolves a named example strictly by its own key", async () => {
    renderComponentCapture("?example=compact");
    expect((await screen.findByTestId("widget")).textContent).toBe("compact");
  });

  it("uses the named example when the compatible legacy selector is also present", async () => {
    renderComponentCapture("?example=wide&props=example");
    expect((await screen.findByTestId("widget")).textContent).toBe("wide");
  });

  it("uses empty props when neither selector is present", async () => {
    renderComponentCapture();
    expect((await screen.findByTestId("widget")).textContent).toBe("");
  });

  it("gives bootstrap props priority over invalid URL selectors", async () => {
    window.__EUI_CAPTURE_BOOTSTRAP__ = {
      kind: "component", target: {}, props: { label: "bootstrap" },
      expected: { kind: "component", componentId: "widget", version: 2, bundleHash: "bh", propsHash: "hash", dsMetaVersion: null, rendererBuild: null },
    };
    renderComponentCapture("?example=compact&example=wide&props=invalid");
    expect((await screen.findByTestId("widget")).textContent).toBe("bootstrap");
  });

  it.each([
    ["duplicate example", "?example=compact&example=wide"],
    ["duplicate props", "?props=example&props=example"],
    ["unsupported props selector", "?props=other"],
  ])("rejects %s", async (_label, query) => {
    renderComponentCapture(query);
    await waitFor(() => expect(document.querySelector("[data-capture-error]")).not.toBeNull());
  });

  it("rejects a missing named example without falling back to legacy props", async () => {
    renderComponentCapture("?example=missing");
    await waitFor(() => expect(document.querySelector("[data-capture-error]")).not.toBeNull());
    expect(screen.queryByTestId("widget")).toBeNull();
  });

  it("rejects a named selector when the examples field is absent", async () => {
    vi.mocked(getComponentVersion).mockResolvedValueOnce({ ...componentVersion, examples: undefined });
    renderComponentCapture("?example=compact");
    await waitFor(() => expect(document.querySelector("[data-capture-error]")).not.toBeNull());
  });

  it("keeps the existing error path when legacy example props are absent", async () => {
    vi.mocked(getComponentVersion).mockResolvedValueOnce({ ...componentVersion, example: undefined });
    renderComponentCapture("?props=example");
    await waitFor(() => expect(document.querySelector("[data-capture-error]")).not.toBeNull());
  });
});
