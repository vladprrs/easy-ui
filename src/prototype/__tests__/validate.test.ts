import { describe, expect, it } from "vitest";
import { z } from "zod";
import helloDocument from "../../../prototypes/hello-world.json";
import { prototypeDocSchema } from "../schema";
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
  it("rejects an unknown nested prop", () => { const d=clone(); d.screens[0].spec.elements.name.props.checks=[{ type:"required", message:"Required", extra:true }]; expectInvalid(d,/Unrecognized key|extra/); });
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
  it("requires preventDefault for Link navigation", () => { const d=clone(); d.screens[0].spec.elements.next={type:"Link",props:{label:"Details",href:"https://example.com"},on:{press:{action:"navigate",params:{screenId:"details"}}}}; expectInvalid(d,/preventDefault/); });
  it("rejects Hotspot without canvas", () => { const d=clone(); d.screens[0].spec.elements.next={type:"Hotspot",props:{x:0,y:0,width:10,height:10,ariaLabel:"Next"}}; expectInvalid(d,/requires a screen canvas/); });
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
  const files = import.meta.glob("../../../prototypes/*.json", { eager: true, import: "default" });
  for (const [filename, document] of Object.entries(files)) it(`${filename} is valid`, () => expect(messages(document)).toEqual([]));
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

  it("rejects param sources and $if on a builtin element (fail closed)", () => {
    // No definitions option → builtin shadcn Button is resolved and recognized as builtin.
    const builtin = validatePrototype(doc({ press: { action: "setState", params: { statePath: "/x", value: { $event: "/value" } } } }, { type: "Button" })).errors.map((e) => e.message);
    expect(builtin).toContain("param sources are only allowed on custom component events");
    const cond = validatePrototype(doc({ press: { action: "setState", $if: { $event: "/ok" }, params: { statePath: "/x", value: 1 } } }, { type: "Button" })).errors.map((e) => e.message);
    expect(cond).toContain("conditional actions ($if) are only allowed on custom component events");
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
