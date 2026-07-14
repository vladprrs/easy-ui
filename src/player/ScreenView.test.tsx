import { JSONUIProvider } from "@json-render/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { createPlayerRuntime } from "../catalog/runtime";
import { prototypeDocSchema } from "../prototype/schema";
import { EasyUiActionRuntime } from "./actionRuntime";
import { ScreenErrorBoundary } from "./ScreenView";
import { ScreenView } from "./ScreenView";

const navigation = vi.hoisted(() => ({ navigate: vi.fn(), browse: vi.fn(), restart: vi.fn(), back: vi.fn() }));
vi.mock("./navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./navigation")>()),
  usePlayerNavigation: () => ({ ...navigation, sessionNonce: "test", flowDepth: 0, entryReason: "flow" as const, goToScreen: navigation.browse, browseToScreen: navigation.browse, flowResetVisible: false, dismissFlowReset: () => {} }),
  // Баннер читает контекст через оригинальный usePlayerNavigation — вне провайдера стаб.
  FlowResetBanner: () => null,
}));

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
  const context = { doc, registry: runtime.registry, runtime: actionRuntime, customTypes: new Set<string>(), customDefinitions: {}, onError: () => {} };
  const router = createMemoryRouter([{
    path: "/p/:protoId",
    element: <JSONUIProvider registry={runtime.registry} handlers={runtime.handlers} store={actionRuntime.store}><Outlet context={context} /></JSONUIProvider>,
    children: [{ path: "s/:screenId", element: <ScreenView /> }],
  }], { initialEntries: [initialPath] });
  return render(<RouterProvider router={router} />);
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

describe("ScreenView stage controls (W1-1)", () => {
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
    const doc = prototypeDocSchema.parse((await import("../../prototypes/hello-world.json")).default);
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
    const context = { doc, registry: runtime.registry, runtime: actionRuntime, customTypes: new Set<string>(), customDefinitions: {}, onError: () => {} };
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
