import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import compositionRaw from "../../prototypes/composition-demo.json";
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
});
