import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentRegistry } from "@json-render/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrototypeDoc } from "../prototype/schema";

const mocks = vi.hoisted(() => ({
  markDevtoolsActive: vi.fn(),
  cleanupDevtools: vi.fn(),
  providerMount: 0,
}));

vi.mock("@json-render/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@json-render/core")>(),
  markDevtoolsActive: mocks.markDevtoolsActive,
}));

vi.mock("@json-render/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@json-render/react")>();
  const React = await import("react");
  return {
    ...actual,
    JSONUIProvider: ({ children }: { children: React.ReactNode }) => {
      const mount = React.useRef(++mocks.providerMount);
      return <div data-testid="provider" data-mount={mount.current}>{children}</div>;
    },
    Renderer: ({ spec }: { spec: unknown }) => <pre data-testid="runtime-spec">{JSON.stringify(spec)}</pre>,
  };
});

import { EditorCanvas } from "./EditorCanvas";

const registry = {} as ComponentRegistry;

function makeDoc(spec: PrototypeDoc["screens"][number]["spec"] = {
  root: "root",
  elements: {
    root: { type: "Box", props: {}, children: ["child"], on: { click: { action: "navigate", params: { screenId: "other" } } } },
    child: { type: "Text", props: { text: "Hello" }, on: { click: { action: "back" } } },
  },
}): PrototypeDoc {
  return {
    version: 1,
    id: "demo",
    name: "Demo",
    designSystem: "shadcn",
    device: "mobile",
    startScreen: "home",
    state: {},
    screens: [{ id: "home", name: "Home", spec }],
  };
}

function renderCanvas(doc = makeDoc(), stateEpoch = 0) {
  return render(<EditorCanvas
    doc={doc}
    screen={doc.screens[0]}
    registry={registry}
    runtimeKey="runtime"
    stateEpoch={stateEpoch}
    selectedKey={null}
    onSelect={vi.fn()}
  />);
}

describe("EditorCanvas", () => {
  beforeEach(() => {
    mocks.providerMount = 0;
    mocks.cleanupDevtools.mockReset();
    mocks.markDevtoolsActive.mockReset().mockReturnValue(mocks.cleanupDevtools);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("removes event handlers from the preview spec", () => {
    renderCanvas();
    const specs = screen.getAllByTestId("runtime-spec").map((node) => JSON.parse(node.textContent ?? "null"));
    expect(specs).not.toHaveLength(0);
    for (const spec of specs) {
      for (const element of Object.values(spec.elements) as Array<Record<string, unknown>>) expect(element).not.toHaveProperty("on");
    }
  });

  it("moves custom on into the metadata side-channel and keeps a string __euiKey in the inert spec", () => {
    const doc = makeDoc({
      root: "root",
      elements: {
        root: { type: "Box", props: {}, children: ["widget"] },
        widget: { type: "Widget", props: { label: "Hi" }, on: { press: { action: "back" } } },
      },
    });
    render(<EditorCanvas doc={doc} screen={doc.screens[0]} registry={registry} runtimeKey="runtime" stateEpoch={0} selectedKey={null} onSelect={vi.fn()} customTypes={new Set(["Widget"])} customDefinitions={{}} />);
    const spec = JSON.parse(screen.getByTestId("runtime-spec").textContent ?? "null");
    expect(spec.elements.widget.props.__euiKey).toBe("widget");
    expect(spec.elements.widget).not.toHaveProperty("on");
    expect(spec.elements.root).not.toHaveProperty("on");
  });

  it("remounts the provider when stateEpoch changes", () => {
    const doc = makeDoc();
    const view = renderCanvas(doc, 1);
    const firstMount = screen.getByTestId("provider").dataset.mount;
    view.rerender(<EditorCanvas doc={doc} screen={doc.screens[0]} registry={registry} runtimeKey="runtime" stateEpoch={2} selectedKey={null} onSelect={vi.fn()} />);
    expect(screen.getByTestId("provider").dataset.mount).not.toBe(firstMount);
  });

  it("shows an empty-root placeholder", () => {
    renderCanvas(makeDoc({ root: "missing", elements: {} }));
    expect(screen.getByText("Нет содержимого")).toBeTruthy();
  });

  it("activates devtools and cleans up on unmount", () => {
    const view = renderCanvas();
    expect(mocks.markDevtoolsActive).toHaveBeenCalledOnce();
    view.unmount();
    expect(mocks.cleanupDevtools).toHaveBeenCalledOnce();
  });

  it("clears selection when no element geometry contains the click", () => {
    const doc = makeDoc();
    const onSelect = vi.fn();
    render(<EditorCanvas doc={doc} screen={doc.screens[0]} registry={registry} runtimeKey="runtime" stateEpoch={0} selectedKey={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId("editor-hit-overlay"), { clientX: 10, clientY: 10 });
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("selects the closest marked element from the event path", () => {
    const doc = makeDoc();
    const onSelect = vi.fn();
    render(<EditorCanvas doc={doc} screen={doc.screens[0]} registry={registry} runtimeKey="runtime" stateEpoch={0} selectedKey={null} onSelect={onSelect} />);

    const previewRoot = document.querySelector<HTMLElement>("[inert]")!;
    const parent = document.createElement("span");
    parent.dataset.jrKey = "root";
    const child = document.createElement("span");
    child.dataset.jrKey = "child";
    parent.append(child);
    previewRoot.append(parent);

    fireEvent.click(child);
    expect(onSelect).toHaveBeenCalledWith("child");
  });

  it("hit-tests through the inert preview when the browser retargets the event", () => {
    const doc = makeDoc();
    const onSelect = vi.fn();
    render(<EditorCanvas doc={doc} screen={doc.screens[0]} registry={registry} runtimeKey="runtime" stateEpoch={0} selectedKey={null} onSelect={onSelect} />);
    const previewRoot = document.querySelector<HTMLElement>("[inert]")!;
    const marker = document.createElement("span");
    marker.dataset.jrKey = "child";
    const node = document.createElement("div");
    marker.append(node);
    previewRoot.append(marker);
    const hitTest = vi.fn(() => node);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hitTest });

    fireEvent.click(screen.getByTestId("editor-hit-overlay"), { clientX: 10, clientY: 10 });
    expect(onSelect).toHaveBeenCalledWith("child");
    expect(hitTest).toHaveBeenCalledWith(10, 10);
    expect(previewRoot.hasAttribute("inert")).toBe(true);
    Reflect.deleteProperty(document, "elementFromPoint");
  });

  it("draws one union frame for a composition with multiple roots and a block descendant", () => {
    const doc = makeDoc({ root: "card", elements: { card: { type: "Card", props: {} } } });
    const view = render(<EditorCanvas doc={doc} screen={doc.screens[0]} registry={registry} runtimeKey="runtime" stateEpoch={0} selectedKey={null} onSelect={vi.fn()} />);

    const previewRoot = document.querySelector<HTMLElement>("[inert]")!;
    const card = document.createElement("span");
    card.dataset.jrKey = "card";
    const header = document.createElement("section");
    const body = document.createElement("div");
    const block = document.createElement("p");
    body.append(block);
    card.append(header, body);
    previewRoot.append(card);
    vi.spyOn(header, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 10, y: 10, width: 30, height: 20 }));
    vi.spyOn(body, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 10, y: 30, width: 40, height: 10 }));
    vi.spyOn(block, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 60, y: 20, width: 50, height: 40 }));
    const rangeSpy = vi.spyOn(document, "createRange").mockImplementation(() => {
      return {
        selectNodeContents: vi.fn(),
        getClientRects: () => [DOMRect.fromRect({ x: 12, y: 12, width: 10, height: 10 })] as unknown as DOMRectList,
      } as unknown as Range;
    });

    view.rerender(<EditorCanvas doc={doc} screen={doc.screens[0]} registry={registry} runtimeKey="runtime" stateEpoch={0} selectedKey="card" onSelect={vi.fn()} />);
    const frames = screen.getAllByTestId("editor-selection-frame");
    expect(frames).toHaveLength(1);
    expect(frames[0].style.cssText).toContain("left: 10px");
    expect(frames[0].style.cssText).toContain("top: 10px");
    expect(frames[0].style.cssText).toContain("width: 100px");
    expect(frames[0].style.cssText).toContain("height: 50px");
    rangeSpy.mockRestore();
  });

  it("measures only the hovered element once per animation frame on a large screen", () => {
    const doc = makeDoc();
    renderCanvas(doc);
    const previewRoot = document.querySelector<HTMLElement>("[inert]")!;
    let target: HTMLElement | null = null;
    for (let index = 0; index < 400; index += 1) {
      const marker = document.createElement("span");
      marker.dataset.jrKey = `item-${index}`;
      const node = document.createElement("div");
      marker.append(node);
      previewRoot.append(marker);
      if (index === 237) target = node;
    }

    const callbacks = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      callbacks.set(++frameId, callback);
      return frameId;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => callbacks.delete(id)));
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 20, height: 20 }));
    const rangeSpy = vi.spyOn(document, "createRange").mockReturnValue({
      selectNodeContents: vi.fn(),
      getClientRects: () => [] as unknown as DOMRectList,
    } as unknown as Range);

    fireEvent.mouseMove(target!);
    fireEvent.mouseMove(target!);
    expect(rectSpy).not.toHaveBeenCalled();
    act(() => callbacks.get(frameId)?.(0));
    expect(screen.getByTestId("editor-hover-frame")).toBeTruthy();
    expect(rectSpy.mock.calls.length).toBeLessThan(10);
    expect(rangeSpy).toHaveBeenCalledOnce();
    rectSpy.mockRestore();
    rangeSpy.mockRestore();
  });
});
