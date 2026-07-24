// @vitest-environment jsdom
import { JSONUIProvider } from "@json-render/react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrototypeDoc } from "../prototype/schema";
import { toRuntimeSpec } from "../prototype/runtimeSpec";
import { createPlayerRuntime } from "../catalog/runtime";
import { Overlay } from "../catalog/hostPrimitives/Overlay";
import { EasyUiActionRuntime } from "./actionRuntime";
import { ScreenSurface } from "./ScreenSurface";
import { FluidStage } from "./FluidStage";

const observed: Element[] = [];
let observedWidth = 0;

class ResizeObserverMock {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    observed.push(target);
    this.callback([{ contentRect: DOMRect.fromRect({ width: observedWidth }) } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  disconnect() {}
}

const eventHandle = () => ({ shouldPreventDefault: false, emit() {} });
const overlay = <Overlay
  props={{ placement: "top-left", inset: "md", scrim: false }}
  emit={() => {}}
  on={eventHandle as never}
>Overlay copy</Overlay>;
const noopDeps = { navigate() {}, back() {}, openUrl() {}, restart() {} };

function regionSpec(overrides: Partial<PrototypeDoc["screens"][number]["spec"]["elements"]> = {}): PrototypeDoc["screens"][number]["spec"] {
  return {
    root: "root",
    elements: {
      root: { type: "@eui/FlowRoot", props: {}, children: ["status", "header", "body", "footer", "overlay"] },
      status: { type: "Text", props: { text: "OS status" }, region: "statusBar" },
      header: { type: "Stack", props: { className: "header-authored" }, children: ["header-copy"], region: "header" },
      "header-copy": { type: "Text", props: { text: "Pinned header" } },
      body: { type: "Text", props: { text: "Scrollable body" } },
      footer: { type: "Stack", props: { className: "relative z-[999]" }, children: ["footer-copy"], region: "footer" },
      "footer-copy": { type: "Text", props: { text: "Pinned footer" } },
      overlay: { type: "Overlay", props: { placement: "bottom", inset: "sm", scrim: true }, children: ["overlay-copy"] },
      "overlay-copy": { type: "Text", props: { text: "Top overlay" } },
      ...overrides,
    },
  };
}

function renderRegionStage(spec = regionSpec(), initialState: Record<string, unknown> = {}) {
  const runtime = createPlayerRuntime(noopDeps);
  const actionRuntime = new EasyUiActionRuntime({ initialState, screenIds: new Set(["screen"]), deps: noopDeps });
  const tree = toRuntimeSpec(spec);
  const view = render(<JSONUIProvider registry={runtime.registry} handlers={runtime.handlers} store={actionRuntime.store}>
    <FluidStage designSystem="shadcn" resetKey="screen">
      <ScreenSurface registry={runtime.registry} runtime={actionRuntime} customDefinitions={{}} onError={() => {}} tree={tree} misclickHighlights={false} />
    </FluidStage>
  </JSONUIProvider>);
  return { ...view, actionRuntime };
}

describe("FluidStage", () => {
  beforeEach(() => {
    observed.length = 0;
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("anchors flow Overlay to the viewport outside its scroller", () => {
    const { container } = render(<FluidStage designSystem="shadcn" themeTokens={{ "space.md": "14px" }}>
      <div>Flow content</div>
      {overlay}
    </FluidStage>);

    const stage = container.querySelector<HTMLElement>("[data-eui-stage-viewport='present-fluid']")!;
    const scroller = container.querySelector<HTMLElement>("[data-eui-content-scroller='present-fluid']")!;
    expect(stage.contains(scroller)).toBe(true);
    expect(scroller.firstElementChild?.classList.contains("min-h-full")).toBe(true);
    expect(stage.querySelector("[data-eui-host-primitive='Overlay']")?.textContent).toBe("Overlay copy");
    expect(stage.classList.contains("isolate")).toBe(true);
    // SurfaceSpacingScope теперь на h-dvh-обёртке FluidStage, а не на самом RegionStage-стейдже.
    expect(stage.parentElement?.style.getPropertyValue("--eui-space-md")).toBe("14px");
    expect(scroller.style.scrollbarGutter).toBe("stable");
    expect(scroller.style.touchAction).toBe("");
  });

  it("extracts bars outside the flex scroller, drops statusBar, and keeps Overlay above authored z-index", () => {
    const { container } = renderRegionStage();
    const stage = container.querySelector<HTMLElement>("[data-eui-stage-viewport='present-fluid']")!;
    const scroller = container.querySelector<HTMLElement>("[data-eui-content-scroller='present-fluid']")!;
    const header = container.querySelector<HTMLElement>("[data-eui-region='header']")!;
    const footer = container.querySelector<HTMLElement>("[data-eui-region='footer']")!;
    const overlayLayer = container.querySelector<HTMLElement>("[data-eui-overlay-layer='present-fluid']")!;

    expect(stage.className).toContain("flex-col");
    expect(stage.className).toContain("overflow-hidden");
    expect(header.contains(screen.getByText("Pinned header"))).toBe(true);
    expect(footer.contains(screen.getByText("Pinned footer"))).toBe(true);
    expect(scroller.contains(screen.getByText("Scrollable body"))).toBe(true);
    expect(scroller.contains(header)).toBe(false);
    expect(scroller.contains(footer)).toBe(false);
    expect(screen.queryByText("OS status")).toBeNull();
    expect(header.className).toContain("z-10");
    expect(footer.className).toContain("z-10");
    expect(footer.querySelector(".z-\\[999\\]")).not.toBeNull();
    expect(overlayLayer.className).toContain("z-20");
    expect(overlayLayer.contains(screen.getByText("Top overlay"))).toBe(true);
    expect(overlayLayer.querySelector("[data-eui-overlay-scrim]")).not.toBeNull();
  });

  it("renders repeat scope inside an extracted footer", () => {
    const spec = regionSpec({
      footer: { type: "Stack", props: {}, children: ["footer-list"], region: "footer" },
      "footer-list": { type: "Stack", props: {}, repeat: { statePath: "/tabs", key: "id" }, children: ["footer-item"] },
      "footer-item": { type: "Text", props: { text: { $item: "label" } } },
    });
    const { container } = renderRegionStage(spec, { tabs: [{ id: "home", label: "Home tab" }, { id: "profile", label: "Profile tab" }] });
    const footer = container.querySelector<HTMLElement>("[data-eui-region='footer']")!;
    expect(footer.contains(screen.getByText("Home tab"))).toBe(true);
    expect(footer.contains(screen.getByText("Profile tab"))).toBe(true);
  });

  it("collapses a conditional empty footer even with a non-zero safe-area inset", () => {
    const spec = regionSpec({
      footer: { type: "Stack", props: {}, children: ["footer-copy"], region: "footer", visible: { $state: "/showFooter" } },
    });
    const { container, actionRuntime } = renderRegionStage(spec, { showFooter: true });
    const footer = container.querySelector<HTMLElement>("[data-eui-region='footer']")!;
    footer.style.setProperty("--eui-safe-area-bottom", "24px");
    expect(footer.style.paddingBottom).toContain("--eui-safe-area-bottom");
    expect(footer.className).toContain("[&:empty]:hidden");
    expect(footer.contains(screen.getByText("Pinned footer"))).toBe(true);

    act(() => actionRuntime.store.set("/showFooter", false));
    expect(screen.queryByText("Pinned footer")).toBeNull();
    expect(footer.childElementCount).toBe(0);
  });

  it("resets both scroll axes on navigate and Back reset-key changes", () => {
    const view = render(<FluidStage designSystem="shadcn" resetKey="first">Screen one</FluidStage>);
    const scroller = view.container.querySelector<HTMLElement>("[data-eui-content-scroller='present-fluid']")!;
    scroller.scrollTop = 120;
    scroller.scrollLeft = 30;
    view.rerender(<FluidStage designSystem="shadcn" resetKey="second">Screen two</FluidStage>);
    expect(scroller.scrollTop).toBe(0);
    expect(scroller.scrollLeft).toBe(0);

    scroller.scrollTop = 90;
    scroller.scrollLeft = 12;
    view.rerender(<FluidStage designSystem="shadcn" resetKey="first">Screen one</FluidStage>);
    expect(scroller.scrollTop).toBe(0);
    expect(scroller.scrollLeft).toBe(0);
  });

  it("starts at the top after the restart session remount", () => {
    const view = render(<FluidStage key="session-a" designSystem="shadcn" resetKey="first">Screen one</FluidStage>);
    const scroller = view.container.querySelector<HTMLElement>("[data-eui-content-scroller='present-fluid']")!;
    scroller.scrollTop = 140;
    scroller.scrollLeft = 18;
    view.rerender(<FluidStage key="session-b" designSystem="shadcn" resetKey="first">Screen one</FluidStage>);
    const restartedScroller = view.container.querySelector<HTMLElement>("[data-eui-content-scroller='present-fluid']")!;
    expect(restartedScroller).not.toBe(scroller);
    expect(restartedScroller.scrollTop).toBe(0);
    expect(restartedScroller.scrollLeft).toBe(0);
  });

  it("scales a 390×2000 canvas from the external 320px host", () => {
    observedWidth = 320;
    const { container } = render(<FluidStage canvas={{ width: 390, height: 2000 }} designSystem="shadcn">
      <div>Canvas content</div>
      {overlay}
    </FluidStage>);

    const scroller = container.querySelector<HTMLElement>("[data-eui-content-scroller='present-fluid']")!;
    const spacer = scroller.firstElementChild as HTMLElement;
    const stage = container.querySelector<HTMLElement>("[data-eui-stage-viewport='present-fluid']")!;
    const scale = 320 / 390;
    expect(observed).toEqual([scroller.parentElement]);
    expect(spacer.style.width).toBe("320px");
    expect(Number.parseFloat(spacer.style.height)).toBeCloseTo(2000 * scale);
    expect(stage.parentElement).toBe(spacer);
    expect(stage.style.transform).toBe(`scale(${scale})`);
    expect(stage.querySelector("[data-eui-host-primitive='Overlay']")?.textContent).toBe("Overlay copy");
    expect(stage.style.getPropertyValue("--eui-space-md")).toBe("12px");
  });

  it("keeps the 390/420 scale stable after one external-host measurement", () => {
    observedWidth = 390;
    const { container } = render(<FluidStage canvas={{ width: 420, height: 920 }} designSystem="shadcn">
      Canvas
    </FluidStage>);

    const scroller = container.querySelector<HTMLElement>("[data-eui-content-scroller='present-fluid']")!;
    const stage = container.querySelector<HTMLElement>("[data-eui-stage-viewport='present-fluid']")!;
    expect(observed).toHaveLength(1);
    expect(observed[0]).toBe(scroller.parentElement);
    expect(stage.style.transform).toBe(`scale(${390 / 420})`);
  });

  it("clips an overflowing canvas descendant at the spacer boundary", () => {
    observedWidth = 320;
    const { container } = render(<FluidStage canvas={{ width: 390, height: 600 }} designSystem="shadcn">
      <div style={{ width: 900 }}>Wide authored child</div>
    </FluidStage>);

    const scroller = container.querySelector<HTMLElement>("[data-eui-content-scroller='present-fluid']")!;
    const spacer = scroller.firstElementChild as HTMLElement;
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 320 },
      // jsdom не считает layout: моделируем scroll-extent из реальной границы spacer.
      scrollWidth: { configurable: true, get: () => Number.parseFloat(spacer.style.width) },
    });
    expect(spacer.classList.contains("overflow-hidden")).toBe(true);
    expect(scroller.scrollWidth).toBe(scroller.clientWidth);
  });
});
