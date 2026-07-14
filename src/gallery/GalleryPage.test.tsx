import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPrototype, getCatalogManifest, listDesignSystems, listPrototypes, listPrototypeVersions } from "../api/client";
import { GalleryPage } from "./GalleryPage";

vi.mock("../api/client", () => ({ createPrototype: vi.fn(), getCatalogManifest: vi.fn(), listDesignSystems: vi.fn(), listPrototypes: vi.fn(), listPrototypeVersions: vi.fn() }));

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
  const router = createMemoryRouter([{ path: "/", element: <GalleryPage /> }, { path: "/p/:id/v/:version", element: <p>Плеер версии</p> }, { path: "/p/:id/edit", element: <p>Редактор нового прототипа</p> }], { initialEntries: ["/"] });
  render(<RouterProvider router={router} />);
  return router;
}

describe("GalleryPage", () => {
  beforeEach(() => {
    vi.mocked(listPrototypes).mockReset();
    vi.mocked(listDesignSystems).mockReset();
    vi.mocked(listPrototypeVersions).mockReset();
    vi.mocked(createPrototype).mockReset();
    vi.mocked(getCatalogManifest).mockReset();
    vi.mocked(getCatalogManifest).mockResolvedValue({ components: [] });
    vi.mocked(createPrototype).mockResolvedValue({ id: "created-prototype", rev: 1, warnings: [] });
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
    expect(screen.getByText("Телефон")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    const draftLink = screen.getByRole("link", { name: "Hello World" });
    expect(within(screen.getByRole("heading", { name: "Hello World" }).closest("li")!).getByText("Shadcn")).toBeTruthy();
    expect(draftLink.getAttribute("href")).toBe("/p/hello-world");
    expect(screen.getByRole("link", { name: "CJM" }).getAttribute("href")).toBe("/p/hello-world/cjm");
    fireEvent.click(screen.getByText("Версии…"));
    expect((await screen.findByRole("link", { name: "Версия v2" })).getAttribute("href")).toBe("/p/hello-world/v/2");
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
    // Actions sit above the stretched link with their own tab stops.
    const actions = within(card).getAllByRole("link").filter((link) => link !== cardLink);
    expect(actions.map((link) => link.textContent)).toEqual(["Презентация", "CJM", "Редактор"]);
    // Кнопка «Презентация» (W1-2) ведёт на present-маршрут вне Layout/PrototypeChrome.
    expect(within(card).getByRole("link", { name: "Презентация" }).getAttribute("href")).toBe("/p/hello-world/present");
    const actionsRow = actions[0]!.parentElement!;
    expect(actionsRow.className).toContain("relative");
    expect(actionsRow.className).toContain("z-10");
    expect(within(card).getByText("Версии…").closest("details")?.className).toContain("relative");
  });

  it("opens any published version from the card versions menu", async () => {
    vi.mocked(listPrototypes).mockResolvedValue([summary]);
    vi.mocked(listPrototypeVersions).mockResolvedValue([
      { version: 3, rev: 5, publishedAt: "2026-07-12T00:00:00.000Z" },
      { version: 2, rev: 3, publishedAt: "2026-07-10T00:00:00.000Z" },
    ]);
    const router = renderGallery();
    await screen.findByRole("heading", { name: "Hello World" });
    fireEvent.click(screen.getByText("Версии…"));
    fireEvent.click(await screen.findByRole("link", { name: "Версия v3" }));
    expect(router.state.location.pathname).toBe("/p/hello-world/v/3");
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

    expect(await screen.findByRole("button", { name: "Wireframe" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Shadcn" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Yandex Pay Design System" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "classic" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Hello World" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Wireframe" }));
    expect(screen.getByRole("heading", { name: "Wire flow" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Hello World" })).toBeNull();
    expect(within(screen.getByRole("heading", { name: "Wire flow" }).closest("li")!).getByText("Wireframe")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "classic" }));
    expect(screen.getByRole("heading", { name: "Legacy flow" })).toBeTruthy();
    expect(within(screen.getByRole("heading", { name: "Legacy flow" }).closest("li")!).getByText("classic")).toBeTruthy();
  });

  it("creates a builtin template from the empty-state CTA and opens its editor", async () => {
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
      startScreen: "outline",
      screens: expect.arrayContaining([expect.objectContaining({ id: "outline" })]),
    }), "Стартовый шаблон v1");
  });

  it("explains why a custom design system without a valid starter cannot be created", async () => {
    vi.mocked(listPrototypes).mockResolvedValue([]);
    vi.mocked(listDesignSystems).mockResolvedValue({ designSystems: [
      { id: "shadcn", name: "Shadcn", description: "", builtinCatalogHash: "one", components: [] },
      { id: "custom-empty", name: "Custom Empty", description: "", builtinCatalogHash: "custom", components: [{ name: "NeedsProps", atomicLevel: "atom", layoutNeutral: false, description: "", events: [], slots: [] }] },
    ] });
    renderGallery();
    await screen.findByRole("heading", { name: "Создайте первый прототип" });
    fireEvent.click(screen.getAllByRole("button", { name: "Новый прототип" }).at(-1)!);
    const dialog = screen.getByRole("dialog", { name: "Создание прототипа" });
    fireEvent.change(within(dialog).getByLabelText("Название прототипа"), { target: { value: "Нельзя создать" } });
    fireEvent.change(within(dialog).getByLabelText("Дизайн-система"), { target: { value: "custom-empty" } });
    expect(within(dialog).getByText(/нет опубликованного компонента с валидным example/)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Создать прототип" }).hasAttribute("disabled")).toBe(true);
    expect(createPrototype).not.toHaveBeenCalled();
  });
});
