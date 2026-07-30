import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LAZY_MOUNT_EVENT, LazyMount, resetPrintMountForce } from "./LazyMount";

// Обёртка тестируется вне контекста дорожек: её переиспользует режим «Сценарии» (T2b).
type IntersectionCallback = ConstructorParameters<typeof IntersectionObserver>[0];
let observers: { callback: IntersectionCallback; element: Element | null; options?: IntersectionObserverInit; disconnected: boolean }[] = [];

function stubIntersectionObserver() {
  observers = [];
  vi.stubGlobal("IntersectionObserver", class {
    readonly root = null;
    readonly rootMargin = "0px";
    readonly thresholds = [0];
    private record: (typeof observers)[number];
    constructor(callback: IntersectionCallback, options?: IntersectionObserverInit) {
      this.record = { callback, element: null, options, disconnected: false };
      observers.push(this.record);
    }
    observe(element: Element) { this.record.element = element; }
    unobserve() {}
    disconnect() { this.record.disconnected = true; }
    takeRecords() { return []; }
  });
}

function intersect(element: Element, isIntersecting: boolean) {
  const observer = observers.find((candidate) => candidate.element === element && !candidate.disconnected);
  if (!observer) throw new Error("Element is not observed");
  act(() => observer.callback([{ isIntersecting, target: element } as IntersectionObserverEntry], {} as IntersectionObserver));
}

const wrapper = () => document.querySelector<HTMLElement>("[data-lazy-mounted]")!;

let teardown: (() => void)[] = [];
const onTeardown = (task: () => void) => teardown.push(task);

describe("LazyMount", () => {
  beforeEach(() => {
    resetPrintMountForce();
    teardown = [];
  });

  afterEach(() => {
    for (const task of teardown) task();
    cleanup();
    vi.unstubAllGlobals();
    resetPrintMountForce();
  });

  it("mounts eagerly where IntersectionObserver is unavailable", () => {
    expect(typeof IntersectionObserver).toBe("undefined");
    render(<LazyMount placeholderHeight={360}><p>Живой тайл</p></LazyMount>);
    expect(wrapper().dataset.lazyMounted).toBe("true");
    expect(screen.getByText("Живой тайл")).toBeTruthy();
    expect(document.querySelector("[data-lazy-placeholder]")).toBeNull();
  });

  it("holds placeholder geometry, keeps host attributes, and mounts once on intersection", () => {
    stubIntersectionObserver();
    const mountedEvents: string[] = [];
    const listener = (event: Event) => mountedEvents.push((event.target as HTMLElement).dataset.cjmNode ?? "");
    document.addEventListener(LAZY_MOUNT_EVENT, listener);
    onTeardown(() => document.removeEventListener(LAZY_MOUNT_EVENT, listener));
    render(<LazyMount placeholderHeight={360} placeholderWidth={304} className="relative z-20" data-cjm-node="flow:main:0" data-screen-id="cart" style={{ gridColumn: 3 }}>
      <p>Живой тайл</p>
    </LazyMount>);

    const node = wrapper();
    expect(node.dataset.lazyMounted).toBe("false");
    expect(node.dataset.cjmNode).toBe("flow:main:0");
    expect(node.dataset.screenId).toBe("cart");
    expect(node.className).toBe("relative z-20");
    expect(node.style.gridColumn).toBe("3");
    const placeholder = node.querySelector<HTMLElement>("[data-lazy-placeholder]")!;
    expect(placeholder.style.height).toBe("360px");
    expect(placeholder.style.width).toBe("304px");
    expect(placeholder.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByText("Живой тайл")).toBeNull();
    // Горизонтальный запас обязателен: грид дорожек скроллится по горизонтали.
    const [horizontal] = String(observers[0]!.options?.rootMargin).split(" ").slice(1);
    expect(Number.parseFloat(horizontal!)).toBeGreaterThan(0);
    expect(mountedEvents).toEqual([]);

    intersect(node, true);
    expect(node.dataset.lazyMounted).toBe("true");
    expect(screen.getByText("Живой тайл")).toBeTruthy();
    expect(node.querySelector("[data-lazy-placeholder]")).toBeNull();
    // Всплывающее событие — то, по чему потребители геометрии пересобирают наблюдение.
    expect(mountedEvents).toEqual(["flow:main:0"]);
    expect(observers[0]!.disconnected).toBe(true);

    // mount-once: уход из вьюпорта тайл не размонтирует.
    expect(() => intersect(node, false)).toThrow();
    expect(node.dataset.lazyMounted).toBe("true");
    expect(screen.getByText("Живой тайл")).toBeTruthy();
  });

  it("mounts on beforeprint without any intersection", () => {
    stubIntersectionObserver();
    render(<><LazyMount placeholderHeight={360}><p>Первый</p></LazyMount><LazyMount placeholderHeight={360}><p>Второй</p></LazyMount></>);
    expect(document.querySelectorAll('[data-lazy-mounted="false"]')).toHaveLength(2);

    act(() => { window.dispatchEvent(new Event("beforeprint")); });
    expect(document.querySelectorAll('[data-lazy-mounted="true"]')).toHaveLength(2);
    expect(screen.getByText("Первый")).toBeTruthy();
    expect(screen.getByText("Второй")).toBeTruthy();
  });

  it("mounts from the first render when the print media query already matches", () => {
    stubIntersectionObserver();
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query === "print",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia);
    render(<LazyMount placeholderHeight={360}><p>Живой тайл</p></LazyMount>);
    expect(wrapper().dataset.lazyMounted).toBe("true");
    expect(screen.getByText("Живой тайл")).toBeTruthy();
  });
});
