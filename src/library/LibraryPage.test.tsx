import { fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCatalogManifest, getComponentMeta, listDesignSystems } from "../api/client";
import { fetchStorybookIndex } from "./storybookIndex";
import { LibraryPage } from "./LibraryPage";

vi.mock("./storybookIndex", async (importOriginal) => {
  const original = await importOriginal<typeof import("./storybookIndex")>();
  return { ...original, fetchStorybookIndex: vi.fn() };
});
vi.mock("../api/client", () => ({ getCatalogManifest: vi.fn(), getComponentMeta: vi.fn(), listDesignSystems: vi.fn() }));

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
    vi.mocked(getComponentMeta).mockResolvedValue({ id: "rating", name: "Rating", designSystem: "yandex-pay", headRev: 3, updatedAt: "now", versions: [
      { version: 3, rev: 3, status: "deprecated", statusReason: "use v4", supersededBy: null, statusRev: 2, designSystem: "yandex-pay", publishedAt: "now" },
    ] });
  });

  it("keeps registry systems and custom cards visible when Storybook is unavailable", async () => {
    vi.mocked(fetchStorybookIndex).mockResolvedValue(null);
    vi.mocked(getCatalogManifest).mockResolvedValue({ components: [{ id: "rating", name: "Rating", designSystem: "yandex-pay", version: 3, bundleUrl: "/rating.js", bundleHash: "hash", atomicLevel: "molecule", description: "Choose a rating", events: ["change"], slots: ["icon"], hostAbiVersion: 1 }] });
    renderLibrary();
    expect(await screen.findByText(/Storybook is unavailable/)).toBeTruthy();
    const switcher = screen.getByLabelText("Design systems");
    expect(within(switcher).getByRole("button", { name: "Yandex Pay Design System" })).toBeTruthy();
    fireEvent.click(within(switcher).getByRole("button", { name: "Yandex Pay Design System" }));
    fireEvent.click(screen.getByRole("button", { name: "Rating" }));
    expect(screen.getByRole("heading", { name: "Rating" })).toBeTruthy();
    // Status badge from getComponentMeta (deprecated) with reason in the title.
    expect((await screen.findByText("Deprecated")).getAttribute("title")).toBe("Deprecated: use v4");
    expect(screen.getByText("Choose a rating")).toBeTruthy();
    expect(screen.queryByTitle("Story preview")).toBeNull();
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
