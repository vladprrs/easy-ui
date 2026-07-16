import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import compositionRaw from "../../test/fixtures/composition-demo.json";
import type { ComponentDefinition } from "../catalog/definitions";
import { prototypeDocSchema } from "../prototype/schema";
import { createEditorState } from "./editorReducer";
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
});
