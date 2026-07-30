import { fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCatalogManifest, getComponentMeta, listDesignSystems, listVisualReferences } from "../api/client";
import { LibraryPage } from "./LibraryPage";

vi.mock("../api/client", () => ({ getCatalogManifest: vi.fn(), getComponentMeta: vi.fn(), listCompositions: vi.fn(), listDesignSystems: vi.fn(), listVisualReferences: vi.fn() }));

function renderLibrary() {
  const router = createMemoryRouter([{ path: "/library", element: <LibraryPage /> }], { initialEntries: ["/library"] });
  render(<RouterProvider router={router} />);
}

describe("LibraryPage витрина компонентов", () => {
  beforeEach(() => {
    vi.mocked(listDesignSystems).mockResolvedValue({ designSystems: [
      { id: "empty", name: "Empty", description: "", builtinCatalogHash: "", components: [] },
      { id: "yandex-pay", name: "Yandex Pay", description: "", builtinCatalogHash: "", components: [] },
    ] });
    vi.mocked(getCatalogManifest).mockResolvedValue({ components: [{
      id: "rating", name: "Rating", designSystem: "yandex-pay", version: 3, bundleUrl: "/rating.js", bundleHash: "hash", atomicLevel: "molecule", description: "Choose a rating", events: ["change"], slots: [], hostAbiVersion: 3, example: { rating: 3 }, canonicalFor: ["ctyp-rating"], headUsageCount: 1,
    }, {
      id: "rating-legacy", name: "RatingLegacy", designSystem: "yandex-pay", version: 1, bundleUrl: "/legacy.js", bundleHash: "hash2", atomicLevel: "molecule", description: "Old rating widget", events: [], slots: [], hostAbiVersion: 3, deprecated: true, replacement: "Rating", headUsageCount: 0,
    }, {
      id: "chip", name: "Chip", designSystem: "yandex-pay", version: 2, bundleUrl: "/chip.js", bundleHash: "hash3", atomicLevel: "atom", description: "", events: [], slots: [], hostAbiVersion: 3, headUsageCount: 0,
    }] });
    vi.mocked(listVisualReferences).mockResolvedValue({ references: [] });
    vi.mocked(getComponentMeta).mockResolvedValue({ id: "rating", name: "Rating", designSystem: "yandex-pay", headRev: 3, updatedAt: "now", figma: null, versions: [{ version: 3, rev: 3, status: "active", statusReason: null, supersededBy: null, statusRev: 3, designSystem: "yandex-pay", publishedAt: "now" }] });
  });

  it("показывает карточки по уровням: живое превью, ссылка на страницу компонента и использование", async () => {
    renderLibrary();

    // Уровни Atomic Design — заголовки секций; карточка ведёт на страницу компонента.
    const molecules = await screen.findByLabelText("Молекулы");
    expect(within(molecules).getByRole("link", { name: "Rating" }).getAttribute("href")).toBe("/library/c/rating?v=3");
    expect(screen.getByLabelText("Атомы")).toBeTruthy();

    expect(screen.getByTitle("Живое превью компонента Rating").getAttribute("src")).toBe("/capture/component/rating/3?props=example");
    expect(within(molecules).getByText("используется в 1 прототипе")).toBeTruthy();
    // Компонент без example-props честно объясняет отсутствие превью.
    expect(screen.getAllByText(/не заданы example-props/).length).toBe(2);
    // Статус подгружается лениво и рисуется точкой с подписью.
    expect((await screen.findAllByText("готов")).length).toBeGreaterThan(0);
  });

  it("ищет по работе компонента и сбрасывает фильтры из пустого состояния", async () => {
    renderLibrary();
    await screen.findByLabelText("Молекулы");

    fireEvent.change(screen.getByPlaceholderText(/navbar/), { target: { value: "ctyp-rating" } });
    const found = screen.getByLabelText("Нашлось 1 компонент");
    expect(within(found).getAllByRole("listitem")).toHaveLength(1);
    expect(within(found).getByRole("link", { name: "Rating" })).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/navbar/), { target: { value: "нетакого" } });
    expect(screen.getByText(/Ничего не нашлось/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить фильтры" }));
    expect(screen.getByLabelText("Молекулы")).toBeTruthy();
  });

  it("фильтрует по дизайн-системе и показывает деприкейт с заменой", async () => {
    renderLibrary();
    const systems = await screen.findByLabelText("Дизайн-системы");
    // Системы без компонентов в фильтр не попадают — выбирать нечего.
    expect(within(systems).queryByRole("button", { name: /Empty/ })).toBeNull();

    fireEvent.click(within(systems).getByRole("button", { name: "Yandex Pay · 3" }));
    const molecules = screen.getByLabelText("Молекулы");
    expect(within(molecules).getByRole("link", { name: "RatingLegacy" })).toBeTruthy();
    expect(within(molecules).getByText("Устаревший")).toBeTruthy();
    expect(within(molecules).getByText("Замена: Rating")).toBeTruthy();
    expect(within(molecules).getByText("Канонический")).toBeTruthy();
  });

  it("объясняет публикацию через API вместо кнопки в никуда", async () => {
    renderLibrary();
    await screen.findByLabelText("Молекулы");

    fireEvent.click(screen.getByRole("button", { name: "Опубликовать компонент" }));
    const dialog = screen.getByRole("dialog", { name: "Как опубликовать компонент" });
    expect(within(dialog).getByText("POST /api/components")).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "Открыть описание API" }).getAttribute("href")).toBe("/api/openapi.json");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("показывает пустое состояние библиотеки, когда компонентов нет", async () => {
    vi.mocked(getCatalogManifest).mockResolvedValue({ components: [] });
    renderLibrary();
    expect(await screen.findByRole("heading", { name: "В библиотеке пока нет компонентов" })).toBeTruthy();
    expect(screen.queryByLabelText("Дизайн-системы")).toBeNull();
  });
});
