import { JSONUIProvider } from "@json-render/react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createPlayerRuntime, type CustomPlayerRuntime } from "../catalog/runtime";
import { HostStageSurface } from "../catalog/hostPrimitives";
import type { PrototypeDoc } from "../prototype/schema";
import { toRuntimeSpec } from "../prototype/runtimeSpec";
import { EasyUiActionRuntime } from "./actionRuntime";
import type { EasyUIComponentProps } from "./easyUiRuntime";
import { ScreenRegionsProvider } from "./ScreenRegions";
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

const overlaySpec = (canvas = false): PrototypeDoc["screens"][number]["spec"] => ({
  root: "root",
  elements: {
    root: { type: "Stack", props: {}, children: ["copy", "top", "corner"] },
    copy: { type: "Text", props: { text: canvas ? "Canvas base" : "Flow base" } },
    top: { type: "Overlay", props: { placement: "top", inset: "md", scrim: true }, children: ["top-copy"] },
    "top-copy": { type: "Text", props: { text: "Top overlay" } },
    corner: { type: "Overlay", props: { placement: "bottom-right", inset: "lg", scrim: false }, children: ["corner-copy"] },
    "corner-copy": { type: "Text", props: { text: "Corner overlay" } },
  },
});

function renderHostedSurface(spec: PrototypeDoc["screens"][number]["spec"], canvas?: { width: number; height: number }) {
  const runtime = createPlayerRuntime(noopDeps);
  const actionRuntime = new EasyUiActionRuntime({ initialState: {}, screenIds: new Set(["screen"]), deps: noopDeps });
  const tree = toRuntimeSpec(spec);
  const host = document.createElement("div");
  host.style.position = "relative";
  document.body.append(host);
  const stageHostRef = createRef<HTMLElement>();
  stageHostRef.current = host;
  const view = render(<JSONUIProvider registry={runtime.registry} handlers={runtime.handlers} store={actionRuntime.store}>
    <HostStageSurface stageHostRef={stageHostRef}>
      <ScreenSurface registry={runtime.registry} runtime={actionRuntime} customDefinitions={{}} onError={() => {}} tree={tree} canvas={canvas} misclickHighlights={false} />
    </HostStageSurface>
  </JSONUIProvider>);
  return { ...view, host, runtime, actionRuntime, stageHostRef };
}

describe("ScreenSurface Overlay stage integration", () => {
  it("keeps flow content unwrapped and portals ordered overlays with stretch/corner placement and scrim", () => {
    const { container, host } = renderHostedSurface(overlaySpec());

    expect(container.firstElementChild?.textContent).toBe("Flow base");
    expect(container.querySelector("[data-eui-host-primitive='Overlay']")).toBeNull();
    const overlays = host.querySelectorAll<HTMLElement>("[data-eui-host-primitive='Overlay']");
    expect(overlays).toHaveLength(2);
    expect(overlays[0]!.textContent).toContain("Top overlay");
    expect(overlays[1]!.textContent).toContain("Corner overlay");
    expect(overlays[0]!.querySelector("[data-eui-overlay-scrim]")).not.toBeNull();
    const top = overlays[0]!.querySelector<HTMLElement>("[data-eui-overlay-content]")!;
    expect(top.style.left).toContain("--eui-space-md");
    expect(top.style.right).toContain("--eui-space-md");
    const corner = overlays[1]!.querySelector<HTMLElement>("[data-eui-overlay-content]")!;
    expect(corner.style.width).toBe("max-content");
    expect(corner.style.right).toContain("--eui-space-lg");
    expect(corner.style.bottom).toContain("--eui-space-lg");
  });

  it("uses the ordered third canvas layer and preserves content < hotspots < overlay", () => {
    const spec = overlaySpec(true);
    spec.elements.root!.children = ["copy", "hotspot", "top", "corner"];
    spec.elements.hotspot = { type: "Hotspot", props: { x: 1, y: 2, width: 30, height: 40, ariaLabel: "Hit" } };
    const { container, host } = renderHostedSurface(spec, { width: 320, height: 240 });

    const canvasRoot = container.firstElementChild as HTMLElement;
    expect(canvasRoot.children).toHaveLength(3);
    expect(canvasRoot.children[2]!.getAttribute("data-eui-canvas-layer")).toBe("overlay");
    expect(screen.getByText("Canvas base")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hit" })).toBeTruthy();
    expect(host.querySelectorAll("[data-eui-host-primitive='Overlay']")).toHaveLength(2);
  });

  it("does not change the legacy absolute child's parent, computed positioning, or offsetParent", () => {
    const spec = overlaySpec();
    spec.elements.root!.children = ["legacy", "top", "corner"];
    spec.elements.legacy = { type: "Stack", props: { direction: "vertical", gap: "none", className: "absolute" }, children: ["copy"] };
    const withoutOverlay = { ...spec, elements: { ...spec.elements, root: { ...spec.elements.root!, children: ["legacy"] } } };
    const { container, rerender, runtime, actionRuntime, stageHostRef } = renderHostedSurface(withoutOverlay);
    const absolute = container.querySelector<HTMLElement>(".absolute")!;
    const parent = absolute.parentElement;
    const before = { position: getComputedStyle(absolute).position, offsetParent: absolute.offsetParent };
    rerender(<JSONUIProvider registry={runtime.registry} handlers={runtime.handlers} store={actionRuntime.store}>
      <HostStageSurface stageHostRef={stageHostRef}>
        <ScreenSurface registry={runtime.registry} runtime={actionRuntime} customDefinitions={{}} onError={() => {}} tree={toRuntimeSpec(spec)} misclickHighlights={false} />
      </HostStageSurface>
    </JSONUIProvider>);
    const after = container.querySelector<HTMLElement>(".absolute")!;
    expect(after.parentElement).toBe(parent);
    expect(getComputedStyle(after).position).toBe(before.position);
    expect(after.offsetParent).toBe(before.offsetParent);
  });

  it("warns and omits Overlay for legacy desktop-flow data", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runtime = createPlayerRuntime(noopDeps);
    const actionRuntime = new EasyUiActionRuntime({ initialState: {}, screenIds: new Set(["screen"]), deps: noopDeps });
    const tree = toRuntimeSpec(overlaySpec());
    render(<JSONUIProvider registry={runtime.registry} handlers={runtime.handlers} store={actionRuntime.store}>
      <ScreenSurface registry={runtime.registry} runtime={actionRuntime} customDefinitions={{}} onError={() => {}} tree={tree} hostPrimitivesAllowed={false} />
    </JSONUIProvider>);
    expect(screen.getByText("Flow base")).toBeTruthy();
    expect(screen.queryByText("Top overlay")).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("desktop flow"));
  });

  it("keeps host Image and Hotspot in desktop flow for a custom-only catalog", () => {
    const Flow = ({ children }: EasyUIComponentProps) => <div data-testid="flow">{children}</div>;
    const custom: CustomPlayerRuntime = {
      definitions: { Flow: { props: z.strictObject({}), slots: ["default"], description: "Flow" } },
      components: { Flow: Flow as never },
    };
    renderSurface({
      root: "flow",
      elements: {
        flow: { type: "Flow", props: {}, children: ["image", "hotspot"] },
        image: { type: "Image", props: { src: "/images/flow.png", alt: "Flow image", objectFit: "cover" } },
        hotspot: { type: "Hotspot", props: { x: 0, y: 0, width: 20, height: 20, ariaLabel: "Flow hotspot" } },
      },
    }, { custom, misclickHighlights: false });

    expect(screen.getByRole("img", { name: "Flow image" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Flow hotspot" })).toBeTruthy();
    expect(screen.getByTestId("flow")).toBeTruthy();
  });

  it("renders named slots correctly after combined Overlay and canvas Hotspot splits", () => {
    const Panel = ({ slots }: EasyUIComponentProps) => <div data-testid="named-panel">
      <div data-testid="header-slot">{slots.header}</div>
      <div data-testid="actions-slot">{slots.actions}</div>
      <div data-testid="default-slot">{slots.default}</div>
    </div>;
    const custom: CustomPlayerRuntime = {
      definitions: { Panel: { props: z.strictObject({}), slots: ["header", "actions", "default"], capabilities: { namedSlots: true }, description: "Panel" } },
      components: { Panel: Panel as never },
    };
    const runtime = createPlayerRuntime(noopDeps, custom);
    const actionRuntime = new EasyUiActionRuntime({ initialState: {}, screenIds: new Set(["screen"]), deps: noopDeps });
    const authored = {
      root: "panel",
      elements: {
        panel: { type: "Panel", props: {}, children: ["header", "overlay", "hotspot", "body"] },
        header: { type: "Image", props: { src: "/header.png", alt: "Slotted header" }, slot: "header" },
        overlay: { type: "Overlay", props: { placement: "top", inset: "md", scrim: false }, children: ["notice"] },
        notice: { type: "Image", props: { src: "/notice.png", alt: "Overlay notice" } },
        hotspot: { type: "Hotspot", props: { x: 1, y: 2, width: 20, height: 20, ariaLabel: "Split hotspot" }, slot: "actions" },
        body: { type: "Image", props: { src: "/body.png", alt: "Default body" } },
      },
    } as PrototypeDoc["screens"][number]["spec"];
    const tree = toRuntimeSpec(authored, { customTypes: new Set(["Panel"]) });
    const host = document.createElement("div");
    document.body.append(host);
    const stageHostRef = createRef<HTMLElement>();
    stageHostRef.current = host;
    render(<JSONUIProvider registry={runtime.registry} handlers={runtime.handlers} store={actionRuntime.store}>
      <HostStageSurface stageHostRef={stageHostRef}>
        <ScreenSurface registry={runtime.registry} runtime={actionRuntime} customDefinitions={custom.definitions} onError={() => {}} tree={tree} canvas={{ width: 320, height: 240 }} misclickHighlights={false} />
      </HostStageSurface>
    </JSONUIProvider>);
    expect(screen.getByTestId("header-slot").contains(screen.getByRole("img", { name: "Slotted header" }))).toBe(true);
    expect(screen.getByTestId("default-slot").contains(screen.getByRole("img", { name: "Default body" }))).toBe(true);
    expect(screen.getByTestId("actions-slot").textContent).toBe("");
    expect(screen.getByRole("button", { name: "Split hotspot" })).toBeTruthy();
    expect(host.contains(screen.getByRole("img", { name: "Overlay notice" }))).toBe(true);
    host.remove();
  });

  it("renders a FlowRoot region inline while Overlay remains a separate provider-backed branch", () => {
    const authored = {
      root: "root",
      elements: {
        root: { type: "@eui/FlowRoot", props: {}, children: ["header", "body", "overlay"] },
        header: { type: "Image", props: { src: "/header.png", alt: "Inline region" }, region: "header" },
        body: { type: "Image", props: { src: "/body.png", alt: "Inline body" } },
        overlay: { type: "Overlay", props: { placement: "top", inset: "md", scrim: false }, children: ["notice"] },
        notice: { type: "Image", props: { src: "/notice.png", alt: "Region overlay" } },
      },
    } as PrototypeDoc["screens"][number]["spec"];
    const { container, host } = renderHostedSurface(authored);
    const flowRoot = container.querySelector("[data-eui-host-primitive='FlowRoot']")!;
    expect(flowRoot.contains(screen.getByRole("img", { name: "Inline region" }))).toBe(true);
    expect(flowRoot.contains(screen.getByRole("img", { name: "Inline body" }))).toBe(true);
    expect(host.contains(screen.getByRole("img", { name: "Region overlay" }))).toBe(true);
  });

  it("drops an extracted region until its portal target is ready without an inline first frame", () => {
    const authored = {
      root: "root",
      elements: {
        root: { type: "@eui/FlowRoot", props: {}, children: ["body", "footer"] },
        body: { type: "Image", props: { src: "/body.png", alt: "Stable body" } },
        footer: { type: "Image", props: { src: "/footer.png", alt: "Deferred footer" }, region: "footer" },
      },
    } as PrototypeDoc["screens"][number]["spec"];
    const runtime = createPlayerRuntime(noopDeps);
    const actionRuntime = new EasyUiActionRuntime({ initialState: {}, screenIds: new Set(["screen"]), deps: noopDeps });
    const tree = toRuntimeSpec(authored);
    const target = document.createElement("div");
    const renderSurfaceWithTarget = (footer: HTMLElement | null) => <JSONUIProvider registry={runtime.registry} handlers={runtime.handlers} store={actionRuntime.store}>
      <ScreenRegionsProvider disposition={{ footer: "extract" }} targets={{ footer }}>
        <ScreenSurface registry={runtime.registry} runtime={actionRuntime} customDefinitions={{}} onError={() => {}} tree={tree} misclickHighlights={false} />
      </ScreenRegionsProvider>
    </JSONUIProvider>;

    const view = render(renderSurfaceWithTarget(null));
    expect(screen.getByRole("img", { name: "Stable body" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Deferred footer" })).toBeNull();

    document.body.append(target);
    view.rerender(renderSurfaceWithTarget(target));
    expect(target.contains(screen.getByRole("img", { name: "Deferred footer" }))).toBe(true);
    target.remove();
  });
});
