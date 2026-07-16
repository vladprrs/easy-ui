import { fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCatalogManifest, getComponentMeta, listDesignSystems, listVisualReferences } from "../api/client";
import { LibraryPage } from "./LibraryPage";

vi.mock("../api/client", () => ({ getCatalogManifest: vi.fn(), getComponentMeta: vi.fn(), listDesignSystems: vi.fn(), listVisualReferences: vi.fn() }));

function renderLibrary() {
  const router = createMemoryRouter([{ path: "/library", element: <LibraryPage /> }], { initialEntries: ["/library"] });
  render(<RouterProvider router={router} />);
}

describe("LibraryPage custom-only", () => {
  beforeEach(() => {
    vi.mocked(listDesignSystems).mockResolvedValue({ designSystems: [
      { id: "empty", name: "Empty", description: "", builtinCatalogHash: "", components: [] },
      { id: "yandex-pay", name: "Yandex Pay", description: "", builtinCatalogHash: "", components: [] },
    ] });
    vi.mocked(getCatalogManifest).mockResolvedValue({ components: [{
      id: "rating", name: "Rating", designSystem: "yandex-pay", version: 3, bundleUrl: "/rating.js", bundleHash: "hash", atomicLevel: "molecule", description: "Choose a rating", events: ["change"], slots: [], hostAbiVersion: 3, example: { rating: 3 },
    }] });
    vi.mocked(listVisualReferences).mockResolvedValue({ references: [] });
    vi.mocked(getComponentMeta).mockResolvedValue({ id: "rating", name: "Rating", designSystem: "yandex-pay", headRev: 3, updatedAt: "now", figma: null, versions: [] });
  });

  it("shows only API-backed custom components and their capture preview", async () => {
    renderLibrary();
    const systems = await screen.findByLabelText("Дизайн-системы");
    fireEvent.click(within(systems).getByRole("button", { name: "Yandex Pay" }));
    expect(await screen.findByRole("heading", { name: "Rating" })).toBeTruthy();
    expect(screen.getByTitle("Превью компонента Rating").getAttribute("src")).toBe("/capture/component/rating/3?props=example");
    expect(screen.queryByText(/Storybook/i)).toBeNull();
  });

  it("keeps the custom empty-state guide", async () => {
    renderLibrary();
    expect(await screen.findByRole("heading", { name: "В этой дизайн-системе пока нет компонентов" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Открыть описание API" }).getAttribute("href")).toBe("/api/openapi.json");
  });
});
