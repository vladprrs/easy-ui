// @vitest-environment jsdom
import { JSONUIProvider } from "@json-render/react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useEffect, type ReactNode } from "react";
import type { PrototypeDoc } from "../prototype/schema";
import { toRuntimeSpec } from "../prototype/runtimeSpec";
import { createPlayerRuntime } from "../catalog/runtime";
import { EasyUiActionRuntime } from "./actionRuntime";
import { ScreenSurface } from "./ScreenSurface";
import { DeviceFrame, type StageZoom } from "./DeviceFrame";
import { useScreenRegions, type ScreenRegionsContract } from "./ScreenRegions";

const noopDeps = { navigate() {}, back() {}, openUrl() {}, restart() {} };
const fitZoom: StageZoom = { mode: "fit", zoom: 1 };

const probe: { regions: ScreenRegionsContract | null } = { regions: null };
function RegionsProbe() {
  const regions = useScreenRegions();
  useEffect(() => { probe.regions = regions; }, [regions]);
  return null;
}

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

const canvasSpec: PrototypeDoc["screens"][number]["spec"] = {
  root: "body",
  elements: { body: { type: "Text", props: { text: "Canvas body" } } },
};

function renderFrame({
  device,
  canvas,
  statusBarHidden = false,
  spec = regionSpec(),
  child,
}: {
  device: PrototypeDoc["device"];
  canvas?: { width: number; height: number };
  statusBarHidden?: boolean;
  spec?: PrototypeDoc["screens"][number]["spec"];
  child?: ReactNode;
}) {
  probe.regions = null;
  const runtime = createPlayerRuntime(noopDeps);
  const actionRuntime = new EasyUiActionRuntime({ initialState: {}, screenIds: new Set(["screen"]), deps: noopDeps });
  const tree = toRuntimeSpec(spec);
  const surface = child ?? <ScreenSurface registry={runtime.registry} runtime={actionRuntime} customDefinitions={{}} onError={() => {}} tree={tree} canvas={canvas} misclickHighlights={false} />;
  return render(<JSONUIProvider registry={runtime.registry} handlers={runtime.handlers} store={actionRuntime.store}>
    <DeviceFrame device={device} canvas={canvas} zoom={fitZoom} designSystem="shadcn" statusBarHidden={statusBarHidden} scrollResetKey="screen">
      {surface}
    </DeviceFrame>
  </JSONUIProvider>);
}

describe("DeviceFrame fixed viewport", () => {
  it("keeps a mobile no-canvas frame at 390×844 with the RegionStage slots inside a player-stage scroller", () => {
    const { container } = renderFrame({ device: "mobile" });
    const stage = container.querySelector<HTMLElement>("[data-eui-stage-viewport='player']")!;
    expect(stage.style.width).toBe("390px");
    expect(stage.style.height).toBe("844px");
    // Внутренняя сцена регионов вместо прямого HostStageSurface.
    const scroller = container.querySelector<HTMLElement>("[data-eui-content-scroller='player-stage']")!;
    expect(stage.contains(scroller)).toBe(true);
    for (const kind of ["statusBar", "header", "footer"] as const) {
      const slot = container.querySelector<HTMLElement>(`[data-eui-region='${kind}']`)!;
      expect(scroller.contains(slot)).toBe(false);
    }
    expect(container.querySelector("[data-eui-region='statusBar']")!.contains(screen.getByText("OS status"))).toBe(true);
    expect(container.querySelector("[data-eui-region='header']")!.contains(screen.getByText("Pinned header"))).toBe(true);
    expect(container.querySelector("[data-eui-region='footer']")!.contains(screen.getByText("Pinned footer"))).toBe(true);
    expect(scroller.contains(screen.getByText("Scrollable body"))).toBe(true);
  });

  it("carries the surface spacing scope on the transform wrapper", () => {
    const { container } = renderFrame({ device: "mobile" });
    const stage = container.querySelector<HTMLElement>("[data-eui-stage-viewport='player']")!;
    expect(stage.style.getPropertyValue("--eui-space-md")).toBe("12px");
  });

  it("caps a taller-than-canonical canvas frame to 390×844 and scrolls the natural canvas in player-canvas", () => {
    const { container } = renderFrame({ device: "mobile", canvas: { width: 390, height: 1722 }, spec: canvasSpec });
    const stage = container.querySelector<HTMLElement>("[data-eui-stage-viewport='player']")!;
    expect(stage.style.width).toBe("390px");
    expect(stage.style.height).toBe("844px");
    const scroller = container.querySelector<HTMLElement>("[data-eui-content-scroller='player-canvas']")!;
    expect(container.querySelector("[data-eui-content-scroller='player-stage']")).toBeNull();
    const canvasDiv = scroller.firstElementChild as HTMLElement;
    expect(canvasDiv.style.width).toBe("390px");
    expect(canvasDiv.style.height).toBe("1722px");
    expect(scroller.style.scrollbarGutter).toBe("stable");
    expect(scroller.contains(screen.getByText("Canvas body"))).toBe(true);
  });

  it("keeps a shorter-than-canonical canvas frame at 390×844", () => {
    const { container } = renderFrame({ device: "mobile", canvas: { width: 390, height: 600 }, spec: canvasSpec });
    const stage = container.querySelector<HTMLElement>("[data-eui-stage-viewport='player']")!;
    expect(stage.style.width).toBe("390px");
    expect(stage.style.height).toBe("844px");
    const canvasDiv = container.querySelector<HTMLElement>("[data-eui-content-scroller='player-canvas']")!.firstElementChild as HTMLElement;
    expect(canvasDiv.style.height).toBe("600px");
  });

  it("uses a canonical 834×1112 frame for tablet with the same region slots", () => {
    const { container } = renderFrame({ device: "tablet" });
    const stage = container.querySelector<HTMLElement>("[data-eui-stage-viewport='player']")!;
    expect(stage.style.width).toBe("834px");
    expect(stage.style.height).toBe("1112px");
    expect(container.querySelector("[data-eui-content-scroller='player-stage']")).not.toBeNull();
    for (const kind of ["statusBar", "header", "footer"] as const) {
      expect(container.querySelector(`[data-eui-region='${kind}']`)).not.toBeNull();
    }
  });

  it("extracts the statusBar when the toggle is off and drops it when on", () => {
    const shown = renderFrame({ device: "mobile", statusBarHidden: false });
    expect(shown.container.querySelector("[data-eui-region='statusBar']")!.contains(screen.getByText("OS status"))).toBe(true);
    shown.unmount();

    const hidden = renderFrame({ device: "mobile", statusBarHidden: true });
    expect(screen.queryByText("OS status")).toBeNull();
    const slot = hidden.container.querySelector<HTMLElement>("[data-eui-region='statusBar']")!;
    expect(slot.childElementCount).toBe(0);
    // header/footer по-прежнему извлечены.
    expect(hidden.container.querySelector("[data-eui-region='header']")!.contains(screen.getByText("Pinned header"))).toBe(true);
    expect(hidden.container.querySelector("[data-eui-region='footer']")!.contains(screen.getByText("Pinned footer"))).toBe(true);
  });
});

describe("DeviceFrame desktop fluid branch", () => {
  it("renders the fluid card without a framed stage viewport", () => {
    const { container } = renderFrame({ device: "desktop", child: <RegionsProbe /> });
    expect(container.querySelector("[data-eui-stage-viewport='player']")).toBeNull();
    expect(container.querySelector("[data-eui-content-scroller='player-stage']")).toBeNull();
    expect(container.querySelector(".rounded-3xl")).not.toBeNull();
  });

  it("keeps the status-bar toggle meaningful via a minimal inline region provider", () => {
    renderFrame({ device: "desktop", statusBarHidden: false, child: <RegionsProbe /> });
    expect(probe.regions?.disposition).toEqual({ statusBar: "inline", header: "inline", footer: "inline" });
    expect(probe.regions?.targets).toEqual({});

    renderFrame({ device: "desktop", statusBarHidden: true, child: <RegionsProbe /> });
    expect(probe.regions?.disposition.statusBar).toBe("drop");
    expect(probe.regions?.disposition.header).toBe("inline");
    expect(probe.regions?.disposition.footer).toBe("inline");
  });
});
