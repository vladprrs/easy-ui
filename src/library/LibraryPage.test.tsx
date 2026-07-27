import { fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCatalogManifest, getComponentMeta, getComponentUsages, listDesignSystems, listVisualReferences } from "../api/client";
import { LibraryPage } from "./LibraryPage";

vi.mock("../api/client", () => ({ getCatalogManifest: vi.fn(), getComponentMeta: vi.fn(), getComponentUsages: vi.fn(), listDesignSystems: vi.fn(), listVisualReferences: vi.fn() }));

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
      id: "rating", name: "Rating", designSystem: "yandex-pay", version: 3, bundleUrl: "/rating.js", bundleHash: "hash", atomicLevel: "molecule", description: "Choose a rating", events: ["change"], slots: [], hostAbiVersion: 3, example: { rating: 3 }, canonicalFor: ["ctyp-rating"], headUsageCount: 1,
    }, {
      id: "rating-legacy", name: "RatingLegacy", designSystem: "yandex-pay", version: 1, bundleUrl: "/legacy.js", bundleHash: "hash2", atomicLevel: "molecule", description: "Old rating widget", events: [], slots: [], hostAbiVersion: 3, deprecated: true, replacement: "Rating", headUsageCount: 0,
    }] });
    vi.mocked(listVisualReferences).mockResolvedValue({ references: [] });
    vi.mocked(getComponentMeta).mockResolvedValue({ id: "rating", name: "Rating", designSystem: "yandex-pay", headRev: 3, updatedAt: "now", figma: null, versions: [] });
    vi.mocked(getComponentUsages).mockResolvedValue({
      componentId: "rating", name: "Rating", versionsInUse: [3], safeToRemove: false, immutableUsages: [],
      currentHeadUsages: [{ prototypeId: "checkout", name: "Checkout", kind: "product-flow", rev: 4, componentVersion: 3, screens: [{ screenId: "home", screenName: "Home", elementKeys: ["stars"] }] }],
    });
  });

  it("shows only API-backed custom components and their capture preview", async () => {
    renderLibrary();
    const systems = await screen.findByLabelText("Дизайн-системы");
    fireEvent.click(within(systems).getByRole("button", { name: "Yandex Pay" }));
    expect(await screen.findByRole("heading", { name: "Rating" })).toBeTruthy();
    expect(screen.getByTitle("Превью компонента Rating").getAttribute("src")).toBe("/capture/component/rating/3?props=example");
    expect(screen.queryByText(/Storybook/i)).toBeNull();
  });

  it("searches by product job and ranks the canonical role above the description", async () => {
    renderLibrary();
    const systems = await screen.findByLabelText("Дизайн-системы");
    fireEvent.click(within(systems).getByRole("button", { name: "Yandex Pay" }));
    await screen.findByRole("heading", { name: "Rating" });

    fireEvent.change(screen.getByLabelText("Поиск по задаче"), { target: { value: "ctyp-rating" } });
    const nav = screen.getByLabelText("Компоненты");
    const matches = within(nav).getAllByRole("button");
    expect(matches).toHaveLength(1);
    expect(matches[0].textContent).toContain("Rating");

    fireEvent.change(screen.getByLabelText("Поиск по задаче"), { target: { value: "нетакого" } });
    expect(await screen.findByText(/Ничего не нашлось/)).toBeTruthy();
  });

  it("shows head usages with links and the deprecated → replacement badge", async () => {
    renderLibrary();
    const systems = await screen.findByLabelText("Дизайн-системы");
    fireEvent.click(within(systems).getByRole("button", { name: "Yandex Pay" }));

    expect(await screen.findByText("1 прототип")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Редактор" }).getAttribute("href")).toBe("/p/checkout/edit");
    fireEvent.click(screen.getByRole("button", { name: "Показать usages" }));
    expect(within(screen.getByLabelText("Дерево использования компонента")).getByText("stars")).toBeTruthy();

    const nav = screen.getByLabelText("Компоненты");
    fireEvent.click(within(nav).getByRole("button", { name: /RatingLegacy/ }));
    expect((await screen.findAllByTitle(/deprecated или superseded/)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Замена: Rating" }));
    expect(await screen.findByRole("heading", { name: "Rating" })).toBeTruthy();
  });

  it("keeps the custom empty-state guide", async () => {
    renderLibrary();
    expect(await screen.findByRole("heading", { name: "В этой дизайн-системе пока нет компонентов" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Открыть описание API" }).getAttribute("href")).toBe("/api/openapi.json");
  });
});
