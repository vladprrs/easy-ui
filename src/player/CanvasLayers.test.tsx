import type { Spec } from "@json-render/core";
import { JSONUIProvider } from "@json-render/react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createPlayerRuntime } from "../catalog/runtime";
import { CanvasLayers } from "./CanvasLayers";

const runtime = createPlayerRuntime({ navigate() {}, back() {}, openUrl() {}, restart() {} });
const content = {
  root: "copy",
  elements: { copy: { type: "Text", props: { text: "Canvas content" } } },
} as Spec;
const hotspot = {
  root: "hotspot",
  elements: { hotspot: { type: "Hotspot", props: { x: 10, y: 20, width: 30, height: 40, ariaLabel: "Open next" } } },
} as Spec;

function renderLayers(contentSpec: Spec | null) {
  return render(
    <JSONUIProvider registry={runtime.registry} handlers={runtime.handlers} initialState={{}}>
      <CanvasLayers canvas={{ width: 640, height: 480 }} specs={{ content: contentSpec, hotspots: [hotspot] }} registry={runtime.registry} />
    </JSONUIProvider>,
  );
}

describe("CanvasLayers", () => {
  it("renders content and hotspots in stacked pointer-event layers", () => {
    const { container } = renderLayers(content);

    expect(screen.getByText("Canvas content")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open next" })).toBeTruthy();
    const root = container.firstElementChild as HTMLElement;
    expect(root.classList.contains("relative")).toBe(true);
    expect(root.style.width).toBe("640px");
    expect(root.style.height).toBe("480px");
    expect(root.children[0].className).toContain("absolute inset-0");
    expect(root.children[1].className).toContain("pointer-events-none absolute inset-0");
    expect(root.children[1].firstElementChild?.className).toContain("pointer-events-auto");
  });

  it("renders a hotspot-only root when content is null", () => {
    expect(() => renderLayers(null)).not.toThrow();
    expect(screen.getByRole("button", { name: "Open next" })).toBeTruthy();
  });
});
