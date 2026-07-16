import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import compositionRaw from "../../test/fixtures/composition-demo.json";
import { customDsPrototypeDoc } from "../../e2e/dev/custom-ds.fixture";
import { prototypeDocSchema } from "../prototype/schema";
import { ElementTree } from "./ElementTree";

const scrollIntoView = vi.fn();
beforeAll(() => { Element.prototype.scrollIntoView = scrollIntoView; });
beforeEach(() => { scrollIntoView.mockClear(); });

describe("ElementTree", () => {
  it("renders child depth, collapses branches, and keeps a newly selected child visible", async () => {
    const onSelect = vi.fn();
    const spec = { root: "root", elements: {
      root: { type: "Stack", props: {}, children: ["card"] },
      card: { type: "Card", props: {}, children: ["child"] },
      child: { type: "Button", props: {} },
    } };
    const { rerender } = render(<ElementTree selectedKey={null} onSelect={onSelect} spec={spec} />);

    expect(screen.getByRole("button", { name: "Card · card" }).closest("li")?.style.paddingLeft).toBe("16px");
    expect(screen.getByRole("button", { name: "Button · child" }).closest("li")?.style.paddingLeft).toBe("32px");
    const cardToggle = screen.getByRole("button", { name: "Свернуть Card" });
    expect(cardToggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(cardToggle);
    expect(screen.queryByRole("button", { name: "Button · child" })).toBeNull();
    expect(screen.getByRole("button", { name: "Развернуть Card" }).getAttribute("aria-expanded")).toBe("false");

    rerender(<ElementTree selectedKey="child" onSelect={onSelect} spec={spec} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Button · child" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Button · child" }).getAttribute("aria-current")).toBe("true");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("walks children from the root and puts unreachable elements in a collapsed group", () => {
    const onSelect = vi.fn();
    const { container } = render(<ElementTree selectedKey="child" onSelect={onSelect} spec={{ root: "root", elements: {
      child: { type: "Text", props: {} }, orphan: { type: "Button", props: {} }, root: { type: "Stack", props: {}, children: ["child"] },
    } }} />);
    expect(within(container).getByRole("button", { name: "Stack · root" })).toBeTruthy();
    expect(within(container).getByRole("button", { name: "Text · child" })).toBeTruthy();
    expect(within(container).getByRole("button", { name: "Button · orphan" })).toBeTruthy();
    expect(screen.getByText("Вне дерева (1)").closest("details")?.hasAttribute("open")).toBe(false);
    expect(screen.getByRole("button", { name: "Text · child" }).getAttribute("aria-current")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Button · orphan" }));
    expect(onSelect).toHaveBeenCalledWith("orphan");
  });

  it("terminates on cycles and lists every reachable element once", () => {
    render(<ElementTree selectedKey={null} onSelect={() => {}} spec={{ root: "a", elements: {
      a: { type: "A", props: {}, children: ["b"] }, b: { type: "B", props: {}, children: ["a"] },
    } }} />);
    expect(screen.getAllByRole("button", { name: / · / }).map((button) => button.textContent)).toEqual(["A · a", "B · b"]);
    expect(screen.queryByText(/Вне дерева/)).toBeNull();
  });

  it("renders the real composition hierarchy and custom-DS element types without crashing", () => {
    const composition = prototypeDocSchema.parse(compositionRaw);
    const custom = prototypeDocSchema.parse(customDsPrototypeDoc);
    const { rerender } = render(<ElementTree selectedKey="row-title" onSelect={() => {}} spec={composition.screens[0]!.spec} />);
    expect(screen.getByRole("button", { name: "Stack · row" }).closest("li")?.style.paddingLeft).toBe("32px");
    expect(screen.getByRole("button", { name: "Text · row-title" }).closest("li")?.style.paddingLeft).toBe("48px");

    rerender(<ElementTree selectedKey="stars" onSelect={() => {}} spec={custom.screens[0]!.spec} />);
    expect(screen.getByRole("button", { name: "E2eRatingStars · stars" })).toBeTruthy();
  });

  it("shows an empty state", () => {
    render(<ElementTree selectedKey={null} onSelect={() => {}} spec={{ root: "missing", elements: {} }} />);
    expect(screen.getByText("На экране пока нет элементов.")).toBeTruthy();
  });
});
