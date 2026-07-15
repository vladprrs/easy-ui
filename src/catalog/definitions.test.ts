import { shadcnComponentDefinitions } from "@json-render/shadcn/catalog";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { normalizeDefinitions } from "./definitions";
import type { ComponentDefinition } from "./normalize";

const fixtureDefinitions = {
  Fixture: {
    description: "normalization fixture",
    props: z.strictObject({
      title: z.string().nullable(),
      nested: z.strictObject({ note: z.string().nullable() }),
      required: z.string(),
    }),
  },
};

describe("normalizeDefinitions", () => {
  const schema = normalizeDefinitions(fixtureDefinitions).Fixture.props;

  it("allows omitted nullable props at top and nested levels", () => {
    expect(schema.safeParse({ required: "yes", nested: {} }).success).toBe(true);
  });

  it("continues to allow null", () => {
    expect(schema.safeParse({ required: "yes", title: null, nested: { note: null } }).success).toBe(true);
  });

  it("keeps required non-nullable props required", () => {
    expect(schema.safeParse({ nested: {} }).success).toBe(false);
  });

  it("rejects unknown nested keys", () => {
    expect(schema.safeParse({ required: "yes", nested: { surprise: true } }).success).toBe(false);
  });

  it("does not mutate the source shadcn definitions", () => {
    const originalProps = shadcnComponentDefinitions.Card.props;
    const before = originalProps.safeParse({}).success;
    normalizeDefinitions(shadcnComponentDefinitions);
    expect(shadcnComponentDefinitions.Card.props).toBe(originalProps);
    expect(originalProps.safeParse({}).success).toBe(before);
    expect(before).toBe(false);
  });

  it("normalizes custom definitions with the builtin rules", () => {
    const custom = normalizeDefinitions({
      RatingStars: { description: "rating", props: z.strictObject({ label: z.string().nullable() }) },
    });
    expect(custom.RatingStars.props.safeParse({}).success).toBe(true);
  });
});

describe("layout declaration validation", () => {
  const props = z.strictObject({
    gap: z.enum(["none", "sm", "md"]).optional().readonly(),
    padding: z.enum(["sm", "md"]).nullable().default("sm"),
    direction: z.enum(["column", "row", "plain"]),
    wrap: z.boolean().optional(),
    caught: z.string().catch("fallback"),
  });
  const valid = (layout: ComponentDefinition["layout"], overrides: Partial<ComponentDefinition> = {}) => () => normalizeDefinitions({
    Fixture: { props, slots: ["default", "items"], description: "fixture", layout, ...overrides },
  });

  it("accepts wrapped enum subsets and independently validated flow domains", () => {
    expect(valid({ version: 1, spacing: ["gap", "padding"], flow: {
      kind: "flex", direction: { prop: "direction", vertical: ["column"], horizontal: ["row"], none: ["plain"] },
      wrap: { prop: "wrap", enabled: [true] }, slot: "items",
    }})).not.toThrow();
  });

  it.each([
    ["empty layout", valid({ version: 1 })],
    ["duplicate spacing", valid({ version: 1, spacing: ["gap", "gap"] })],
    ["spacer slots", valid({ version: 1, spacer: true })],
    ["spacer spacing", valid({ version: 1, spacer: true, spacing: ["gap"] }, { slots: [] })],
    ["flow without gap", valid({ version: 1, spacing: ["padding"], flow: { kind: "flex", direction: "vertical" } })],
    ["missing spacing prop", valid({ version: 1, spacing: ["paddingX"] })],
    ["missing direction prop", valid({ version: 1, spacing: ["gap"], flow: { kind: "flex", direction: { prop: "missing", vertical: ["a"], horizontal: ["b"] } } })],
    ["same direction/wrap prop", valid({ version: 1, spacing: ["gap"], flow: { kind: "flex", direction: { prop: "direction", vertical: ["column"], horizontal: ["row"] }, wrap: { prop: "direction", enabled: ["plain"] } } })],
    ["empty direction domain", valid({ version: 1, spacing: ["gap"], flow: { kind: "flex", direction: { prop: "direction", vertical: [], horizontal: ["row"] } } })],
    ["non scalar direction", valid({ version: 1, spacing: ["gap"], flow: { kind: "flex", direction: { prop: "direction", vertical: [{} as never], horizontal: ["row"] } } })],
    ["overlapping direction", valid({ version: 1, spacing: ["gap"], flow: { kind: "flex", direction: { prop: "direction", vertical: ["column"], horizontal: ["column"] } } })],
    ["rejected direction value", valid({ version: 1, spacing: ["gap"], flow: { kind: "flex", direction: { prop: "direction", vertical: ["column"], horizontal: ["invalid"] } } })],
    ["empty wrap enabled", valid({ version: 1, spacing: ["gap"], flow: { kind: "flex", direction: "vertical", wrap: { prop: "wrap", enabled: [] } } })],
    ["duplicate wrap enabled", valid({ version: 1, spacing: ["gap"], flow: { kind: "flex", direction: "vertical", wrap: { prop: "wrap", enabled: [true, true] } } })],
    ["rejected wrap value", valid({ version: 1, spacing: ["gap"], flow: { kind: "flex", direction: "vertical", wrap: { prop: "wrap", enabled: ["yes"] } } })],
    ["unknown flow slot", valid({ version: 1, spacing: ["gap"], flow: { kind: "flex", direction: "vertical", slot: "missing" } })],
  ])("rejects %s", (_label, run) => expect(run).toThrow());

  it("rejects non-object roots and non-enum spacing props", () => {
    expect(valid({ version: 1, spacing: ["gap"] }, { props: z.string() })).toThrow(/object props schema/);
    expect(valid({ version: 1, spacing: ["gap"] }, { props: z.object({ gap: z.string() }) })).toThrow(/enum subset/);
    expect(valid({ version: 1, spacing: ["gap"] }, { props: z.object({ gap: z.enum(["sm", "huge"]) }) })).toThrow(/enum subset/);
  });
});
