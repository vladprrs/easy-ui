import { createRef } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createPlayerRuntime } from "../runtime";
import { HostStageSurface } from "./HostStageSurface";
import { Overlay } from "./Overlay";
import { overlayPlacements, type OverlayProps } from "./overlay.definition";
import type { SpaceToken } from "../../designSystems/types";
import { COMPOSITION_TYPE, extractionPrimitiveNames, FLOW_ROOT_TYPE, hostContentTypeNames, hostPrimitiveDefinitions, hostPrimitiveNames, SLOT_TYPE } from ".";

const noopDeps = { navigate() {}, back() {}, openUrl() {}, restart() {} };
const eventHandle = () => ({ shouldPreventDefault: false, emit() {} });

describe("Overlay host primitive", () => {
  it("is merged into provider-backed and custom-only runtime registries", () => {
    expect(extractionPrimitiveNames).toEqual(new Set(["Overlay"]));
    expect(hostContentTypeNames).toEqual(new Set(["Image", "Hotspot"]));
    // Волна 5 добавила композиционные примитивы: они раскрываются до рендера, но имена зарезервированы.
    expect(hostPrimitiveNames).toEqual(new Set(["Overlay", "Image", "Hotspot", COMPOSITION_TYPE, SLOT_TYPE, FLOW_ROOT_TYPE]));
    expect(hostPrimitiveDefinitions.Overlay).toMatchObject({ slots: ["default"], atomicLevel: "atom", layoutNeutral: true });
    expect(hostPrimitiveDefinitions.Overlay.props.parse({ placement: "top" })).toEqual({ placement: "top", inset: "md", scrim: false, scroll: false });
    expect(createPlayerRuntime(noopDeps, undefined, "shadcn").registry.Overlay).toBeDefined();
    expect(createPlayerRuntime(noopDeps, undefined, "yandex-pay").registry.Overlay).toBeDefined();
  });

  it("portals into StageViewport with stretch, fallback spacing and scrim hit-testing", () => {
    const host = document.createElement("section");
    document.body.append(host);
    const stageHostRef = createRef<HTMLElement>();
    stageHostRef.current = host;
    const view = render(
      <HostStageSurface stageHostRef={stageHostRef}>
        <Overlay props={{ placement: "top", inset: "md", scrim: true, scroll: false }} emit={() => {}} on={eventHandle as never}>
          <button type="button">Action</button>
        </Overlay>
      </HostStageSurface>,
    );
    expect(view.container.childElementCount).toBe(0);
    const wrapper = host.querySelector<HTMLElement>("[data-eui-host-primitive='Overlay']")!;
    const scrim = host.querySelector<HTMLElement>("[data-eui-overlay-scrim]")!;
    const content = host.querySelector<HTMLElement>("[data-eui-overlay-content]")!;
    expect(wrapper.style.pointerEvents).toBe("none");
    expect(scrim.getAttribute("aria-hidden")).toBe("true");
    expect(scrim.style.pointerEvents).toBe("auto");
    expect(content.style.pointerEvents).toBe("auto");
    expect(content.style.left).toBe("var(--eui-space-md, 12px)");
    expect(content.style.right).toBe("var(--eui-space-md, 12px)");
    view.unmount();
    host.remove();
  });

  it("uses shrink-to-fit placement and preserves document stacking order", () => {
    const host = document.createElement("section");
    document.body.append(host);
    const stageHostRef = createRef<HTMLElement>();
    stageHostRef.current = host;
    const view = render(<HostStageSurface stageHostRef={stageHostRef}>
      <Overlay props={{ placement: "center", inset: "sm", scrim: false, scroll: false }} emit={() => {}} on={eventHandle as never}>First</Overlay>
      <Overlay props={{ placement: "bottom-right", inset: "lg", scrim: false, scroll: false }} emit={() => {}} on={eventHandle as never}>Second</Overlay>
    </HostStageSurface>);
    const overlays = host.querySelectorAll<HTMLElement>("[data-eui-host-primitive='Overlay']");
    expect(overlays).toHaveLength(2);
    expect(overlays[0]!.textContent).toBe("First");
    expect(overlays[1]!.textContent).toBe("Second");
    expect(overlays[0]!.querySelector<HTMLElement>("[data-eui-overlay-content]")!.style.width).toBe("max-content");
    expect(host.querySelector("[data-eui-overlay-scrim]")).toBeNull();
    view.unmount();
    host.remove();
  });

  // --- W5 T5a (план 2026-08-06): высотный инвариант и владение прокруткой --------------------

  const renderOverlay = (props: { placement: OverlayProps["placement"]; inset?: SpaceToken; scroll?: boolean }) => {
    const host = document.createElement("section");
    document.body.append(host);
    const stageHostRef = createRef<HTMLElement>();
    stageHostRef.current = host;
    const view = render(
      <HostStageSurface stageHostRef={stageHostRef}>
        <Overlay props={{ placement: props.placement, inset: props.inset ?? "md", scrim: false, scroll: props.scroll ?? false }} emit={() => {}} on={eventHandle as never}>
          <p>Sheet</p>
        </Overlay>
      </HostStageSurface>,
    );
    const content = host.querySelector<HTMLElement>("[data-eui-overlay-content]")!;
    return { content, dispose: () => { view.unmount(); host.remove(); } };
  };

  it("каждое из семи placement ограничено высотой сцены минус вертикальные insets", () => {
    // Строка 10 фидбэка: до волны контент выше вьюпорта вытекал за сцену, и приёмка мерила ленту.
    for (const placement of overlayPlacements) {
      const { content, dispose } = renderOverlay({ placement, inset: "lg" });
      try {
        expect(content.style.maxHeight, placement).toBe("calc(100% - var(--eui-space-lg, 16px) - var(--eui-space-lg, 16px))");
      } finally { dispose(); }
    }
  });

  it("scroll:true отдаёт прокрутку контенту оверлея, scroll:false клипает его", () => {
    const scrolling = renderOverlay({ placement: "bottom", scroll: true });
    try {
      expect(scrolling.content.style.overflowY).toBe("auto");
      expect(scrolling.content.style.overscrollBehavior).toBe("contain");
      expect(scrolling.content.style.overflow).toBe("");
    } finally { scrolling.dispose(); }
    const clipping = renderOverlay({ placement: "bottom", scroll: false });
    try {
      expect(clipping.content.style.overflow).toBe("hidden");
      expect(clipping.content.style.overscrollBehavior).toBe("");
    } finally { clipping.dispose(); }
  });

  it("data-eui-overlay-content — стабильный контракт измерения на каждом placement", () => {
    // По этому атрибуту geometry-сбор находит layout-корень оверлея (§W5 T5c.3): его пропажа
    // превратила бы измерение модалки в измерение пустой сцены — молча, без единого отказа.
    for (const placement of overlayPlacements) {
      const { content, dispose } = renderOverlay({ placement });
      try {
        expect(content.getAttribute("data-eui-overlay-content"), placement).toBe("");
        expect(content.parentElement?.getAttribute("data-eui-host-primitive")).toBe("Overlay");
      } finally { dispose(); }
    }
  });
});
