import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentRegistry } from "@json-render/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrototypeDoc } from "../prototype/schema";
import { editorStripTile } from "../designSystems/deviceMetrics";

vi.mock("@json-render/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@json-render/react")>();
  const React = await import("react");
  return {
    ...actual,
    JSONUIProvider: ({ children }: { children: React.ReactNode }) => <div data-testid="provider">{children}</div>,
    Renderer: ({ spec }: { spec: unknown }) => <pre data-testid="runtime-spec">{JSON.stringify(spec)}</pre>,
  };
});

import { EditorScreenStrip } from "./EditorScreenStrip";

const registry = {} as ComponentRegistry;

function makeDoc(overrides: Partial<PrototypeDoc> = {}): PrototypeDoc {
  return {
    version: 1,
    id: "demo",
    name: "Demo",
    designSystem: "shadcn",
    device: "mobile",
    startScreen: "home",
    state: {},
    screens: [
      { id: "home", name: "Home", spec: { root: "root", elements: { root: { type: "Text", props: { text: "A" } } } } },
      { id: "next", name: "Next", spec: { root: "root", elements: { root: { type: "Text", props: { text: "B" } } } } },
    ],
    ...overrides,
  };
}

function renderStrip(doc = makeDoc(), onSelect = vi.fn()) {
  render(<EditorScreenStrip
    doc={doc}
    registry={registry}
    handlers={{}}
    runtimeKey="runtime"
    stateEpoch={0}
    selectedScreenId={doc.screens[0]!.id}
    onSelect={onSelect}
    customTypes={undefined}
    customDefinitions={undefined}
  />);
  return onSelect;
}

describe("EditorScreenStrip (W2-1)", () => {
  afterEach(cleanup);

  it("рендерит хедер с числом экранов и тоггл сворачивания вне скролл-списка", () => {
    renderStrip();
    const strip = screen.getByRole("region", { name: "Экраны прототипа" });
    expect(within(strip).getByRole("heading", { name: "Экраны (2)" })).toBeTruthy();
    const toggle = within(strip).getByRole("button", { name: "Свернуть" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    // Хедер — сиблинг списка, а не его элемент: остаётся видимым при скролле.
    const list = within(strip).getByRole("list");
    expect(list.contains(toggle)).toBe(false);
  });

  it("капит высоту тайла editorStripTile.heightCap (fallback до замера)", () => {
    renderStrip();
    const frames = screen.getAllByTestId("runtime-spec").map((node) => node.closest("div[style]")?.parentElement?.parentElement);
    // Auto-height экран до первого замера — fallbackHeight, не выше cap.
    const article = screen.getAllByRole("article")[0]!;
    const frame = article.querySelector<HTMLElement>("div.overflow-hidden");
    expect(frame).toBeTruthy();
    expect(Number.parseFloat(frame!.style.height)).toBeLessThanOrEqual(editorStripTile.heightCap);
    expect(Number.parseFloat(frame!.style.width)).toBe(editorStripTile.width);
    expect(frames.length).toBeGreaterThan(0);
  });

  it("капит фиксированную canvas-высоту, превышающую cap", () => {
    const doc = makeDoc();
    doc.screens[0] = { ...doc.screens[0]!, canvas: { width: 800, height: 1200 } };
    renderStrip(doc);
    const article = screen.getAllByRole("article")[0]!;
    const frame = article.querySelector<HTMLElement>("div.overflow-hidden");
    expect(Number.parseFloat(frame!.style.height)).toBe(editorStripTile.heightCap);
  });

  it("сворачивается в компактные чипы и разворачивается обратно", () => {
    const onSelect = renderStrip();
    fireEvent.click(screen.getByRole("button", { name: "Свернуть" }));
    // Тайлы исчезли, чипы с именами экранов на месте.
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    const chipNext = screen.getByRole("button", { name: "Выбрать экран «Next»" });
    expect(chipNext.textContent).toBe("Next");
    expect(screen.getByRole("button", { name: "Выбрать экран «Home»" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chipNext);
    expect(onSelect).toHaveBeenCalledWith("next");
    fireEvent.click(screen.getByRole("button", { name: "Развернуть" }));
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("выбор экрана в развёрнутой ленте работает через overlay-кнопку", () => {
    const onSelect = renderStrip();
    fireEvent.click(screen.getByRole("button", { name: "Выбрать экран «Next»" }));
    expect(onSelect).toHaveBeenCalledWith("next");
  });
});
