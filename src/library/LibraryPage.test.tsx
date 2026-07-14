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
  const badgeManifest = { id: "badge", name: "Badge", designSystem: "yandex-pay", version: 1, bundleUrl: "/badge.js", bundleHash: "badge-hash", atomicLevel: "atom" as const, description: "Show a badge", events: [], slots: [], hostAbiVersion: 1 };

  it("keeps registry systems and custom cards visible when Storybook is unavailable", async () => {
    vi.mocked(fetchStorybookIndex).mockResolvedValue(null);
    vi.mocked(getCatalogManifest).mockResolvedValue(ratingManifest);
    renderLibrary();
    expect(await screen.findByText(/Storybook недоступен/)).toBeTruthy();
    const switcher = screen.getByLabelText("Дизайн-системы");
    expect(within(switcher).getByRole("button", { name: "Yandex Pay Design System" })).toBeTruthy();
    fireEvent.click(within(switcher).getByRole("button", { name: "Yandex Pay Design System" }));
    fireEvent.click(screen.getByRole("button", { name: "Rating" }));
    expect(screen.getByRole("heading", { name: "Rating" })).toBeTruthy();
    // Status badge from getComponentMeta (deprecated) with reason in the title.
    expect((await screen.findByText("Устаревший")).getAttribute("title")).toBe("Устаревший: use v4");
    // Figma badge from the component head revision provenance.
    expect((await screen.findByText("Figma")).getAttribute("title")).toBe("Figma abc · 2 узла");
    // Live preview iframe targets the component capture shell with the example props.
    expect(screen.getByTitle("Превью компонента Rating").getAttribute("src")).toBe("/capture/component/rating/3?props=example");
    expect(screen.getByText("Choose a rating")).toBeTruthy();
    expect(screen.queryByTitle("Превью истории")).toBeNull();
  });

  it("filters the custom component list by status chips", async () => {
    vi.mocked(fetchStorybookIndex).mockResolvedValue(null);
    vi.mocked(getCatalogManifest).mockResolvedValue({ components: [...ratingManifest.components, badgeManifest] });
    vi.mocked(getComponentMeta).mockImplementation(async (id) => id === "badge"
      ? { id: "badge", name: "Badge", designSystem: "yandex-pay", headRev: 1, updatedAt: "now", figma: null, versions: [
        { version: 1, rev: 1, status: "active", statusReason: null, supersededBy: null, statusRev: 1, designSystem: "yandex-pay", publishedAt: "now" },
      ] }
      : { id: "rating", name: "Rating", designSystem: "yandex-pay", headRev: 3, updatedAt: "now", figma: null, versions: [
        { version: 3, rev: 3, status: "deprecated", statusReason: "use v4", supersededBy: null, statusRev: 2, designSystem: "yandex-pay", publishedAt: "now" },
      ] });
    renderLibrary();
    const switcher = await screen.findByLabelText("Дизайн-системы");
    fireEvent.click(within(switcher).getByRole("button", { name: "Yandex Pay Design System" }));
    const navigation = screen.getByRole("navigation", { name: "Компоненты" });
    expect(within(navigation).getByRole("button", { name: /Rating/ })).toBeTruthy();
    // Wait for the lazy status load: Rating is blocked, while Badge is published and pending.
    await waitFor(() => expect(vi.mocked(getComponentMeta)).toHaveBeenCalled());
    const filters = await screen.findByLabelText("Фильтры статусов");
    expect(within(filters).queryByRole("button", { name: "Проверен" })).toBeNull();
    expect(within(filters).queryByRole("button", { name: "Отклонён" })).toBeNull();
    fireEvent.click(within(filters).getByRole("button", { name: "Опубликован" }));
    await waitFor(() => expect(within(navigation).queryByRole("button", { name: /Rating/ })).toBeNull());
    expect(within(navigation).getByRole("button", { name: /Badge/ })).toBeTruthy();
    fireEvent.click(within(filters).getByRole("button", { name: "Опубликован" }));
    fireEvent.click(within(filters).getByRole("button", { name: "Заблокирован" }));
    expect(within(navigation).getByRole("button", { name: /Rating/ })).toBeTruthy();
    expect(within(navigation).queryByRole("button", { name: /Badge/ })).toBeNull();
  });

  it("hides status filters for builtin stories and a uniform custom component list", async () => {
    vi.mocked(fetchStorybookIndex).mockResolvedValue({ entries: {
      atom: { id: "atom", title: "Shadcn/Atoms/Button", name: "Default", type: "story" },
    } });
    vi.mocked(getCatalogManifest).mockResolvedValue(ratingManifest);
    renderLibrary();

    const switcher = await screen.findByLabelText("Дизайн-системы");
    expect(screen.queryByLabelText("Фильтры статусов")).toBeNull();
    fireEvent.click(within(switcher).getByRole("button", { name: "Yandex Pay Design System" }));
    await waitFor(() => expect(vi.mocked(getComponentMeta)).toHaveBeenCalled());
    expect(screen.queryByLabelText("Фильтры статусов")).toBeNull();
  });

  it("switches sorted systems, groups known levels, and falls back to Other", async () => {
    vi.mocked(fetchStorybookIndex).mockResolvedValue({ entries: {
      wire: { id: "wire", title: "Wireframe/Atoms/Input", name: "Default", type: "story" },
      page: { id: "page", title: "Shadcn/Pages/Dashboard", name: "Default", type: "story" },
      atom: { id: "atom", title: "Shadcn/Atoms/Button", name: "Default", type: "story" },
      odd: { id: "odd", title: "Shadcn/Legacy", name: "Legacy story", type: "story" },
    } });
    renderLibrary();

    const switcher = await screen.findByLabelText("Дизайн-системы");
    expect(within(switcher).getAllByRole("button").map((button) => button.textContent)).toEqual(["Shadcn", "Wireframe", "Yandex Pay Design System"]);
    expect(within(switcher).getByRole("button", { name: "Shadcn" }).getAttribute("aria-pressed")).toBe("true");
    const navigation = screen.getByRole("navigation", { name: "Компоненты" });
    expect(within(navigation).getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["Атомы", "Страницы", "Прочее"]);
    expect(within(navigation).getByRole("button", { name: "Button" })).toBeTruthy();
    expect(within(navigation).getByRole("button", { name: "Legacy story" })).toBeTruthy();

    fireEvent.click(within(switcher).getByRole("button", { name: "Wireframe" }));
    expect(within(navigation).getByRole("button", { name: "Input" })).toBeTruthy();
    expect(within(navigation).queryByRole("button", { name: "Button" })).toBeNull();
    expect(screen.getByTitle("Превью истории").getAttribute("src")).toContain("id=wire");
  });

  it("shows a meaningful empty state when the selected system has no components", async () => {
    vi.mocked(fetchStorybookIndex).mockResolvedValue({ entries: {} });
    renderLibrary();
    expect(await screen.findByRole("heading", { name: "В этой дизайн-системе пока нет компонентов" })).toBeTruthy();
    expect(screen.getByText(/Добавьте и опубликуйте первый пользовательский компонент через API/)).toBeTruthy();
    expect(screen.getByText("POST /api/components")).toBeTruthy();
    expect(screen.getByText("POST /api/components/{id}/publish")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Открыть описание API" }).getAttribute("href")).toBe("/api/openapi.json");
    expect(screen.queryByText(/Выберите компонент слева/)).toBeNull();
    expect(screen.queryByLabelText("Фильтры статусов")).toBeNull();
  });
});
