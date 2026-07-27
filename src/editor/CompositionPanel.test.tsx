import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import compositionRaw from "../../test/fixtures/architecture/ctyp-payment-success.composition.json";
import screenRaw from "../../test/fixtures/architecture/composition-screen.json";
import { compositionDocSchema } from "../prototype/composition";
import { prototypeDocSchema } from "../prototype/schema";
import { createEditorState } from "./editorReducer";
import { InspectorPanel } from "./InspectorPanel";

beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); });

const composition = compositionDocSchema.parse(compositionRaw);
const doc = prototypeDocSchema.parse(screenRaw);
const compositions = { "ctyp-payment-success": composition };
const pins = [{ id: "ctyp-payment-success", name: composition.name, version: 3, sourceHash: "hash", doc: composition }];

function renderPanel(elementKey: string | null = "screen") {
  const dispatch = vi.fn();
  const state = { ...createEditorState({ doc, rev: 1 }), selection: { screenId: "success", elementKey } };
  render(<InspectorPanel state={state} definitions={{}} dispatch={dispatch} compositions={compositions} compositionPins={pins} />);
  return dispatch;
}

describe("CompositionPanel (волна 5)", () => {
  it("shows the pinned composition and its slot map for the selected reference", () => {
    renderPanel();
    const panel = screen.getByRole("region", { name: "Композиция" });

    expect(panel.textContent).toContain("ctyp-payment-success");
    expect(panel.textContent).toContain("CtypPaymentSuccessComposition");
    expect(panel.textContent).toContain("v3");
    // Слот, оставшийся без ребёнка, честно помечен пустым.
    expect(panel.textContent).toContain("accrual");
    expect(panel.textContent).toContain("пусто");
  });

  it("edits a composition param in the authored document", () => {
    const dispatch = renderPanel();
    const input = screen.getByRole("textbox", { name: "accrual-amount" }) as HTMLInputElement;
    expect(input.value).toBe("12 ₽");

    fireEvent.change(input, { target: { value: "99 ₽" } });
    fireEvent.blur(input);

    expect(dispatch).toHaveBeenCalledWith({
      type: "set-element-props",
      screenId: "success",
      elementKey: "screen",
      props: { composition: "ctyp-payment-success", params: { "accrual-amount": "99 ₽" } },
    });
  });

  it("clears a param when its field is emptied", () => {
    const dispatch = renderPanel();
    const input = screen.getByRole("textbox", { name: "accrual-amount" });
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.blur(input);

    expect(dispatch).toHaveBeenCalledWith({
      type: "set-element-props", screenId: "success", elementKey: "screen",
      props: { composition: "ctyp-payment-success" },
    });
  });

  it("moves a child into another slot", () => {
    const dispatch = renderPanel();
    const select = screen.getByRole("combobox", { name: "Слот элемента nav" }) as HTMLSelectElement;
    expect(select.value).toBe("nav");

    fireEvent.change(select, { target: { value: "offer" } });

    expect(dispatch).toHaveBeenCalledWith({ type: "set-element-slot", screenId: "success", elementKey: "nav", slot: "offer" });
  });

  it("disables extraction on a composition reference and enables it on a plain element", () => {
    renderPanel();
    expect(screen.getByRole("button", { name: "Извлечь композицию из экрана" }).hasAttribute("disabled")).toBe(true);
    screen.getByRole("button", { name: "Вставить композицию…" });
  });

  it("enables extraction for an authored element", () => {
    renderPanel("nav");
    expect(screen.getByRole("button", { name: "Извлечь композицию из экрана" }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByRole("region", { name: "Композиция" })).toBeNull();
  });
});
