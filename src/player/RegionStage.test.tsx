// @vitest-environment jsdom
import { JSONUIProvider } from "@json-render/react";
import { render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import type { PrototypeDoc } from "../prototype/schema";
import { toRuntimeSpec } from "../prototype/runtimeSpec";
import { createPlayerRuntime } from "../catalog/runtime";
import { EasyUiActionRuntime } from "./actionRuntime";
import { ScreenSurface } from "./ScreenSurface";
import { RegionStage } from "./RegionStage";
import { useScreenRegions, type ScreenRegionsContract } from "./ScreenRegions";

const noopDeps = { navigate() {}, back() {}, openUrl() {}, restart() {} };

function regionSpec(): PrototypeDoc["screens"][number]["spec"] {
  return {
    root: "root",
    elements: {
      root: { type: "@eui/FlowRoot", props: {}, children: ["status", "header", "body", "footer"] },
      status: { type: "Text", props: { text: "OS status" }, region: "statusBar" },
      header: { type: "Text", props: { text: "Pinned header" }, region: "header" },
      body: { type: "Text", props: { text: "Scrollable body" } },
      footer: { type: "Text", props: { text: "Pinned footer" }, region: "footer" },
    },
  };
}

// Мутация внешней переменной в рендере запрещена (react-hooks/globals) — пишем в эффекте.
let captured: ScreenRegionsContract | null = null;
function RegionsProbe() {
  const regions = useScreenRegions();
  useEffect(() => { captured = regions; }, [regions]);
  return null;
}

function renderStage(statusBarDisposition: "extract" | "drop") {
  captured = null;
  const runtime = createPlayerRuntime(noopDeps);
  const actionRuntime = new EasyUiActionRuntime({ initialState: {}, screenIds: new Set(["screen"]), deps: noopDeps });
  const tree = toRuntimeSpec(regionSpec());
  return render(<JSONUIProvider registry={runtime.registry} handlers={runtime.handlers} store={actionRuntime.store}>
    <div className="h-dvh w-full">
      <RegionStage statusBarDisposition={statusBarDisposition} scrollResetKey="screen" surfaceName="player-stage">
        <RegionsProbe />
        <ScreenSurface registry={runtime.registry} runtime={actionRuntime} customDefinitions={{}} onError={() => {}} tree={tree} misclickHighlights={false} />
      </RegionStage>
    </div>
  </JSONUIProvider>);
}

describe("RegionStage", () => {
  it("stays height-agnostic and pins three slots with an overlay layer above the scroller", () => {
    const { container } = renderStage("extract");
    const stage = container.querySelector<HTMLElement>("[data-eui-stage-viewport='player-stage']")!;
    const scroller = container.querySelector<HTMLElement>("[data-eui-content-scroller='player-stage']")!;
    const overlayLayer = container.querySelector<HTMLElement>("[data-eui-overlay-layer='player-stage']")!;

    expect(stage.className).toContain("h-full");
    expect(stage.className).not.toContain("h-dvh");
    expect(stage.className).toContain("flex-col");
    expect(scroller.firstElementChild?.classList.contains("min-h-full")).toBe(true);
    expect(scroller.style.scrollbarGutter).toBe("stable");
    expect(overlayLayer.className).toContain("z-20");
    expect(overlayLayer.className).toContain("absolute");
    for (const kind of ["statusBar", "header", "footer"] as const) {
      const slot = container.querySelector<HTMLElement>(`[data-eui-region='${kind}']`)!;
      expect(slot.className).toContain("shrink-0");
      expect(slot.className).toContain("[&:empty]:hidden");
      expect(scroller.contains(slot)).toBe(false);
    }
  });

  it("extracts the statusBar into its slot-target when disposition is extract", () => {
    const { container } = renderStage("extract");
    const statusSlot = container.querySelector<HTMLElement>("[data-eui-region='statusBar']")!;

    expect(captured?.disposition.statusBar).toBe("extract");
    expect(captured?.targets.statusBar).toBe(statusSlot);
    expect(statusSlot.contains(screen.getByText("OS status"))).toBe(true);
    // header/footer всегда извлекаются.
    expect(container.querySelector("[data-eui-region='header']")!.contains(screen.getByText("Pinned header"))).toBe(true);
    expect(container.querySelector("[data-eui-region='footer']")!.contains(screen.getByText("Pinned footer"))).toBe(true);
  });

  it("drops the statusBar (slot stays empty and hidden) when disposition is drop", () => {
    const { container } = renderStage("drop");
    const statusSlot = container.querySelector<HTMLElement>("[data-eui-region='statusBar']")!;

    expect(captured?.disposition.statusBar).toBe("drop");
    expect(screen.queryByText("OS status")).toBeNull();
    expect(statusSlot.childElementCount).toBe(0);
    expect(statusSlot.className).toContain("[&:empty]:hidden");
    // header/footer по-прежнему пиннятся.
    expect(container.querySelector("[data-eui-region='header']")!.contains(screen.getByText("Pinned header"))).toBe(true);
  });
});
