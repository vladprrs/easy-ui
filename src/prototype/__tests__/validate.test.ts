import { describe, expect, it } from "vitest";
import { z } from "zod";
import helloDocument from "../../../prototypes/hello-world.json";
import { prototypeDocSchema } from "../schema";
import { validatePrototype } from "../validate";

const hello: unknown = helloDocument;

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

  it("reports an unknown design system", () => {
    const d = clone();
    d.designSystem = "unknown-system";
    const result = validatePrototype(prototypeDocSchema.parse(d));
    expect(result.errors).toEqual([{ path: "/designSystem", message: "unknown design system: unknown-system" }]);
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
  it("rejects repeat", () => { const d=clone(); d.screens[0].spec.elements.next.repeat={statePath:"/items"}; expectInvalid(d,/Unrecognized key.*repeat/); });
  it("rejects a reserved state path", () => { const d=clone(); d.screens[0].spec.elements.next.on.press={action:"setState",params:{statePath:"/_viewer/x",value:true}}; expectInvalid(d,/reserved viewer namespace/); });
  it("rejects a javascript URL", () => { const d=clone(); d.screens[0].spec.elements.next.on.press={action:"openUrl",params:{url:"javascript:alert(1)"}}; expectInvalid(d,/http\(s\)/); });
  it("rejects a dynamic Image src", () => { const d=clone(); d.screens[0].spec.elements.greeting={type:"Image",props:{src:{$state:"/image"},alt:"x"}}; expectInvalid(d,/URL must be a static string/); });
  it("requires preventDefault for Link navigation", () => { const d=clone(); d.screens[0].spec.elements.next={type:"Link",props:{label:"Details",href:"https://example.com"},on:{press:{action:"navigate",params:{screenId:"details"}}}}; expectInvalid(d,/preventDefault/); });
  it("rejects Hotspot without canvas", () => { const d=clone(); d.screens[0].spec.elements.next={type:"Hotspot",props:{x:0,y:0,width:10,height:10,ariaLabel:"Next"}}; expectInvalid(d,/requires a screen canvas/); });
  it("rejects Hotspot outside canvas", () => { const d=clone(); d.screens[0].canvas={width:100,height:100}; d.screens[0].spec.elements.next={type:"Hotspot",props:{x:95,y:0,width:10,height:10,ariaLabel:"Next"}}; expectInvalid(d,/outside canvas bounds/); });
  it("rejects an unknown $cond operator", () => { const d=clone(); d.screens[0].spec.elements.greeting.props.text={$cond:{if:{$state:"/name",contains:"A"},then:"yes",else:"no"}}; expectInvalid(d,/unknown condition operator/); });
  it("rejects a non-numeric ordering operand", () => { const d=clone(); d.screens[0].spec.elements.greeting.props.text={$cond:{if:{$state:"/name",gt:"10"},then:"yes",else:"no"}}; expectInvalid(d,/gt operand must be a number/); });
  it("rejects a directive as the entire props object", () => { const d=clone(); d.screens[0].spec.elements.greeting.props={$cond:{if:true,then:{text:"yes"},else:{text:"no"}}}; expectInvalid(d,/directive cannot be the entire props object/); });
  it("rejects an extra key in $cond", () => { const d=clone(); d.screens[0].spec.elements.greeting.props.text={$cond:{if:true,then:"yes",else:"no",extra:1}}; expectInvalid(d,/\$cond must be \{if, then, else\}/); });
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

describe("repository prototypes", () => {
  const files = import.meta.glob("../../../prototypes/*.json", { eager: true, import: "default" });
  for (const [filename, document] of Object.entries(files)) it(`${filename} is valid`, () => expect(messages(document)).toEqual([]));
});
