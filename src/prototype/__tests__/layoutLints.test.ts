import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { ComponentDefinition } from "../../catalog/definitions";
import { resolveBuiltinSystem } from "../../designSystems";
import type { ComponentLayout } from "../../designSystems/types";
import { classNamePositioningTokens, layoutLintCodes, lintPrototypeLayouts } from "../layoutLints";
import { prototypeDocSchema, type PrototypeDoc } from "../schema";
import { validatePrototype } from "../validate";

type ElementInput = { type: string; props?: Record<string, unknown>; children?: string[]; slot?: string };

const spacerDefinition: ComponentDefinition = {
  props: z.strictObject({ size: z.number().default(8), axis: z.enum(["vertical", "horizontal"]).default("vertical") }),
  description: "spacer",
  layout: { version: 1, spacer: true },
};

const stackLayout: ComponentLayout = {
  version: 1,
  spacing: ["gap"],
  flow: {
    kind: "flex",
    direction: { prop: "direction", vertical: ["column"], horizontal: ["row"], none: ["none"] },
  },
};

function stackDefinition(directionSchema: z.ZodType = z.enum(["column", "row", "none", "other"]).default("column")): ComponentDefinition {
  return {
    props: z.strictObject({ direction: directionSchema, gap: z.enum(["none", "sm", "md"]).optional() }),
    slots: ["default", "footer"],
    description: "stack",
    layout: stackLayout,
  };
}

const itemDefinition: ComponentDefinition = { props: z.strictObject({ className: z.string().optional() }), description: "item" };
const definitions: Record<string, ComponentDefinition> = { Stack: stackDefinition(), Spacer: spacerDefinition, Item: itemDefinition };

function doc(elements: Record<string, ElementInput>, root = "root", designSystem = "shadcn"): PrototypeDoc {
  return {
    version: 1,
    id: "layout-lint-test",
    name: "Layout lint test",
    designSystem,
    device: "desktop",
    startScreen: "screen",
    state: {},
    screens: [{
      id: "screen",
      name: "Screen",
      spec: {
        root,
        elements: Object.fromEntries(Object.entries(elements).map(([key, element]) => [key, {
          type: element.type,
          props: element.props ?? {},
          ...(element.children ? { children: element.children } : {}),
          ...(element.slot ? { slot: element.slot } : {}),
        }])),
      },
    }],
  } as PrototypeDoc;
}

const codes = (value: PrototypeDoc, defs = definitions) => lintPrototypeLayouts(value, defs).map((issue) => issue.code);
const spacer = (axis: "vertical" | "horizontal" = "vertical", size = 8): ElementInput => ({ type: "Spacer", props: { axis, size } });
const items = (count: number): Record<string, ElementInput> => Object.fromEntries(Array.from({ length: count }, (_, index) => [`item-${index}`, { type: "Item" }]));

describe("layout spacer lints", () => {
  test("spacer-chain starts at two and is scoped to each slot group", () => {
    const positive = doc({ root: { type: "Stack", children: ["a", "b"] }, a: spacer(), b: spacer() });
    expect(codes(positive).filter((code) => code === "layout/spacer-chain")).toHaveLength(1);

    const splitSlots = doc({ root: { type: "Stack", children: ["a", "b"] }, a: spacer(), b: { ...spacer(), slot: "footer" } });
    expect(codes(splitSlots)).not.toContain("layout/spacer-chain");

    const namedSlot = doc({ root: { type: "Stack", children: ["a", "middle", "b", "c"] }, a: { ...spacer(), slot: "footer" }, middle: { type: "Item" }, b: { ...spacer(), slot: "footer" }, c: { ...spacer(), slot: "footer" } });
    expect(codes(namedSlot).filter((code) => code === "layout/spacer-chain")).toHaveLength(1);
  });

  test("spacer-heavy requires both eight spacers and more than 25 percent", () => {
    const atFraction = doc({ root: { type: "Item" }, ...items(23), ...Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`spacer-${index}`, spacer()])) });
    expect(Object.keys(atFraction.screens[0]!.spec.elements)).toHaveLength(32);
    expect(codes(atFraction)).not.toContain("layout/spacer-heavy");

    const overFraction = doc({ root: { type: "Item" }, ...items(22), ...Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`spacer-${index}`, spacer()])) });
    expect(Object.keys(overFraction.screens[0]!.spec.elements)).toHaveLength(31);
    expect(codes(overFraction)).toContain("layout/spacer-heavy");

    const belowAbsolute = doc({ root: { type: "Item" }, ...Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`spacer-${index}`, spacer()])) });
    expect(codes(belowAbsolute)).not.toContain("layout/spacer-heavy");
  });

  test("spacer-vs-gap requires a declared flow, known direction, compatible axis and target slot", () => {
    const positive = doc({ root: { type: "Stack", props: { direction: "column" }, children: ["a"] }, a: spacer("vertical") });
    expect(codes(positive)).toContain("layout/spacer-vs-gap");
    expect(codes(doc({ root: { type: "Stack", props: { direction: "column", gap: "sm" }, children: ["a"] }, a: spacer() }))).not.toContain("layout/spacer-vs-gap");
    expect(codes(doc({ root: { type: "Stack", props: { direction: "column" }, children: ["a"] }, a: spacer("horizontal") }))).not.toContain("layout/spacer-vs-gap");
    expect(codes(doc({ root: { type: "Stack", props: { direction: "column" }, children: ["a"] }, a: { ...spacer(), slot: "footer" } }))).not.toContain("layout/spacer-vs-gap");

    const noFlow = { ...stackDefinition(), layout: { version: 1 as const, spacing: ["gap" as const] } };
    expect(codes(positive, { ...definitions, Stack: noFlow })).not.toContain("layout/spacer-vs-gap");
  });

  test("direction uses a per-field default, while missing-without-default, directives and unmapped values are n/a", () => {
    const absent = doc({ root: { type: "Stack", children: ["a"] }, a: spacer() });
    expect(codes(absent)).toContain("layout/spacer-vs-gap");

    const noDefault = { ...definitions, Stack: stackDefinition(z.enum(["column", "row", "none", "other"]).optional()) };
    expect(codes(absent, noDefault)).not.toContain("layout/spacer-vs-gap");
    expect(codes(doc({ root: { type: "Stack", props: { direction: { $state: "/direction" } }, children: ["a"] }, a: spacer() }))).not.toContain("layout/spacer-vs-gap");
    expect(codes(doc({ root: { type: "Stack", props: { direction: "other" }, children: ["a"] }, a: spacer() }))).not.toContain("layout/spacer-vs-gap");
  });

  test("replacement names an exact token only when every spacer has the same exact px equivalent", () => {
    const exact = lintPrototypeLayouts(doc({ root: { type: "Stack", children: ["a", "b"] }, a: spacer("vertical", 8), b: spacer("vertical", 8) }), definitions)
      .find((issue) => issue.code === "layout/spacer-vs-gap")!;
    expect(exact.message).toContain('gap="sm"');
    expect(exact.message).toContain("exact pixel equivalent");

    const general = lintPrototypeLayouts(doc({ root: { type: "Stack", children: ["a"] }, a: spacer("vertical", 10) }), definitions)
      .find((issue) => issue.code === "layout/spacer-vs-gap")!;
    expect(general.message).toContain("no exact token can be inferred");
    expect(general.message).not.toMatch(/gap="[^"]+"/);
  });
});

describe("prop and className lints", () => {
  test("default-props-noise starts at five static per-field defaults through Zod wrappers", () => {
    const Defaults: ComponentDefinition = {
      props: z.strictObject({
        a: z.string().default("a").optional().readonly(),
        b: z.string().nullable().default("b"),
        c: z.string().prefault("c").catch("fallback"),
        d: z.string().default("d").pipe(z.string()),
        e: z.number().default(5),
        f: z.boolean().default(false),
      }),
      description: "defaults",
    };
    const five = doc({ root: { type: "Defaults", props: { a: "a", b: "b", c: "c", d: "d", e: 5 } } });
    expect(codes(five, { Defaults })).toContain("layout/default-props-noise");
    const four = doc({ root: { type: "Defaults", props: { a: "a", b: "b", c: "c", d: "d" } } });
    expect(codes(four, { Defaults })).not.toContain("layout/default-props-noise");
    const directive = doc({ root: { type: "Defaults", props: { a: "a", b: "b", c: "c", d: "d", e: { $state: "/e" } } } });
    expect(codes(directive, { Defaults })).not.toContain("layout/default-props-noise");
  });

  test("classname parser tokenizes exact utilities, variants, negatives and arbitrary values", () => {
    expect(classNamePositioningTokens("rounded-md prose md:absolute hover:-mt-2 z-[999] inset-x-0 relative flex"))
      .toEqual(["md:absolute", "hover:-mt-2", "z-[999]", "inset-x-0", "relative"]);
    expect(classNamePositioningTokens("rounded memento translate-x-1 shadow-staticish")).toEqual([]);

    const issue = lintPrototypeLayouts(doc({ root: { type: "Item", props: { className: "flex md:fixed -ml-[2px]" } } }), definitions)
      .find((entry) => entry.code === "layout/classname-positioning")!;
    expect(issue.path).toBe("/screens/0/spec/elements/root");
    expect(issue.message).toContain("md:fixed -ml-[2px]");
    expect(codes(doc({ root: { type: "Item", props: { className: { $state: "/className" } } } }))).not.toContain("layout/classname-positioning");
  });
});

describe("legacy numeric spacing", () => {
  const legacyDefinitions = { ...definitions, YpSpacer: { ...spacerDefinition, layout: undefined } };
  const legacyDoc = (value: number, count: number) => doc(Object.fromEntries(Array.from({ length: count }, (_, index) => [`s${index}`, { type: "YpSpacer", props: { size: value, axis: "vertical" } }])), "s0", "yandex-pay");

  test("starts at five prototype-wide repeats and ignores zero and one", () => {
    expect(codes(legacyDoc(8, 4), legacyDefinitions)).not.toContain("layout/legacy-numeric-spacing");
    expect(codes(legacyDoc(8, 5), legacyDefinitions)).toContain("layout/legacy-numeric-spacing");
    expect(codes(legacyDoc(0, 5), legacyDefinitions)).not.toContain("layout/legacy-numeric-spacing");
    expect(codes(legacyDoc(1, 5), legacyDefinitions)).not.toContain("layout/legacy-numeric-spacing");
  });

  test("exact and general recommendations use the resolved design-system scale", () => {
    const exact = lintPrototypeLayouts(legacyDoc(8, 5), legacyDefinitions).find((issue) => issue.code === "layout/legacy-numeric-spacing")!;
    expect(exact.message).toContain('token "sm"');
    expect(exact.message).toContain("exact 8px equivalent");
    const general = lintPrototypeLayouts(legacyDoc(20, 5), legacyDefinitions).find((issue) => issue.code === "layout/legacy-numeric-spacing")!;
    expect(general.message).toContain("no exact token equivalent");

    const custom = legacyDoc(12, 5);
    custom.designSystem = "custom-ds";
    const canonical = lintPrototypeLayouts(custom, legacyDefinitions).find((issue) => issue.code === "layout/legacy-numeric-spacing")!;
    expect(canonical.message).toContain('token "md"');
  });
});

describe("integration fixtures", () => {
  test("validatePrototype appends coded non-blocking layout warnings", () => {
    const result = validatePrototype(doc({ root: { type: "Stack", children: ["a", "b"] }, a: spacer(), b: spacer() }), { definitions });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "layout/spacer-chain", path: "/screens/0/spec/elements/a" })]));
  });

  test("all shipped prototypes remain layout-warning-free", () => {
    const prototypesDir = resolve(process.cwd(), "test/fixtures");
    for (const name of readdirSync(prototypesDir).filter((entry) => entry.endsWith(".json"))) {
      const parsed = prototypeDocSchema.parse(JSON.parse(readFileSync(resolve(prototypesDir, name), "utf8")));
      const result = validatePrototype(parsed, { definitions: resolveBuiltinSystem(parsed.designSystem).definitions });
      expect(result.warnings.filter((issue) => issue.code?.startsWith("layout/")), name).toEqual([]);
    }
  });

  test("cpqr production scenario has stable warning counts by rule", () => {
    const stored = JSON.parse(readFileSync(resolve(__dirname, "fixtures/cpqr-scenario.draft.json"), "utf8")) as { doc: PrototypeDoc };
    const ypBox: ComponentDefinition = {
      props: z.strictObject({
        mode: z.enum(["box", "row", "col"]).default("row"),
        shrink: z.boolean().default(false),
        wrap: z.boolean().default(false),
        inline: z.boolean().default(false),
        justify: z.enum(["start", "center", "end", "between", "around", "evenly"]).default("start"),
        align: z.enum(["start", "center", "end", "baseline"]).default("start"),
        verticalAlign: z.enum(["default", "bottom"]).default("default"),
        width: z.enum(["auto", "full"]).default("auto"),
        height: z.enum(["auto", "fitContent", "full"]).default("auto"),
        gap: z.enum(["none", "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"]).optional(),
      }),
      slots: ["default"],
      description: "Yandex Pay Box fixture definition",
      layout: {
        version: 1,
        spacing: ["gap"],
        flow: { kind: "flex", direction: { prop: "mode", vertical: ["col"], horizontal: ["row"], none: ["box"] } },
      },
    };
    const warnings = lintPrototypeLayouts(stored.doc, { YpBox: ypBox });
    const counts = Object.fromEntries(layoutLintCodes.map((code) => [code, warnings.filter((issue) => issue.code === code).length]));
    expect(counts).toEqual({
      "layout/spacer-chain": 8,
      "layout/spacer-heavy": 4,
      "layout/spacer-vs-gap": 16,
      "layout/default-props-noise": 22,
      "layout/legacy-numeric-spacing": 2,
      "layout/classname-positioning": 0,
    });
  });
});
