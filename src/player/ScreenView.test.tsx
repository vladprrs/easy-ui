import { JSONUIProvider } from "@json-render/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPlayerRuntime } from "../catalog/runtime";
import { prototypeDocSchema } from "../prototype/schema";
import { EasyUiActionRuntime } from "./actionRuntime";
import { InspectorLog } from "./inspector/log";
import { ScreenErrorBoundary } from "./ScreenView";
import { ScreenView } from "./ScreenView";

const navigation = vi.hoisted(() => ({ navigate: vi.fn(), browse: vi.fn(), restart: vi.fn(), back: vi.fn() }));
vi.mock("./navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./navigation")>()),
  usePlayerNavigation: () => ({ ...navigation, sessionNonce: "test", flowDepth: 0, entryReason: "flow" as const, goToScreen: navigation.browse, browseToScreen: navigation.browse, flowResetVisible: false, dismissFlowReset: () => {} }),
  // Баннер читает контекст через оригинальный usePlayerNavigation — вне провайдера стаб.
  FlowResetBanner: () => null,
}));

beforeEach(() => window.localStorage.clear());

function BrokenRuntimeProp(): never {
  throw new Error("invalid runtime prop");
}

describe("ScreenView error boundary", () => {
  it("shows diagnostics and Restart when runtime rendering fails", () => {
    const restart = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<ScreenErrorBoundary prototypeId="broken-prototype" screenId="bad-screen" restart={restart}><BrokenRuntimeProp /></ScreenErrorBoundary>);
    expect(screen.getByRole("alert").textContent).toContain("broken-prototype");
    expect(screen.getByRole("alert").textContent).toContain("bad-screen");
    screen.getByRole("button", { name: "Начать сначала" }).click();
    expect(restart).toHaveBeenCalledOnce();
  });
});

function renderPlayer(doc: ReturnType<typeof prototypeDocSchema.parse>, initialPath: string) {
  const deps = { navigate: navigation.navigate, back: navigation.back, openUrl() {}, restart: navigation.restart };
  const runtime = createPlayerRuntime(deps);
  const actionRuntime = new EasyUiActionRuntime({ initialState: doc.state, screenIds: new Set(doc.screens.map((s) => s.id)), deps });
  const context = { doc, registry: runtime.registry, runtime: actionRuntime, customTypes: new Set<string>(), customDefinitions: {}, onError: () => {}, inspector: { enabled: false, visible: false, log: new InspectorLog(), toggle: () => {} } };
  const router = createMemoryRouter([{
    path: "/p/:protoId",
    element: <JSONUIProvider registry={runtime.registry} handlers={runtime.handlers} store={actionRuntime.store}><Outlet context={context} /></JSONUIProvider>,
    children: [{ path: "s/:screenId", element: <ScreenView /> }],
  }], { initialEntries: [initialPath] });
  return { ...render(<RouterProvider router={router} />), router };
}

const mobileDoc = () => prototypeDocSchema.parse({
  version: 1,
  id: "stage-prototype",
  name: "Stage prototype",
  device: "mobile",
  startScreen: "home",
  state: {},
  screens: [{
    id: "home",
    name: "Home",
    spec: { root: "copy", elements: { copy: { type: "Text", props: { text: "Home screen" } } } },
  }],
});

const regionsDoc = () => prototypeDocSchema.parse({
  version: 1,
  id: "regions-prototype",
  name: "Regions prototype",
  designSystem: "custom-only",
  device: "mobile",
  startScreen: "home",
  state: {},
  screens: [{
    id: "home",
    name: "Home",
    spec: {
      root: "root",
      elements: {
        root: { type: "@eui/FlowRoot", props: {}, children: ["status", "header", "body", "footer"] },
        status: { type: "Image", props: { src: "/status.png", alt: "Player status bar" }, region: "statusBar" },
        header: { type: "Image", props: { src: "/header.png", alt: "Player header" }, region: "header" },
        body: { type: "Image", props: { src: "/body.png", alt: "Player body" } },
        footer: { type: "Image", props: { src: "/footer.png", alt: "Player footer" }, region: "footer" },
      },
    },
  }, {
    id: "plain",
    name: "Plain",
    spec: { root: "body", elements: { body: { type: "Image", props: { src: "/plain.png", alt: "Plain player screen" } } } },
  }],
});

const overlayElementSet = (label: string) => ({
  root: "root",
  elements: {
    root: { type: "Stack", props: {}, children: ["base", "overlay"] },
    base: { type: "Text", props: { text: `${label} base` } },
    overlay: { type: "Overlay", props: { placement: "bottom", inset: "md", scrim: true }, children: ["overlay-copy"] },
    "overlay-copy": { type: "Text", props: { text: `${label} overlay` } },
  },
});

function overlayDoc(device: "mobile" | "tablet", withCanvasScreen = false) {
  return prototypeDocSchema.parse({
    version: 1, id: "overlay-prototype", name: "Overlay prototype", device, startScreen: withCanvasScreen ? "canvas" : "flow", state: {},
    screens: [
      ...(withCanvasScreen ? [{ id: "canvas", name: "Canvas", canvas: { width: 640, height: 480 }, spec: overlayElementSet("Canvas") }] : []),
      { id: "flow", name: "Flow", spec: overlayElementSet("Flow") },
    ],
  });
}

describe("ScreenView stage controls (W1-1)", () => {
  it("toggles only statusBar and hides the control on a screen without that region", async () => {
    const { router } = renderPlayer(regionsDoc(), "/p/regions-prototype/s/home");
    const toggle = screen.getByRole("button", { name: "Скрыть статус-бар" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("img", { name: "Player status bar" })).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("img", { name: "Player status bar" })).toBeNull();
    expect(screen.getByRole("img", { name: "Player header" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Player footer" })).toBeTruthy();

    await router.navigate("/p/regions-prototype/s/plain");
    await screen.findByRole("img", { name: "Plain player screen" });
    expect(screen.queryByRole("button", { name: "Скрыть статус-бар" })).toBeNull();
  });

  it("renders zoom controls in the chrome actions slot and switches fit/actual/manual", () => {
    renderPlayer(mobileDoc(), "/p/stage-prototype/s/home");
    const zoomGroup = screen.getByRole("group", { name: "Масштаб" });
    const fit = screen.getByRole("button", { name: "Вписать" });
    const actual = screen.getByRole("button", { name: "100%" });
    expect(zoomGroup).toBeTruthy();
    expect(fit.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(actual);
    expect(actual.getAttribute("aria-pressed")).toBe("true");
    expect(fit.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Увеличить масштаб" }));
    expect(actual.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(fit);
    expect(fit.getAttribute("aria-pressed")).toBe("true");
  });

  it("switches device via chrome controls and keeps zoom controls hidden for desktop auto-height", () => {
    renderPlayer(mobileDoc(), "/p/stage-prototype/s/home");
    const desktop = screen.getByRole("button", { name: "Компьютер" });
    fireEvent.click(desktop);
    expect(desktop.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("group", { name: "Масштаб" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Телефон" }));
    expect(screen.getByRole("group", { name: "Масштаб" })).toBeTruthy();
  });

  it("collapses and expands the screens sidebar", () => {
    renderPlayer(mobileDoc(), "/p/stage-prototype/s/home");
    expect(screen.getByRole("button", { name: "Home" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Свернуть список экранов" }));
    expect(screen.queryByRole("button", { name: "Home" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Развернуть список экранов" }));
    expect(screen.getByRole("button", { name: "Home" })).toBeTruthy();
  });

  it("handles browse, restart, zoom and help hotkeys", () => {
    navigation.browse.mockReset();
    navigation.restart.mockReset();
    const doc = prototypeDocSchema.parse({
      ...mobileDoc(),
      screens: [
        ...mobileDoc().screens,
        { id: "details", name: "Details", spec: { root: "copy", elements: { copy: { type: "Text", props: { text: "Details" } } } } },
      ],
    });
    renderPlayer(doc, "/p/stage-prototype/s/home");

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(navigation.browse).toHaveBeenCalledWith("details");
    fireEvent.keyDown(window, { key: "r" });
    expect(navigation.restart).toHaveBeenCalledOnce();

    const fit = screen.getByRole("button", { name: "Вписать" });
    const actual = screen.getByRole("button", { name: "100%" });
    fireEvent.keyDown(window, { key: "f" });
    expect(actual.getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(window, { key: "F" });
    expect(fit.getAttribute("aria-pressed")).toBe("true");

    fireEvent.keyDown(window, { key: "?", shiftKey: true });
    expect(screen.getByRole("dialog", { name: "Горячие клавиши" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "?", shiftKey: true });
    expect(screen.queryByRole("dialog", { name: "Горячие клавиши" })).toBeNull();
  });

  it("ignores hotkeys from a real prototype input and filtered events", async () => {
    navigation.browse.mockReset();
    navigation.restart.mockReset();
    const doc = prototypeDocSchema.parse((await import("../../test/fixtures/hello-world.json")).default);
    renderPlayer(doc, "/p/hello-world/s/welcome");
    const input = screen.getByLabelText("Name");
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowRight" });
    fireEvent.keyDown(input, { key: "r" });
    expect(navigation.browse).not.toHaveBeenCalled();
    expect(navigation.restart).not.toHaveBeenCalled();

    input.blur();
    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    fireEvent.keyDown(window, { key: "r", repeat: true });
    const prevented = new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true });
    prevented.preventDefault();
    window.dispatchEvent(prevented);
    expect(navigation.restart).not.toHaveBeenCalled();
  });
});

describe("ScreenView screen note (W1-8)", () => {
  it("shows the note toggle only for a screen with a note and reveals its plain text", () => {
    const doc = prototypeDocSchema.parse({
      ...mobileDoc(),
      screens: [{
        ...mobileDoc().screens[0],
        note: "Первая строка\nВторая строка",
      }],
    });
    renderPlayer(doc, "/p/stage-prototype/s/home");

    const toggle = screen.getByRole("button", { name: "Заметка" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByLabelText("Заметка к экрану")).toBeNull();

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("Заметка к экрану").textContent).toBe("Первая строка\nВторая строка");
  });

  it("does not show the note toggle for a screen without a note", () => {
    renderPlayer(mobileDoc(), "/p/stage-prototype/s/home");

    expect(screen.queryByRole("button", { name: "Заметка" })).toBeNull();
  });
});

describe("ScreenView canvas", () => {
  it("keeps hotspot navigation wired through the player runtime", async () => {
    navigation.navigate.mockReset();
    const doc = prototypeDocSchema.parse({
      version: 1,
      id: "canvas-prototype",
      name: "Canvas prototype",
      device: "desktop",
      startScreen: "canvas",
      state: {},
      screens: [{
        id: "canvas",
        name: "Canvas",
        canvas: { width: 640, height: 480 },
        spec: {
          root: "content",
          elements: {
            content: { type: "Text", props: { text: "Canvas screen" }, children: ["next"] },
            next: {
              type: "Hotspot",
              props: { x: 20, y: 30, width: 100, height: 50, ariaLabel: "Next screen" },
              on: { press: { action: "navigate", params: { screenId: "details" } } },
            },
          },
        },
      }, {
        id: "details",
        name: "Details",
        spec: { root: "details-copy", elements: { "details-copy": { type: "Text", props: { text: "Details" } } } },
      }],
    });
    const deps = { navigate: navigation.navigate, back: navigation.back, openUrl() {}, restart: navigation.restart };
    const runtime = createPlayerRuntime(deps);
    const actionRuntime = new EasyUiActionRuntime({ initialState: doc.state, screenIds: new Set(doc.screens.map((s) => s.id)), deps });
    const context = { doc, registry: runtime.registry, runtime: actionRuntime, customTypes: new Set<string>(), customDefinitions: {}, onError: () => {}, inspector: { enabled: false, visible: false, log: new InspectorLog(), toggle: () => {} } };
    const router = createMemoryRouter([{
      path: "/p/:protoId",
      element: <JSONUIProvider registry={runtime.registry} handlers={runtime.handlers} store={actionRuntime.store}><Outlet context={context} /></JSONUIProvider>,
      children: [{ path: "s/:screenId", element: <ScreenView /> }],
    }], { initialEntries: ["/p/canvas-prototype/s/canvas"] });

    render(<RouterProvider router={router} />);
    fireEvent.click(screen.getByRole("button", { name: "Next screen" }));

    await waitFor(() => expect(navigation.navigate).toHaveBeenCalledWith("details"));
  });
});

describe("ScreenView Overlay device rules and stage", () => {
  it.each(["mobile", "tablet"] as const)("renders %s flow Overlay and disables desktop with a title", (device) => {
    renderPlayer(overlayDoc(device), "/p/overlay-prototype/s/flow");
    expect(screen.getByText("Flow overlay")).toBeTruthy();
    const desktop = screen.getByRole("button", { name: "Компьютер" }) as HTMLButtonElement;
    expect(desktop.disabled).toBe(true);
    expect(desktop.title).toContain("Overlay");
    fireEvent.click(desktop);
    expect(screen.getByRole("button", { name: device === "mobile" ? "Телефон" : "Планшет" }).getAttribute("aria-pressed")).toBe("true");
    const stage = document.querySelector<HTMLElement>("[data-eui-stage-viewport='player']")!;
    expect(stage.querySelector("[data-eui-host-primitive='Overlay']")).not.toBeNull();
    expect(stage.style.getPropertyValue("--eui-space-md")).toBe("12px");
    const bottom = stage.querySelector<HTMLElement>("[data-eui-overlay-content]")!;
    expect(bottom.style.left).toContain("--eui-space-md");
    expect(bottom.style.right).toContain("--eui-space-md");
    expect(bottom.style.bottom).toContain("--eui-space-md");
  });

  it("allows desktop on canvas Overlay, then resets desktop override when navigating to flow Overlay", async () => {
    const { router } = renderPlayer(overlayDoc("mobile", true), "/p/overlay-prototype/s/canvas");
    const desktop = screen.getByRole("button", { name: "Компьютер" }) as HTMLButtonElement;
    expect(desktop.disabled).toBe(false);
    fireEvent.click(desktop);
    expect(desktop.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector("[data-eui-canvas-layer='overlay']")).not.toBeNull();
    expect(screen.getByText("Canvas overlay")).toBeTruthy();

    await router.navigate("/p/overlay-prototype/s/flow");
    await waitFor(() => expect(screen.getByRole("button", { name: "Телефон" }).getAttribute("aria-pressed")).toBe("true"));
    expect((screen.getByRole("button", { name: "Компьютер" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Flow overlay")).toBeTruthy();
  });

  it("keeps Overlay anchored to the transformed StageViewport while the player scroller moves", () => {
    renderPlayer(overlayDoc("mobile"), "/p/overlay-prototype/s/flow");
    const scroller = document.querySelector<HTMLElement>("[data-eui-content-scroller='player']")!;
    const stage = document.querySelector<HTMLElement>("[data-eui-stage-viewport='player']")!;
    const overlay = stage.querySelector<HTMLElement>("[data-eui-host-primitive='Overlay']")!;
    const hostBefore = overlay.parentElement;
    const bottomBefore = overlay.querySelector<HTMLElement>("[data-eui-overlay-content]")!.style.bottom;
    scroller.scrollTop = 120;
    fireEvent.scroll(scroller);
    expect(overlay.parentElement).toBe(hostBefore);
    expect(overlay.parentElement).toBe(stage);
    expect(overlay.querySelector<HTMLElement>("[data-eui-overlay-content]")!.style.bottom).toBe(bottomBefore);
  });
});
