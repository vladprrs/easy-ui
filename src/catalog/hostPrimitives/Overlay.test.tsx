import { createRef } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createPlayerRuntime } from "../runtime";
import { HostStageSurface } from "./HostStageSurface";
import { Overlay } from "./Overlay";
import { hostPrimitiveDefinitions, hostPrimitiveNames } from ".";

const noopDeps = { navigate() {}, back() {}, openUrl() {}, restart() {} };
const eventHandle = () => ({ shouldPreventDefault: false, emit() {} });

describe("Overlay host primitive", () => {
  it("is merged into provider-backed and custom-only runtime registries", () => {
    expect(hostPrimitiveNames).toEqual(new Set(["Overlay"]));
    expect(hostPrimitiveDefinitions.Overlay).toMatchObject({ slots: ["default"], atomicLevel: "atom", layoutNeutral: true });
    expect(hostPrimitiveDefinitions.Overlay.props.parse({ placement: "top" })).toEqual({ placement: "top", inset: "md", scrim: false });
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
        <Overlay props={{ placement: "top", inset: "md", scrim: true }} emit={() => {}} on={eventHandle as never}>
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
      <Overlay props={{ placement: "center", inset: "sm", scrim: false }} emit={() => {}} on={eventHandle as never}>First</Overlay>
      <Overlay props={{ placement: "bottom-right", inset: "lg", scrim: false }} emit={() => {}} on={eventHandle as never}>Second</Overlay>
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
});
