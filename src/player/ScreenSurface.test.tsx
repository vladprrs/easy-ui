import { JSONUIProvider } from "@json-render/react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createPlayerRuntime, type CustomPlayerRuntime } from "../catalog/runtime";
import type { PrototypeDoc } from "../prototype/schema";
import { toRuntimeSpec } from "../prototype/runtimeSpec";
import { EasyUiActionRuntime } from "./actionRuntime";
import type { EasyUIComponentProps } from "./easyUiRuntime";
import { ScreenSurface } from "./ScreenSurface";

const noopDeps = { navigate() {}, back() {}, openUrl() {}, restart() {} };
const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
  x: left, y: top, left, top, width, height, right: left + width, bottom: top + height,
  toJSON: () => ({}),
} as DOMRect);

function mockRect(element: Element, value: DOMRect) {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(value);
}

function renderSurface(spec: PrototypeDoc["screens"][number]["spec"], options: {
  custom?: CustomPlayerRuntime;
  canvas?: { width: number; height: number };
  misclickHighlights?: boolean;
} = {}) {
  const runtime = createPlayerRuntime(noopDeps, options.custom);
  const actionRuntime = new EasyUiActionRuntime({ initialState: {}, screenIds: new Set(["screen"]), deps: noopDeps });
  const customDefinitions = options.custom?.definitions ?? {};
  const tree = toRuntimeSpec(spec, { customTypes: new Set(Object.keys(customDefinitions)) });
  return render(
    <JSONUIProvider registry={runtime.registry} handlers={runtime.handlers} store={actionRuntime.store}>
      <ScreenSurface
        registry={runtime.registry}
        runtime={actionRuntime}
        customDefinitions={customDefinitions}
        onError={() => {}}
        tree={tree}
        canvas={options.canvas}
        misclickHighlights={options.misclickHighlights ?? true}
      />
    </JSONUIProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ScreenSurface misclick highlights", () => {
  it("highlights builtin and custom on.press elements on a non-canvas misclick for 400ms", () => {
    vi.useFakeTimers();
    const custom: CustomPlayerRuntime = {
      definitions: { CustomAction: { description: "Custom action", props: z.strictObject({ label: z.string() }) } },
      components: {
        CustomAction: (({ props, emit }: EasyUIComponentProps<{ label: string }>) => <button type="button" onClick={() => emit("press")}>{props.label}</button>) as CustomPlayerRuntime["components"][string],
      },
    };
    renderSurface({
      root: "stack",
      elements: {
        stack: { type: "Stack", props: {}, children: ["copy", "builtin", "custom"] },
        copy: { type: "Text", props: { text: "Click outside" } },
        builtin: { type: "Button", props: { label: "Builtin" }, on: { press: { action: "restart" } } },
        custom: { type: "CustomAction", props: { label: "Custom" }, on: { press: { action: "restart" } } },
      },
    }, { custom });
    mockRect(screen.getByRole("button", { name: "Builtin" }), rect(10, 20, 100, 40));
    mockRect(screen.getByRole("button", { name: "Custom" }), rect(10, 80, 120, 40));

    fireEvent.click(screen.getByText("Click outside"));

    const highlights = screen.getByTestId("misclick-highlights");
    expect(highlights.querySelectorAll("[data-eui-highlight-key]")).toHaveLength(2);
    expect(highlights.querySelector('[data-eui-highlight-key="builtin"]')).not.toBeNull();
    expect(highlights.querySelector('[data-eui-highlight-key="custom"]')).not.toBeNull();

    act(() => vi.advanceTimersByTime(399));
    expect(screen.getByTestId("misclick-highlights")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId("misclick-highlights")).toBeNull();
  });

  it("highlights both a canvas Hotspot and a builtin on.press element", () => {
    renderSurface({
      root: "stack",
      elements: {
        stack: { type: "Stack", props: {}, children: ["copy", "action", "hotspot"] },
        copy: { type: "Text", props: { text: "Canvas copy" } },
        action: { type: "Button", props: { label: "Canvas action" }, on: { press: { action: "restart" } } },
        hotspot: { type: "Hotspot", props: { x: 4, y: 8, width: 80, height: 30, ariaLabel: "Canvas hotspot" } },
      },
    }, { canvas: { width: 320, height: 240 } });
    mockRect(screen.getByRole("button", { name: "Canvas action" }), rect(20, 30, 100, 40));
    mockRect(screen.getByRole("button", { name: "Canvas hotspot" }), rect(4, 8, 80, 30));

    fireEvent.click(screen.getByText("Canvas copy"));

    const highlights = screen.getByTestId("misclick-highlights");
    expect(highlights.querySelector('[data-eui-highlight-key="action"]')).not.toBeNull();
    expect(highlights.querySelector('[data-eui-highlight-key="hotspot"]')).not.toBeNull();
  });

  it("does not highlight after a click on an authored interactive element", () => {
    renderSurface({
      root: "stack",
      elements: {
        stack: { type: "Stack", props: {}, children: ["copy", "action"] },
        copy: { type: "Text", props: { text: "Passive copy" } },
        action: { type: "Button", props: { label: "Interactive" }, on: { press: { action: "restart" } } },
      },
    });
    mockRect(screen.getByRole("button", { name: "Interactive" }), rect(10, 20, 100, 40));

    fireEvent.click(screen.getByRole("button", { name: "Interactive" }));

    expect(screen.queryByTestId("misclick-highlights")).toBeNull();
  });

  it("does not highlight while text is selected or when the player-only mode is disabled", () => {
    const selection = { isCollapsed: false, toString: () => "selected" } as Selection;
    vi.spyOn(window, "getSelection").mockReturnValue(selection);
    const spec = {
      root: "stack",
      elements: {
        stack: { type: "Stack", props: {}, children: ["copy", "action"] },
        copy: { type: "Text", props: { text: "Selectable copy" } },
        action: { type: "Button", props: { label: "Action" }, on: { press: { action: "restart" } } },
      },
    } as PrototypeDoc["screens"][number]["spec"];
    const first = renderSurface(spec);
    mockRect(screen.getByRole("button", { name: "Action" }), rect(10, 20, 100, 40));
    fireEvent.click(screen.getByText("Selectable copy"));
    expect(screen.queryByTestId("misclick-highlights")).toBeNull();

    first.unmount();
    vi.mocked(window.getSelection).mockReturnValue(null);
    renderSurface(spec, { misclickHighlights: false });
    mockRect(screen.getByRole("button", { name: "Action" }), rect(10, 20, 100, 40));
    fireEvent.click(screen.getByText("Selectable copy"));
    expect(screen.queryByTestId("misclick-highlights")).toBeNull();
  });
});
