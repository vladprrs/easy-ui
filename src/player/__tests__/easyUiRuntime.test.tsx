import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ComponentType, ReactNode } from "react";
import type { ComponentDefinition } from "../../catalog/definitions";
import type { ElementMetadata } from "../../prototype/runtimeSpec";
import { EasyUiRuntimeProvider, wrapCustomComponent, type EasyUIComponentProps } from "../easyUiRuntime";
import { EUI_KEY_PROP } from "../../prototype/runtimeSpec";

afterEach(cleanup);

// Renders a wrapped custom component with a controlled runtime context. `libraryProps.children`
// mimics json-render's element.children output (one node per child, in element.children order).
function renderWrapped({
  name,
  Component,
  definition,
  metadata,
  euiKey = "el",
  children,
}: {
  name: string;
  Component: ComponentType<EasyUIComponentProps>;
  definition: ComponentDefinition;
  metadata: Record<string, ElementMetadata>;
  euiKey?: string;
  children?: ReactNode;
}) {
  const Wrapped = wrapCustomComponent(name, Component) as ComponentType<Record<string, unknown>>;
  return render(
    <EasyUiRuntimeProvider value={{ metadata, runtime: null, definitions: { [name]: definition } }}>
      <Wrapped element={{ type: name, props: {} }} props={{ [EUI_KEY_PROP]: euiKey }} children={children} />
    </EasyUiRuntimeProvider>,
  );
}

const child = (id: string) => <span key={id} data-testid={id}>{id}</span>;

describe("wrapCustomComponent named slots", () => {
  it("distributes children into named slots and default per slotIndices", () => {
    const seen = vi.fn();
    const Panel = (p: EasyUIComponentProps) => {
      seen(Object.keys(p.slots));
      return (
        <div>
          <header data-testid="header-slot">{p.slots.header}</header>
          <ul data-testid="items-slot">{p.slots.items}</ul>
          <footer data-testid="default-slot">{p.slots.default}</footer>
        </div>
      );
    };
    const definition: ComponentDefinition = { description: "Panel", props: z.strictObject({}), slots: ["header", "items"], capabilities: { namedSlots: true } };
    const { getByTestId } = renderWrapped({
      name: "Panel",
      Component: Panel,
      definition,
      metadata: { el: { type: "Panel", slotIndices: { header: [0], items: [1, 2], default: [3] } } },
      children: [child("h"), child("a"), child("b"), child("d")],
    });
    expect(getByTestId("header-slot").textContent).toBe("h");
    expect(getByTestId("items-slot").textContent).toBe("ab");
    expect(getByTestId("default-slot").textContent).toBe("d");
    expect(seen).toHaveBeenCalledWith(["default", "header", "items"]);
  });

  it("passes children === slots.default for a named-slots component", () => {
    let captured: EasyUIComponentProps | null = null;
    const Panel = (p: EasyUIComponentProps) => { captured = p; return <div>{p.slots.default}</div>; };
    const definition: ComponentDefinition = { description: "Panel", props: z.strictObject({}), slots: ["header"], capabilities: { namedSlots: true } };
    renderWrapped({
      name: "Panel",
      Component: Panel,
      definition,
      metadata: { el: { type: "Panel", slotIndices: { header: [0], default: [1] } } },
      children: [child("h"), child("d")],
    });
    expect(captured!.children).toBe(captured!.slots.default);
  });

  it("gives a legacy component the untouched children with slots.default only", () => {
    let captured: EasyUIComponentProps | null = null;
    const Widget = (p: EasyUIComponentProps) => { captured = p; return <div>{p.children as ReactNode}</div>; };
    const definition: ComponentDefinition = { description: "Widget", props: z.strictObject({}) };
    const children = [child("a"), child("b")];
    renderWrapped({ name: "Widget", Component: Widget, definition, metadata: { el: { type: "Widget" } }, children });
    // No namedSlots capability: children flow through unchanged, slots carries only default.
    expect(captured!.children).toBe(children);
    expect(Object.keys(captured!.slots)).toEqual(["default"]);
    expect(captured!.slots.default).toBe(children);
  });
});
