import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeObjects } from "../app/routes";
import type { PrototypeDraft, PrototypeVersion } from "../api/client";
import { prototypeDocSchema } from "../prototype/schema";

const mocks = vi.hoisted(() => ({ getDraft: vi.fn(), getVersion: vi.fn(), loadCustom: vi.fn() }));
vi.mock("../api/client", async (original) => ({ ...(await original()), getPrototypeDraft: mocks.getDraft, getPrototypeVersion: mocks.getVersion }));
vi.mock("../customComponents/loader", () => ({ loadCustomComponents: mocks.loadCustom }));

const hello = prototypeDocSchema.parse((await import("../../prototypes/hello-world.json")).default);
const draft = (doc = hello, rev = 1): PrototypeDraft => ({ doc, rev, builtinCatalogHash: "builtin", componentManifestHash: "empty", components: [] });

function renderAt(path: string) {
  const router = createMemoryRouter(routeObjects, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

function conditionalDocument(canvas: boolean) {
  return prototypeDocSchema.parse({
    version: 1,
    id: canvas ? "conditional-canvas" : "conditional-flow",
    name: "Conditional flow",
    device: "desktop",
    startScreen: "main",
    state: { enabled: false },
    screens: [{
      id: "main",
      name: "Main",
      ...(canvas ? { canvas: { width: 640, height: 480 } } : {}),
      spec: {
        root: "card",
        elements: {
          card: { type: "Card", props: { title: "Condition" }, children: ["copy", "toggle"] },
          copy: { type: "Text", props: { text: { $cond: { if: { $state: "/enabled" }, then: "Enabled", else: "Disabled" } } } },
          toggle: { type: "Button", props: { label: "Enable" }, on: { press: { action: "setState", params: { statePath: "/enabled", value: true } } } },
        },
      },
    }],
  });
}

describe("PlayerShell", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.getDraft.mockImplementation(async (id: string) => draft(id === "other" ? { ...hello, id: "other", name: "Other", state: { name: "Grace" } } : hello));
    mocks.getVersion.mockResolvedValue({ ...draft(), version: 2, publishedAt: "2026-07-10T00:00:00Z" } satisfies PrototypeVersion);
    mocks.loadCustom.mockResolvedValue({ definitions: {}, components: {} });
  });

  it("loads a draft, redirects to start, and keeps bound state while screens change", async () => {
    const router = renderAt("/p/hello-world");
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/s/welcome"));
    expect(mocks.getDraft).toHaveBeenCalledWith("hello-world", expect.any(AbortSignal));
    const input = await screen.findByLabelText("Name");
    expect(document.title).toBe("Hello World · Welcome — easy-ui");
    fireEvent.change(input, { target: { value: "Lin" } });
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Lin");
    expect(screen.getByText("Hello, Lin!")).toBeTruthy();
    const device = screen.getByRole("region", { name: "Превью прототипа на устройстве" });
    fireEvent.click(within(device).getByRole("button", { name: "Details" }));
    await screen.findByText("This is the second screen.");
    fireEvent.click(within(device).getByRole("button", { name: "Back" }));
    expect((await screen.findByLabelText("Name") as HTMLInputElement).value).toBe("Lin");
  });

  it("loads a version and navigates under its version-aware route base", async () => {
    const router = renderAt("/p/hello-world/v/2");
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/v/2/s/welcome"));
    expect(mocks.getVersion).toHaveBeenCalledWith("hello-world", 2, expect.any(AbortSignal));
    expect(screen.getByRole("link", { name: "CJM" }).getAttribute("href")).toBe("/p/hello-world/v/2/cjm");
    expect(document.title).toBe("Hello World v2 · Welcome — easy-ui");
  });

  it("links to the draft CJM from the sidebar", async () => {
    renderAt("/p/hello-world/s/welcome");
    expect((await screen.findByRole("link", { name: "CJM" })).getAttribute("href")).toBe("/p/hello-world/cjm");
  });

  it("restart and prototype changes create a clean store", async () => {
    const router = renderAt("/p/hello-world/s/welcome");
    const input = await screen.findByLabelText("Name");
    fireEvent.change(input, { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Начать сначала" }));
    expect((await screen.findByLabelText("Name") as HTMLInputElement).value).toBe("Ada");
    await router.navigate("/p/other/s/welcome");
    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Grace"));
  });

  it("remounts the store when switching from draft to a published version", async () => {
    const router = renderAt("/p/hello-world/s/welcome");
    const input = await screen.findByLabelText("Name");
    fireEvent.change(input, { target: { value: "Changed" } });
    await router.navigate("/p/hello-world/v/2/s/welcome");
    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Ada"));
  });

  it("deep link into the middle of the flow shows the reset banner; restart returns to start (W1-5)", async () => {
    const router = renderAt("/p/hello-world/s/details");
    await screen.findByText("This is the second screen.");
    expect(router.state.location.pathname).toBe("/p/hello-world/s/details");
    const banner = await screen.findByTestId("flow-reset-banner");
    fireEvent.click(within(banner).getByRole("button", { name: "Начать сначала" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/s/welcome"));
    expect(screen.queryByTestId("flow-reset-banner")).toBeNull();
  });

  it("sidebar navigation is browse: replace outside flowDepth, Back stays disabled, no banner (W1-5)", async () => {
    const router = renderAt("/p/hello-world");
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/s/welcome"));
    await screen.findByLabelText("Name");
    const sidebar = screen.getByRole("complementary", { name: "Экраны" });
    fireEvent.click(within(sidebar).getByRole("button", { name: "Details" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/s/details"));
    const state = router.state.location.state as { flowDepth: number; entryReason: string };
    expect(state.flowDepth).toBe(0);
    expect(state.entryReason).toBe("browse");
    const back = within(screen.getByTestId("chrome-actions")).getByRole("button", { name: "Назад" }) as HTMLButtonElement;
    expect(back.disabled).toBe(true);
    expect(screen.queryByTestId("flow-reset-banner")).toBeNull();
  });

  it("shows pinned component diagnostics when a bundle fails", async () => {
    mocks.getDraft.mockResolvedValue({ ...draft(), componentManifestHash: "custom", components: [{ id: "rating", name: "RatingStars", version: 3, bundleUrl: "/api/components/rating/versions/3/bundle.js", bundleHash: "hash" }] });
    mocks.loadCustom.mockRejectedValue(new Error("Custom component RatingStars v3: broken contract"));
    renderAt("/p/hello-world/s/welcome");
    expect((await screen.findByRole("alert")).textContent).toContain("RatingStars v3: broken contract");
  });

  it.each([false, true])("renders and updates $cond without runtime errors (canvas: %s)", async (canvas) => {
    const doc = conditionalDocument(canvas);
    mocks.getDraft.mockResolvedValue(draft(doc));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    renderAt(`/p/${doc.id}/s/main`);

    expect(await screen.findByText("Disabled")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    expect(await screen.findByText("Enabled")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
