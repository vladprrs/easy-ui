import { JSONUIProvider, Renderer } from "@json-render/react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { EasyUIComponentProps } from "../player/easyUiRuntime";
import { EasyUiRuntimeProvider } from "../player/easyUiRuntime";
import { toRuntimeSpec } from "../prototype/runtimeSpec";
import type { PrototypeDoc } from "../prototype/schema";
import { createPlayerRuntime, EUI_KEY_ATTRIBUTE, type CustomPlayerRuntime } from "./runtime";

const noopDeps = { navigate() {}, back() {}, openUrl() {}, restart() {} };

describe("createPlayerRuntime element markers", () => {
  it("renders stable DOM markers for builtin and custom elements", () => {
    const definition = { description: "Custom action", props: z.strictObject({ label: z.string() }) };
    const CustomAction = ({ props }: EasyUIComponentProps<{ label: string }>) => <button type="button">{props.label}</button>;
    const runtime = createPlayerRuntime(noopDeps, {
      definitions: { CustomAction: definition },
      components: { CustomAction: CustomAction as CustomPlayerRuntime["components"][string] },
    });
    const authored = {
      root: "stack",
      elements: {
        stack: { type: "Stack", props: {}, children: ["builtin", "custom"] },
        builtin: { type: "Button", props: { label: "Builtin" }, on: { press: { action: "restart" } } },
        custom: { type: "CustomAction", props: { label: "Custom" }, on: { press: { action: "restart" } } },
      },
    } as PrototypeDoc["screens"][number]["spec"];
    const tree = toRuntimeSpec(authored, { customTypes: new Set(["CustomAction"]) });

    const { container } = render(
      <JSONUIProvider registry={runtime.registry} handlers={runtime.handlers} initialState={{}}>
        <EasyUiRuntimeProvider value={{ metadata: tree.metadata, runtime: null, definitions: { CustomAction: definition } }}>
          <Renderer registry={runtime.registry} spec={tree.spec} />
        </EasyUiRuntimeProvider>
      </JSONUIProvider>,
    );

    const builtinMarker = screen.getByRole("button", { name: "Builtin" }).closest(`[${EUI_KEY_ATTRIBUTE}="builtin"]`);
    const customMarker = screen.getByRole("button", { name: "Custom" }).closest(`[${EUI_KEY_ATTRIBUTE}="custom"]`);
    expect(builtinMarker).not.toBeNull();
    expect(customMarker).not.toBeNull();
    expect((builtinMarker as HTMLElement).style.display).toBe("contents");
    expect(container.querySelectorAll(`[${EUI_KEY_ATTRIBUTE}]`)).toHaveLength(3);
  });
});
