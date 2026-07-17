import { JSONUIProvider, Renderer } from "@json-render/react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createPlayerRuntime } from "../runtime";
import { toRuntimeSpec } from "../../prototype/runtimeSpec";
import type { PrototypeDoc } from "../../prototype/schema";
import { FLOW_ROOT_TYPE, flowRootDefinition, hostPrimitiveDefinitions } from ".";

const noopDeps = { navigate() {}, back() {}, openUrl() {}, restart() {} };

describe("FlowRoot host primitive", () => {
  it("is a neutral slotted block registered under the collision-proof type", () => {
    expect(flowRootDefinition).toMatchObject({ slots: ["default"], layoutNeutral: true });
    expect(flowRootDefinition.props.parse({})).toEqual({});
    expect(hostPrimitiveDefinitions[FLOW_ROOT_TYPE]).toBe(flowRootDefinition);
    expect(createPlayerRuntime(noopDeps).registry[FLOW_ROOT_TYPE]).toBeDefined();
  });

  it("renders children without contributing layout or inherited styles", () => {
    const runtime = createPlayerRuntime(noopDeps);
    const authored = {
      root: "root",
      elements: {
        root: { type: FLOW_ROOT_TYPE, props: {}, children: ["image"] },
        image: { type: "Image", props: { src: "/theme.png", alt: "Inherited child" } },
      },
    } as PrototypeDoc["screens"][number]["spec"];
    const tree = toRuntimeSpec(authored);
    const { container } = render(<div style={{ color: "rgb(1, 2, 3)", fontFamily: "serif" }}>
      <JSONUIProvider registry={runtime.registry} handlers={runtime.handlers} initialState={{}}>
        <Renderer registry={runtime.registry} spec={tree.spec} />
      </JSONUIProvider>
    </div>);
    const root = container.querySelector<HTMLElement>("[data-eui-host-primitive='FlowRoot']")!;
    expect(root.tagName).toBe("DIV");
    expect(root.getAttribute("style")).toBeNull();
    expect(screen.getByRole("img", { name: "Inherited child" }).closest("[data-eui-host-primitive='FlowRoot']")).toBe(root);
  });
});

