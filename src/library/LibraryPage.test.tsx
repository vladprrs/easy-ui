import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCatalogManifest, getComponentMeta, listDesignSystems, listVisualReferences } from "../api/client";
import { fetchStorybookIndex } from "./storybookIndex";
import { LibraryPage } from "./LibraryPage";

vi.mock("./storybookIndex", async (importOriginal) => {
  const original = await importOriginal<typeof import("./storybookIndex")>();
  return { ...original, fetchStorybookIndex: vi.fn() };
});
vi.mock("../api/client", () => ({ getCatalogManifest: vi.fn(), getComponentMeta: vi.fn(), listDesignSystems: vi.fn(), listVisualReferences: vi.fn() }));

const systems = { designSystems: [
  { id: "shadcn", name: "Shadcn", description: "", builtinCatalogHash: "one", components: [] },
  { id: "wireframe", name: "Wireframe", description: "", builtinCatalogHash: "two", components: [] },
  { id: "yandex-pay", name: "Yandex Pay Design System", description: "", builtinCatalogHash: "", components: [] },
] };

function renderLibrary() {
  const router = createMemoryRouter([{ path: "/library", element: <LibraryPage /> }], { initialEntries: ["/library"] });
  render(<RouterProvider router={router} />);
}

describe("LibraryPage", () => {
  beforeEach(() => {
    vi.mocked(listDesignSystems).mockResolvedValue(systems);
    vi.mocked(getCatalogManifest).mockResolvedValue({ components: [] });
    vi.mocked(listVisualReferences).mockResolvedValue({ references: [] });
    vi.mocked(getComponentMeta).mockResolvedValue({ id: "rating", name: "Rating", designSystem: "yandex-pay", headRev: 3, updatedAt: "now", figma: { fileKey: "abc", nodeIds: ["1:2", "3:4"] }, versions: [
      { version: 3, rev: 3, status: "deprecated", statusReason: "use v4", supersededBy: null, statusRev: 2, designSystem: "yandex-pay", publishedAt: "now" },
    ] });
  });

  const ratingManifest = { components: [{ id: "rating", name: "Rating", designSystem: "yandex-pay", version: 3, bundleUrl: "/rating.js", bundleHash: "hash", atomicLevel: "molecule" as const, description: "Choose a rating", events: ["change"], slots: ["icon"], hostAbiVersion: 1, example: { rating: 3 } }] };

  it("keeps registry systems and custom cards visible when Storybook is unavailable", async () => {
    vi.mocked(fetchStorybookIndex).mockResolvedValue(null);
    vi.mocked(getCatalogManifest).mockResolvedValue(ratingManifest);
    renderLibrary();
    expect(await screen.findByText(/Storybook is unavailable/)).toBeTruthy();
    const switcher = screen.getByLabelText("Design systems");
    expect(within(switcher).getByRole("button", { name: "Yandex Pay Design System" })).toBeTruthy();
    fireEvent.click(within(switcher).getByRole("button", { name: "Yandex Pay Design System" }));
    fireEvent.click(screen.getByRole("button", { name: "Rating" }));
    expect(screen.getByRole("heading", { name: "Rating" })).toBeTruthy();
    // Status badge from getComponentMeta (deprecated) with reason in the title.
    expect((await screen.findByText("Deprecated")).getAttribute("title")).toBe("Deprecated: use v4");
    // Figma badge from the component head revision provenance.
    expect((await screen.findByText("Figma")).getAttribute("title")).toBe("Figma abc · 2 nodes");
    // Live preview iframe targets the component capture shell with the example props.
    expect(screen.getByTitle("Rating preview").getAttribute("src")).toBe("/capture/component/rating/3?props=example");
    expect(screen.getByText("Choose a rating")).toBeTruthy();
    expect(screen.queryByTitle("Story preview")).toBeNull();
  });

  it("filters the custom component list by status chips", async () => {
    vi.mocked(fetchStorybookIndex).mockResolvedValue(null);
    vi.mocked(getCatalogManifest).mockResolvedValue(ratingManifest);
    renderLibrary();
    const switcher = await screen.findByLabelText("Design systems");
    fireEvent.click(within(switcher).getByRole("button", { name: "Yandex Pay Design System" }));
    const navigation = screen.getByRole("navigation", { name: "Components" });
    expect(within(navigation).getByRole("button", { name: /Rating/ })).toBeTruthy();
    // Wait for the lazy status load (meta latest version is deprecated → blocked, not verified).
    await waitFor(() => expect(vi.mocked(getComponentMeta)).toHaveBeenCalled());
    const filters = screen.getByLabelText("Status filters");
    // Verified filter hides the deprecated component.
    fireEvent.click(within(filters).getByRole("button", { name: "Verified" }));
    await waitFor(() => expect(within(navigation).queryByRole("button", { name: /Rating/ })).toBeNull());
    // Switching to Blocked brings it back.
    fireEvent.click(within(filters).getByRole("button", { name: "Verified" }));
    fireEvent.click(within(filters).getByRole("button", { name: "Blocked" }));
    expect(within(navigation).getByRole("button", { name: /Rating/ })).toBeTruthy();
  });

  it("switches sorted systems, groups known levels, and falls back to Other", async () => {
    vi.mocked(fetchStorybookIndex).mockResolvedValue({ entries: {
      wire: { id: "wire", title: "Wireframe/Atoms/Input", name: "Default", type: "story" },
      page: { id: "page", title: "Shadcn/Pages/Dashboard", name: "Default", type: "story" },
      atom: { id: "atom", title: "Shadcn/Atoms/Button", name: "Default", type: "story" },
      odd: { id: "odd", title: "Shadcn/Legacy", name: "Legacy story", type: "story" },
    } });
    renderLibrary();

    const switcher = await screen.findByLabelText("Design systems");
    expect(within(switcher).getAllByRole("button").map((button) => button.textContent)).toEqual(["Shadcn", "Wireframe", "Yandex Pay Design System"]);
    expect(within(switcher).getByRole("button", { name: "Shadcn" }).getAttribute("aria-pressed")).toBe("true");
    const navigation = screen.getByRole("navigation", { name: "Components" });
    expect(within(navigation).getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["Atoms", "Pages", "Other"]);
    expect(within(navigation).getByRole("button", { name: "Button" })).toBeTruthy();
    expect(within(navigation).getByRole("button", { name: "Legacy story" })).toBeTruthy();

    fireEvent.click(within(switcher).getByRole("button", { name: "Wireframe" }));
    expect(within(navigation).getByRole("button", { name: "Input" })).toBeTruthy();
    expect(within(navigation).queryByRole("button", { name: "Button" })).toBeNull();
    expect(screen.getByTitle("Story preview").getAttribute("src")).toContain("id=wire");
  });
});
