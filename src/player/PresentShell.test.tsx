import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeObjects } from "../app/routes";
import type { PrototypeDraft, PrototypeVersion } from "../api/client";
import { prototypeDocSchema } from "../prototype/schema";

const mocks = vi.hoisted(() => ({ getDraft: vi.fn(), getVersion: vi.fn(), loadCustom: vi.fn() }));
vi.mock("../api/client", async (original) => ({ ...(await original()), getPrototypeDraft: mocks.getDraft, getPrototypeVersion: mocks.getVersion }));
vi.mock("../customComponents/loader", () => ({ loadCustomComponents: mocks.loadCustom }));

const hello = prototypeDocSchema.parse((await import("../../test/fixtures/hello-world.json")).default);
const draft = (): PrototypeDraft => ({ doc: hello, rev: 1, builtinCatalogHash: "builtin", componentManifestHash: "empty", components: [] });

const presentOverlayDoc = prototypeDocSchema.parse({
  version: 1, id: "present-overlay", name: "Present Overlay", device: "tablet", startScreen: "main", state: {},
  screens: [{ id: "main", name: "Main", spec: {
    root: "root", elements: {
      root: { type: "Stack", props: {}, children: ["base", "overlay"] },
      base: { type: "Text", props: { text: "Present base" } },
      overlay: { type: "Overlay", props: { placement: "top-left", inset: "sm", scrim: true }, children: ["copy"] },
      copy: { type: "Text", props: { text: "Present overlay" } },
    },
  } }],
});

const presentHostDoc = prototypeDocSchema.parse({
  version: 1, id: "present-host", name: "Present host", designSystem: "custom-only", device: "mobile", startScreen: "main", state: {},
  screens: [{ id: "main", name: "Main", canvas: { width: 390, height: 844 }, spec: { root: "image", elements: {
    image: { type: "Image", props: { src: "/images/present.png", alt: "Present host image", objectFit: "cover" } },
    hotspot: { type: "Hotspot", props: { x: 1, y: 2, width: 30, height: 40, ariaLabel: "Present host hotspot" } },
  } } }],
});

const presentRegionsDoc = prototypeDocSchema.parse({
  version: 1, id: "present-regions", name: "Present regions", designSystem: "custom-only", device: "mobile", startScreen: "main", state: {},
  screens: [{
    id: "main", name: "Main", spec: { root: "root", elements: {
      root: { type: "@eui/FlowRoot", props: {}, children: ["status", "header", "body", "footer"] },
      status: { type: "Image", props: { src: "/status.png", alt: "Authored status bar" }, region: "statusBar" },
      header: { type: "Image", props: { src: "/header.png", alt: "Authored header" }, region: "header" },
      body: { type: "Image", props: { src: "/body.png", alt: "Authored body" } },
      footer: { type: "Image", props: { src: "/footer.png", alt: "Authored footer" }, region: "footer" },
    } },
  }, {
    id: "plain", name: "Plain", spec: { root: "body", elements: {
      body: { type: "Image", props: { src: "/plain.png", alt: "Plain screen" } },
    } },
  }],
});

function renderAt(path: string) {
  const router = createMemoryRouter(routeObjects, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

function matchMedia(matches: boolean): typeof window.matchMedia {
  return vi.fn((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as typeof window.matchMedia;
}

describe("PresentShell (W2-1)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    vi.stubGlobal("matchMedia", matchMedia(false));
    mocks.getDraft.mockResolvedValue(draft());
    mocks.getVersion.mockResolvedValue({ ...draft(), version: 2, publishedAt: "2026-07-10T00:00:00Z" } satisfies PrototypeVersion);
    mocks.loadCustom.mockResolvedValue({ definitions: {}, components: {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("redirects the index route to the start screen without any app chrome", async () => {
    const router = renderAt("/p/hello-world/present");
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/present/s/welcome"));
    await screen.findByLabelText("Name");
    expect(document.title).toBe("Hello World · Презентация — easy-ui");
    // Ни глобального Layout, ни PrototypeChrome: только прототип и оснастка.
    expect(screen.queryByRole("link", { name: "Галерея" })).toBeNull();
    expect(screen.queryByTestId("chrome-actions")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Экраны" })).toBeNull();
    // Пейджер и счётчик.
    const pager = screen.getByRole("navigation", { name: "Экраны презентации" });
    expect(pager.childElementCount).toBe(2);
    expect(screen.getByText("1 / 2")).toBeTruthy();
    // Прямой вход: вместо Esc-поведения — «Открыть в easy-ui».
    expect(screen.getByRole("link", { name: "Открыть в easy-ui" }).getAttribute("href")).toBe("/p/hello-world/s/welcome");
    expect(screen.queryByText("Esc — вернуться в плеер")).toBeNull();
  });

  it("uses the footerless fluid stage for ?mobile=1", async () => {
    renderAt("/p/hello-world/present?mobile=1");
    await screen.findByLabelText("Name");
    expect(document.querySelector("main")?.classList.contains("bg-background")).toBe(true);
    expect(document.querySelector("[data-eui-stage-viewport='present-fluid']")).not.toBeNull();
    expect(document.querySelector("[data-eui-stage-viewport='player']")).toBeNull();
    expect(document.querySelector("footer")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Открыть управление презентацией" }));
    expect(screen.getByRole("link", { name: "Открыть в easy-ui" }).getAttribute("href")).toBe("/p/hello-world/s/welcome?mobile=1");
  });

  it("keeps the desktop frame and footer for ?mobile=0", async () => {
    renderAt("/p/hello-world/present?mobile=0");
    await screen.findByLabelText("Name");
    expect(document.querySelector("[data-eui-stage-viewport='player']")).not.toBeNull();
    expect(document.querySelector("[data-eui-stage-viewport='present-fluid']")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Экраны презентации" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Открыть управление презентацией" })).toBeNull();
  });

  it("shares the status-bar preference between the framed player and desktop present", async () => {
    mocks.getDraft.mockResolvedValue({ ...draft(), doc: presentRegionsDoc });
    const router = renderAt("/p/present-regions/s/main");
    expect(await screen.findByRole("img", { name: "Authored status bar" })).toBeTruthy();
    const playerToggle = screen.getByRole("button", { name: "Скрыть статус-бар" });
    expect(playerToggle.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(playerToggle);
    expect(screen.queryByRole("img", { name: "Authored status bar" })).toBeNull();
    expect(screen.getByRole("img", { name: "Authored header" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Authored footer" })).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Презентация" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/p/present-regions/present/s/main"));
    const presentToggle = await screen.findByRole("button", { name: "Скрыть статус-бар" });
    expect(presentToggle.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("img", { name: "Authored status bar" })).toBeNull();
    expect(screen.getByRole("img", { name: "Authored header" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Authored footer" })).toBeTruthy();

    fireEvent.click(presentToggle);
    expect(presentToggle.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("img", { name: "Authored status bar" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Authored header" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Authored footer" })).toBeTruthy();

    await router.navigate("/p/present-regions/present/s/plain");
    await screen.findByRole("img", { name: "Plain screen" });
    expect(screen.queryByRole("button", { name: "Скрыть статус-бар" })).toBeNull();
  });

  it("does not show the toggle in mobile fluid present and always drops the status bar", async () => {
    mocks.getDraft.mockResolvedValue({ ...draft(), doc: presentRegionsDoc });
    renderAt("/p/present-regions/present/s/main?mobile=1");

    expect(await screen.findByRole("img", { name: "Authored body" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Скрыть статус-бар" })).toBeNull();
    expect(screen.queryByRole("img", { name: "Authored status bar" })).toBeNull();
    expect(screen.getByRole("img", { name: "Authored header" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Authored footer" })).toBeTruthy();
  });

  it("runs the interactive flow and restart resets state", async () => {
    const router = renderAt("/p/hello-world/present");
    const input = await screen.findByLabelText("Name");
    fireEvent.change(input, { target: { value: "Lin" } });
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/present/s/details"));
    await screen.findByText("This is the second screen.");
    expect(screen.getByText("2 / 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Начать сначала" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/present/s/welcome"));
    expect((await screen.findByLabelText("Name") as HTMLInputElement).value).toBe("Ada");
  });

  it("opens navigate, Back, and restart destinations at the top in fluid present", async () => {
    renderAt("/p/hello-world/present?mobile=1");
    await screen.findByLabelText("Name");
    const currentScroller = () => document.querySelector<HTMLElement>("[data-eui-content-scroller='present-fluid']")!;

    currentScroller().scrollTop = 140;
    currentScroller().scrollLeft = 24;
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    await screen.findByText("This is the second screen.");
    await waitFor(() => {
      expect(currentScroller().scrollTop).toBe(0);
      expect(currentScroller().scrollLeft).toBe(0);
    });

    currentScroller().scrollTop = 110;
    currentScroller().scrollLeft = 16;
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByLabelText("Name");
    await waitFor(() => {
      expect(currentScroller().scrollTop).toBe(0);
      expect(currentScroller().scrollLeft).toBe(0);
    });

    currentScroller().scrollTop = 90;
    currentScroller().scrollLeft = 12;
    fireEvent.click(screen.getByRole("button", { name: "Открыть управление презентацией" }));
    fireEvent.click(screen.getByRole("button", { name: "Начать сначала" }));
    await screen.findByLabelText("Name");
    await waitFor(() => {
      expect(currentScroller().scrollTop).toBe(0);
      expect(currentScroller().scrollLeft).toBe(0);
    });
  });

  it("keeps a deep-linked screen (no forced redirect to start)", async () => {
    const router = renderAt("/p/hello-world/present/s/details");
    await screen.findByText("This is the second screen.");
    expect(router.state.location.pathname).toBe("/p/hello-world/present/s/details");
    expect(screen.getByRole("link", { name: "Открыть в easy-ui" }).getAttribute("href")).toBe("/p/hello-world/s/details");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/s/details"));
  });

  it("supports browse, restart and help hotkeys but ignores a focused prototype input", async () => {
    const router = renderAt("/p/hello-world/present");
    const input = await screen.findByLabelText("Name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Lin" } });
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowRight" });
    fireEvent.keyDown(input, { key: "r" });
    expect(router.state.location.pathname).toBe("/p/hello-world/present/s/welcome");
    expect(input.value).toBe("Lin");

    input.blur();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/present/s/details"));
    fireEvent.keyDown(window, { key: "R" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/present/s/welcome"));
    expect((await screen.findByLabelText("Name") as HTMLInputElement).value).toBe("Ada");

    fireEvent.keyDown(window, { key: "?", shiftKey: true });
    expect(screen.getByRole("dialog", { name: "Горячие клавиши" })).toBeTruthy();
    expect(screen.getByText("Вернуться в плеер")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Горячие клавиши" })).toBeNull();
    expect(router.state.location.pathname).toBe("/p/hello-world/present/s/welcome");
  });

  it("closes the mobile HUD on the first Escape and exits on the second", async () => {
    const router = renderAt("/p/hello-world/s/welcome?mobile=1");
    await screen.findByLabelText("Name");
    fireEvent.click(within(screen.getByTestId("chrome-actions")).getByRole("link", { name: "Презентация" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/present/s/welcome"));

    fireEvent.click(await screen.findByRole("button", { name: "Открыть управление презентацией" }));
    expect(screen.getByRole("link", { name: "Вернуться в плеер" }).getAttribute("href")).toBe("/p/hello-world/s/welcome?mobile=1");
    const locationBeforeEscape = `${router.state.location.pathname}${router.state.location.search}`;
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Управление презентацией" })).toBeNull();
    expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(locationBeforeEscape);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/s/welcome"));
    expect(router.state.location.search).toBe("?mobile=1");
  });

  it("enters from the player chrome action and Esc returns to the player at the same screen", async () => {
    const router = renderAt("/p/hello-world/s/welcome");
    await screen.findByLabelText("Name");
    const presentLink = within(screen.getByTestId("chrome-actions")).getByRole("link", { name: "Презентация" });
    expect(presentLink.getAttribute("href")).toBe("/p/hello-world/present/s/welcome");
    fireEvent.click(presentLink);
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/present/s/welcome"));
    await screen.findByLabelText("Name");
    // Внутренний вход: Esc-подсказка вместо кнопки «Открыть в easy-ui».
    expect(screen.getByText("Esc — вернуться в плеер")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Открыть в easy-ui" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/present/s/details"));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/s/details"));
    // Снова плеер: единый хром /p/* на месте.
    expect(await screen.findByRole("link", { name: "Галерея" })).toBeTruthy();
  });

  it("serves the versioned present route under its version-aware base", async () => {
    const router = renderAt("/p/hello-world/v/2/present");
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/v/2/present/s/welcome"));
    expect(mocks.getVersion).toHaveBeenCalledWith("hello-world", 2, expect.any(AbortSignal));
    await screen.findByLabelText("Name");
    expect(document.title).toBe("Hello World v2 · Презентация — easy-ui");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/hello-world/v/2/present/s/details"));
  });

  it("renders Overlay in the present StageViewport with surface spacing", async () => {
    mocks.getDraft.mockResolvedValue({ ...draft(), doc: presentOverlayDoc });
    renderAt("/p/present-overlay/present/s/main");
    expect(await screen.findByText("Present overlay")).toBeTruthy();
    const stage = document.querySelector<HTMLElement>("[data-eui-stage-viewport='player']")!;
    expect(stage.querySelector("[data-eui-host-primitive='Overlay']")).not.toBeNull();
    expect(stage.querySelector("[data-eui-overlay-scrim]")).not.toBeNull();
    expect(stage.style.getPropertyValue("--eui-space-md")).toBe("12px");
  });

  it("renders host Image and canvas-split Hotspot in present", async () => {
    mocks.getDraft.mockResolvedValue({ ...draft(), doc: presentHostDoc });
    renderAt("/p/present-host/present/s/main");
    expect(await screen.findByRole("img", { name: "Present host image" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Present host hotspot" })).toBeTruthy();
  });

  it("keeps scoped-share navigation tokenless and exposes no workspace exit", async () => {
    const router = renderAt("/share/p/hello-world/v/2/present/s/welcome?mobile=1");
    await screen.findByLabelText("Name");
    expect(document.title).toBe("Hello World v2 · Просмотр — easy-ui");
    expect(screen.queryByRole("link", { name: "Открыть в easy-ui" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Галерея" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Открыть управление презентацией" }));
    expect(screen.queryByRole("link")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/share/p/hello-world/v/2/present/s/details"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(router.state.location.pathname).toBe("/share/p/hello-world/v/2/present/s/details");
    expect(screen.queryByRole("dialog", { name: "Управление презентацией" })).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(router.state.location.pathname).toBe("/share/p/hello-world/v/2/present/s/details");
    fireEvent.keyDown(window, { key: "?", shiftKey: true });
    expect(screen.queryByText("Вернуться в плеер")).toBeNull();
  });
});
