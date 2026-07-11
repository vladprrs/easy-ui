import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  afterEach(cleanup);

  it("removes event handlers from the preview spec", () => {
    renderCanvas();
    const specs = screen.getAllByTestId("runtime-spec").map((node) => JSON.parse(node.textContent ?? "null"));
    expect(specs).not.toHaveLength(0);
    for (const spec of specs) {
      for (const element of Object.values(spec.elements) as Array<Record<string, unknown>>) expect(element).not.toHaveProperty("on");
    }
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

  it("selects the deepest element containing the click", () => {
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

    const rects = new Map<Node, DOMRect>([
      [parent, DOMRect.fromRect({ x: 0, y: 0, width: 40, height: 40 })],
      [child, DOMRect.fromRect({ x: 0, y: 0, width: 100, height: 100 })],
    ]);
    const rangeSpy = vi.spyOn(document, "createRange").mockImplementation(() => {
      let selected: Node;
      return {
        selectNodeContents: (node: Node) => { selected = node; },
        getClientRects: () => [rects.get(selected)!] as unknown as DOMRectList,
        getBoundingClientRect: () => rects.get(selected)!,
      } as unknown as Range;
    });

    fireEvent.click(screen.getByTestId("editor-hit-overlay"), { clientX: 10, clientY: 10 });
    expect(onSelect).toHaveBeenCalledWith("child");
    rangeSpy.mockRestore();
  });

  it("prefers the smaller union rect at equal DOM depth", () => {
    const doc = makeDoc();
    const onSelect = vi.fn();
    render(<EditorCanvas doc={doc} screen={doc.screens[0]} registry={registry} runtimeKey="runtime" stateEpoch={0} selectedKey={null} onSelect={onSelect} />);

    const previewRoot = document.querySelector<HTMLElement>("[inert]")!;
    const large = document.createElement("span");
    large.dataset.jrKey = "large";
    const hotspot = document.createElement("span");
    hotspot.dataset.jrKey = "hotspot";
    previewRoot.append(large, hotspot);

    const rects = new Map<Node, DOMRect>([
      [large, DOMRect.fromRect({ x: 0, y: 0, width: 100, height: 100 })],
      [hotspot, DOMRect.fromRect({ x: 5, y: 5, width: 20, height: 20 })],
    ]);
    const rangeSpy = vi.spyOn(document, "createRange").mockImplementation(() => {
      let selected: Node;
      return {
        selectNodeContents: (node: Node) => { selected = node; },
        getClientRects: () => [rects.get(selected)!] as unknown as DOMRectList,
        getBoundingClientRect: () => rects.get(selected)!,
      } as unknown as Range;
    });

    fireEvent.click(screen.getByTestId("editor-hit-overlay"), { clientX: 10, clientY: 10 });
    expect(onSelect).toHaveBeenCalledWith("hotspot");
    rangeSpy.mockRestore();
  });
});
