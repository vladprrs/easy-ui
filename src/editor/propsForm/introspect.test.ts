import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describePropsSchema } from "./introspect";

describe("describePropsSchema", () => {
  it("describes scalar controls, literal unions, wrappers, defaults, and pipe inputs", () => {
    const fields = describePropsSchema(z.object({
      text: z.string(),
      choice: z.enum(["a", "b"]),
      numbers: z.union([z.literal(1), z.literal(2)]),
      literal: z.literal("only"),
      enabled: z.boolean(),
      amount: z.number(),
      optional: z.string().optional(),
      nullable: z.string().nullable(),
      defaulted: z.string().default("value"),
      readonly: z.boolean().readonly(),
      caught: z.number().catch(1),
      prefault: z.string().prefault("input"),
      piped: z.string().pipe(z.string().transform((value) => value.length)),
      nested: z.object({ value: z.string() }),
    }))!;
    expect(Object.fromEntries(fields.map((field) => [field.name, field.control.kind]))).toEqual({
      text: "text", choice: "select", numbers: "select", literal: "select", enabled: "switch",
      amount: "number", optional: "text", nullable: "text", defaulted: "text", readonly: "switch",
      caught: "number", prefault: "text", piped: "text", nested: "json",
    });
    expect(fields.find((field) => field.name === "numbers")!.control).toEqual({ kind: "select", options: [1, 2] });
    expect(fields.find((field) => field.name === "optional")).toMatchObject({ required: false, nullable: false });
    expect(fields.find((field) => field.name === "nullable")).toMatchObject({ required: true, nullable: true });
    expect(fields.find((field) => field.name === "defaulted")).toMatchObject({ required: false, defaultValue: "value" });
  });

  it("returns null for a non-object schema", () => {
    expect(describePropsSchema(z.string())).toBeNull();
  });

});
