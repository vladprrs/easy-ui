import { describe, expect, it } from "vitest";
import { z } from "zod";
import helloDocument from "../../../test/fixtures/hello-world.json";
import type { ComponentDefinition } from "../../catalog/definitions";
import { prototypeDocSchema, type PrototypeDoc } from "../schema";
import { isDynamicValue, validateElementProps, validatePrototype } from "../validate";

const hello: unknown = helloDocument;

describe("element props validation", () => {
  const definition = {
    description: "Test component",
    props: z.strictObject({ label: z.string().min(2) }),
  };
  const validate = (props: Record<string, unknown>, state: Record<string, unknown> = {}) => validateElementProps({
    definition,
    props,
    state,
    path: ["props"],
  });

  it("accepts valid props", () => {
    expect(validate({ label: "Valid" })).toEqual({ errors: [], warnings: [] });
  });

  /**
   * BR-01a (план 2026-08-08 §1): контекст резолвера превращает «Unrecognized key» в
   * типизированный `component_prop_unknown` с адресом самого prop'а и фактически применённой
   * схемой. Без контекста (клиентская валидация редактора) форма issue доволновая.
   */
  it("types an unrecognized prop as component_prop_unknown when the resolver context is supplied", () => {
    const schemaContext = {
      componentId: "test-component",
      resolvedVersion: 2,
      sourceHash: "a".repeat(64),
      propsSchemaHash: "b".repeat(64),
      catalogRevision: "catalog-1",
      acceptedKeys: ["label"],
    };
    expect(validateElementProps({ definition, props: { label: "Valid", mode: "current-main" }, state: {}, path: ["props"], schemaContext }).errors).toEqual([
      { path: "/props/mode", message: expect.stringContaining("mode"), code: "component_prop_unknown", ...schemaContext },
    ]);
    // Без контекста — прежняя форма: путь до объекта props, без кода.
    expect(validate({ label: "Valid", mode: "current-main" }).errors).toEqual([
      { path: "/props", message: expect.stringContaining("mode") },
    ]);
  });

  it("reports schema violations", () => {
    expect(validate({ label: "x" }).errors).toEqual([
      { path: "/props/label", message: "Too small: expected string to have >=2 characters" },
    ]);
  });

  it("validates dynamic values against state paths", () => {
    expect(validate({ label: { $state: "/profile/name" } }, { profile: { name: "Ada" } })).toEqual({ errors: [], warnings: [] });
    expect(validate({ label: { $state: "/profile/missing" } }, { profile: { name: "Ada" } }).warnings).toEqual([
      { path: "/props/label/$state", message: "state path is not present in document state" },
    ]);
    expect(validate({ label: { $bindState: "profile/name" } }).errors).toEqual([
      { path: "/props/label/$bindState", message: "state path must be an absolute RFC 6901 JSON Pointer" },
    ]);
  });

  it("preserves strict object validation", () => {
    expect(validate({ label: "Valid", extra: true }).errors).toEqual([
      { path: "/props", message: 'Unrecognized key: "extra"' },
    ]);
  });

  it("identifies dynamic directives", () => {
    expect(isDynamicValue({ $state: "/name" })).toBe(true);
    expect(isDynamicValue({ label: "$state" })).toBe(false);
    expect(isDynamicValue(null)).toBe(false);
  });
});

// Mutation-heavy negative fixtures intentionally use a loose JSON shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function clone(): Record<string, any> { return structuredClone(hello) as Record<string, any>; }
function messages(raw: unknown): string[] {
  const parsed = prototypeDocSchema.safeParse(raw);
  if (!parsed.success) return parsed.error.issues.map((entry) => `${entry.path.join("/")}: ${entry.message}`);
  return validatePrototype(parsed.data).errors.map((entry) => `${entry.path}: ${entry.message}`);
}
function expectInvalid(raw: unknown, pattern: RegExp) { expect(messages(raw).join("\n")).toMatch(pattern); }

describe("prototype v1 validation", () => {
  it("accepts hello-world", () => expect(messages(hello)).toEqual([]));

  it("defaults designSystem to shadcn", () => {
    expect(prototypeDocSchema.parse(hello).designSystem).toBe("shadcn");
  });

  it("accepts screen notes and JSON state overrides", () => {
    const d = clone();
    d.screens[0].note = "  A useful caption  ";
    d.screens[0].stateOverrides = { nested: { value: null }, items: [1, true, "x"] };
    const parsed = prototypeDocSchema.parse(d);
    expect(parsed.screens[0].note).toBe("A useful caption");
  });

  it.each(["", "   "])("rejects an empty note (%j)", (note) => { const d=clone(); d.screens[0].note=note; expectInvalid(d,/note/); });
  it("keeps screens strict when optional fields are added", () => { const d=clone(); d.screens[0].surprise=true; expectInvalid(d,/Unrecognized key.*surprise/); });

  it("treats a system without provider as an empty builtin catalog", () => {
    const d = clone();
    d.designSystem = "unknown-system";
    const result = validatePrototype(prototypeDocSchema.parse(d));
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.every((e) => /unknown component type/.test(e.message))).toBe(true);
  });

  it("rejects a children cycle", () => { const d=clone(); d.screens[0].spec.elements.next.children=["card"]; expectInvalid(d,/cycle/); });
  it("rejects an element with a second parent", () => { const d=clone(); d.screens[0].spec.elements.greeting.children=["next"]; expectInvalid(d,/more than one parent/); });
  it("rejects an unknown type", () => { const d=clone(); d.screens[0].spec.elements.next.type="Mystery"; expectInvalid(d,/unknown component type/); });
  it("uses the exact supplied custom definition for nested props", () => { const d=clone(); d.screens[0].spec.elements.name.props.checks=[{ type:"required", message:"Required", extra:true }]; expect(messages(d)).toEqual([]); });
  it("rejects an unknown event", () => { const d=clone(); d.screens[0].spec.elements.next.on.click=d.screens[0].spec.elements.next.on.press; delete d.screens[0].spec.elements.next.on.press; expectInvalid(d,/unknown event/); });
  it("rejects an unknown action", () => { const d=clone(); d.screens[0].spec.elements.next.on.press.action="launch"; expectInvalid(d,/unknown action/); });
  it("rejects invalid action params", () => { const d=clone(); d.screens[0].spec.elements.next.on.press.params={}; expectInvalid(d,/screenId|Invalid input/); });
  it("rejects dynamic action params", () => { const d=clone(); d.screens[0].spec.elements.next.on.press.params.screenId={$state:"/target"}; expectInvalid(d,/static literals/); });
  it("rejects two terminal actions", () => { const d=clone(); d.screens[0].spec.elements.next.on.press=[{action:"back",params:{}},{action:"navigate",params:{screenId:"details"}}]; expectInvalid(d,/at most one terminal/); });
  it("rejects a missing navigate target", () => { const d=clone(); d.screens[0].spec.elements.next.on.press.params.screenId="missing"; expectInvalid(d,/target does not exist/); });
  it("rejects spec.state", () => { const d=clone(); d.screens[0].spec.state={}; expectInvalid(d,/Unrecognized key.*state/); });
  it("rejects watch", () => { const d=clone(); d.screens[0].spec.elements.next.watch={}; expectInvalid(d,/Unrecognized key.*watch/); });
  it("rejects a repeat statePath that is not an absolute pointer", () => { const d=clone(); d.screens[0].spec.elements.next.repeat={statePath:"items"}; expectInvalid(d,/statePath/); });
  it("rejects a reserved state path", () => { const d=clone(); d.screens[0].spec.elements.next.on.press={action:"setState",params:{statePath:"/_viewer/x",value:true}}; expectInvalid(d,/reserved viewer namespace/); });
  it("rejects a javascript URL", () => { const d=clone(); d.screens[0].spec.elements.next.on.press={action:"openUrl",params:{url:"javascript:alert(1)"}}; expectInvalid(d,/http\(s\)/); });
  it("rejects a dynamic Image src", () => { const d=clone(); d.screens[0].spec.elements.greeting={type:"Image",props:{src:{$state:"/image"},alt:"x"}}; expectInvalid(d,/URL must be a static string/); });
  it("accepts an $asset directive as an Image src", () => { const d=clone(); d.screens[0].spec.elements.greeting={type:"Image",props:{src:{$asset:`asset_${"a".repeat(64)}`},alt:"x"}}; expect(messages(d)).toEqual([]); });
  it("rejects an $asset with a malformed id", () => { const d=clone(); d.screens[0].spec.elements.greeting={type:"Image",props:{src:{$asset:"asset_nothex"},alt:"x"}}; expectInvalid(d,/\$asset must be an asset id/); });
  it("rejects an $asset directive inside action params", () => { const d=clone(); d.screens[0].spec.elements.next.on.press={action:"setState",params:{statePath:"/x",value:{$asset:`asset_${"a".repeat(64)}`}}}; expectInvalid(d,/static literals/); });
  it("does not apply name-based Link semantics", () => { const d=clone(); d.screens[0].spec.elements.next={type:"Link",props:{label:"Details",href:"https://example.com"},on:{press:{action:"navigate",params:{screenId:"details"}}}}; expect(messages(d)).toEqual([]); });
  it("accepts host Hotspot without canvas as ordinary flow content", () => { const d=clone(); d.screens[0].spec.elements.next={type:"Hotspot",props:{x:0,y:0,width:10,height:10,ariaLabel:"Next"}}; expect(messages(d)).toEqual([]); });
  it("accepts host content types without a design-system binding", () => {
    const doc = prototypeDocSchema.parse({
      version: 1, id: "host-only", name: "Host only", designSystem: "custom-only", device: "desktop", startScreen: "main", state: {},
      screens: [{ id: "main", name: "Main", spec: { root: "image", elements: {
        image: { type: "Image", props: { src: "/images/host.png", alt: "Host", objectFit: "cover" } },
      } } }],
    });
    expect(validatePrototype(doc, { definitions: {} }).errors).toEqual([]);
  });
  it("rejects Hotspot outside canvas", () => { const d=clone(); d.screens[0].canvas={width:100,height:100}; d.screens[0].spec.elements.next={type:"Hotspot",props:{x:95,y:0,width:10,height:10,ariaLabel:"Next"}}; expectInvalid(d,/outside canvas bounds/); });
  it("rejects an unknown $cond operator", () => { const d=clone(); d.screens[0].spec.elements.greeting.props.text={$cond:{if:{$state:"/name",contains:"A"},then:"yes",else:"no"}}; expectInvalid(d,/unknown condition operator/); });
  it("rejects a non-numeric ordering operand", () => { const d=clone(); d.screens[0].spec.elements.greeting.props.text={$cond:{if:{$state:"/name",gt:"10"},then:"yes",else:"no"}}; expectInvalid(d,/gt operand must be a number/); });
  it("rejects a directive as the entire props object", () => { const d=clone(); d.screens[0].spec.elements.greeting.props={$cond:{if:true,then:{text:"yes"},else:{text:"no"}}}; expectInvalid(d,/directive cannot be the entire props object/); });
  it("rejects an extra key in $cond", () => { const d=clone(); d.screens[0].spec.elements.greeting.props.text={$cond:{if:true,then:"yes",else:"no",extra:1}}; expectInvalid(d,/\$cond must be \{if, then, else\}/); });

  it.each(["currentScreen", "navStack", "_viewer"])("rejects reserved override key %s", (key) => {
    const d=clone(); d.screens[0].stateOverrides={ [key]: true }; expectInvalid(d,/state override key is reserved/);
  });

  it.each(["__proto__", "prototype", "constructor"])("rejects forbidden override key %s at any depth", (key) => {
    const d=prototypeDocSchema.parse(clone()); d.screens[0]!.stateOverrides={ safe: [{ nested: Object.fromEntries([[key, true]]) }] } as never;
    const result = validatePrototype(d);
    expect(result.errors.map((entry) => entry.message).join("\n")).toMatch(/state override key is forbidden/);
  });

  it("rejects override object nesting beyond the limit", () => {
    const d=clone(); let cursor: Record<string, unknown> = d.screens[0].stateOverrides={};
    for (let i=0;i<33;i++) cursor = cursor.next={};
    expectInvalid(d,/depth exceeds 32/);
  });

  it("checks screen state paths against effective state", () => {
    const d=clone();
    d.screens[0].stateOverrides={ overrideOnly: "visible" };
    d.screens[0].spec.elements.greeting.props.text={ $state: "/overrideOnly" };
    const parsed = prototypeDocSchema.parse(d);
    const result = validatePrototype(parsed);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((entry) => entry.message.includes("state path"))).toBe(false);
  });
});

describe("atomic design nesting", () => {
  const definition = (atomicLevel?: "atom" | "molecule" | "organism", layoutNeutral = false) => ({
    description: "Test component",
    props: z.strictObject({}),
    ...(atomicLevel ? { atomicLevel } : {}),
    ...(layoutNeutral ? { layoutNeutral: true } : {}),
  });
  const definitions = {
    Button: definition("atom"),
    Card: definition("organism"),
    Stack: definition("atom", true),
    Grid: definition("atom", true),
    UnknownLevel: definition(),
  };
  const document = (elements: Record<string, { type: string; props: Record<string, unknown>; children?: string[] }>, root = "root") => prototypeDocSchema.parse({
    version: 1, id: "atomic-test", name: "Atomic test", startScreen: "main", state: {},
    screens: [{ id: "main", name: "Main", spec: { root, elements } }],
  });
  const atomicWarnings = (doc: ReturnType<typeof document>) => validatePrototype(doc, { definitions }).warnings.filter((entry) => entry.message.startsWith("atomic-design:"));

  it("warns when an organism is nested in an atom", () => {
    const warnings = atomicWarnings(document({ root: { type: "Button", props: {}, children: ["card"] }, card: { type: "Card", props: {} } }));
    expect(warnings).toEqual([{ path: "/screens/0/spec/elements/card", message: "atomic-design: Card (organism) should not be nested inside a atom" }]);
  });

  it("keeps multiple layout-neutral ancestors transparent", () => {
    const warnings = atomicWarnings(document({
      root: { type: "Button", props: {}, children: ["stack"] }, stack: { type: "Stack", props: {}, children: ["grid"] },
      grid: { type: "Grid", props: {}, children: ["card"] }, card: { type: "Card", props: {} },
    }));
    expect(warnings).toHaveLength(1);
  });

  it("does not warn through a layout-neutral element inside an organism", () => {
    expect(atomicWarnings(document({ root: { type: "Card", props: {}, children: ["stack"] }, stack: { type: "Stack", props: {}, children: ["card"] }, card: { type: "Card", props: {} } }))).toEqual([]);
  });

  it("allows equal levels", () => {
    expect(atomicWarnings(document({ root: { type: "Card", props: {}, children: ["card"] }, card: { type: "Card", props: {} } }))).toEqual([]);
  });

  it("keeps components without a level transparent", () => {
    expect(atomicWarnings(document({ root: { type: "Button", props: {}, children: ["middle"] }, middle: { type: "UnknownLevel", props: {}, children: ["card"] }, card: { type: "Card", props: {} } }))).toHaveLength(1);
  });

  it("remains cycle-safe when orphan elements exist", () => {
    const doc = document({
      root: { type: "Button", props: {}, children: ["card"] }, card: { type: "Card", props: {}, children: ["root"] },
      orphan: { type: "Card", props: {} },
    });
    const result = validatePrototype(doc, { definitions });
    expect(result.errors.some((entry) => entry.message.includes("cycle"))).toBe(true);
    expect(result.warnings.some((entry) => entry.path.endsWith("/card") && entry.message.startsWith("atomic-design:"))).toBe(true);
  });
});

describe("custom component definitions", () => {
  const definition = {
    description: "A star rating input.",
    props: z.strictObject({ value: z.number().int().min(1).max(5) }),
    events: ["change"],
  };
  const document = prototypeDocSchema.parse({
    version: 1,
    id: "custom-rating",
    name: "Custom rating",
    device: "desktop",
    startScreen: "main",
    state: {},
    screens: [{
      id: "main",
      name: "Main",
      spec: {
        root: "rating",
        elements: {
          rating: {
            type: "RatingStars",
            props: { value: 4 },
            on: { change: { action: "setState", params: { statePath: "/rating", value: 5 } } },
          },
        },
      },
    }],
  });

  it("accepts a custom type only when its definition is supplied", () => {
    expect(validatePrototype(document, { definitions: { RatingStars: definition } }).errors).toEqual([]);
    expect(validatePrototype(document).errors.map((entry) => entry.message)).toContain("unknown component type: RatingStars");
  });

  it("validates custom props and events", () => {
    const invalidProps = structuredClone(document);
    invalidProps.screens[0]!.spec.elements.rating!.props.value = 6;
    expect(validatePrototype(invalidProps, { definitions: { RatingStars: definition } }).errors.some((entry) => entry.path.endsWith("/props/value"))).toBe(true);

    const invalidEvent = structuredClone(document);
    invalidEvent.screens[0]!.spec.elements.rating!.on = { press: { action: "back", params: {} } };
    expect(validatePrototype(invalidEvent, { definitions: { RatingStars: definition } }).errors.map((entry) => entry.message)).toContain("unknown event for RatingStars: press");
  });
});

describe("repeat", () => {
  const definitions = {
    List: { description: "A list container", props: z.strictObject({}) },
    Item: { description: "A list item", props: z.strictObject({ label: z.unknown().optional() }) },
    Hotspot: { description: "Hotspot", props: z.strictObject({ x: z.number(), y: z.number(), width: z.number(), height: z.number(), ariaLabel: z.string() }) },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function repeatDoc(elements: Record<string, any>, state: Record<string, any> = { items: [{ label: "A" }, { label: "B" }] }, canvas?: { width: number; height: number }) {
    return prototypeDocSchema.parse({
      version: 1, id: "repeat-test", name: "Repeat test", startScreen: "main", state,
      screens: [{ id: "main", name: "Main", ...(canvas ? { canvas } : {}), spec: { root: "list", elements } }],
    });
  }
  const validate = (doc: ReturnType<typeof repeatDoc>) => validatePrototype(doc, { definitions });

  it("accepts a valid repeat with $item in props", () => {
    const doc = repeatDoc({
      list: { type: "List", props: {}, repeat: { statePath: "/items" }, children: ["item"] },
      item: { type: "Item", props: { label: { $item: "label" } } },
    });
    expect(validate(doc).errors).toEqual([]);
  });

  it("accepts $index inside a repeat subtree condition", () => {
    const doc = repeatDoc({
      list: { type: "List", props: {}, repeat: { statePath: "/items" }, children: ["item"] },
      item: { type: "Item", props: {}, visible: { $index: true, gt: 0 } },
    });
    expect(validate(doc).errors).toEqual([]);
  });

  it("rejects nested repeat", () => {
    const doc = repeatDoc({
      list: { type: "List", props: {}, repeat: { statePath: "/items" }, children: ["inner"] },
      inner: { type: "List", props: {}, repeat: { statePath: "/items" }, children: ["item"] },
      item: { type: "Item", props: {} },
    });
    expect(validate(doc).errors.map((e) => e.message)).toContain("nested repeat is not allowed");
  });

  it("rejects more than 20 repeat elements on a screen", () => {
    const elements: Record<string, unknown> = {
      list: { type: "List", props: {}, children: Array.from({ length: 21 }, (_, i) => `r${i}`) },
    };
    for (let i = 0; i < 21; i++) elements[`r${i}`] = { type: "List", props: {}, repeat: { statePath: "/items" } };
    const doc = repeatDoc(elements);
    expect(validate(doc).errors.some((e) => /exceeds 20 repeat elements/.test(e.message))).toBe(true);
  });

  it("rejects a Hotspot inside a repeat subtree", () => {
    const doc = repeatDoc({
      list: { type: "List", props: {}, repeat: { statePath: "/items" }, children: ["hot"] },
      hot: { type: "Hotspot", props: { x: 0, y: 0, width: 10, height: 10, ariaLabel: "Go" } },
    }, undefined, { width: 100, height: 100 });
    expect(validate(doc).errors.some((e) => e.message === "Hotspot is not allowed inside a repeat subtree")).toBe(true);
  });

  it("rejects $item used outside a repeat subtree", () => {
    const doc = repeatDoc({
      list: { type: "Item", props: { label: { $item: "label" } } },
    });
    expect(validate(doc).errors.some((e) => /\$item is only allowed inside a repeat subtree/.test(e.message))).toBe(true);
  });

  it("rejects $index used outside a repeat subtree condition", () => {
    const doc = repeatDoc({
      list: { type: "List", props: {}, visible: { $index: true } },
    });
    expect(validate(doc).errors.some((e) => /\$index is only allowed inside a repeat subtree/.test(e.message))).toBe(true);
  });

  it("warns when the repeat state path is not an array in the effective initial state", () => {
    const doc = repeatDoc({
      list: { type: "List", props: {}, repeat: { statePath: "/missing" }, children: ["item"] },
      item: { type: "Item", props: {} },
    }, { items: [] });
    expect(validate(doc).warnings.some((e) => /may be populated dynamically/.test(e.message))).toBe(true);
  });

  it("rejects render cost exceeding the 2000 budget", () => {
    const doc = repeatDoc({
      list: { type: "List", props: {}, repeat: { statePath: "/items" }, children: ["item"] },
      item: { type: "Item", props: {} },
    }, { items: Array.from({ length: 2500 }, (_, i) => ({ label: `item-${i}` })) });
    expect(validate(doc).errors.some((e) => /exceeds the budget of 2000/.test(e.message))).toBe(true);
  });

  it("allows a repeat statePath that resolves to a populated array without a warning", () => {
    const doc = repeatDoc({
      list: { type: "List", props: {}, repeat: { statePath: "/items", key: "id" }, children: ["item"] },
      item: { type: "Item", props: { label: { $item: "label" } } },
    }, { items: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
    const result = validate(doc);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((e) => /may be populated dynamically/.test(e.message))).toBe(false);
  });
});

describe("repository prototypes", () => {
  const files = Object.entries(import.meta.glob("../../../test/fixtures/*.json", { eager: true, import: "default" }));
  /**
   * Юниту доступны определения только систем с builtin-провайдером. Фикстура на кастомной
   * дизайн-системе (её компоненты живут в БД сервера) дала бы здесь ложные
   * `unknown component type`, поэтому у неё проверяется структура документа, а полная
   * валидация против настоящего каталога — это её публикация в e2e
   * (`test/fixtures/duo-kso.json` → `e2e/dev/surfaces.spec.ts`).
   */
  const builtinDesignSystems = new Set(["shadcn", "wireframe"]);
  const onBuiltinCatalog = ([, document]: [string, unknown]) =>
    builtinDesignSystems.has((document as { designSystem?: string }).designSystem ?? "shadcn");
  const unknownType = (message: string) => /unknown component type/.test(message);

  for (const [filename, document] of files.filter(onBuiltinCatalog)) it(`${filename} is valid`, () => expect(messages(document)).toEqual([]));
  // Semantic warnings must stay calibrated: no shipped prototype gains a new warning.
  for (const [filename, document] of files.filter(onBuiltinCatalog)) it(`${filename} has no warnings`, () => {
    const parsed = prototypeDocSchema.parse(document);
    expect(validatePrototype(parsed).warnings).toEqual([]);
  });
  for (const [filename, document] of files.filter((entry) => !onBuiltinCatalog(entry))) {
    it(`${filename} is structurally valid on its custom design system`, () => {
      expect(messages(document).filter((message) => !unknownType(message))).toEqual([]);
      const parsed = prototypeDocSchema.parse(document);
      expect(validatePrototype(parsed).warnings.map((warning) => warning.message).filter((message) => !unknownType(message))).toEqual([]);
    });
  }
});

describe("semantic warnings", () => {
  const warns = (doc: PrototypeDoc, definitions?: Record<string, ComponentDefinition>) =>
    validatePrototype(doc, definitions ? { definitions } : undefined).warnings.map((w) => w.message);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const screen = (elements: Record<string, any>, root: string, extra: Record<string, unknown> = {}) => ({ id: "s", name: "S", spec: { root, elements }, ...extra });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const build = (elements: Record<string, any>, root: string, opts: { state?: Record<string, unknown>; screens?: any[] } = {}) => prototypeDocSchema.parse({
    version: 1, id: "sw", name: "SW", designSystem: "shadcn", startScreen: "s", state: opts.state ?? {},
    screens: opts.screens ?? [screen(elements, root)],
  });

  it("takes interactive semantics from a custom definition, not its name", () => {
    const def: ComponentDefinition = { description: "Button-like", props: z.strictObject({ label: z.string() }), events: ["press"], interactive: true, accessibleLabelProps: ["label"] };
    const bare = build({ b: { type: "Widget", props: { label: "Go" } } }, "b");
    expect(warns(bare, { Widget: def })).toContain("interactive Widget has no event handler and no two-way binding");
    const namedButton = build({ b: { type: "Button", props: { label: "Go" } } }, "b");
    expect(warns(namedButton)).not.toContain("interactive Button has no event handler and no two-way binding");
  });

  it("warns on an interactive element without an accessible label", () => {
    const def: ComponentDefinition = { description: "Toggle", props: z.strictObject({ label: z.string() }), events: ["press"], interactive: true, accessibleLabelProps: ["label"] };
    const missing = build({ w: { type: "Widget", props: { label: "" }, on: { press: { action: "back", params: {} } } } }, "w");
    expect(warns(missing, { Widget: def })).toContain("interactive Widget has no accessible label");
    const labelled = build({ w: { type: "Widget", props: { label: "Save" }, on: { press: { action: "back", params: {} } } } }, "w");
    expect(warns(labelled, { Widget: def })).not.toContain("interactive Widget has no accessible label");
  });

  it("warns when a repeated element reads $event from a payload without item identity", () => {
    const noId: ComponentDefinition = { description: "Picker", props: z.strictObject({}), events: ["pick"], eventPayloadSchemas: { pick: z.strictObject({ label: z.string() }) } };
    const withId: ComponentDefinition = { description: "Picker", props: z.strictObject({}), events: ["pick"], eventPayloadSchemas: { pick: z.strictObject({ id: z.string() }) } };
    const list: ComponentDefinition = { description: "List", props: z.strictObject({}) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = (payloadKey: string): any => build({
      list: { type: "List", props: {}, repeat: { statePath: "/items" }, children: ["w"] },
      w: { type: "Picker", props: {}, on: { pick: { action: "setState", params: { statePath: "/x", value: { $event: `/${payloadKey}` } } } } },
    }, "list", { state: { items: [{}] } });
    expect(warns(doc("label"), { Picker: noId, List: list })).toContain("event payload has no item identity (itemId/id/key/value) for a repeated element");
    expect(warns(doc("id"), { Picker: withId, List: list }).some((m) => m.includes("item identity"))).toBe(false);
  });

  it("warns on a large inline base64/data-URL string prop", () => {
    const big = "A".repeat(120 * 1024);
    const flagged = build({ t: { type: "Text", props: { text: big } } }, "t");
    expect(warns(flagged).some((m) => m.includes("inline base64/data-URL value exceeds"))).toBe(true);
    const small = build({ t: { type: "Text", props: { text: "hello" } } }, "t");
    expect(warns(small).some((m) => m.includes("inline base64"))).toBe(false);
  });

  it("warns when multiple screens have no navigate between different screens", () => {
    const disconnected = build({}, "b", { screens: [
      screen({ b: { type: "Button", props: { label: "Back" }, on: { press: { action: "back", params: {} } } } }, "b"),
      screen({ b2: { type: "Button", props: { label: "Back" }, on: { press: { action: "back", params: {} } } } }, "b2", { id: "s2", name: "S2" }),
    ] });
    expect(warns(disconnected)).toContain("prototype has multiple screens but no navigate action moves between different screens");
    const connected = build({}, "b", { screens: [
      screen({ b: { type: "Button", props: { label: "Next" }, on: { press: { action: "navigate", params: { screenId: "s2" } } } } }, "b"),
      screen({ b2: { type: "Button", props: { label: "Back" }, on: { press: { action: "back", params: {} } } } }, "b2", { id: "s2", name: "S2" }),
    ] });
    expect(warns(connected).some((m) => m.includes("no navigate action moves between"))).toBe(false);
  });

  it("warns for a missing flow edge at the destination step path", () => {
    const doc = build({}, "a", { screens: [
      screen({ a: { type: "Text", props: { text: "A" } } }, "a", { id: "s", name: "A" }),
      screen({ b: { type: "Text", props: { text: "B" } } }, "b", { id: "s2", name: "B" }),
    ] });
    doc.flows = [{ id: "main", name: "Main", steps: [{ screenId: "s" }, { screenId: "s2" }] }];
    expect(validatePrototype(doc).warnings).toContainEqual({
      path: "/flows/0/steps/1/screenId",
      message: "flow step is not connected to the previous step by a navigate action",
    });
  });

  it("suppresses a missing flow-edge warning for a dynamic navigate source", () => {
    const widget: ComponentDefinition = { description: "Widget", props: z.strictObject({}), events: ["go"], eventPayloadSchemas: { go: z.strictObject({ target: z.string() }) } };
    const doc = build({}, "a", { screens: [
      screen({ a: { type: "Widget", props: {}, on: { go: { action: "navigate", params: { screenId: { $event: "/target" } } } } } }, "a", { id: "s", name: "A" }),
      screen({ b: { type: "Text", props: { text: "B" } } }, "b", { id: "s2", name: "B" }),
    ] });
    doc.flows = [{ id: "main", name: "Main", steps: [{ screenId: "s" }, { screenId: "s2" }] }];
    expect(validatePrototype(doc, { definitions: { Widget: widget } }).warnings.some((entry) => entry.message.includes("flow step is not connected"))).toBe(false);
  });

  it("warns for a single-step root flow", () => {
    const doc = build({ a: { type: "Text", props: { text: "A" } } }, "a");
    doc.flows = [
      { id: "main", name: "Main", steps: [{ screenId: "s", note: "Shown on the main tile" }] },
      { id: "branch", name: "Branch", steps: [{ screenId: "s", note: "Rendered by the scenarios view" }] },
    ];
    const warnings = validatePrototype(doc).warnings;
    expect(warnings).toEqual(expect.arrayContaining([
      { path: "/flows/0/steps", message: "flow has a single step" },
      { path: "/flows/1/steps", message: "flow has a single step" },
    ]));
  });

  // План docs/plans/2026-07-29-scrn-gallery-ux.md §3, освобождение 4: премиса «у якоря
  // нет своего тайла» перестала быть верной — режим «Сценарии» рендерит якорные шаги.
  it("no longer warns about a note on a main-flow anchor in any flow, flat ones included", () => {
    const doc = build({ a: { type: "Text", props: { text: "A" } } }, "a");
    doc.flows = [
      { id: "main", name: "Main", steps: [{ screenId: "s", note: "Main" }] },
      { id: "flat", name: "Flat", steps: [{ screenId: "s", note: "Anchor note" }] },
      { id: "child", name: "Child", parentId: "main", steps: [{ screenId: "s", note: "Anchor note" }] },
    ];
    expect(validatePrototype(doc).warnings.some((entry) => entry.message.includes("main-flow anchor"))).toBe(false);
  });

  // Освобождение 3: канонический лист дерева — один экран.
  it("exempts a child flow from the single-step warning", () => {
    const doc = build({ a: { type: "Text", props: { text: "A" } } }, "a");
    doc.flows = [
      { id: "main", name: "Main", steps: [{ screenId: "s" }, { screenId: "s" }] },
      { id: "leaf", name: "Leaf", parentId: "main", steps: [{ screenId: "s" }] },
    ];
    expect(validatePrototype(doc).warnings).not.toContainEqual(expect.objectContaining({ path: "/flows/1/steps" }));
  });

  // Освобождение 2: дочерний флоу — выборка экранов, а не связная цепочка рёбер.
  it("exempts a child flow from the connectivity warning but keeps it for root flows", () => {
    const make = (parentId?: string) => {
      const doc = build({}, "a", { screens: [
        screen({ a: { type: "Text", props: { text: "A" } } }, "a", { id: "s", name: "A" }),
        screen({ b: { type: "Text", props: { text: "B" } } }, "b", { id: "s2", name: "B" }),
      ] });
      doc.flows = [
        { id: "main", name: "Main", steps: [{ screenId: "s" }, { screenId: "s2" }] },
        { id: "slice", name: "Slice", ...(parentId === undefined ? {} : { parentId }), steps: [{ screenId: "s" }, { screenId: "s2" }] },
      ];
      return validatePrototype(doc).warnings.filter((entry) => entry.message.includes("flow step is not connected"));
    };
    expect(make().map((entry) => entry.path)).toEqual(["/flows/0/steps/1/screenId", "/flows/1/steps/1/screenId"]);
    expect(make("main").map((entry) => entry.path)).toEqual(["/flows/0/steps/1/screenId"]);
  });

  it("keeps reachability based on statically inferred navigate edges", () => {
    const doc = build({}, "a", { screens: [
      screen({ a: { type: "Button", props: { label: "Next" }, on: { press: { action: "navigate", params: { screenId: "s2" } } } } }, "a", { id: "s", name: "A" }),
      screen({ b: { type: "Text", props: { text: "B" } } }, "b", { id: "s2", name: "B" }),
      screen({ c: { type: "Text", props: { text: "C" } } }, "c", { id: "s3", name: "C" }),
    ] });
    expect(validatePrototype(doc).warnings.filter((entry) => entry.message === "screen is not reachable by navigate actions"))
      .toEqual([{ path: "/screens/2/id", message: "screen is not reachable by navigate actions" }]);
  });

  // План 2026-08-02, P9: у служебных видов оба предупреждения ложны by design —
  // витрина не навигируется, а её кнопки никуда не ведут.
  it("suppresses reachability and no-handler warnings for service prototype kinds", () => {
    const def: ComponentDefinition = { description: "Button-like", props: z.strictObject({ label: z.string() }), events: ["press"], interactive: true, accessibleLabelProps: ["label"] };
    const doc = build({}, "a", { screens: [
      screen({ a: { type: "Widget", props: { label: "Go" } } }, "a", { id: "s", name: "A" }),
      screen({ c: { type: "Text", props: { text: "C" } } }, "c", { id: "s3", name: "C" }),
    ] });
    const list = (kind?: string) => validatePrototype(doc, { definitions: { Widget: def }, kind }).warnings.map((entry) => entry.message);
    expect(list()).toEqual(expect.arrayContaining([
      "screen is not reachable by navigate actions",
      "interactive Widget has no event handler and no two-way binding",
    ]));
    for (const kind of ["component-gallery", "evidence", "visual-reference", "composition-fixture"]) {
      expect(list(kind)).not.toContain("screen is not reachable by navigate actions");
      expect(list(kind)).not.toContain("interactive Widget has no event handler and no two-way binding");
    }
    // Продуктовый вид предупреждения сохраняет.
    expect(list("experiment")).toContain("screen is not reachable by navigate actions");
  });

  it("warns on a monolithic screen (single custom organism/page root with no children)", () => {
    const page: ComponentDefinition = { description: "Whole page", props: z.strictObject({}), atomicLevel: "page" };
    const container: ComponentDefinition = { description: "Container", props: z.strictObject({}), atomicLevel: "organism" };
    const item: ComponentDefinition = { description: "Item", props: z.strictObject({}), atomicLevel: "atom" };
    const mono = build({ p: { type: "Page", props: {} } }, "p");
    expect(warns(mono, { Page: page }).some((m) => m.startsWith("monolithic screen:"))).toBe(true);
    const composed = build({ p: { type: "Container", props: {}, children: ["c"] }, c: { type: "Item", props: {} } }, "p");
    expect(warns(composed, { Container: container, Item: item }).some((m) => m.startsWith("monolithic screen:"))).toBe(false);
  });

  it("warns on a urlProp pointing to a non-public local path, but not a public one", () => {
    const local = build({ img: { type: "Image", props: { src: "/uploads/x.png", alt: "x", width: 10, height: 10 } } }, "img");
    expect(warns(local).some((m) => m.includes("may be unavailable in the player runtime"))).toBe(true);
    const publicPath = build({ img: { type: "Image", props: { src: "/images/x.png", alt: "x", width: 10, height: 10 } } }, "img");
    expect(warns(publicPath).some((m) => m.includes("may be unavailable"))).toBe(false);
    const asset = build({ img: { type: "Image", props: { src: "/api/assets/asset_" + "a".repeat(64), alt: "x", width: 10, height: 10 } } }, "img");
    expect(warns(asset).some((m) => m.includes("may be unavailable"))).toBe(false);
  });
});

describe("typed events, param sources and $if validation", () => {
  const widget = {
    description: "Custom widget",
    props: z.strictObject({}),
    events: ["rate", "plain"],
    eventPayloadSchemas: { rate: z.strictObject({ value: z.number() }) },
  };
  const doc = (on: Record<string, unknown>, opts: { type?: string; repeat?: unknown; extra?: Record<string, unknown> } = {}) => prototypeDocSchema.parse({
    version: 1, id: "t", name: "T", designSystem: "shadcn", startScreen: "s", state: {},
    screens: [{ id: "s", name: "S", spec: { root: "w", elements: {
      w: opts.repeat
        ? { type: opts.type ?? "MyWidget", props: {}, repeat: opts.repeat, children: ["c"] }
        : { type: opts.type ?? "MyWidget", props: {}, on },
      ...(opts.repeat ? { c: { type: "MyWidget", props: {}, on } } : {}),
      ...(opts.extra ?? {}),
    } } }],
  });
  const errs = (on: Record<string, unknown>, opts?: Parameters<typeof doc>[1]) =>
    validatePrototype(doc(on, opts), { definitions: { MyWidget: widget } }).errors.map((e) => e.message);

  it("allows $event only on a custom event with a declared payload schema", () => {
    expect(errs({ rate: { action: "setState", params: { statePath: "/x", value: { $event: "/value" } } } })).toEqual([]);
  });

  it("rejects $event on a payloadless custom event", () => {
    expect(errs({ plain: { action: "setState", params: { statePath: "/x", value: { $event: "" } } } }))
      .toContain("$event is only allowed on an event with a declared payload schema");
  });

  it("does not infer builtin restrictions from a retired component name", () => {
    const builtin = validatePrototype(doc({ press: { action: "setState", params: { statePath: "/x", value: { $event: "/value" } } } }, { type: "Button" })).errors.map((e) => e.message);
    expect(builtin).not.toContain("param sources are only allowed on custom component events");
    const cond = validatePrototype(doc({ press: { action: "setState", $if: { $event: "/ok" }, params: { statePath: "/x", value: 1 } } }, { type: "Button" })).errors.map((e) => e.message);
    expect(cond).not.toContain("conditional actions ($if) are only allowed on custom component events");
  });

  it("rejects a param source in a disallowed location (statePath is not a value/index/screenId)", () => {
    expect(errs({ rate: { action: "setState", params: { statePath: { $event: "/value" }, value: 1 } } }).some((m) => m.includes("is not allowed here"))).toBe(true);
  });

  it("requires repeat.key for $itemKey and forbids item sources outside a repeat scope", () => {
    expect(errs({ rate: { action: "setState", params: { statePath: "/x", value: { $itemKey: true } } } }))
      .toContain("$itemKey is only allowed inside a repeat subtree");
    expect(errs({ rate: { action: "setState", params: { statePath: "/x", value: { $itemKey: true } } } }, { repeat: { statePath: "/items" } }))
      .toContain("$itemKey requires the repeat element to declare a key");
    expect(errs({ rate: { action: "setState", params: { statePath: "/x", value: { $itemKey: true } } } }, { repeat: { statePath: "/items", key: "id" } }))
      .toEqual([]);
  });

  it("rejects the reserved __eui* namespace in document props", () => {
    const withEui = prototypeDocSchema.parse({
      version: 1, id: "t", name: "T", designSystem: "shadcn", startScreen: "s", state: {},
      screens: [{ id: "s", name: "S", spec: { root: "w", elements: { w: { type: "Text", props: { __euiKey: "hax", text: "x" } } } } }],
    });
    expect(validatePrototype(withEui).errors.map((e) => e.message))
      .toContain("the __eui* namespace is reserved and cannot appear in props");
  });
});

describe("named slots", () => {
  const definitions = {
    Panel: { description: "A slotted panel", props: z.strictObject({}), slots: ["header", "items"], capabilities: { namedSlots: true } as const },
    Plain: { description: "A plain custom container", props: z.strictObject({}) },
    Item: { description: "An item", props: z.strictObject({}) },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = (elements: Record<string, any>, state: Record<string, any> = {}) => prototypeDocSchema.parse({
    version: 1, id: "slots", name: "Slots", designSystem: "shadcn", startScreen: "s", state,
    screens: [{ id: "s", name: "S", spec: { root: "panel", elements } }],
  });
  const errs = (elements: Record<string, unknown>, state?: Record<string, unknown>) =>
    validatePrototype(doc(elements, state), { definitions }).errors.map((e) => e.message);

  it("accepts children routed to declared slots of a named-slots custom parent", () => {
    expect(errs({
      panel: { type: "Panel", props: {}, children: ["h", "a", "b"] },
      h: { type: "Item", props: {}, slot: "header" },
      a: { type: "Item", props: {}, slot: "items" },
      b: { type: "Item", props: {} },
    })).toEqual([]);
  });

  it("rejects an unknown slot name", () => {
    expect(errs({
      panel: { type: "Panel", props: {}, children: ["h"] },
      h: { type: "Item", props: {}, slot: "footer" },
    })).toContain("unknown slot for Panel: footer");
  });

  it("rejects a slot child of a builtin parent", () => {
    expect(errs({
      panel: { type: "Card", props: {}, children: ["h"] },
      h: { type: "Item", props: {}, slot: "header" },
    })).toContain("slot is only allowed on a child of a custom component with named slots");
  });

  it("rejects a slot child of a custom parent without the namedSlots capability", () => {
    expect(errs({
      panel: { type: "Plain", props: {}, children: ["h"] },
      h: { type: "Item", props: {}, slot: "header" },
    })).toContain("slot is only allowed on a child of a custom component with named slots");
  });

  it("rejects repeat on a named-slots custom parent", () => {
    expect(errs({
      panel: { type: "Panel", props: {}, repeat: { statePath: "/items" }, children: ["a"] },
      a: { type: "Item", props: {} },
    }, { items: [] })).toContain("repeat is not allowed on a custom component with named slots");
  });

  it("allows repeat on a child inside a slot", () => {
    expect(errs({
      panel: { type: "Panel", props: {}, children: ["list"] },
      list: { type: "Plain", props: {}, slot: "items", repeat: { statePath: "/items" }, children: ["a"] },
      a: { type: "Item", props: {} },
    }, { items: [{}, {}] })).toEqual([]);
  });
});

describe("computed values", () => {
  const definitions = {
    List: { description: "A list container", props: z.strictObject({}) },
    Text: { description: "A text node", props: z.strictObject({ text: z.unknown().optional() }) },
    Field: { description: "A bound field", props: z.strictObject({ value: z.unknown().optional() }) },
    Widget: { description: "A custom widget", props: z.strictObject({}), events: ["press"] },
  };
  const cart = [{ price: 100, qty: 2 }];
  const defaultComputed = { cartTotal: { op: "sum", from: "/cart", field: "price" } };
  type Options = {
    computed?: unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    state?: Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    elements?: Record<string, any>;
    root?: string;
    stateOverrides?: Record<string, unknown>;
  };
  const doc = (options: Options = {}) => prototypeDocSchema.parse({
    version: 1, id: "computed", name: "Computed", designSystem: "shadcn", startScreen: "s",
    state: options.state ?? { cart, shippingFee: 500 },
    computed: Object.hasOwn(options, "computed") ? options.computed : defaultComputed,
    screens: [{
      id: "s", name: "S",
      ...(options.stateOverrides ? { stateOverrides: options.stateOverrides } : {}),
      spec: { root: options.root ?? "list", elements: options.elements ?? { list: { type: "List", props: {} } } },
    }],
  });
  const result = (options?: Options) => validatePrototype(doc(options), { definitions });
  const errs = (options?: Options) => result(options).errors.map((e) => `${e.path}: ${e.message}`);
  const warns = (options?: Options) => result(options).warnings.map((e) => `${e.path}: ${e.message}`);
  const writeErrs = (action: string, params: Record<string, unknown>) =>
    errs({ root: "w", elements: { w: { type: "Widget", props: {}, on: { press: { action, params } } } } });

  it("accepts a valid computed spec", () => {
    expect(errs()).toEqual([]);
    expect(warns()).toEqual([]);
  });

  it("tolerates a stored spec without entry shape", () => {
    expect(errs({ computed: null })).toEqual([]);
    expect(errs({ computed: { alpha: null, beta: 5, gamma: { op: "avg", from: "/cart" } } })).toEqual([]);
  });

  // --- D6: collisions ---

  it("rejects a computed key that collides with a state key", () => {
    expect(errs({ state: { cart, cartTotal: 0 } }).join("\n"))
      .toMatch(/^\/computed\/cartTotal: computed key collides with a state key: cartTotal$/m);
  });

  it.each(["currentScreen", "navStack", "_viewer"])("rejects the reserved computed key %s", (key) => {
    expect(errs({ computed: { [key]: { op: "count", from: "/cart" } } }).join("\n"))
      .toMatch(new RegExp(`^/computed/${key}: computed key is reserved: ${key}$`, "m"));
  });

  it("rejects a state override that shadows a computed key", () => {
    expect(errs({ stateOverrides: { cartTotal: 5 } }).join("\n"))
      .toMatch(/^\/screens\/0\/stateOverrides\/cartTotal: state override key is reserved: cartTotal$/m);
  });

  // --- D4: order and references ---

  it("accepts an add term referencing an earlier computed key", () => {
    expect(errs({
      computed: {
        subtotal: { op: "sumProduct", from: "/cart", fields: ["price", "qty"] },
        total: { op: "add", terms: ["/subtotal", "/shippingFee", -100] },
      },
    })).toEqual([]);
  });

  it("rejects forward and self references between computed keys", () => {
    expect(errs({
      computed: {
        total: { op: "add", terms: ["/subtotal", 0] },
        subtotal: { op: "count", from: "/cart" },
      },
    }).join("\n")).toMatch(/^\/computed\/total\/terms\/0: computed term may only reference a computed value declared earlier$/m);
    expect(errs({ computed: { total: { op: "add", terms: ["/total", 1] } } }).join("\n"))
      .toMatch(/computed term may only reference a computed value declared earlier/);
  });

  it("rejects a computed source pointing at another computed value", () => {
    expect(errs({
      computed: {
        cartCount: { op: "count", from: "/cart" },
        bogus: { op: "sum", from: "/cartCount" },
      },
    }).join("\n")).toMatch(/^\/computed\/bogus\/from: state path is a computed value and is read-only$/m);
  });

  // --- entry payloads ---

  it("rejects unsafe sources, fields and terms", () => {
    expect(errs({ computed: { t: { op: "count", from: "cart" } } }).join("\n")).toMatch(/\/computed\/t\/from: state path must be an absolute RFC 6901 JSON Pointer/);
    expect(errs({ computed: { t: { op: "count", from: "/_viewer/cart" } } }).join("\n")).toMatch(/\/computed\/t\/from: state path uses a reserved viewer namespace/);
    expect(errs({ computed: { t: { op: "sum", from: "/cart", field: "__proto__" } } }).join("\n")).toMatch(/^\/computed\/t\/field: computed field must be a safe relative field path$/m);
    expect(errs({ computed: { t: { op: "sumProduct", from: "/cart", fields: ["price", "__proto__"] } } }).join("\n")).toMatch(/^\/computed\/t\/fields\/1: computed field must be a safe relative field path$/m);
    expect(errs({ computed: { t: { op: "add", terms: ["shippingFee", 1] } } }).join("\n")).toMatch(/\/computed\/t\/terms\/0: state path must be an absolute RFC 6901 JSON Pointer/);
    expect(errs({ computed: { t: { op: "add", terms: [Number.POSITIVE_INFINITY, 1] } } }).join("\n")).toMatch(/^\/computed\/t\/terms\/0: computed term must be a finite number$/m);
    expect(errs({ computed: { t: { op: "add", terms: [true, 1] } } }).join("\n")).toMatch(/^\/computed\/t\/terms\/0: computed term must be a JSON Pointer string or a number$/m);
  });

  it("warns about a term missing from the initial state", () => {
    expect(warns({ computed: { t: { op: "add", terms: ["/discount", 1] } } }).join("\n"))
      .toMatch(/^\/computed\/t\/terms\/0: state path is not present in document state$/m);
  });

  it("warns when the computed source is not an array in the initial state", () => {
    expect(warns({ computed: { t: { op: "count", from: "/shippingFee" } } }).join("\n"))
      .toMatch(/^\/computed\/t\/from: computed source path is not an array in the initial state$/m);
  });

  // --- D7: computed values are read-only ---

  it.each([
    ["setState", { statePath: "/cartTotal", value: 1 }],
    ["pushState", { statePath: "/cartTotal", value: 1 }],
    ["removeState", { statePath: "/cartTotal", index: 0 }],
    ["pushState", { statePath: "/cart", value: 1, clearStatePath: "/cartTotal" }],
  ])("rejects writing to a computed value via %s (%j)", (action, params) => {
    expect(writeErrs(action, params as Record<string, unknown>).join("\n"))
      .toMatch(/params\/(clear)?[sS]tatePath: state path is a computed value and is read-only/);
  });

  it("rejects a $bindState binding to a computed value", () => {
    expect(errs({ root: "f", elements: { f: { type: "Field", props: { value: { $bindState: "/cartTotal" } } } } }).join("\n"))
      .toMatch(/^\/screens\/0\/spec\/elements\/f\/props\/value\/\$bindState: state path is a computed value and is read-only$/m);
  });

  it("allows writes and bindings to ordinary state", () => {
    expect(writeErrs("setState", { statePath: "/shippingFee", value: 1 })).toEqual([]);
    expect(writeErrs("pushState", { statePath: "/cart", value: 1, clearStatePath: "/shippingFee" })).toEqual([]);
    expect(errs({ root: "f", elements: { f: { type: "Field", props: { value: { $bindState: "/shippingFee" } } } } })).toEqual([]);
  });

  // --- D8: repeat over a computed value ---

  it("rejects a repeat over a computed value without the dynamic-population warning", () => {
    const outcome = result({
      root: "list",
      elements: {
        list: { type: "List", props: {}, repeat: { statePath: "/cartTotal" }, children: ["t"] },
        t: { type: "Text", props: {} },
      },
    });
    expect(outcome.errors.map((e) => `${e.path}: ${e.message}`).join("\n"))
      .toMatch(/^\/screens\/0\/spec\/elements\/list\/repeat\/statePath: state path is a computed value and is read-only$/m);
    expect(outcome.warnings.some((w) => /may be populated dynamically/.test(w.message))).toBe(false);
  });

  // --- reading a computed value ---

  it("does not warn when a prop reads a computed value", () => {
    const outcome = result({ root: "t", elements: { t: { type: "Text", props: { text: { $state: "/cartTotal" } } } } });
    expect(outcome.errors).toEqual([]);
    expect(outcome.warnings).toEqual([]);
  });
});
