import { shadcnComponentDefinitions } from "@json-render/shadcn";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { normalizeDefinitions } from "./definitions";

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
});
