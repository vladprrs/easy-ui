// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Overlay } from "../catalog/hostPrimitives/Overlay";
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
    expect(stage.style.getPropertyValue("--eui-space-md")).toBe("14px");
    expect(scroller.style.scrollbarGutter).toBe("stable");
    expect(scroller.style.touchAction).toBe("");
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
