import { describe, expect, it } from "vitest";
import compositionRaw from "../../test/fixtures/architecture/ctyp-payment-success.composition.json";
import screenRaw from "../../test/fixtures/architecture/composition-screen.json";
import { COMPOSITION_TYPE, SLOT_TYPE } from "../catalog/hostPrimitives/composition.definition";
import { compositionDocSchema, expandedKey, type CompositionDocV2 } from "../prototype/composition";
import { prototypeDocSchema, type PrototypeDoc } from "../prototype/schema";
import {
  buildCompositionFromSubtree, compositionMapFromPins, defaultParams, expandForEditor, insertComposition, replaceSubtreeWithComposition,
} from "./compositions";

const composition = compositionDocSchema.parse(compositionRaw);
const authored = prototypeDocSchema.parse(screenRaw);
const compositions = { "ctyp-payment-success": composition };

function plainDoc(spec: PrototypeDoc["screens"][number]["spec"]): PrototypeDoc {
  return prototypeDocSchema.parse({
    version: 1, id: "extract-demo", name: "Extract demo", designSystem: "shadcn", device: "mobile",
    startScreen: "home", state: {}, screens: [{ id: "home", name: "Home", spec }],
  });
}

const cardScreen = plainDoc({
  root: "root",
  elements: {
    root: { type: "Box", props: {}, children: ["card", "tail"] },
    card: { type: "Card", props: { tone: "success" }, children: ["title", "body"] },
    title: { type: "Text", props: { text: "Готово" } },
    body: { type: "Text", props: { text: "Оплата прошла" } },
    tail: { type: "Text", props: { text: "Хвост" } },
  },
});

describe("expandForEditor", () => {
  it("expands composition references and maps host keys to the expanded root", () => {
    const expansion = expandForEditor(authored, compositions);
    const elements = expansion.doc.screens[0]!.spec.elements;

    expect(expansion.issues).toEqual([]);
    expect(elements[expandedKey("screen", "shell")]).toBeTruthy();
    expect(elements[expandedKey("screen", "badge")]!.props).toMatchObject({ amount: "12 ₽" });
    expect(elements.screen).toBeUndefined();
    expect(expansion.hostRootKeys).toEqual({ screen: "screen$shell" });
    expect(expansion.compositionRefs["screen$badge"]).toEqual({ compositionId: "ctyp-payment-success", hostKey: "screen", innerKey: "badge" });
    // Дети экрана маршрутизированы в слоты и остались авторскими ключами.
    expect(elements["screen$shell"]!.children).toContain("nav");
  });

  it("keeps the authored document untouched when there are no composition references", () => {
    const expansion = expandForEditor(cardScreen, compositions);
    expect(expansion.doc).toBe(cardScreen);
    expect(expansion.hostRootKeys).toEqual({});
  });

  it("keeps exact pin metadata for v2 expansion and origin chains", () => {
    const pinnedComposition = compositionDocSchema.parse({
      version: 2,
      name: "Pinned v2",
      atomicLevel: "molecule",
      params: {},
      slots: [],
      spec: { root: "root", elements: { root: { type: "Box", props: {} } } },
    }) as CompositionDocV2;
    const pin = {
      id: "pinned-v2",
      name: pinnedComposition.name,
      version: 17,
      sourceHash: "hash",
      doc: pinnedComposition,
      designSystem: "shadcn",
      status: "deprecated",
    };
    const mapped = compositionMapFromPins([pin]);
    expect(mapped[pin.id]).toMatchObject({ doc: pinnedComposition, version: 17, designSystem: "shadcn", status: "deprecated" });

    const expansion = expandForEditor(plainDoc({
      root: "screen",
      elements: { screen: { type: COMPOSITION_TYPE, props: { composition: pin.id } } },
    }), mapped);

    expect(expansion.issues).toEqual([]);
    expect(expansion.compositionRefs["screen$root"]).toEqual({
      compositionId: pin.id,
      hostKey: "screen",
      innerKey: "root",
      chain: [{ compositionId: pin.id, version: 17, hostKey: "screen", innerKey: "root" }],
    });
  });
});

describe("insertComposition", () => {
  it("adds a reference with the required params prefilled", () => {
    const { doc, elementKey } = insertComposition(cardScreen, "home", {
      parentKey: "card", compositionId: "ctyp-payment-success", composition,
    });
    const elements = doc.screens[0]!.spec.elements;

    expect(elementKey).toBe("ctyp-payment-success");
    expect(elements.card!.children).toEqual(["title", "body", "ctyp-payment-success"]);
    expect(elements[elementKey!]).toEqual({
      type: COMPOSITION_TYPE,
      props: { composition: "ctyp-payment-success", params: { "accrual-amount": "" } },
    });
    expect(defaultParams(composition)).toEqual({ "accrual-amount": "" });
    expect(prototypeDocSchema.safeParse(doc).success).toBe(true);
  });
});

describe("buildCompositionFromSubtree + replaceSubtreeWithComposition", () => {
  it("produces a schema-valid composition and replaces the subtree with a reference", () => {
    const screen = cardScreen.screens[0]!;
    const built = buildCompositionFromSubtree(screen, "card", { name: "Success card" });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(compositionDocSchema.safeParse(built.doc).success).toBe(true);
    expect(built.doc.spec.root).toBe("card");
    expect(Object.keys(built.doc.spec.elements).sort()).toEqual(["body", "card", "title"]);
    expect(built.doc.slots).toEqual([]);
    expect(built.keptChildren).toEqual([]);

    const replaced = replaceSubtreeWithComposition(cardScreen, "home", "card", { compositionId: "success-card" });
    const elements = replaced.screens[0]!.spec.elements;
    expect(Object.keys(elements).sort()).toEqual(["card", "root", "tail"]);
    expect(elements.card).toEqual({ type: COMPOSITION_TYPE, props: { composition: "success-card" } });
    expect(elements.root!.children).toEqual(["card", "tail"]);
    expect(prototypeDocSchema.safeParse(replaced).success).toBe(true);
    // Раскрытие вернуло исходную структуру: композиция подставилась вместо ссылки.
    const expansion = expandForEditor(replaced, { "success-card": built.doc });
    expect(expansion.issues).toEqual([]);
    expect(expansion.doc.screens[0]!.spec.elements["card$title"]!.props).toEqual({ text: "Готово" });
  });

  it("offers a slot for the children that stay on the screen", () => {
    const screen = cardScreen.screens[0]!;
    const built = buildCompositionFromSubtree(screen, "card", { name: "Success shell", keepChildren: true, slotName: "body" });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.doc.slots).toEqual(["body"]);
    expect(built.keptChildren).toEqual(["title", "body"]);
    const slotKey = built.doc.spec.elements.card!.children![0]!;
    expect(built.doc.spec.elements[slotKey]).toEqual({ type: SLOT_TYPE, props: { name: "body" } });

    const replaced = replaceSubtreeWithComposition(cardScreen, "home", "card", {
      compositionId: "success-shell", keptChildren: built.keptChildren, slotName: built.doc.slots[0],
    });
    const elements = replaced.screens[0]!.spec.elements;
    expect(elements.card!.children).toEqual(["title", "body"]);
    expect(elements.title!.slot).toBe("body");
    expect(elements.title).toBeTruthy();
    expect(prototypeDocSchema.safeParse(replaced).success).toBe(true);
    const expansion = expandForEditor(replaced, { "success-shell": built.doc });
    expect(expansion.issues).toEqual([]);
    expect(expansion.doc.screens[0]!.spec.elements["card$card"]!.children).toEqual(["title", "body"]);
  });

  it("refuses regions, FlowRoot and nested compositions with a russian message", () => {
    const doc = plainDoc({
      root: "root",
      elements: {
        root: { type: "@eui/FlowRoot", props: {}, children: ["header"] },
        header: { type: "Box", props: {}, children: ["inner"], region: "header" },
        inner: { type: "@eui/Composition", props: { composition: "other" } },
      },
    });
    const built = buildCompositionFromSubtree(doc.screens[0]!, "header", { name: "Header" });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.errors.join(" ")).toContain("помечен регионом");
    expect(built.errors.join(" ")).toContain("вложенные композиции");

    const rootBuilt = buildCompositionFromSubtree(doc.screens[0]!, "root", { name: "Root" });
    expect(rootBuilt.ok).toBe(false);
    if (rootBuilt.ok) return;
    expect(rootBuilt.errors.join(" ")).toContain("@eui/FlowRoot");
  });

  it("surfaces composition schema issues instead of throwing", () => {
    const doc = plainDoc({
      root: "root",
      elements: {
        root: { type: "Box", props: {}, children: ["broken"] },
        broken: { type: "Box", props: {}, children: ["ghost"] },
      },
    });
    const built = buildCompositionFromSubtree(doc.screens[0]!, "broken", { name: "Broken" });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.errors.join(" ")).toContain("unknown child element: ghost");
  });
});
