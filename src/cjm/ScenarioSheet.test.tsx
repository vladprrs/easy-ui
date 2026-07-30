import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrototypeDraft } from "../api/client";
import { routeObjects } from "../app/routes";
import { prototypeDocSchema } from "../prototype/schema";
import { resetPrintMountForce } from "./LazyMount";

// Режим «Сценарии» (план 2026-07-29 §7 T2b): простыня секций в DFS-порядке дерева
// `flow.parentId`, дерево слева и per-step метка проходимости.

const mocks = vi.hoisted(() => ({ getDraft: vi.fn(), getVersion: vi.fn(), getThemeVersion: vi.fn(), getLatestTheme: vi.fn(), loadCustom: vi.fn() }));
vi.mock("../api/client", async (original) => ({ ...(await original()), getPrototypeDraft: mocks.getDraft, getPrototypeVersion: mocks.getVersion, getDesignSystemVersion: mocks.getThemeVersion, getDesignSystemById: mocks.getLatestTheme }));
vi.mock("../customComponents/loader", () => ({ loadCustomComponents: mocks.loadCustom }));

const navigateTo = (target: string) => ({ action: "navigate", params: { screenId: target } });
const screenSpec = (key: string, label: string, target?: string) => ({
  root: key,
  elements: { [key]: { type: "Button", props: { label }, ...(target === undefined ? {} : { on: { press: navigateTo(target) } }) } },
});

/** Три уровня иерархии + второй корень; ребро `hub → amount` отсутствует намеренно. */
const treeDoc = prototypeDocSchema.parse({
  version: 1, id: "tree", name: "Дерево", designSystem: "shadcn", device: "mobile", startScreen: "home", state: {},
  screens: [
    { id: "home", name: "Главный", spec: screenSpec("home", "Переводы", "hub") },
    { id: "hub", name: "Переводы", spec: screenSpec("hub", "Телефон", "phone") },
    { id: "phone", name: "Телефон", spec: screenSpec("phone", "Сумма", "amount") },
    { id: "amount", name: "Сумма", spec: screenSpec("amount", "Готово") },
    { id: "history", name: "История", spec: screenSpec("history", "Назад") },
  ],
  flows: [
    { id: "main", name: "Главная линия", description: "Корневой сценарий", steps: [{ screenId: "home" }, { screenId: "hub" }, { screenId: "phone" }, { screenId: "amount" }] },
    { id: "section", name: "Раздел переводов", parentId: "main", steps: [{ screenId: "hub" }, { screenId: "phone" }] },
    { id: "shortcut", name: "Быстрый перевод", parentId: "section", steps: [{ screenId: "hub" }, { screenId: "amount", note: "Разрыв связности" }] },
    { id: "history-line", name: "История операций", steps: [{ screenId: "home" }, { screenId: "history" }] },
  ],
});
const draft: PrototypeDraft = { doc: treeDoc, rev: 1, builtinCatalogHash: "builtin", componentManifestHash: "empty", components: [], designSystemMetaVersion: 1 };

function renderAt(path: string) {
  const router = createMemoryRouter(routeObjects, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

const sections = () => [...document.querySelectorAll<HTMLElement>(".cjm-sheet-section")];
const treeItems = () => [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')];

afterEach(() => { cleanup(); vi.unstubAllGlobals(); resetPrintMountForce(); });

describe("CJM scenarios sheet", () => {
  beforeEach(() => {
    mocks.getDraft.mockReset().mockResolvedValue(draft);
    mocks.getVersion.mockReset();
    mocks.getThemeVersion.mockReset().mockResolvedValue({ systemId: "shadcn", version: 1, createdAt: "2026-07-01T00:00:00Z", tokens: {}, fonts: [], icons: [] });
    mocks.getLatestTheme.mockReset().mockResolvedValue({ id: "shadcn", latestMetaVersion: 1, tokens: {}, fonts: [], icons: [] });
    mocks.loadCustom.mockReset().mockResolvedValue(undefined);
  });

  it("is the default mode and lays sections out in DFS order with a per-depth indent", async () => {
    renderAt("/p/tree/cjm");
    await waitFor(() => expect(sections()).toHaveLength(4));
    expect(sections().map((node) => node.dataset.flowId)).toEqual(["main", "section", "shortcut", "history-line"]);
    // Ступень отступа — 28px на уровень (редизайн 2026-07-30, макет 02).
    expect(sections().map((node) => node.style.marginInlineStart)).toEqual(["0px", "28px", "56px", "0px"]);
    // Дорожек в дефолтном режиме нет — рёбра простыня не рисует.
    expect(screen.queryByLabelText("Легенда рёбер сценариев")).toBeNull();
    expect(document.querySelector(".cjm-grid")).toBeNull();
    // Зато легенда связности общая для обоих режимов (план 2026-07-31, S3):
    // метка шага перестала объясняться одним лишь `title`.
    const legend = screen.getByLabelText("Легенда связности шагов");
    expect(within(legend).getByText("Подтверждённый переход")).toBeTruthy();
    expect(within(legend).getByText("Динамический переход")).toBeTruthy();
    expect(within(legend).getByText("Переход не найден")).toBeTruthy();
  });

  // Третий счётчик трёхчастный (W2-1): `dynamic` больше не считается дефектом, а
  // готовность ключуется только на «не найдено». Единица счёта — смежная пара шагов.
  it("counts step connectivity in three honest buckets", async () => {
    renderAt("/p/tree/cjm");
    const counters = await screen.findByLabelText("Сводка прототипа");
    // main: home→hub, hub→phone, phone→amount + section: hub→phone = 4 подтверждённых;
    // shortcut: hub→amount и history-line: home→history переходов не имеют.
    expect(within(counters).getByText("4 подтверждено")).toBeTruthy();
    expect(within(counters).getByText("0 динамических")).toBeTruthy();
    expect(within(counters).getByText("2 не найдено")).toBeTruthy();
    expect(within(counters).getByText("2 перехода не найдено")).toBeTruthy();
    expect(within(counters).queryByText("Готов к публикации")).toBeNull();
    expect(counters.textContent).not.toContain("проверок");
  });

  // Линейный документ: ячейка готовности хвалила пустоту («Готов к публикации»,
  // 0 непроверенных) — вместо неё подпись о том, что считать не по чему.
  it("replaces the readiness cell with an explanation on a document without flows", async () => {
    const linearDoc = prototypeDocSchema.parse({
      version: 1, id: "flat", name: "Плоский", designSystem: "shadcn", device: "mobile", startScreen: "home", state: {},
      screens: [
        { id: "home", name: "Главный", spec: screenSpec("home", "Дальше", "next") },
        { id: "next", name: "Дальше", spec: screenSpec("next", "Готово") },
      ],
    });
    mocks.getDraft.mockResolvedValue({ ...draft, doc: linearDoc });
    renderAt("/p/flat/cjm");
    const counters = await screen.findByLabelText("Сводка прототипа");
    expect(within(counters).getByText("Сценарии не размечены")).toBeTruthy();
    expect(within(counters).queryByText("Готов к публикации")).toBeNull();
    expect(within(counters).queryByText("связность шагов")).toBeNull();
  });

  it("counts steps and cross-scenario reuse in the section heading", async () => {
    renderAt("/p/tree/cjm");
    await waitFor(() => expect(sections()).toHaveLength(4));
    const shortcut = within(sections()[2]!);
    expect(shortcut.getByRole("heading", { name: "Быстрый перевод" })).toBeTruthy();
    // hub участвует в main/section/shortcut, amount — в main/shortcut ⇒ 3 сценария.
    expect(shortcut.getByText("2 экрана · в 3 сценариях")).toBeTruthy();
    expect(within(sections()[3]!).getByText("2 экрана · в 2 сценариях")).toBeTruthy();
  });

  it("renders every step including main-line anchors and marks each transition", async () => {
    renderAt("/p/tree/cjm");
    await waitFor(() => expect(sections()).toHaveLength(4));

    // Оба шага «Быстрого перевода» — якоря главной линии: в дорожках у них тайлов нет.
    const steps = [...sections()[2]!.querySelectorAll<HTMLElement>("li[data-flow-step]")];
    expect(steps.map((node) => node.dataset.screenId)).toEqual(["hub", "amount"]);
    expect(steps[0]!.querySelector(".cjm-tile")).not.toBeNull();
    expect(within(steps[1]!).getByText("Разрыв связности")).toBeTruthy();

    // Метка проходимости: у первого шага её нет, у второго переход не найден.
    expect(steps[0]!.querySelector("[data-verified]")).toBeNull();
    expect(steps[1]!.querySelector("[data-verified]")?.getAttribute("data-verified")).toBe("missing");
    expect(within(steps[1]!).getByText("Переход не найден")).toBeTruthy();
    const mainSteps = [...sections()[0]!.querySelectorAll<HTMLElement>("li[data-flow-step]")];
    expect(mainSteps[1]!.querySelector("[data-verified]")?.getAttribute("data-verified")).toBe("static");
  });

  it("offers a player link and copies the scenario link", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderAt("/p/tree/cjm");
    await waitFor(() => expect(sections()).toHaveLength(4));

    const section = within(sections()[1]!);
    expect(section.getByRole("link", { name: "В плеер →" }).getAttribute("href")).toBe("/p/tree/s/hub?flow=section&step=0");
    fireEvent.click(section.getByRole("button", { name: "Ссылка" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/p/tree/cjm?flow=section`));
    expect(await section.findByRole("button", { name: "Ссылка скопирована" })).toBeTruthy();
    // Отчёт о клике живёт 2 с и уступает место обычной подписи: залипшая надпись
    // через минуту читается как свойство сценария, а не как результат действия.
    await waitFor(() => expect(section.getByRole("button", { name: "Ссылка" })).toBeTruthy(), { timeout: 4000 });
  });

  it("exposes the flow tree with ARIA levels, expansion, current item and arrow navigation", async () => {
    renderAt("/p/tree/cjm");
    const tree = await screen.findByRole("tree", { name: "Дерево сценариев" });
    expect(treeItems().map((node) => node.dataset.flowId)).toEqual(["main", "section", "shortcut", "history-line"]);
    expect(treeItems().map((node) => node.getAttribute("aria-level"))).toEqual(["1", "2", "3", "1"]);
    expect(treeItems().map((node) => node.getAttribute("aria-expanded"))).toEqual(["true", "true", null, null]);
    expect(treeItems()[0]!.getAttribute("aria-current")).toBe("true");
    expect(treeItems().map((node) => node.tabIndex)).toEqual([0, -1, -1, -1]);

    const first = treeItems()[0]!;
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(treeItems()[1]!);
    // ← сворачивает узел с детьми: внук уходит из дерева.
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(treeItems().map((node) => node.dataset.flowId)).toEqual(["main", "section", "history-line"]);
    expect(treeItems()[1]!.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(treeItems()[0]!);
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect((document.activeElement as HTMLElement).dataset.flowId).toBe("history-line");

    // Активация переносит `aria-current` на выбранный сценарий.
    fireEvent.click(within(tree).getByText("История операций"));
    await waitFor(() => expect(treeItems().find((node) => node.getAttribute("aria-current") === "true")?.dataset.flowId).toBe("history-line"));
  });

  // Каретка (W2-9): 24×24 hit-area вместо голого глифа и смена `▸`/`▾` вместо вращения.
  it("collapses a branch by clicking the caret and swaps the glyph", async () => {
    renderAt("/p/tree/cjm");
    await screen.findByRole("tree", { name: "Дерево сценариев" });
    const caret = treeItems()[0]!.querySelector<HTMLElement>("span[aria-hidden='true']")!;
    expect(caret.textContent).toBe("▾");
    expect(caret.className).toContain("h-6 w-6");
    fireEvent.click(caret);
    expect(treeItems()[0]!.getAttribute("aria-expanded")).toBe("false");
    expect(treeItems().map((node) => node.dataset.flowId)).toEqual(["main", "history-line"]);
    expect(treeItems()[0]!.querySelector("span[aria-hidden='true']")!.textContent).toBe("▸");
  });

  // Ниже 1024px левая колонка уезжает в поповер (W2-4), а не исчезает вместе с
  // ориентацией «где я»: в jsdom медиазапросов нет, поэтому проверяем сам поповер.
  it("keeps the flow tree reachable through the narrow-screen popover", async () => {
    renderAt("/p/tree/cjm");
    await waitFor(() => expect(sections()).toHaveLength(4));
    const trigger = screen.getByRole("button", { name: "Сценарии" });
    fireEvent.click(trigger);
    const trees = screen.getAllByRole("tree", { name: "Дерево сценариев" });
    expect(trees).toHaveLength(2);

    // Поповер стоит перед сеткой, поэтому в DOM он первый; кликаем именно в нём.
    fireEvent.click(within(screen.getByRole("menu")).getByText("История операций"));
    // Выбор уводит скролл к секции — поповер поверх неё закрывается.
    await waitFor(() => expect(screen.getAllByRole("tree", { name: "Дерево сценариев" })).toHaveLength(1));
    expect(treeItems().find((node) => node.getAttribute("aria-current") === "true")?.dataset.flowId).toBe("history-line");
  });

  // Лайтбокс экрана (редизайн 2026-07-30, макет 03): открывается кликом по тайлу
  // ленты, листает шаги ←/→ и закрывается Esc, оставаясь внутри одного сценария.
  it("opens the screen lightbox from a strip tile and walks the scenario steps", async () => {
    renderAt("/p/tree/cjm");
    await waitFor(() => expect(sections()).toHaveLength(4));

    const steps = [...sections()[0]!.querySelectorAll<HTMLElement>("li[data-flow-step]")];
    fireEvent.click(within(steps[1]!).getByRole("button", { name: /Переводы/ }));

    const dialog = await screen.findByTestId("screen-lightbox");
    expect(within(dialog).getByText("шаг 2 / 4")).toBeTruthy();

    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(within(dialog).getByText("шаг 3 / 4")).toBeTruthy());
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    await waitFor(() => expect(within(dialog).getByText("шаг 2 / 4")).toBeTruthy());

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("screen-lightbox")).toBeNull());
  });

  it("switches to lanes only through ?view=lanes and keeps the scenario query", async () => {
    const router = renderAt("/p/tree/cjm?flow=section");
    const lanes = await screen.findByRole("link", { name: "Дорожки" });
    // «Сценарии» теперь есть и в сегменте хрома (место), и в переключателе режима — скоупим по режиму.
    const modeSwitch = screen.getByRole("navigation", { name: "Режим просмотра" });
    expect(within(modeSwitch).getByRole("link", { name: "Сценарии" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(lanes);

    await waitFor(() => expect(router.state.location.search).toBe("?flow=section&view=lanes"));
    expect(await screen.findAllByTestId("cjm-lane-label")).toHaveLength(2);
    expect(document.querySelector(".cjm-sheet")).toBeNull();
    // Липкость режима: сегмент «Плеер» уносит `view` вместе со сценарным контекстом.
    expect(screen.getByRole("link", { name: "Плеер" }).getAttribute("href")).toBe("/p/tree?flow=section&view=lanes");
  });
});
