import { JSONUIProvider } from "@json-render/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { createPlayerRuntime } from "../catalog/runtime";
import { prototypeDocSchema } from "../prototype/schema";
import { EasyUiActionRuntime } from "./actionRuntime";
import { ScreenErrorBoundary } from "./ScreenView";
import { ScreenView } from "./ScreenView";

const navigation = vi.hoisted(() => ({ navigate: vi.fn(), restart: vi.fn(), back: vi.fn() }));
vi.mock("./navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./navigation")>()),
  usePlayerNavigation: () => ({ ...navigation, sessionNonce: "test", flowDepth: 0, goToScreen: navigation.navigate }),
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
    screen.getByRole("button", { name: "Restart" }).click();
    expect(restart).toHaveBeenCalledOnce();
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
