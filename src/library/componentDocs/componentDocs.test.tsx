// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EventsSection, MetaSection, PropsTable, SlotsSection, SourceView } from ".";
import { RAW_JSON_MAX_CHARS } from "./RawJson";

const objectSchema = (properties: Record<string, unknown>, required?: string[]) => ({
  type: "object",
  properties,
  ...(required ? { required } : {}),
});

describe("PropsTable", () => {
  it("renders enum, default, required state and accessible table semantics", () => {
    const { container } = render(<PropsTable schema={objectSchema({
      tone: { type: "string", enum: ["neutral", "danger"], default: "neutral" },
    }, ["tone"])} />);

    const table = screen.getByRole("table", { name: "Props компонента" });
    const row = within(table).getByRole("row", { name: /tone/ });
    expect(row.textContent).toContain("string");
    expect(row.textContent).toContain("Да");
    expect(row.textContent).toContain('"neutral"');
    expect(row.textContent).toContain('enum: "neutral", "danger"');
    expect(table.querySelector('th[scope="col"]')).toBeTruthy();
    expect(row.querySelector('th[scope="row"]')).toBeTruthy();
    expect(container.querySelector(".overflow-x-auto > table")).toBe(table);
  });

  it("renders an optional prop and its description", () => {
    render(<PropsTable schema={objectSchema({ label: { type: "string", description: "Подпись кнопки", minLength: 2 } })} />);
    const row = screen.getByRole("row", { name: /label/ });
    expect(row.textContent).toContain("Нет");
    expect(row.textContent).toContain("Подпись кнопки");
    expect(row.textContent).toContain("минимальная длина: 2");
  });

  it.each([
    ["вложенный object", { type: "object", properties: { title: { type: "string" } } }],
    ["anyOf nullable union", { anyOf: [{ type: "string" }, { type: "null" }] }],
    ["oneOf", { oneOf: [{ type: "string" }, { type: "number" }] }],
    ["$ref", { $ref: "#/$defs/label" }],
    ["нет type", { description: "тип потерян" }],
    ["boolean schema", false],
    ["tuple", { type: "array", items: [{ type: "string" }, { type: "number" }] }],
  ])("falls back to raw JSON for %s", (_name, fieldSchema) => {
    render(<PropsTable schema={objectSchema({ complex: fieldSchema })} />);
    const row = screen.getByRole("row", { name: /complex/ });
    expect(row.textContent).toContain("Формат схемы не поддерживается");
    expect(within(row).getByText("Показать исходную схему")).toBeTruthy();
  });

  it("falls back for a root schema with $defs", () => {
    render(<PropsTable schema={{ ...objectSchema({ label: { type: "string" } }), $defs: { label: { type: "string" } } }} />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("Формат схемы не поддерживается")).toBeTruthy();
    expect(screen.getByText(/\$defs/)).toBeTruthy();
  });

  it("renders arrays with primitive items", () => {
    render(<PropsTable schema={objectSchema({ tags: {
      type: "array", items: { type: "string", enum: ["new", "sale"] }, minItems: 1, uniqueItems: true,
    } })} />);
    const row = screen.getByRole("row", { name: /tags/ });
    expect(row.textContent).toContain("array<string>");
    expect(row.textContent).toContain("минимум элементов: 1");
    expect(row.textContent).toContain('элементы — enum: "new", "sale"');
  });

  it("shows a dedicated unavailable state when there is no schema", () => {
    render(<PropsTable />);
    expect(screen.getByText("Схема props недоступна.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("caps raw JSON depth", () => {
    let nested: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 12; index += 1) nested = { nested };
    render(<PropsTable schema={objectSchema({ deep: { type: "object", properties: nested } })} />);
    expect(screen.getByText(/Достигнут лимит глубины/)).toBeTruthy();
  });

  it("caps raw JSON size", () => {
    render(<PropsTable schema={objectSchema({ huge: { type: "object", payload: "x".repeat(RAW_JSON_MAX_CHARS + 100) } })} />);
    expect(screen.getByText(/JSON сокращён из-за ограничения размера/)).toBeTruthy();
  });
});

describe("documentation sections", () => {
  it("renders events, payloads and slots as accessible, scrollable tables", () => {
    const { container } = render(<>
      <EventsSection events={["press", "change"]} eventPayloads={{ change: { type: "number" } }} />
      <SlotsSection slots={["header", "items"]} />
    </>);
    const eventTable = screen.getByRole("table", { name: "События компонента" });
    expect(within(eventTable).getByRole("row", { name: /press/ }).textContent).toContain("Без payload");
    expect(within(eventTable).getByRole("row", { name: /change/ }).textContent).toContain('"type": "number"');
    expect(screen.getByRole("table", { name: "Слоты компонента" })).toBeTruthy();
    expect(container.querySelectorAll(".overflow-x-auto > table")).toHaveLength(2);
  });

  it("does not crash for a legacy definition_meta row", () => {
    const legacy: {
      description: string;
      events: string[];
      slots: string[];
      propsJsonSchema?: unknown;
    } = { description: "Старый компонент", events: ["press"], slots: [] };
    render(<>
      <PropsTable schema={legacy.propsJsonSchema} />
      <EventsSection events={legacy.events} />
      <SlotsSection slots={legacy.slots} />
      <MetaSection meta={legacy} />
    </>);
    expect(screen.getByText("Схема props недоступна.")).toBeTruthy();
    expect(screen.getByText("Старый компонент")).toBeTruthy();
    expect(screen.getAllByText("Не объявлены")).toHaveLength(2);
    expect(screen.getByText("Слоты не объявлены.")).toBeTruthy();
  });

  it("renders capabilities and legacy plus named examples", () => {
    render(<MetaSection meta={{
      description: "Карточка", atomicLevel: "molecule", layoutNeutral: true,
      capabilities: { typedEvents: true, namedSlots: true },
      example: { tone: "default" }, examples: { compact: { tone: "small" } },
    }} />);
    expect(screen.getByText("Типизированные события, Именованные слоты")).toBeTruthy();
    expect(screen.getByText("default")).toBeTruthy();
    expect(screen.getByText("compact")).toBeTruthy();
  });
});

describe("XSS-safe text rendering", () => {
  it("renders source and metadata fixtures as text without creating executable markup", () => {
    const attack = '<script>globalThis.pwned=true</script><img src=x onerror="globalThis.pwned=true">';
    const { container } = render(<>
      <SourceView source={attack} />
      <PropsTable schema={objectSchema({ [attack]: { type: "string", description: attack, default: attack } })} />
      <EventsSection events={[attack]} eventPayloads={{ [attack]: { const: attack } }} />
      <SlotsSection slots={[attack]} />
      <MetaSection meta={{ description: attack, examples: { [attack]: { value: attack } } }} />
    </>);

    expect(screen.getAllByText(attack).length).toBeGreaterThan(0);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });
});
