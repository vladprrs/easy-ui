import { describe, expect, it } from "vitest";
import { prototypeDocSchema, type PrototypeDoc } from "../prototype/schema";
import { decodeJsonPointer, describeDocPath, diffDocs, formatDocChange, humanizeIssues } from "./docDiff";

const makeDoc = (): PrototypeDoc => prototypeDocSchema.parse({
  version: 1,
  id: "shop",
  name: "Магазин",
  description: "Демо",
  device: "mobile",
  startScreen: "cart",
  state: { items: 2, promo: null },
  screens: [
    {
      id: "cart",
      name: "Корзина",
      note: "Экран корзины",
      stateOverrides: { items: 5 },
      spec: {
        root: "layout",
        elements: {
          "layout": { type: "Stack", props: {}, children: ["cart-total", "checkout"] },
          "cart-total": { type: "Text", props: { text: "Итого: 100 ₽", size: "md" } },
          "checkout": {
            type: "Button",
            props: { label: "Оплатить" },
            on: { click: { action: "navigate", params: { to: "done" } } },
            repeat: { statePath: "/items" },
            slot: "footer",
            visible: { $state: "/items" },
          },
        },
      },
    },
    { id: "done", name: "Готово", spec: { root: "text", elements: { text: { type: "Text", props: { text: "Спасибо" } } } } },
  ],
});

const clone = (doc: PrototypeDoc): PrototypeDoc => structuredClone(doc);

const paths = (changes: ReturnType<typeof diffDocs>) => changes.map((change) => `${change.kind}:${change.segments.join(" › ")}`);

describe("diffDocs (W2-4)", () => {
  it("returns no changes for identical documents", () => {
    expect(diffDocs(makeDoc(), clone(makeDoc()))).toEqual([]);
  });

  it("makes a flows-only CAS conflict visible without a generic flows change", () => {
    const base = makeDoc();
    base.flows = [{ id: "main", name: "Покупка", steps: [{ screenId: "cart" }, { screenId: "done" }] }];
    const next = clone(base);
    next.flows![0]!.steps = [{ screenId: "cart", note: "Проверить сумму" }, { screenId: "done" }];
    expect(paths(diffDocs(base, next))).toEqual(["changed:Сценарий «Покупка» › шаги"]);
  });

  it("preserves flows through an unrelated edit and document round-trip", () => {
    const base = makeDoc();
    base.flows = [{ id: "main", name: "Покупка", steps: [{ screenId: "cart" }, { screenId: "done" }] }];
    const edited = { ...base, name: "Магазин после правки" };
    const roundTripped = prototypeDocSchema.parse(JSON.parse(JSON.stringify(edited)));
    expect(roundTripped.flows).toEqual(base.flows);
  });

  it("reports added, removed, and renamed flows", () => {
    const base = makeDoc();
    base.flows = [
      { id: "main", name: "Покупка", steps: [{ screenId: "cart" }, { screenId: "done" }] },
      { id: "old", name: "Старый", steps: [{ screenId: "cart" }] },
    ];
    const next = clone(base);
    next.flows = [
      { id: "main", name: "Новая покупка", steps: [{ screenId: "cart" }, { screenId: "done" }] },
      { id: "new", name: "Новый", steps: [{ screenId: "cart" }] },
    ];
    expect(paths(diffDocs(base, next))).toEqual([
      "renamed:Сценарий «Покупка»",
      "removed:Сценарий «Старый»",
      "added:Сценарий «Новый»",
    ]);
  });

  it("reports added and removed screens by id", () => {
    const base = makeDoc();
    const next = clone(base);
    next.screens = next.screens.filter((screen) => screen.id !== "done");
    next.screens.push({ id: "promo", name: "Промо", spec: { root: "r", elements: { r: { type: "Text", props: {} } } } });
    expect(paths(diffDocs(base, next))).toEqual([
      "removed:Экран «Готово»",
      "added:Экран «Промо»",
    ]);
  });

  it("reports a screen rename as renamed, not removed+added", () => {
    const base = makeDoc();
    const next = clone(base);
    next.screens[0]!.name = "Оформление";
    const changes = diffDocs(base, next);
    expect(changes).toEqual([{ kind: "renamed", segments: ["Экран «Корзина»"], detail: "«Корзина» → «Оформление»" }]);
  });

  it("diffs elements: added, removed, prop changes with element addresses", () => {
    const base = makeDoc();
    const next = clone(base);
    const elements = next.screens[0]!.spec.elements;
    elements["cart-total"]!.props.text = "Итого: 200 ₽";
    delete elements["cart-total"]!.props.size;
    elements["banner"] = { type: "Image", props: { src: "x" } };
    delete elements["layout"];
    const changes = paths(diffDocs(base, next));
    expect(changes).toContain("removed:Экран «Корзина» › layout");
    expect(changes).toContain("changed:Экран «Корзина» › cart-total › text");
    expect(changes).toContain("removed:Экран «Корзина» › cart-total › size");
    expect(changes).toContain("added:Экран «Корзина» › banner");
  });

  it("diffs on/repeat/region/slot/children/visible and element type", () => {
    const base = makeDoc();
    const next = clone(base);
    const checkout = next.screens[0]!.spec.elements["checkout"]!;
    checkout.type = "Link";
    checkout.on = { click: { action: "back" }, hover: { action: "toast" } };
    delete checkout.repeat;
    checkout.region = "footer";
    checkout.slot = "header";
    checkout.visible = true;
    next.screens[0]!.spec.elements["layout"]!.children = ["checkout", "cart-total"];
    const changes = paths(diffDocs(base, next));
    expect(changes).toContain("changed:Экран «Корзина» › checkout › тип");
    expect(changes).toContain("changed:Экран «Корзина» › checkout › обработчик «click»");
    expect(changes).toContain("added:Экран «Корзина» › checkout › обработчик «hover»");
    expect(changes).toContain("removed:Экран «Корзина» › checkout › повтор (repeat)");
    expect(changes).toContain("added:Экран «Корзина» › checkout › регион");
    expect(changes).toContain("changed:Экран «Корзина» › checkout › слот");
    expect(changes).toContain("changed:Экран «Корзина» › checkout › видимость");
    expect(changes).toContain("changed:Экран «Корзина» › layout › дочерние элементы");
  });

  it("diffs doc state per top-level key and screen stateOverrides/note/canvas/root", () => {
    const base = makeDoc();
    const next = clone(base);
    next.state = { items: 3, discount: 10 };
    const screen = next.screens[0]!;
    screen.stateOverrides = { items: 5, promo: true };
    screen.note = "Новая заметка";
    screen.canvas = { width: 100, height: 200 };
    screen.spec.root = "cart-total";
    const changes = paths(diffDocs(base, next));
    expect(changes).toContain("changed:Состояние › items");
    expect(changes).toContain("removed:Состояние › promo");
    expect(changes).toContain("added:Состояние › discount");
    expect(changes).toContain("added:Экран «Корзина» › состояние экрана › promo");
    expect(changes).toContain("changed:Экран «Корзина» › заметка");
    expect(changes).toContain("added:Экран «Корзина» › холст");
    expect(changes).toContain("changed:Экран «Корзина» › корневой элемент");
  });

  it("diffs document metadata with scalar details", () => {
    const base = makeDoc();
    const next = clone(base);
    next.name = "Магазин v2";
    next.device = "desktop";
    next.startScreen = "done";
    delete next.description;
    const changes = diffDocs(base, next);
    expect(paths(changes)).toEqual([
      "changed:Название",
      "removed:Описание",
      "changed:Устройство",
      "changed:Стартовый экран",
    ]);
    expect(changes[0]!.detail).toBe("«Магазин» → «Магазин v2»");
  });

  it("formats a change as a single human-readable line", () => {
    expect(formatDocChange({ kind: "changed", segments: ["Экран «Корзина»", "cart-total", "text"], detail: "«A» → «B»" }))
      .toBe("Экран «Корзина» › cart-total › text — изменено («A» → «B»)");
    expect(formatDocChange({ kind: "added", segments: ["Экран «Промо»"] })).toBe("Экран «Промо» — добавлено");
  });
});

describe("decodeJsonPointer", () => {
  it("splits segments and unescapes ~1 and ~0 in order", () => {
    expect(decodeJsonPointer("/screens/0/spec/elements/cart-total")).toEqual(["screens", "0", "spec", "elements", "cart-total"]);
    expect(decodeJsonPointer("/a~1b/c~0d/~01")).toEqual(["a/b", "c~d", "~1"]);
    expect(decodeJsonPointer("")).toEqual([]);
    expect(decodeJsonPointer("/")).toEqual([]);
  });
});

describe("describeDocPath", () => {
  const doc = makeDoc();

  it("decodes element prop paths to screen-name addresses", () => {
    expect(describeDocPath(doc, "/screens/0/spec/elements/cart-total/props/text")).toBe("Экран «Корзина» › cart-total › text");
    expect(describeDocPath(doc, ["screens", 0, "spec", "elements", "cart-total", "props", "text"])).toBe("Экран «Корзина» › cart-total › text");
  });

  it("decodes handlers, repeat, region, root, overrides and screen fields", () => {
    expect(describeDocPath(doc, "/screens/0/spec/elements/checkout/on/click")).toBe("Экран «Корзина» › checkout › обработчик «click»");
    expect(describeDocPath(doc, "/screens/0/spec/elements/checkout/repeat/statePath")).toBe("Экран «Корзина» › checkout › повтор (repeat) › statePath");
    expect(describeDocPath(doc, "/screens/0/spec/elements/checkout/region")).toBe("Экран «Корзина» › checkout › регион");
    expect(describeDocPath(doc, "/screens/0/spec/root")).toBe("Экран «Корзина» › корневой элемент");
    expect(describeDocPath(doc, "/screens/0/stateOverrides/items")).toBe("Экран «Корзина» › состояние экрана › items");
    expect(describeDocPath(doc, "/screens/1/name")).toBe("Экран «Готово» › Название");
  });

  it("decodes doc-level fields, state keys and falls back gracefully", () => {
    expect(describeDocPath(doc, "/startScreen")).toBe("Стартовый экран");
    expect(describeDocPath(doc, "/state/items")).toBe("Состояние › items");
    expect(describeDocPath(doc, "")).toBe("Документ");
    expect(describeDocPath(doc, "/screens/99/name")).toBe("screens[99] › Название");
    expect(describeDocPath(doc, "/unknown/thing")).toBe("unknown › thing");
  });
});

describe("humanizeIssues (422-форматтер)", () => {
  const doc = makeDoc();

  it("handles string pointers (validatePrototype) and array paths (zod)", () => {
    const issues = humanizeIssues(doc, [
      { path: "/screens/0/spec/elements/cart-total/props/text", message: "must be a string" },
      { path: ["screens", 0, "spec", "elements", "checkout", "on", "click"], message: "unknown action" },
      { path: ["startScreen"], message: "must reference an existing screen" },
    ]);
    expect(issues).toEqual([
      { path: "Экран «Корзина» › cart-total › text", message: "must be a string" },
      { path: "Экран «Корзина» › checkout › обработчик «click»", message: "unknown action" },
      { path: "Стартовый экран", message: "must reference an existing screen" },
    ]);
  });

  it("prefers the RFC pointer and preserves an optional warning code", () => {
    expect(humanizeIssues(doc, [{
      path: ["screens"],
      pointer: "/screens/0/spec/elements/cart-total",
      message: "layout warning",
      code: "layout/spacer-chain",
    }])).toEqual([{
      path: "Экран «Корзина» › cart-total",
      message: "layout warning",
      code: "layout/spacer-chain",
    }]);
  });

  it("survives malformed issues", () => {
    expect(humanizeIssues(doc, ["oops", { message: "no path" }, undefined])).toEqual([
      { path: "Документ", message: "oops" },
      { path: "Документ", message: "no path" },
      { path: "Документ", message: "undefined" },
    ]);
    expect(humanizeIssues(doc, undefined)).toEqual([]);
  });
});
