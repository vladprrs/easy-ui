import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listDesignSystems, listPrototypes } from "../api/client";
import { GalleryPage } from "./GalleryPage";

vi.mock("../api/client", () => ({ listDesignSystems: vi.fn(), listPrototypes: vi.fn() }));

const summary = {
  id: "hello-world", name: "Hello World", description: "A minimal two-screen prototype.", device: "mobile" as const,
  screenCount: 2, headRev: 3, latestVersion: 2, updatedAt: "2026-07-10T00:00:00.000Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function renderGallery() {
  const router = createMemoryRouter([{ path: "/", element: <GalleryPage /> }], { initialEntries: ["/"] });
  render(<RouterProvider router={router} />);
}

describe("GalleryPage", () => {
  beforeEach(() => {
    vi.mocked(listPrototypes).mockReset();
    vi.mocked(listDesignSystems).mockReset();
    vi.mocked(listDesignSystems).mockResolvedValue({ designSystems: [
      { id: "shadcn", name: "Shadcn", description: "", builtinCatalogHash: "one", components: [] },
      { id: "wireframe", name: "Wireframe", description: "", builtinCatalogHash: "two", components: [] },
    ] });
  });

  it("shows loading, then renders draft and published links from summaries", async () => {
    const request = deferred<(typeof summary)[]>();
    vi.mocked(listPrototypes).mockReturnValue(request.promise);
    renderGallery();
    expect(screen.getByText("Loading prototypes…")).toBeTruthy();
    await act(async () => request.resolve([summary]));
    expect(screen.getByRole("heading", { name: "Hello World" })).toBeTruthy();
    expect(screen.getByText("Mobile")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    const draftLink = screen.getByRole("link", { name: /Hello World/ });
    expect(within(draftLink).getByText("Shadcn")).toBeTruthy();
    expect(draftLink.getAttribute("href")).toBe("/p/hello-world");
    expect(screen.getByRole("link", { name: "Published v2" }).getAttribute("href")).toBe("/p/hello-world/v/2");
  });

  it("shows an API error and retries", async () => {
    vi.mocked(listPrototypes).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([]);
    renderGallery();
    expect(await screen.findByText("API недоступен")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No prototypes found.")).toBeTruthy();
    expect(listPrototypes).toHaveBeenCalledTimes(2);
  });

  it("filters by registered and legacy design systems and shows readable badges", async () => {
    vi.mocked(listPrototypes).mockResolvedValue([
      summary,
      { ...summary, id: "wire", name: "Wire flow", designSystem: "wireframe" },
      { ...summary, id: "legacy", name: "Legacy flow", designSystem: "classic" },
    ]);
    renderGallery();

    expect(await screen.findByRole("button", { name: "Wireframe" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "classic" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Hello World" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Wireframe" }));
    expect(screen.getByRole("heading", { name: "Wire flow" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Hello World" })).toBeNull();
    expect(within(screen.getByRole("link", { name: /Wire flow/ })).getByText("Wireframe")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "classic" }));
    expect(screen.getByRole("heading", { name: "Legacy flow" })).toBeTruthy();
    expect(within(screen.getByRole("link", { name: /Legacy flow/ })).getByText("classic")).toBeTruthy();
  });
});
