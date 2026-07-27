import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ComponentDefinition } from "../../catalog/definitions";
import type { ScreenSpec } from "../../architecture/screenTree";
import { TreeTab } from "./TreeTab";

const spec: ScreenSpec = {
  root: "root",
  elements: {
    root: { type: "@eui/FlowRoot", props: {}, children: ["card"] },
    card: { type: "YpCard", props: { tone: "brand" }, children: ["text"] },
    text: { type: "YpText", props: {} },
  },
};

const definitions: Record<string, ComponentDefinition> = {
  YpCard: { description: "card", props: z.object({ tone: z.enum(["neutral", "brand"]).default("neutral") }), atomicLevel: "molecule" } as ComponentDefinition,
};

// jsdom не считает layout: подменяем rect только у маркеров прототипа.
const rects: Record<string, { left: number; top: number; width: number; height: number }> = {
  card: { left: 10, top: 20, width: 300, height: 120 },
  text: { left: 12, top: 40, width: 200, height: 24 },
};

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const key = this.getAttribute("data-eui-key");
    const rect = key === null ? undefined : rects[key];
    const box = rect ?? { left: 0, top: 0, width: 0, height: 0 };
    return { ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => ({}) } as DOMRect;
  });
});
afterEach(() => { vi.restoreAllMocks(); cleanup(); });

function renderTab() {
  return render(<div>
    <div data-eui-key="card"><span data-eui-key="text">текст</span></div>
    <TreeTab spec={spec} definitions={definitions} />
  </div>);
}

describe("TreeTab", () => {
  it("lists the screen tree with host/custom, atomic and version badges", () => {
    render(<TreeTab spec={spec} definitions={definitions} pins={[{ id: "cmp", name: "YpCard", version: 7 }]} />);
    const list = screen.getByRole("list", { name: "Дерево компонентов экрана" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.querySelector("span")!.textContent)).toEqual([
      "@eui/FlowRoot · root", "YpCard · card", "YpText · text",
    ]);
    expect(items[0]!.textContent).toContain("host");
    expect(items[1]!.textContent).toContain("custom");
    expect(items[1]!.textContent).toContain("molecule");
    expect(items[1]!.textContent).toContain("v7");
  });

  it("highlights the DOM node with the matching data-eui-key on selection and shows its rect", async () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "YpCard · card" }));

    await waitFor(() => expect(screen.getByTestId("inspector-tree-highlights")).toBeTruthy());
    const highlight = screen.getByTestId("inspector-tree-highlights").querySelector<HTMLElement>('[data-eui-highlight-key="card"]')!;
    expect(highlight.style.left).toBe("10px");
    expect(highlight.style.width).toBe("300px");
    await waitFor(() => expect(screen.getByTestId("inspector-tree-detail").textContent).toContain("300×120 px"));
    expect(screen.getByTestId("inspector-tree-detail").textContent).toContain("tone");
  });

  it("highlights on hover without changing the selection", async () => {
    renderTab();
    fireEvent.mouseEnter(screen.getByRole("button", { name: "YpText · text" }));
    await waitFor(() => expect(screen.getByTestId("inspector-tree-highlights").querySelector('[data-eui-highlight-key="text"]')).toBeTruthy());
    expect(screen.queryByTestId("inspector-tree-detail")).toBeNull();
    fireEvent.mouseLeave(screen.getByRole("button", { name: "YpText · text" }));
    await waitFor(() => expect(screen.queryByTestId("inspector-tree-highlights")).toBeNull());
  });

  it("selects the nearest enclosing [data-eui-key] on a click inside the prototype", async () => {
    renderTab();
    fireEvent.click(screen.getByText("текст"));
    await waitFor(() => expect(screen.getByRole("button", { name: "YpText · text" }).getAttribute("aria-current")).toBe("true"));
    await waitFor(() => expect(screen.getByTestId("inspector-tree-detail").textContent).toContain("200×24 px"));
  });

  it("reports an element that is not rendered on screen", async () => {
    render(<TreeTab spec={spec} definitions={definitions} />);
    fireEvent.click(screen.getByRole("button", { name: "@eui/FlowRoot · root" }));
    await waitFor(() => expect(screen.getByTestId("inspector-tree-detail").textContent).toContain("Элемент не отрисован на экране."));
  });

  it("falls back to a hint when there is no screen spec", () => {
    render(<TreeTab />);
    expect(screen.getByText("Дерево доступно только для отрисованного экрана.")).toBeTruthy();
  });
});
