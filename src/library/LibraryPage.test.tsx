import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getComponentPreview, getDesignSystemById, getLibraryCatalog, type LibraryCatalogEntry, type LibraryCatalogResponse } from "../api/client";
import { resetFontRegistryForTests } from "../designSystems/fontRegistry";
import { resetThemeCacheForTests } from "../designSystems/themeCache";
import { LibraryPage } from "./LibraryPage";
import { resetMountedPreviewsForTests } from "./preview/mountedRegistry";
import { resetPreviewSchedulerForTests } from "./preview/previewScheduler";

vi.mock("../api/client", () => ({
  getLibraryCatalog: vi.fn(), getComponentPreview: vi.fn(), getDesignSystemById: vi.fn(), listCompositions: vi.fn(),
}));

const entry = (patch: Partial<LibraryCatalogEntry> & { id: string }): LibraryCatalogEntry => ({
  kind: "component",
  name: patch.id,
  designSystem: "yandex-pay",
  version: 1,
  bundleUrl: `/api/components/${patch.id}/versions/1/bundle.js`,
  bundleHash: "hash",
  hostAbiVersion: 4,
  description: "",
  layoutNeutral: false,
  canonicalFor: [],
  deprecated: false,
  headUsageCount: 0,
  status: { published: true, verified: false, visualPending: true, blocked: false, rejected: false, accepted: false },
  figma: null,
  preview: { selector: "legacy" },
  ...patch,
});

/**
 * Витрина «Рекомендуем» — повышение: попавшая на неё запись уходит из своего яруса (ровно один
 * рендер на компонент). Чтобы нижние ярусы вообще существовали, шельф из 12 мест занимают
 * заведомые фавориты — организмы с использованием, какого у образцов ниже нет.
 */
const shelf = Array.from({ length: 12 }, (_, index) => entry({
  id: `top${index}`, name: `Top${String(index).padStart(2, "0")}`, atomicLevel: "organism", headUsageCount: 100,
}));

const catalog = (patch: Partial<LibraryCatalogResponse> = {}): LibraryCatalogResponse => ({
  catalogRevision: "rev",
  systems: [{ id: "yandex-pay", name: "Yandex Pay", count: 16 }, { id: "e2e", name: "E2E", count: 1 }],
  components: [
    ...shelf,
    entry({ id: "rating", name: "Rating", version: 3, atomicLevel: "molecule", description: "Choose a rating", canonicalFor: ["ctyp-rating"], headUsageCount: 1 }),
    entry({ id: "rating-legacy", name: "RatingLegacy", atomicLevel: "molecule", description: "Old rating widget", deprecated: true, replacement: "Rating" }),
    entry({ id: "chip", name: "Chip", version: 2, atomicLevel: "atom", preview: null }),
    entry({ id: "navbar", name: "Navbar", atomicLevel: "organism", status: { published: false, verified: false, visualPending: false, blocked: false, rejected: true, accepted: false } }),
    entry({ id: "rating", name: "Rating", designSystem: "e2e", atomicLevel: "molecule" }),
  ],
  ...patch,
});

function renderLibrary(search = "") {
  const router = createMemoryRouter([{ path: "/library", element: <LibraryPage /> }], { initialEntries: [`/library${search}`] });
  render(<RouterProvider router={router} />);
}

describe("LibraryPage витрина компонентов", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPreviewSchedulerForTests();
    resetMountedPreviewsForTests();
    resetThemeCacheForTests();
    resetFontRegistryForTests();
    vi.mocked(getLibraryCatalog).mockResolvedValue(catalog());
    // Превью намеренно не разрешается: экран обязан быть готов и искаться до того, как оно осядет.
    vi.mocked(getComponentPreview).mockReturnValue(new Promise(() => {}));
    vi.mocked(getDesignSystemById).mockReturnValue(new Promise(() => {}));
  });

  it("читает каталог одним запросом и готов до того, как осядет хоть одно превью", async () => {
    renderLibrary();
    const main = await screen.findByRole("main");
    expect(main.getAttribute("data-library-ready")).toBe("true");
    expect(vi.mocked(getLibraryCatalog)).toHaveBeenCalledTimes(1);

    // Ни одно превью не готово, но метаданные уже на экране и ищутся.
    expect(document.querySelectorAll("[data-component-preview-state='ready']").length).toBe(0);
    expect(document.querySelectorAll("iframe").length).toBe(0);
    expect(screen.getByRole("heading", { level: 1, name: "Компоненты вашей дизайн-системы" })).toBeTruthy();
    expect(screen.getByText("Агент использует их в прототипах и добавляет новые, когда нужно.")).toBeTruthy();
    expect(screen.getByPlaceholderText("Например, кнопка оплаты или экран успеха")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Поиск по задаче"), { target: { value: "ctyp-rating" } });
    const found = screen.getByLabelText("Нашлось 1 компонент");
    expect(within(found).getByRole("link", { name: "Rating" }).getAttribute("href")).toBe("/library/c/rating?v=3");
  });

  it("раскладывает каталог по ярусам и различает одноимённые компоненты разных систем", async () => {
    renderLibrary();
    const molecules = await screen.findByLabelText("Молекулы");
    const recommended = screen.getByLabelText("Рекомендуем");
    // Одноимённые записи двух систем — две разные карточки, но каждая ровно одна на экране:
    // канонический Rating забрала витрина, его тёзка из другой системы остался в молекулах.
    expect(screen.getAllByRole("link", { name: "Rating" })).toHaveLength(2);
    expect(within(recommended).getAllByRole("link", { name: "Rating" })).toHaveLength(1);
    expect(within(recommended).getByText("используется в 1 прототипе")).toBeTruthy();
    expect(within(molecules).getAllByRole("link", { name: "Rating" })).toHaveLength(1);
    // Витрина ограничена 12 местами, и всё, что на неё попало, ушло из своего яруса.
    expect(within(recommended).getAllByRole("listitem")).toHaveLength(12);
    expect(screen.getAllByRole("link", { name: "Top00" })).toHaveLength(1);
    // Ярусы: организмы отдельно, атомы и списанное — компактными индексами.
    expect(screen.getByLabelText("Страницы, шаблоны и организмы")).toBeTruthy();
    expect(within(screen.getByLabelText("Атомы и лэйаут")).getByRole("link", { name: "Chip" })).toBeTruthy();
    const retired = screen.getByLabelText("Устаревшее");
    expect(within(retired).getByRole("link", { name: "RatingLegacy" })).toBeTruthy();
    expect(within(retired).getByText("Замена: Rating")).toBeTruthy();
  });

  it("повышенный на витрину атом не грузится сам, а ждёт кнопки", async () => {
    vi.mocked(getLibraryCatalog).mockResolvedValue(catalog({
      components: [entry({ id: "chip", name: "Chip", atomicLevel: "atom", headUsageCount: 500 })],
    }));
    renderLibrary();
    const recommended = await screen.findByLabelText("Рекомендуем");
    const card = within(recommended).getByRole("listitem");

    // Одна ссылка на весь экран — карточка не продублирована в компактном индексе.
    expect(screen.getAllByRole("link", { name: "Chip" })).toHaveLength(1);
    expect(screen.queryByLabelText("Атомы и лэйаут")).toBeNull();
    // Атом не встаёт в очередь ни в каком ярусе: превью в DOM нет, запроса тоже.
    expect(card.querySelectorAll("[data-component-preview]").length).toBe(0);
    expect(vi.mocked(getComponentPreview)).not.toHaveBeenCalled();

    fireEvent.click(within(card).getByRole("button", { name: "Показать превью" }));
    expect(card.querySelectorAll("[data-component-preview]").length).toBe(1);
    await waitFor(() => expect(vi.mocked(getComponentPreview)).toHaveBeenCalledTimes(1));
  });

  it("в компактном индексе превью раскрывается только по действию пользователя", async () => {
    renderLibrary();
    const atoms = await screen.findByLabelText("Атомы и лэйаут");
    expect(within(atoms).queryByText("Превью недоступно: не заданы примерные параметры.")).toBeNull();

    const button = within(atoms).getByRole("button", { name: "Показать превью" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    // У Chip нет примерных параметров — превью честно объясняет своё отсутствие.
    expect(within(atoms).getByText("Превью недоступно: не заданы примерные параметры.")).toBeTruthy();
  });

  it("фильтрует по дизайн-системе и по статусу", async () => {
    renderLibrary();
    const systems = await screen.findByLabelText("Дизайн-системы");
    fireEvent.click(within(systems).getByRole("button", { name: "E2E · 1" }));
    // Единственная запись системы — она же и вся витрина; в нижние ярусы ей уже не попасть.
    expect(within(screen.getByLabelText("Рекомендуем")).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByLabelText("Молекулы")).toBeNull();
    expect(screen.queryByLabelText("Атомы и лэйаут")).toBeNull();

    fireEvent.click(within(systems).getByRole("button", { name: "Все системы" }));
    fireEvent.click(within(screen.getByLabelText("Фильтры статусов")).getByRole("button", { name: "Отклонён" }));
    expect(screen.getByLabelText("Страницы, шаблоны и организмы")).toBeTruthy();
    expect(screen.queryByLabelText("Молекулы")).toBeNull();
  });

  // Признак `accepted` (RFC candidate-acceptance §7, волна R3c): чип и бейдж появляются только
  // там, где приёмка что-то нашла. Пустая приёмка (ожидаемое состояние прода до включения
  // promote-практики) не должна ни рисовать бейджей, ни добавлять неработающий чип.
  it("показывает чип и бейдж приёмки только при непустом accepted", async () => {
    renderLibrary();
    await screen.findByLabelText("Молекулы");
    expect(within(screen.getByLabelText("Фильтры статусов")).queryByRole("button", { name: "Принят" })).toBeNull();
    expect(screen.queryByTitle(/через приёмку/)).toBeNull();

    vi.mocked(getLibraryCatalog).mockResolvedValue(catalog({
      components: [
        ...shelf,
        entry({ id: "rating", name: "Rating", atomicLevel: "molecule" }),
        entry({
          id: "accepted-one", name: "AcceptedOne", atomicLevel: "molecule",
          status: { published: true, verified: false, visualPending: true, blocked: false, rejected: false, accepted: true },
        }),
      ],
    }));
    cleanup();
    renderLibrary();
    const molecules = await screen.findByLabelText("Молекулы");
    expect(within(molecules).getAllByTitle(/через приёмку/)).toHaveLength(1);

    fireEvent.click(within(screen.getByLabelText("Фильтры статусов")).getByRole("button", { name: "Принят" }));
    // Осталась ровно принятая запись (единственная — она же и вся витрина «Рекомендуем»).
    expect(screen.getAllByRole("link", { name: "AcceptedOne" })).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "Rating" })).toBeNull();
  });

  it("не монтирует превью при ?libraryPreviews=off", async () => {
    renderLibrary("?libraryPreviews=off");
    await screen.findByLabelText("Молекулы");
    expect(document.querySelectorAll("[data-component-preview]").length).toBe(0);
    expect(vi.mocked(getComponentPreview)).not.toHaveBeenCalled();
    // Метаданные при этом на месте.
    expect(screen.getAllByText("Choose a rating").length).toBeGreaterThan(0);
  });

  it("сбрасывает фильтры из пустого состояния поиска", async () => {
    renderLibrary();
    await screen.findByLabelText("Молекулы");
    fireEvent.change(screen.getByLabelText("Поиск по задаче"), { target: { value: "нетакого" } });
    expect(screen.getByText("Ничего не нашли. Попробуйте описать задачу иначе.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить фильтры" }));
    expect(screen.getByLabelText("Молекулы")).toBeTruthy();
  });

  it("не предлагает ручную публикацию компонента в непустой библиотеке", async () => {
    renderLibrary();
    await screen.findByLabelText("Молекулы");
    expect(screen.queryByRole("button", { name: "Опубликовать компонент" })).toBeNull();
    expect(screen.queryByText("POST /api/components")).toBeNull();
  });

  it("показывает пустое состояние библиотеки, когда компонентов нет", async () => {
    vi.mocked(getLibraryCatalog).mockResolvedValue(catalog({ components: [], systems: [] }));
    renderLibrary();
    expect(await screen.findByRole("heading", { name: "Компонентов пока нет" })).toBeTruthy();
    expect(screen.getAllByText("Агент добавит нужные компоненты при сборке прототипа.").length).toBeGreaterThan(0);
    expect(screen.getByText("Агент добавит и опубликует нужные компоненты при сборке прототипа.")).toBeTruthy();
    expect(screen.queryByLabelText("Дизайн-системы")).toBeNull();
    expect(screen.queryByRole("button", { name: "Опубликовать компонент" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Собрать с агентом" }));
    const dialog = screen.getByRole("dialog", { name: "Соберите прототип с агентом" });
    expect(within(dialog).getByText("Откройте Codex или Claude со скиллом Easy UI и опишите идею. Агент соберёт прототип и добавит его в галерею.")).toBeTruthy();
  });
});
