import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FitToBox } from "./FitToBox";

function sizes(node: HTMLElement, box: { width: number; height: number }, content: { width: number; height: number }) {
  Object.defineProperty(node, "clientWidth", { configurable: true, value: box.width });
  Object.defineProperty(node, "clientHeight", { configurable: true, value: box.height });
  const inner = node.querySelector<HTMLElement>("[data-fit-to-box-content]")!;
  Object.defineProperty(inner, "offsetWidth", { configurable: true, value: content.width });
  Object.defineProperty(inner, "offsetHeight", { configurable: true, value: content.height });
  return inner;
}

afterEach(() => vi.unstubAllGlobals());

describe("FitToBox", () => {
  it("always applies a transform so fixed-position children cannot escape the card", () => {
    render(<FitToBox><div>content</div></FitToBox>);
    const inner = screen.getByText("content").parentElement!;
    expect(inner.style.transform).toBe("scale(1)");
    const box = inner.parentElement!;
    expect(box.style.overflow).toBe("hidden");
    expect(box.style.isolation).toBe("isolate");
    expect(box.style.contain).toBe("layout paint");
  });

  it("scales oversized content down to the box and leaves small content untouched", () => {
    const observed: (() => void)[] = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { observed.push(callback); }
      observe() {}
      unobserve() {}
      disconnect() {}
    });

    const { container, rerender } = render(<FitToBox gutter={10}><div>content</div></FitToBox>);
    const box = container.querySelector<HTMLElement>("[data-fit-to-box]")!;
    const inner = sizes(box, { width: 420, height: 220 }, { width: 800, height: 100 });
    act(() => observed[0]!());
    // (420 - 20) / 800 = 0.5 — по ширине, высота свободна.
    expect(inner.style.transform).toBe("scale(0.5)");

    Object.defineProperty(inner, "offsetWidth", { configurable: true, value: 100 });
    act(() => observed[0]!());
    expect(inner.style.transform).toBe("scale(1)");

    rerender(<FitToBox gutter={10}><div>content</div></FitToBox>);
    expect(inner.style.transform).toBe("scale(1)");
  });

  it("degrades to scale(1) without ResizeObserver and on a zero-sized box", () => {
    const original = globalThis.ResizeObserver;
    // @ts-expect-error — воспроизводим jsdom без ResizeObserver.
    delete globalThis.ResizeObserver;
    try {
      const { container } = render(<FitToBox><div>content</div></FitToBox>);
      const inner = container.querySelector<HTMLElement>("[data-fit-to-box-content]")!;
      expect(inner.style.transform).toBe("scale(1)");
    } finally {
      globalThis.ResizeObserver = original;
    }
  });
});
