import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../app/routes";
import type { PrototypeDraft, PrototypeVersion } from "../api/client";
import { prototypeDocSchema } from "../prototype/schema";

const mocks = vi.hoisted(() => ({ getDraft: vi.fn(), getVersion: vi.fn(), loadCustom: vi.fn() }));
vi.mock("../api/client", async (original) => ({ ...(await original()), getPrototypeDraft: mocks.getDraft, getPrototypeVersion: mocks.getVersion }));
vi.mock("../customComponents/loader", () => ({ loadCustomComponents: mocks.loadCustom }));

const hello = prototypeDocSchema.parse((await import("../../prototypes/hello-world.json")).default);
const draft = (doc = hello, rev = 1): PrototypeDraft => ({ doc, rev, builtinCatalogHash: "builtin", componentManifestHash: "empty", components: [] });

function renderAt(path: string) {
  const router = createMemoryRouter([{ path: "*", element: <AppRoutes /> }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
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
    fireEvent.change(input, { target: { value: "Lin" } });
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Lin");
    expect(screen.getByText("Hello, Lin!")).toBeTruthy();
    const device = screen.getByRole("region", { name: "Prototype device preview" });
    fireEvent.click(within(device).getByRole("button", { name: "Details" }));
    await screen.findByText("This is the second screen.");
    fireEvent.click(within(device).getByRole("button", { name: "Back" }));
    expect((await screen.findByLabelText("Name") as HTMLInputElement).value).toBe("Lin");
  });

  it("loads a version and navigates under its version-aware route base", async () => {
    const router = renderAt("/p/hello-world/v/2");
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/v/2/s/welcome"));
    expect(mocks.getVersion).toHaveBeenCalledWith("hello-world", 2, expect.any(AbortSignal));
  });

  it("restart and prototype changes create a clean store", async () => {
    const router = renderAt("/p/hello-world/s/welcome");
    const input = await screen.findByLabelText("Name");
    fireEvent.change(input, { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
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

  it("shows pinned component diagnostics when a bundle fails", async () => {
    mocks.getDraft.mockResolvedValue({ ...draft(), componentManifestHash: "custom", components: [{ id: "rating", name: "RatingStars", version: 3, bundleUrl: "/api/components/rating/versions/3/bundle.js", bundleHash: "hash" }] });
    mocks.loadCustom.mockRejectedValue(new Error("Custom component RatingStars v3: broken contract"));
    renderAt("/p/hello-world/s/welcome");
    expect((await screen.findByRole("alert")).textContent).toContain("RatingStars v3: broken contract");
  });
});
