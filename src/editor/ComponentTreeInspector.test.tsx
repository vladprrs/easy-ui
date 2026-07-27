import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import compositionRaw from "../../test/fixtures/composition-demo.json";
import { customDsPrototypeDoc } from "../../e2e/dev/custom-ds.fixture";
import type { ComponentDefinition } from "../catalog/definitions";
import { prototypeDocSchema } from "../prototype/schema";
import { ComponentTreeInspector } from "./ComponentTreeInspector";

const scrollIntoView = vi.fn();
beforeAll(() => { Element.prototype.scrollIntoView = scrollIntoView; });
beforeEach(() => { scrollIntoView.mockClear(); });

describe("ComponentTreeInspector", () => {
  it("renders child depth, collapses branches, and keeps a newly selected child visible", async () => {
    const onSelect = vi.fn();
    const spec = { root: "root", elements: {
      root: { type: "Stack", props: {}, children: ["card"] },
      card: { type: "Card", props: {}, children: ["child"] },
      child: { type: "Button", props: {} },
    } };
    const { rerender } = render(<ComponentTreeInspector selectedKey={null} onSelect={onSelect} spec={spec} />);

    expect(screen.getByRole("button", { name: "Card · card" }).closest("li")?.style.paddingLeft).toBe("16px");
    expect(screen.getByRole("button", { name: "Button · child" }).closest("li")?.style.paddingLeft).toBe("32px");
    const cardToggle = screen.getByRole("button", { name: "Свернуть Card" });
    expect(cardToggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(cardToggle);
    expect(screen.queryByRole("button", { name: "Button · child" })).toBeNull();
    expect(screen.getByRole("button", { name: "Развернуть Card" }).getAttribute("aria-expanded")).toBe("false");

    rerender(<ComponentTreeInspector selectedKey="child" onSelect={onSelect} spec={spec} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Button · child" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Button · child" }).getAttribute("aria-current")).toBe("true");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("walks children from the root and puts unreachable elements in a collapsed group", () => {
    const onSelect = vi.fn();
    const { container } = render(<ComponentTreeInspector selectedKey="child" onSelect={onSelect} spec={{ root: "root", elements: {
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

  it("opens the orphan group when the selected element lives there", async () => {
    render(<ComponentTreeInspector selectedKey="orphan" onSelect={() => {}} spec={{ root: "root", elements: {
      root: { type: "Stack", props: {} }, orphan: { type: "Button", props: {} },
    } }} />);
    await waitFor(() => expect(screen.getByText("Вне дерева (1)").closest("details")?.hasAttribute("open")).toBe(true));
  });

  it("terminates on cycles and lists every reachable element once", () => {
    render(<ComponentTreeInspector selectedKey={null} onSelect={() => {}} spec={{ root: "a", elements: {
      a: { type: "A", props: {}, children: ["b"] }, b: { type: "B", props: {}, children: ["a"] },
    } }} />);
    expect(screen.getAllByRole("button", { name: / · / }).map((button) => button.textContent)).toEqual(["A · a", "B · b"]);
    expect(screen.queryByText(/Вне дерева/)).toBeNull();
  });

  it("renders the real composition hierarchy and custom-DS element types without crashing", () => {
    const composition = prototypeDocSchema.parse(compositionRaw);
    const custom = prototypeDocSchema.parse(customDsPrototypeDoc);
    const { rerender } = render(<ComponentTreeInspector selectedKey="row-title" onSelect={() => {}} spec={composition.screens[0]!.spec} />);
    expect(screen.getByRole("button", { name: "Stack · row" }).closest("li")?.style.paddingLeft).toBe("32px");
    expect(screen.getByRole("button", { name: "Text · row-title" }).closest("li")?.style.paddingLeft).toBe("48px");

    rerender(<ComponentTreeInspector selectedKey="stars" onSelect={() => {}} spec={custom.screens[0]!.spec} />);
    expect(screen.getByRole("button", { name: "E2eRatingStars · stars" })).toBeTruthy();
  });

  it("shows an empty state", () => {
    render(<ComponentTreeInspector selectedKey={null} onSelect={() => {}} spec={{ root: "missing", elements: {} }} />);
    expect(screen.getByText("На экране пока нет элементов.")).toBeTruthy();
  });

  it("shows the authored region as an element badge", () => {
    render(<ComponentTreeInspector selectedKey={null} onSelect={() => {}} spec={{ root: "root", elements: {
      root: { type: "@eui/FlowRoot", props: {}, children: ["header"] },
      header: { type: "Header", props: {}, region: "header" },
    } }} />);
    expect(screen.getByTitle("Регион: header").textContent).toBe("header");
  });

  it("badges host primitives, scope, pinned version and deprecated status", () => {
    const definitions: Record<string, ComponentDefinition> = {
      YpCard: { description: "card", props: z.object({}), atomicLevel: "molecule", scope: "section" } as ComponentDefinition,
    };
    render(<ComponentTreeInspector
      selectedKey={null}
      onSelect={() => {}}
      definitions={definitions}
      pins={[{ id: "cmp_card", name: "YpCard", version: 4, status: "deprecated" }]}
      spec={{ root: "root", elements: {
        root: { type: "@eui/FlowRoot", props: {}, children: ["card"] },
        card: { type: "YpCard", props: {} },
      } }}
    />);
    const cardRow = screen.getByRole("button", { name: "YpCard · card" }).closest("li")!;
    expect(within(cardRow).getByTitle("Scope: section").textContent).toBe("section");
    expect(within(cardRow).getByTitle("Версия компонента в пине: v4").textContent).toBe("v4");
    expect(within(cardRow).getByTitle("Статус версии: deprecated").textContent).toBe("deprecated");
    expect(within(cardRow).getByTitle("Пользовательский компонент").textContent).toBe("custom");
    const rootRow = screen.getByRole("button", { name: "@eui/FlowRoot · root" }).closest("li")!;
    expect(within(rootRow).getByTitle("Примитив host-рантайма").textContent).toBe("host");
    expect(within(rootRow).getByTitle("Определение компонента не загружено")).toBeTruthy();
  });

  it("shows props that differ from the declared default, provenance and the library link for the selected node", () => {
    const definitions: Record<string, ComponentDefinition> = {
      YpCard: { description: "card", props: z.object({ tone: z.enum(["neutral", "brand"]).default("neutral"), title: z.string().default("Заголовок") }) } as ComponentDefinition,
    };
    render(<ComponentTreeInspector
      selectedKey="card"
      onSelect={() => {}}
      definitions={definitions}
      pins={[{ id: "cmp_card", name: "YpCard", version: 2 }]}
      spec={{ root: "card", elements: { card: { type: "YpCard", props: { tone: "brand", title: "Заголовок" } } } }}
    />);
    const details = screen.getByText("Архитектура узла").closest("details")!;
    expect(details.textContent).toContain("Renderer не применяет zod-дефолты");
    expect(details.textContent).toContain("tone");
    expect(details.textContent).toContain("объявленный дефолт: neutral");
    // title равен объявленному дефолту — в diff не попадает
    expect(details.textContent).not.toContain("title");
    expect(screen.getByRole("link", { name: "Открыть в библиотеке" }).getAttribute("href")).toBe("/library/c/cmp_card?v=2");
  });

  it("marks elements carrying validation issues and lists them in the detail", () => {
    render(<ComponentTreeInspector
      selectedKey="card"
      onSelect={() => {}}
      issues={{ warnings: [{ path: "/screens/0/spec/elements/card", message: "монолитный корень экрана" }] }}
      spec={{ root: "card", elements: { card: { type: "YpCard", props: {} } } }}
    />);
    expect(screen.getByTitle("Замечаний: 1")).toBeTruthy();
    expect(screen.getByText("монолитный корень экрана")).toBeTruthy();
  });
});
