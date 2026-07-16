import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { PrototypeDraft, PrototypeVersion } from "../api/client";
import { prototypeDocSchema } from "../prototype/schema";
import { routeObjects } from "../app/routes";
import { CjmFrame, TileErrorBoundary } from "./CjmScreenTile";

const mocks = vi.hoisted(() => ({ getDraft: vi.fn(), getVersion: vi.fn(), getThemeVersion: vi.fn(), getLatestTheme: vi.fn(), loadCustom: vi.fn() }));
vi.mock("../api/client", async (original) => ({ ...(await original()), getPrototypeDraft: mocks.getDraft, getPrototypeVersion: mocks.getVersion, getDesignSystemVersion: mocks.getThemeVersion, getDesignSystemById: mocks.getLatestTheme }));
vi.mock("../customComponents/loader", () => ({ loadCustomComponents: mocks.loadCustom }));

const doc = prototypeDocSchema.parse({
  version: 1, id: "journey", name: "Checkout journey", description: "From cart to success", device: "mobile", startScreen: "cart",
  state: { copy: "Base" },
  screens: [
    { id: "cart", name: "Cart", note: "Review the order", stateOverrides: { copy: "Override copy" }, spec: { root: "text", elements: { text: { type: "Text", props: { text: { $state: "/copy" } } } } } },
    { id: "success", name: "Success", spec: { root: "text", elements: { text: { type: "Text", props: { text: "Done" } } } } },
  ],
});
const draft: PrototypeDraft = { doc, rev: 4, builtinCatalogHash: "builtin", componentManifestHash: "empty", components: [], designSystemMetaVersion: 1 };

const hostDoc = prototypeDocSchema.parse({
  version: 1, id: "journey", name: "Host journey", designSystem: "custom-only", device: "mobile", startScreen: "cart", state: {},
  screens: [{ id: "cart", name: "Cart", canvas: { width: 390, height: 844 }, spec: { root: "image", elements: {
    image: { type: "Image", props: { src: "/images/cjm.png", alt: "CJM host image", objectFit: "cover" } },
    hotspot: { type: "Hotspot", props: { x: 1, y: 2, width: 30, height: 40, ariaLabel: "CJM host hotspot" } },
  } } }],
});

afterEach(cleanup);

function renderAt(path: string) {
  const router = createMemoryRouter(routeObjects, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

describe("CjmShell", () => {
  beforeEach(() => {
    mocks.getDraft.mockReset().mockResolvedValue(draft);
    mocks.getVersion.mockReset().mockResolvedValue({ ...draft, version: 2, publishedAt: "2026-07-10T00:00:00Z" } satisfies PrototypeVersion);
    mocks.getThemeVersion.mockReset().mockResolvedValue({ systemId: "shadcn", version: 1, createdAt: "2026-07-01T00:00:00Z", tokens: { "space.md": "20px", "space.lg": "24px", "space.xl": "32px", "space.2xl": "40px" }, fonts: [], icons: [] });
    mocks.getLatestTheme.mockReset().mockResolvedValue({ id: "shadcn", latestMetaVersion: 2, tokens: { "space.md": "40px", "space.lg": "48px", "space.xl": "56px", "space.2xl": "64px", "space.3xl": "72px", "space.4xl": "80px" }, fonts: [], icons: [] });
    mocks.loadCustom.mockReset().mockResolvedValue(undefined);
  });

  it.each([
    ["mobile", 280, 608],
    ["tablet", 420, 560],
    ["desktop", 560, 560],
  ] as const)("uses the %s preview width and caps tall screens", (device, width, heightCap) => {
    render(<CjmFrame device={device} nativeWidth={1000} nativeHeight={3000} resetKey={device} designSystem="custom-only"><div>Preview</div></CjmFrame>);
    const frame = screen.getByTestId("cjm-frame");
    expect(Number.parseFloat(frame.style.width)).toBe(width);
    expect(Number.parseFloat(frame.style.height)).toBe(heightCap);
    expect(frame.classList.contains("cjm-frame-capped")).toBe(true);
  });

  it("truncates a long screen name visually and preserves it in title", async () => {
    const longName = "Очень длинное название экрана, которое не должно расширять карточку CJM";
    mocks.getDraft.mockResolvedValue({ ...draft, doc: { ...doc, screens: [{ ...doc.screens[0]!, name: longName }] } });
    renderAt("/p/journey/cjm");
    const heading = await screen.findByRole("heading", { name: longName });
    expect(heading.classList.contains("truncate")).toBe(true);
    expect(heading.getAttribute("title")).toBe(longName);
  });

  it("renders ordered tiles, notes, override state, and the optional description", async () => {
    renderAt("/p/journey/cjm");
    expect(await screen.findByText("Override copy")).toBeTruthy();
    expect(screen.getByText("Review the order")).toBeTruthy();
    expect(screen.getByText("From cart to success")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Открыть экран «Cart» прототипа «Checkout journey» в плеере" }).getAttribute("href")).toBe("/p/journey/s/cart");
    expect(screen.getByRole("link", { name: "Плеер" }).getAttribute("href")).toBe("/p/journey");
    expect(screen.getByText("демо-состояние")).toBeTruthy();
    const metadata = screen.getByLabelText("Метаданные CJM");
    expect(within(metadata).getByText("2 экрана")).toBeTruthy();
    expect(within(metadata).getByText("shadcn")).toBeTruthy();
    await waitFor(() => expect(document.title).toBe("Checkout journey · CJM — easy-ui"));
  });

  it("keeps published tile links version-aware", async () => {
    renderAt("/p/journey/v/2/cjm");
    expect((await screen.findByRole("link", { name: "Открыть экран «Success» прототипа «Checkout journey» в плеере" })).getAttribute("href")).toBe("/p/journey/v/2/s/success");
    // PrototypeChrome version policy (WF-4): player keeps /v/N, editor goes to the draft.
    expect(screen.getByRole("link", { name: "Плеер" }).getAttribute("href")).toBe("/p/journey/v/2");
    expect(screen.getByRole("link", { name: /Редактор/ }).getAttribute("href")).toBe("/p/journey/edit");
    expect(screen.getByText("v2")).toBeTruthy();
    await waitFor(() => expect(document.title).toBe("Checkout journey v2 · CJM — easy-ui"));
  });

  it("renders a published Overlay tile with its exact pinned v1 theme after v2 exists", async () => {
    const overlayDoc = prototypeDocSchema.parse({ ...doc, screens: [{
      id: "cart", name: "Cart", canvas: { width: 390, height: 844 }, spec: { root: "root", elements: {
        root: { type: "Stack", props: {}, children: ["body", "overlay"] },
        body: { type: "Text", props: { text: "Body" } },
        overlay: { type: "Overlay", props: { placement: "bottom-right", inset: "md", scrim: false }, children: ["action"] },
        action: { type: "Text", props: { text: "Pinned action" } },
      } },
    }] });
    mocks.getVersion.mockResolvedValue({ ...draft, doc: overlayDoc, version: 2, publishedAt: "2026-07-10T00:00:00Z", designSystemMetaVersion: 1 } satisfies PrototypeVersion);
    renderAt("/p/journey/v/2/cjm");
    const stage = await waitFor(() => {
      const node = document.querySelector<HTMLElement>("[data-eui-stage-viewport='cjm']");
      if (!node) throw new Error("CJM StageViewport has not mounted");
      expect(node.querySelector("[data-eui-host-primitive='Overlay']")).not.toBeNull();
      return node;
    });
    await waitFor(() => expect(stage.style.getPropertyValue("--eui-space-md")).toBe("20px"));
    expect(stage.closest("[inert]")).not.toBeNull();
    expect(mocks.getThemeVersion).toHaveBeenCalledWith("shadcn", 1, expect.any(AbortSignal));
    expect(mocks.getLatestTheme).not.toHaveBeenCalled();
  });

  it("renders host Image and canvas-split Hotspot in CJM", async () => {
    mocks.getDraft.mockResolvedValue({ ...draft, doc: hostDoc, designSystemMetaVersion: null });
    renderAt("/p/journey/cjm");
    expect(await screen.findByRole("img", { name: "CJM host image" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "CJM host hotspot" })).toBeTruthy();
  });

  it("labels static and dynamic authored navigate transitions without creating edges", async () => {
    const transitionDoc = prototypeDocSchema.parse({ ...doc, state: { target: "secret" }, screens: [
      { id: "cart", name: "Cart", spec: { root: "actions", elements: {
        actions: { type: "Stack", props: {}, children: ["static", "dynamic"] },
        static: { type: "Button", props: { label: "Static" }, on: { press: { action: "navigate", params: { screenId: "success" } } } },
        dynamic: { type: "Button", props: { label: "Dynamic" }, on: { press: { action: "navigate", params: { screenId: { $event: "/screenId" } } } } },
      } } },
      { id: "success", name: "Success", spec: { root: "text", elements: { text: { type: "Text", props: { text: "Done" } } } } },
      { id: "secret", name: "Secret", spec: { root: "text", elements: { text: { type: "Text", props: { text: "Hidden target" } } } } },
    ] });
    mocks.getDraft.mockResolvedValue({ ...draft, doc: transitionDoc });
    renderAt("/p/journey/cjm");
    expect(await screen.findByText("→ Success")).toBeTruthy();
    expect(screen.getByText("динамический переход")).toBeTruthy();
    expect(screen.queryByText("→ Secret")).toBeNull();
  });

  it("omits the description block when the document has no description", async () => {
    mocks.getDraft.mockResolvedValue({ ...draft, doc: { ...doc, description: undefined } });
    renderAt("/p/journey/cjm");
    await screen.findByRole("heading", { name: "Checkout journey" });
    expect(screen.queryByText("From cart to success")).toBeNull();
  });

  it("does not activate modal side effects for an open Dialog", async () => {
    const dialogDoc = prototypeDocSchema.parse({ ...doc, state: { open: false }, screens: [{ id: "cart", name: "Cart", stateOverrides: { open: true }, spec: { root: "dialog", elements: { dialog: { type: "Dialog", props: { title: "Modal", openPath: "/open" } } } } }] });
    mocks.getDraft.mockResolvedValue({ ...draft, doc: dialogDoc });
    renderAt("/p/journey/cjm");
    const list = await screen.findByRole("list", { name: "Экраны CJM" });
    await waitFor(() => expect(document.body.style.pointerEvents).not.toBe("none"));
    expect(list.getAttribute("aria-hidden")).toBeNull();
    expect(screen.getByRole("link", { name: /Открыть экран/ })).toBeTruthy();
  });

  it("contains a renderer failure to its tile while neighbors stay alive", async () => {
    const brokenDoc = prototypeDocSchema.parse({ ...doc, startScreen: "broken", screens: [
      { id: "broken", name: "Broken", spec: { root: "broken", elements: { broken: { type: "Broken", props: { text: "Crash" } } } } },
      { id: "success", name: "Success", spec: { root: "text", elements: { text: { type: "Text", props: { text: "Still alive" } } } } },
    ] });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const Broken = () => { throw new Error("renderer exploded"); };
    render(<><TileErrorBoundary prototypeId={brokenDoc.id} screenId="broken"><Broken /></TileErrorBoundary><p>Still alive</p></>);
    expect(screen.getByTestId("tile-error")).toBeTruthy();
    expect(screen.getByText("Still alive")).toBeTruthy();
  });

  it("renders a custom DS component with named-slot metadata in tiles", async () => {
    const customDoc = prototypeDocSchema.parse({
      ...doc, startScreen: "custom", screens: [{ id: "custom", name: "Custom", spec: { root: "widget", elements: {
        widget: { type: "Widget", props: { label: "Custom label" }, children: ["header-text", "body-text"], on: { press: { action: "back" } } },
        "header-text": { type: "Text", props: { text: "In header" }, slot: "header" },
        "body-text": { type: "Text", props: { text: "In body" } },
      } } }],
    });
    mocks.getDraft.mockResolvedValue({ ...draft, doc: customDoc, componentManifestHash: "custom", components: [{ id: "widget", name: "Widget", version: 1, bundleUrl: "/api/components/widget/versions/1/bundle.js", bundleHash: "hash" }] });
    mocks.loadCustom.mockResolvedValue({
      definitions: { Widget: { props: z.object({ label: z.string().optional() }), description: "w", events: ["press"], slots: ["header"], capabilities: { namedSlots: true } } },
      components: { Widget: ({ props, slots }: { props: { label?: string }; slots: Record<string, ReactNode> }) =>
        <div><span data-testid="widget-label">{props.label}</span><div data-testid="widget-header">{slots.header}</div><div data-testid="widget-body">{slots.default}</div></div> },
    });
    renderAt("/p/journey/cjm");
    expect((await screen.findByTestId("widget-label")).textContent).toBe("Custom label");
    // slotIndices metadata survives the inert transform: the slotted child routes into the named slot.
    const header = screen.getByTestId("widget-header");
    expect(within(header).getByText("In header")).toBeTruthy();
    const body = screen.getByTestId("widget-body");
    expect(within(body).getByText("In body")).toBeTruthy();
    expect(within(body).queryByText("In header")).toBeNull();
  });

  it("isolates state stores between tiles", async () => {
    const isolatedDoc = prototypeDocSchema.parse({ ...doc, startScreen: "screen-1", state: { copy: "Base" }, screens: ["One", "Two"].map((name, index) => ({
      id: `screen-${index + 1}`, name, stateOverrides: { copy: name }, spec: { root: "input", elements: { input: { type: "Input", props: { label: name, value: { $bindState: "/copy" } } } } },
    })) });
    mocks.getDraft.mockResolvedValue({ ...draft, doc: isolatedDoc });
    renderAt("/p/journey/cjm");
    const [first, second] = await screen.findAllByRole("textbox") as HTMLInputElement[];
    expect(first.value).toBe("One");
    expect(second.value).toBe("Two");
    fireEvent.change(first, { target: { value: "Changed" } });
    expect(first.value).toBe("Changed");
    expect(second.value).toBe("Two");
  });
});
