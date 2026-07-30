import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, createPrototype, getCatalogManifest, getPrototypeDraft, listDesignSystems, listPrototypes, listPrototypeVersions, setPrototypeLifecycle, setPrototypeStatus, type PrototypeKind, type PrototypeSummary } from "../api/client";
import { filterAndSortPrototypes, GalleryPage } from "./GalleryPage";
import type { GalleryTab } from "./galleryModel";

vi.mock("../api/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api/client")>();
  return { ...original, createPrototype: vi.fn(), getCatalogManifest: vi.fn(), getPrototypeDraft: vi.fn(), listDesignSystems: vi.fn(), listPrototypes: vi.fn(), listPrototypeVersions: vi.fn(), setPrototypeLifecycle: vi.fn(), setPrototypeStatus: vi.fn() };
});
vi.mock("../auth", () => ({ useAuth: () => ({ user: { userId: "user-me", name: "Я", isAdmin: false }, loading: false }) }));
vi.mock("./GalleryShareDialog", () => ({
  GalleryShareDialog: ({ prototypeId, latestVersion, onClose }: { prototypeId: string; latestVersion: number; onClose: () => void }) => <div role="dialog" aria-label={`QR ${prototypeId} v${latestVersion}`}><button type="button" onClick={onClose}>Закрыть QR</button></div>,
}));

const summary: PrototypeSummary = {
  id: "hello-world", name: "Hello World", description: "A minimal two-screen prototype.", device: "mobile" as const,
  designSystem: "shadcn",
  screenCount: 2, flowCount: 1, headRev: 3, latestVersion: 2, updatedAt: "2026-07-10T00:00:00.000Z",
  status: "private", owner: { id: "user-me", name: "Я" },
};

const draft = {
  doc: {
    version: 1 as const, id: summary.id, name: summary.name, description: summary.description, designSystem: "shadcn", device: "mobile" as const,
    startScreen: "welcome", state: {}, screens: [{ id: "welcome", name: "Welcome", spec: { root: "copy", elements: { copy: { type: "Text", props: { text: "Preview" } } } } }],
  },
  rev: 3, builtinCatalogHash: "builtin", componentManifestHash: "empty", components: [],
};

type IntersectionCallback = ConstructorParameters<typeof IntersectionObserver>[0];
let intersectionObservers: { callback: IntersectionCallback; element: Element | null }[] = [];

function intersect(element: Element, isIntersecting: boolean) {
  const observer = intersectionObservers.find((candidate) => candidate.element === element);
  if (!observer) throw new Error("Element is not observed");
  observer.callback([{ isIntersecting, target: element } as IntersectionObserverEntry], {} as IntersectionObserver);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function renderGallery() {
  const router = createMemoryRouter([{ path: "/", element: <GalleryPage /> }, { path: "/p/:id/v/:version", element: <p>Плеер версии</p> }, { path: "/p/:id/edit", element: <p>Редактор нового прототипа</p> }], { initialEntries: ["/"] });
  render(<RouterProvider router={router} />);
  return router;
}

// Статус-действия владельца живут внутри свёрнутого «⋯»-меню (нативный <details>).
// Раскрываем его так же, как пользователь: клик по <summary aria-label="Действия">.
// В этом jsdom клик по summary тоглит details.open — именно так меню и открывается.
function openCardMenu(card: HTMLElement) {
  const summary = within(card).getByLabelText("Действия");
  const details = summary.closest("details") as HTMLDetailsElement;
  if (!details.open) fireEvent.click(summary);
  expect(details.open).toBe(true);
  return details;
}

describe("GalleryPage", () => {
  beforeEach(() => {
    vi.mocked(listPrototypes).mockReset();
    vi.mocked(listDesignSystems).mockReset();
    vi.mocked(listPrototypeVersions).mockReset();
    vi.mocked(createPrototype).mockReset();
    vi.mocked(getCatalogManifest).mockReset();
    vi.mocked(getPrototypeDraft).mockReset();
    vi.mocked(setPrototypeStatus).mockReset();
    vi.mocked(setPrototypeLifecycle).mockReset();
    vi.mocked(getPrototypeDraft).mockResolvedValue(draft);
    intersectionObservers = [];
    vi.stubGlobal("IntersectionObserver", class {
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds = [0];
      private record: { callback: IntersectionCallback; element: Element | null };
      constructor(callback: IntersectionCallback) {
        this.record = { callback, element: null };
        intersectionObservers.push(this.record);
      }
      observe(element: Element) { this.record.element = element; }
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    });
    vi.mocked(getCatalogManifest).mockResolvedValue({ components: [
      { id: "starter", name: "Starter", designSystem: "shadcn", version: 1, bundleUrl: "/starter.js", bundleHash: "hash", hostAbiVersion: 3, description: "", events: [], slots: [] },
      { id: "starter-wire", name: "StarterWire", designSystem: "wireframe", version: 1, bundleUrl: "/starter-wire.js", bundleHash: "hash", hostAbiVersion: 3, description: "", events: [], slots: [] },
    ] });
    vi.mocked(createPrototype).mockResolvedValue({ id: "created-prototype", rev: 1, warnings: [] });
    vi.mocked(setPrototypeStatus).mockImplementation(async (_id, status) => ({ status }));
    vi.mocked(listPrototypeVersions).mockResolvedValue([{ version: 2, rev: 3, publishedAt: "2026-07-10T00:00:00.000Z" }]);
    vi.mocked(listDesignSystems).mockResolvedValue({ designSystems: [
      { id: "shadcn", name: "Shadcn", description: "", builtinCatalogHash: "one", components: [] },
      { id: "wireframe", name: "Wireframe", description: "", builtinCatalogHash: "two", components: [] },
    ] });
  });

  it("shows loading, then renders draft and published links from summaries", async () => {
    const request = deferred<(typeof summary)[]>();
    vi.mocked(listPrototypes).mockReturnValue(request.promise);
    renderGallery();
    expect(screen.getByText("Загружаем прототипы…")).toBeTruthy();
    expect(document.title).toBe("Прототипы — easy-ui");
    await act(async () => request.resolve([summary]));
    expect(screen.getByRole("heading", { name: "Hello World" })).toBeTruthy();
    const card = screen.getByRole("heading", { name: "Hello World" }).closest("li")!;
    // Мета-строка карточки: экраны, сценарии, дата — и ничего больше (макет 01).
    expect(within(card).getByText("2 экрана")).toBeTruthy();
    expect(within(card).getByText("1 сценарий")).toBeTruthy();
    expect(within(card).getByText("обновлён 10 июл. 2026 г.")).toBeTruthy();
    expect(within(card).getByText("Shadcn")).toBeTruthy();
    // Заглушки описания и статус-чипа приватного прототипа на карточке нет.
    expect(within(card).queryByText("Без описания")).toBeNull();
    expect(within(card).queryByText("Черновик")).toBeNull();
    const draftLink = within(card).getByRole("link", { name: "Hello World" });
    expect(draftLink.getAttribute("href")).toBe("/p/hello-world");
    const menu = within(openCardMenu(card));
    expect(menu.getByRole("link", { name: "Плеер" }).getAttribute("href")).toBe("/p/hello-world");
    expect(menu.getByRole("link", { name: "Сценарии" }).getAttribute("href")).toBe("/p/hello-world/cjm");
    expect(menu.getByRole("link", { name: "Презентация" }).getAttribute("href")).toBe("/p/hello-world/present");
    fireEvent.click(menu.getByText("Версии"));
    expect((await screen.findByRole("link", { name: "Версия v2" })).getAttribute("href")).toBe("/p/hello-world/v/2");
  });

  it("loads a preview only after intersection and unmounts it offscreen", async () => {
    vi.mocked(listPrototypes).mockResolvedValue([summary]);
    renderGallery();
    const card = (await screen.findByRole("heading", { name: "Hello World" })).closest("li")!;
    const previewRoot = card.querySelector("[data-gallery-preview]")!;
    expect(getPrototypeDraft).not.toHaveBeenCalled();
    await waitFor(() => expect(intersectionObservers.some((candidate) => candidate.element === previewRoot)).toBe(true));

    await act(async () => intersect(previewRoot, true));
    expect(await screen.findByTestId("gallery-preview-hello-world")).toBeTruthy();
    expect(getPrototypeDraft).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("gallery-preview-hello-world").querySelector("[inert]")).not.toBeNull();

    await act(async () => intersect(previewRoot, false));
    expect(screen.queryByTestId("gallery-preview-hello-world")).toBeNull();
    expect(previewRoot.getAttribute("data-gallery-preview-mounted")).toBe("false");
  });

  it("limits concurrent preview document loads to four", async () => {
    const requests = Array.from({ length: 5 }, () => deferred<typeof draft>());
    let requestIndex = 0;
    vi.mocked(getPrototypeDraft).mockImplementation(() => requests[requestIndex++]!.promise);
    vi.mocked(listPrototypes).mockResolvedValue(Array.from({ length: 5 }, (_, index) => ({
      ...summary, id: `prototype-${index}`, name: `Prototype ${index}`,
    })));
    renderGallery();
    await screen.findByRole("heading", { name: "Prototype 4" });
    const previewRoots = Array.from(document.querySelectorAll("[data-gallery-preview]"));
    await waitFor(() => expect(intersectionObservers.filter(({ element }) => previewRoots.includes(element!))).toHaveLength(5));

    await act(async () => { for (const root of previewRoots) intersect(root, true); });
    await waitFor(() => expect(getPrototypeDraft).toHaveBeenCalledTimes(4));
    await act(async () => requests[0]!.resolve(draft));
    await waitFor(() => expect(getPrototypeDraft).toHaveBeenCalledTimes(5));
    await act(async () => { for (const request of requests.slice(1)) request.resolve(draft); });
  });

  it("searches by name and sorts by updated date or name", async () => {
    vi.mocked(listPrototypes).mockResolvedValue([
      { ...summary, id: "zulu", name: "Зебра", updatedAt: "2026-07-12T00:00:00.000Z" },
      { ...summary, id: "alpha", name: "Альфа", updatedAt: "2026-07-01T00:00:00.000Z" },
    ]);
    renderGallery();
    await screen.findByRole("heading", { name: "Альфа" });
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Зебра", "Альфа"]);

    fireEvent.change(screen.getByLabelText("Сортировка"), { target: { value: "name" } });
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Альфа", "Зебра"]);
    fireEvent.change(screen.getByLabelText("Поиск по названию"), { target: { value: "зеб" } });
    expect(screen.getByRole("heading", { name: "Зебра" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Альфа" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Поиск по названию"), { target: { value: "нет такого" } });
    expect(screen.getByText("По вашему запросу ничего не найдено.")).toBeTruthy();
  });

  it("stretches the card link over a non-interactive layer and keeps actions separately focusable", async () => {
    vi.mocked(listPrototypes).mockResolvedValue([summary]);
    renderGallery();
    const card = (await screen.findByRole("heading", { name: "Hello World" })).closest("li")!;
    // Stretched-link: the title link covers the whole card via an absolute pseudo-element.
    const cardLink = within(card).getByRole("link", { name: "Hello World" });
    expect(card.className).toContain("relative");
    expect(cardLink.className).toContain("after:absolute");
    expect(cardLink.className).toContain("after:inset-0");
    // No nested interactive elements: no anchor lives inside another anchor.
    for (const anchor of Array.from(card.querySelectorAll("a"))) {
      expect(anchor.parentElement?.closest("a")).toBeNull();
    }
    // Единственный контрол карточки — «⋯»: он лежит над растянутой ссылкой со своим tab stop.
    const menu = within(card).getByLabelText("Действия").closest("details")!;
    expect(menu.className).toContain("relative");
    expect(menu.parentElement!.className).toContain("z-10");
    expect(within(card).getAllByRole("link").filter((link) => link !== cardLink && !menu.contains(link))).toHaveLength(0);
  });

  it("opens any published version from the card versions menu", async () => {
    vi.mocked(listPrototypes).mockResolvedValue([summary]);
    vi.mocked(listPrototypeVersions).mockResolvedValue([
      { version: 3, rev: 5, publishedAt: "2026-07-12T00:00:00.000Z" },
      { version: 2, rev: 3, publishedAt: "2026-07-10T00:00:00.000Z" },
    ]);
    const router = renderGallery();
    const card = (await screen.findByRole("heading", { name: "Hello World" })).closest("li")!;
    fireEvent.click(within(openCardMenu(card)).getByText("Версии"));
    fireEvent.click(await screen.findByRole("link", { name: "Версия v3" }));
    expect(router.state.location.pathname).toBe("/p/hello-world/v/3");
  });

  it("opens one QR dialog for a published prototype and hides the action without versions", async () => {
    vi.mocked(listPrototypes).mockResolvedValue([
      summary,
      { ...summary, id: "draft-only", name: "Draft only", latestVersion: null },
    ]);
    renderGallery();
    const publishedCard = (await screen.findByRole("heading", { name: "Hello World" })).closest("li")!;
    const draftCard = screen.getByRole("heading", { name: "Draft only" }).closest("li")!;

    const qrButton = within(openCardMenu(publishedCard)).getByRole("button", { name: "QR на телефон" });
    expect(within(openCardMenu(draftCard)).queryByRole("button", { name: "QR на телефон" })).toBeNull();
    fireEvent.click(qrButton);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "QR hello-world v2" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть QR" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows an API error and retries", async () => {
    vi.mocked(listPrototypes).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([]);
    renderGallery();
    expect(await screen.findByText("API недоступен")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByRole("heading", { name: "Создайте первый прототип" })).toBeTruthy();
    expect(listPrototypes).toHaveBeenCalledTimes(2);
  });

  it("filters by registered and legacy design systems and shows readable badges", async () => {
    vi.mocked(listDesignSystems).mockResolvedValue({ designSystems: [
      { id: "shadcn", name: "Shadcn", description: "", builtinCatalogHash: "one", components: [] },
      { id: "wireframe", name: "Wireframe", description: "", builtinCatalogHash: "two", components: [] },
      { id: "yandex-pay", name: "Yandex Pay Design System", description: "", builtinCatalogHash: "", components: [] },
    ] });
    vi.mocked(listPrototypes).mockResolvedValue([
      summary,
      { ...summary, id: "wire", name: "Wire flow", designSystem: "wireframe" },
      { ...summary, id: "legacy", name: "Legacy flow", designSystem: "classic" },
    ]);
    renderGallery();

    const systemFilter = await screen.findByLabelText("Дизайн-система");
    expect(within(systemFilter).getByRole("option", { name: "Дизайн-система: все" })).toBeTruthy();
    for (const name of ["Wireframe", "Shadcn", "Yandex Pay Design System", "classic"]) {
      expect(within(systemFilter).getByRole("option", { name })).toBeTruthy();
    }
    expect(screen.getByRole("heading", { name: "Hello World" })).toBeTruthy();
    fireEvent.change(systemFilter, { target: { value: "wireframe" } });
    expect(screen.getByRole("heading", { name: "Wire flow" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Hello World" })).toBeNull();
    expect(within(screen.getByRole("heading", { name: "Wire flow" }).closest("li")!).getByText("Wireframe")).toBeTruthy();
    fireEvent.change(systemFilter, { target: { value: "classic" } });
    expect(screen.getByRole("heading", { name: "Legacy flow" })).toBeTruthy();
    expect(within(screen.getByRole("heading", { name: "Legacy flow" }).closest("li")!).getByText("classic")).toBeTruthy();
  });

  it("filters mine, shared and archive tabs in the chokepoint", () => {
    const rows: PrototypeSummary[] = [
      { ...summary, id: "own-private", name: "Own private", status: "private" },
      { ...summary, id: "own-published", name: "Own published", status: "published" },
      { ...summary, id: "own-archived", name: "Own archived", status: "archived" },
      { ...summary, id: "foreign-published", name: "Foreign published", status: "published", owner: { id: "user-other", name: "Другой" } },
    ];
    const ids = (tab: "mine" | "shared" | "archive") => filterAndSortPrototypes(rows, { tab, userId: "user-me", systemId: null, query: "", sort: "name" }).map(({ id }) => id);
    expect(ids("mine")).toEqual(["own-private", "own-published"]);
    expect(ids("shared")).toEqual(["foreign-published", "own-published"]);
    expect(ids("archive")).toEqual(["own-archived"]);
  });

  it("hides service kinds from the product tabs and shows them under «Служебные»", () => {
    const rows: PrototypeSummary[] = [
      { ...summary, id: "flow", name: "Flow", status: "private" },
      { ...summary, id: "legacy-no-kind", name: "Legacy", status: "private", kind: undefined },
      { ...summary, id: "fixture", name: "Fixture", status: "private", kind: "composition-fixture" },
      { ...summary, id: "evidence", name: "Evidence", status: "published", kind: "evidence" },
      { ...summary, id: "experiment", name: "Experiment", status: "private", kind: "experiment" },
    ];
    const ids = (tab: GalleryTab, kind: PrototypeKind | null = null) =>
      filterAndSortPrototypes(rows, { tab, userId: "user-me", systemId: null, query: "", sort: "name", kind }).map(({ id }) => id);
    // Прототип без kind остаётся product-flow — витрина не пустеет.
    expect(ids("mine")).toEqual(["experiment", "flow", "legacy-no-kind"]);
    expect(ids("shared")).toEqual([]);
    expect(ids("service")).toEqual(["evidence", "fixture"]);
    expect(ids("mine", "experiment")).toEqual(["experiment"]);
    expect(ids("service", "evidence")).toEqual(["evidence"]);
  });

  it("filters the grid by kind and shows the kind chip on the card", async () => {
    vi.mocked(listPrototypes).mockResolvedValue([
      { ...summary, id: "flow", name: "Флоу" },
      { ...summary, id: "lab", name: "Лаборатория", kind: "experiment", tags: ["draft"], derivedFrom: "flow" },
    ]);
    renderGallery();
    const lab = (await screen.findByRole("heading", { name: "Лаборатория" })).closest("li")!;
    expect(within(lab).getByText("Эксперимент")).toBeTruthy();
    // Теги и происхождение с карточки убраны: они не помогают выбрать прототип в гриде.
    expect(within(lab).queryByText("Производный от: flow")).toBeNull();
    expect(within(lab).queryByText("draft")).toBeNull();
    // Продуктовый флоу не показывает чип вида по умолчанию.
    expect(within(screen.getByRole("heading", { name: "Флоу" }).closest("li")!).queryByText("Продуктовый флоу")).toBeNull();

    const kindFilter = screen.getByLabelText("Вид");
    fireEvent.change(kindFilter, { target: { value: "experiment" } });
    expect(screen.queryByRole("heading", { name: "Флоу" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Лаборатория" })).toBeTruthy();
    fireEvent.change(kindFilter, { target: { value: "" } });
    expect(screen.getByRole("heading", { name: "Флоу" })).toBeTruthy();
  });

  it("sets kind and tags from the card actions menu", async () => {
    vi.mocked(listPrototypes).mockResolvedValue([{ ...summary, id: "own", name: "Свой", kind: "product-flow", tags: [] }]);
    vi.mocked(setPrototypeLifecycle).mockResolvedValue({ kind: "evidence", tags: ["proof"], derivedFrom: null });
    renderGallery();
    const card = (await screen.findByRole("heading", { name: "Свой" })).closest("li")!;
    fireEvent.click(within(openCardMenu(card)).getByRole("button", { name: "Вид и теги…" }));
    const dialog = screen.getByRole("dialog", { name: "Вид и теги прототипа" });
    fireEvent.change(within(dialog).getByLabelText("Вид"), { target: { value: "evidence" } });
    fireEvent.change(within(dialog).getByLabelText("Теги (через запятую)"), { target: { value: "proof, Proof , " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(setPrototypeLifecycle).toHaveBeenCalledWith("own", { kind: "evidence", tags: ["proof"] }));
  });

  it("renders mutation controls only for the owner and changes status through the API", async () => {
    vi.mocked(listPrototypes).mockResolvedValue([
      { ...summary, id: "own", name: "Свой", status: "published" },
      { ...summary, id: "foreign", name: "Чужой", status: "published", owner: { id: "user-other", name: "Анна" } },
    ]);
    renderGallery();
    fireEvent.click(await screen.findByRole("button", { name: "Общие" }));
    const own = screen.getByRole("heading", { name: "Свой" }).closest("li")!;
    const foreign = screen.getByRole("heading", { name: "Чужой" }).closest("li")!;
    // Действия владельца доступны только после раскрытия «⋯»-меню.
    const ownMenu = within(openCardMenu(own));
    expect(ownMenu.getByRole("link", { name: "Редактор" })).toBeTruthy();
    expect(ownMenu.getByRole("button", { name: "Снять с публикации" })).toBeTruthy();
    expect(within(foreign).getByText("Владелец: Анна")).toBeTruthy();
    // У чужой карточки нет ни редактора, ни статус-действий — только открыть и экспорт.
    const foreignMenu = within(openCardMenu(foreign));
    expect(foreignMenu.queryByRole("link", { name: "Редактор" })).toBeNull();
    expect(foreignMenu.queryByRole("button", { name: "Снять с публикации" })).toBeNull();
    expect(foreignMenu.queryByRole("button", { name: "В архив" })).toBeNull();
    fireEvent.click(ownMenu.getByRole("button", { name: "Снять с публикации" }));
    await waitFor(() => expect(setPrototypeStatus).toHaveBeenCalledWith("own", "private"));
  });

  it("shows the typed 409 message when an archived head is not renderable", async () => {
    vi.mocked(listPrototypes).mockResolvedValue([{ ...summary, status: "archived" }]);
    vi.mocked(setPrototypeStatus).mockRejectedValue(new ApiError(409, { code: "prototype_not_renderable", message: "not renderable" }));
    renderGallery();
    fireEvent.click(await screen.findByRole("button", { name: "Архив" }));
    const card = screen.getByRole("heading", { name: "Hello World" }).closest("li")!;
    const menu = within(openCardMenu(card));
    fireEvent.click(menu.getByRole("button", { name: "Вернуть из архива" }));
    // role=alert рендерится сиблингом details (вне сворачиваемой области), поэтому виден и после закрытия меню.
    expect((await screen.findByRole("alert")).textContent).toContain("текущая ревизия не отображается");
  });

  it("creates a host-only template from the empty-state CTA and opens its editor", async () => {
    vi.mocked(listPrototypes).mockResolvedValue([]);
    const router = renderGallery();
    await screen.findByRole("heading", { name: "Создайте первый прототип" });
    fireEvent.click(screen.getAllByRole("button", { name: "Новый прототип" }).at(-1)!);
    const dialog = screen.getByRole("dialog", { name: "Создание прототипа" });
    fireEvent.change(within(dialog).getByLabelText("Название прототипа"), { target: { value: "Новый сценарий" } });
    fireEvent.change(within(dialog).getByLabelText("Дизайн-система"), { target: { value: "wireframe" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Создать прототип" }));

    await screen.findByText("Редактор нового прототипа");
    expect(router.state.location.pathname).toBe("/p/created-prototype/edit");
    expect(createPrototype).toHaveBeenCalledWith(expect.objectContaining({
      name: "Новый сценарий",
      designSystem: "wireframe",
      startScreen: "start",
      screens: expect.arrayContaining([expect.objectContaining({ id: "start" })]),
    }), "Стартовый шаблон v2");
  });

  it("offers design-system creation when no active components are usable", async () => {
    vi.mocked(listPrototypes).mockResolvedValue([]);
    vi.mocked(getCatalogManifest).mockResolvedValue({ components: [] });
    vi.mocked(listDesignSystems).mockResolvedValue({ designSystems: [
      { id: "shadcn", name: "Shadcn", description: "", builtinCatalogHash: "one", components: [] },
      { id: "custom-empty", name: "Custom Empty", description: "", builtinCatalogHash: "custom", components: [{ name: "NeedsProps", atomicLevel: "atom", layoutNeutral: false, description: "", events: [], slots: [] }] },
    ] });
    renderGallery();
    await screen.findByRole("heading", { name: "Создайте первый прототип" });
    expect(screen.getByRole("link", { name: "Создать дизайн-систему" }).getAttribute("href")).toBe("/library");
    expect(screen.queryByRole("button", { name: "Новый прототип" })).toBeNull();
    expect(createPrototype).not.toHaveBeenCalled();
  });
});
