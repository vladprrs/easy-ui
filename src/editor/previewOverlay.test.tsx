import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlayerRuntime } from "../catalog/runtime";
import type { ThemeContent } from "../api/client";
import type { PrototypeDoc } from "../prototype/schema";
import { editorStripTile } from "../designSystems/deviceMetrics";
import { EditorCanvas } from "./EditorCanvas";
import { EditorScreenStrip } from "./EditorScreenStrip";

const theme: ThemeContent = { tokens: { "space.md": "20px", "space.lg": "24px", "space.xl": "32px", "space.2xl": "40px" }, fonts: [], icons: [] };
const doc: PrototypeDoc = {
  version: 1,
  id: "editor-overlay",
  name: "Editor Overlay",
  designSystem: "shadcn",
  device: "mobile",
  startScreen: "home",
  state: {},
  screens: [{
    id: "home",
    name: "Home",
    canvas: { width: 390, height: 400 },
    spec: {
      root: "root",
      elements: {
        root: { type: "Stack", props: {}, children: ["copy", "overlay"] },
        copy: { type: "Text", props: { text: "Body" } },
        overlay: { type: "Overlay", props: { placement: "bottom", inset: "md", scrim: false }, children: ["overlay-copy"] },
        "overlay-copy": { type: "Text", props: { text: "Pinned action" } },
      },
    },
  }],
};
const runtime = createPlayerRuntime({ navigate() {}, back() {}, openUrl() {}, restart() {} }, undefined, doc.designSystem);

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("editor Overlay previews", () => {
  it("portals Overlay into the native editor StageViewport before the scale transform", async () => {
    class ResizeObserverMock {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() { this.callback([{ contentRect: DOMRect.fromRect({ width: 195 }) } as ResizeObserverEntry], this as unknown as ResizeObserver); }
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    render(<EditorCanvas doc={doc} screen={doc.screens[0]!} registry={runtime.registry} handlers={runtime.handlers} runtimeKey="runtime" stateEpoch={0} selectedKey={null} onSelect={() => {}} themeContent={theme} />);
    const stage = document.querySelector<HTMLElement>("[data-eui-stage-viewport='editor']")!;
    await waitFor(() => expect(stage.querySelector("[data-eui-host-primitive='Overlay']")).not.toBeNull());
    expect(stage.style.transform).toBe("scale(0.5)");
    expect(stage.style.getPropertyValue("--eui-space-md")).toBe("20px");
    expect(stage.hasAttribute("inert")).toBe(true);
    expect(stage.querySelector<HTMLElement>("[data-eui-overlay-content]")!.style.bottom).toBe("var(--eui-space-md, 12px)");
  });

  it("keeps Overlay inside the inert, height-capped screen-strip tile", async () => {
    render(<EditorScreenStrip doc={doc} registry={runtime.registry} handlers={runtime.handlers} runtimeKey="runtime" stateEpoch={0} selectedScreenId="home" onSelect={() => {}} themeContent={theme} />);
    const stage = document.querySelector<HTMLElement>("[data-eui-stage-viewport='editor-strip']")!;
    await waitFor(() => expect(stage.querySelector("[data-eui-host-primitive='Overlay']")).not.toBeNull());
    expect(stage.closest("[inert]")).not.toBeNull();
    expect(stage.style.getPropertyValue("--eui-space-md")).toBe("20px");
    const frame = screen.getByRole("article").querySelector<HTMLElement>("div.overflow-hidden")!;
    expect(Number.parseFloat(frame.style.height)).toBe(editorStripTile.heightCap);
  });
});
