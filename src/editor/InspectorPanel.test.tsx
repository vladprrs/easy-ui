import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import compositionRaw from "../../test/fixtures/composition-demo.json";
import type { ComponentDefinition } from "../catalog/definitions";
import { FLOW_ROOT_TYPE } from "../catalog/hostPrimitives/flowRoot.definition";
import { prototypeDocSchema } from "../prototype/schema";
import { createEditorState, editorReducer, type EditorAction } from "./editorReducer";
import { InspectorPanel } from "./InspectorPanel";

beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); });

describe("InspectorPanel", () => {
  it("shows the selected element ancestry and selects Card from its breadcrumb", () => {
    const doc = prototypeDocSchema.parse(compositionRaw);
    const dispatch = vi.fn();
    const state = {
      ...createEditorState({ doc, rev: 1 }),
      selection: { screenId: "done", elementKey: "restart" },
    };
    render(<InspectorPanel state={state} definitions={{}} dispatch={dispatch} />);

    const breadcrumbs = screen.getByRole("navigation", { name: "Предки элемента" });
    expect(breadcrumbs.textContent).toBe("Экран›Card›Button");
    fireEvent.click(within(breadcrumbs).getByRole("button", { name: "Card" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "select-element", elementKey: "done" });
  });

  it("shows navigate with the target screen name", () => {
    const doc = prototypeDocSchema.parse({
      version: 1, id: "events", name: "Events", device: "desktop", startScreen: "home", state: {},
      screens: [
        { id: "home", name: "Главная", spec: { root: "button", elements: { button: { type: "Button", props: {}, on: { press: { action: "navigate", params: { screenId: "cart" } } } } } } },
        { id: "cart", name: "Корзина", spec: { root: "text", elements: { text: { type: "Text", props: { text: "Cart" } } } } },
      ],
    });
    const state = { ...createEditorState({ doc, rev: 1 }), selection: { screenId: "home", elementKey: "button" } };

    render(<InspectorPanel state={state} definitions={{}} dispatch={vi.fn()} />);

    expect(screen.getByText("press → navigate(Корзина)")).not.toBeNull();
  });

  it("shows multiple authored events and actions in declaration order, including typed custom event names", () => {
    const doc = prototypeDocSchema.parse({
      version: 1, id: "custom-events", name: "Custom events", device: "desktop", startScreen: "home", state: {},
      screens: [{ id: "home", name: "Главная", spec: { root: "picker", elements: {
        picker: { type: "Picker", props: {}, on: {
          valueCommitted: [
            { action: "setState", params: { statePath: "/choice", value: "card" } },
            { action: "openUrl", params: { url: "https://example.com/receipt" } },
          ],
          dismissed: { action: "back" },
        } },
      } } }],
    });
    const definitions: Record<string, ComponentDefinition> = {
      Picker: { description: "Typed picker", props: z.object({}), events: ["valueCommitted", "dismissed"], capabilities: { typedEvents: true } },
    };
    const state = { ...createEditorState({ doc, rev: 1 }), selection: { screenId: "home", elementKey: "picker" } };

    render(<InspectorPanel state={state} definitions={definitions} dispatch={vi.fn()} />);

    const events = screen.getByRole("heading", { name: "События" }).parentElement!;
    expect(events.textContent).toContain("valueCommitted → setState(statePath: /choice, value: card), openUrl(https://example.com/receipt)");
    expect(events.textContent).toContain("dismissed → back()");
    expect(events.textContent!.indexOf("setState")).toBeLessThan(events.textContent!.indexOf("openUrl"));
  });

  it("hides the events section for an element without authored handlers", () => {
    const doc = prototypeDocSchema.parse(compositionRaw);
    const state = { ...createEditorState({ doc, rev: 1 }), selection: { screenId: "done", elementKey: "done-title" } };

    render(<InspectorPanel state={state} definitions={{}} dispatch={vi.fn()} />);

    expect(screen.queryByRole("heading", { name: "События" })).toBeNull();
    expect(screen.queryByText(/undefined|null/)).toBeNull();
  });

  it("edits regions for direct FlowRoot children and disables an occupied kind", () => {
    const doc = prototypeDocSchema.parse({
      version: 1, id: "regions", name: "Regions", device: "mobile", startScreen: "home", state: {},
      screens: [{ id: "home", name: "Home", spec: { root: "root", elements: {
        root: { type: FLOW_ROOT_TYPE, props: {}, children: ["header", "footer"] },
        header: { type: "Header", props: {} },
        footer: { type: "Footer", props: {}, region: "footer" },
      } } }],
    });
    const dispatch = vi.fn();
    const state = { ...createEditorState({ doc, rev: 1 }), selection: { screenId: "home", elementKey: "header" } };
    render(<InspectorPanel state={state} definitions={{}} dispatch={dispatch} />);

    const select = screen.getByRole("combobox", { name: "Регион" });
    expect((screen.getByRole("option", { name: "Футер" }) as HTMLOptionElement).disabled).toBe(true);
    fireEvent.change(select, { target: { value: "header" } });
    fireEvent.change(select, { target: { value: "" } });
    expect(dispatch).toHaveBeenNthCalledWith(1, { type: "set-element-region", screenId: "home", elementKey: "header", region: "header" });
    expect(dispatch).toHaveBeenNthCalledWith(2, { type: "set-element-region", screenId: "home", elementKey: "header", region: undefined });
  });

  it("disables regions with an explanation on an ineligible screen and hides them for nested elements", () => {
    const doc = prototypeDocSchema.parse({
      version: 1, id: "regions", name: "Regions", startScreen: "home", state: {},
      screens: [{ id: "home", name: "Home", spec: { root: "root", elements: {
        root: { type: "CustomRoot", props: {}, children: ["wrapper"] },
        wrapper: { type: "Stack", props: {}, children: ["nested"] },
        nested: { type: "Header", props: {} },
      } } }],
    });
    const state = { ...createEditorState({ doc, rev: 1 }), selection: { screenId: "home", elementKey: "wrapper" } };
    const { rerender } = render(<InspectorPanel state={state} definitions={{}} dispatch={vi.fn()} />);

    expect((screen.getByRole("combobox", { name: "Регион" }) as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText("Регионы доступны на экранах с корнем FlowRoot")).toBeTruthy();

    rerender(<InspectorPanel state={{ ...state, selection: { screenId: "home", elementKey: "nested" } }} definitions={{}} dispatch={vi.fn()} />);
    expect(screen.queryByRole("combobox", { name: "Регион" })).toBeNull();
  });

  it("shows a conservative suggestion and applies it only on click", () => {
    const doc = prototypeDocSchema.parse({
      version: 1, id: "regions", name: "Regions", startScreen: "home", state: {},
      screens: [{ id: "home", name: "Home", spec: { root: "root", elements: {
        root: { type: FLOW_ROOT_TYPE, props: {}, children: ["top", "content"] },
        top: { type: "AppBar", props: {} },
        content: { type: "Content", props: {} },
      } } }],
    });
    const dispatch = vi.fn();
    const state = { ...createEditorState({ doc, rev: 1 }), selection: { screenId: "home", elementKey: "top" } };
    render(<InspectorPanel state={state} definitions={{}} dispatch={dispatch} />);

    expect(screen.getByText("Предложение: Шапка")).toBeTruthy();
    expect(dispatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Применить" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "set-element-region", screenId: "home", elementKey: "top", region: "header" });
  });

  it("confirms a canvas transition and reducer-clears regions atomically", () => {
    const doc = prototypeDocSchema.parse({
      version: 1, id: "regions", name: "Regions", startScreen: "home", state: {},
      screens: [{ id: "home", name: "Home", spec: { root: "root", elements: {
        root: { type: FLOW_ROOT_TYPE, props: {}, children: ["header", "content"] },
        header: { type: "Header", props: {}, region: "header" },
        content: { type: "Content", props: {} },
      } } }],
    });
    let current = createEditorState({ doc, rev: 1 });
    const dispatch = (action: EditorAction) => { current = editorReducer(current, action); };
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<InspectorPanel state={current} definitions={{}} dispatch={dispatch} />);

    fireEvent.change(screen.getByRole("spinbutton", { name: "Ширина холста" }), { target: { value: "390" } });
    const height = screen.getByRole("spinbutton", { name: "Высота холста" });
    fireEvent.change(height, { target: { value: "844" } });
    fireEvent.blur(height);
    expect(current.doc.screens[0]!.canvas).toBeUndefined();
    expect(current.doc.screens[0]!.spec.elements.header!.region).toBe("header");

    fireEvent.blur(height);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(current.doc.screens[0]!.canvas).toEqual({ width: 390, height: 844 });
    expect(current.doc.screens[0]!.spec.elements.header).not.toHaveProperty("region");
    expect(current.past).toHaveLength(1);
    confirm.mockRestore();
  });
});
