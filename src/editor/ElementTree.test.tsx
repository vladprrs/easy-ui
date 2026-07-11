import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ElementTree } from "./ElementTree";

beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); });

describe("ElementTree", () => {
  it("walks children from the root and puts unreachable elements in a collapsed group", () => {
    const onSelect = vi.fn();
    const { container } = render(<ElementTree selectedKey="child" onSelect={onSelect} spec={{ root: "root", elements: {
      child: { type: "Text", props: {} }, orphan: { type: "Button", props: {} }, root: { type: "Stack", props: {}, children: ["child"] },
    } }} />);
    const buttons = within(container).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Stack · root", "Text · child", "Button · orphan"]);
    expect(screen.getByText("Вне дерева (1)").closest("details")?.hasAttribute("open")).toBe(false);
    expect(screen.getByRole("button", { name: "Text · child" }).getAttribute("aria-current")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Button · orphan" }));
    expect(onSelect).toHaveBeenCalledWith("orphan");
  });

  it("terminates on cycles and lists every reachable element once", () => {
    render(<ElementTree selectedKey={null} onSelect={() => {}} spec={{ root: "a", elements: {
      a: { type: "A", props: {}, children: ["b"] }, b: { type: "B", props: {}, children: ["a"] },
    } }} />);
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["A · a", "B · b"]);
    expect(screen.queryByText(/Вне дерева/)).toBeNull();
  });

  it("shows an empty state", () => {
    render(<ElementTree selectedKey={null} onSelect={() => {}} spec={{ root: "missing", elements: {} }} />);
    expect(screen.getByText("На экране пока нет элементов.")).toBeTruthy();
  });
});
