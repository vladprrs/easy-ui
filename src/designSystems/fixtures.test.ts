import { z } from "zod";
import { describe, expect, it } from "vitest";
import { createFixtures } from "./fixtures";

describe("createFixtures", () => {
  it("prefers definition examples, falls back to overrides, and does not mutate inputs", () => {
    const definitions = {
      Example: { props: z.object({}), description: "example", example: { label: "from example" } },
      Override: { props: z.object({}), description: "override" },
    };
    const overrides = { Example: { label: "ignored" }, Override: { label: "from override" } };

    const result = createFixtures(definitions, overrides);

    expect(result.Example.props).toEqual({ label: "from example" });
    expect(result.Override.props).toEqual({ label: "from override" });
    expect(result.Example.children).toEqual([]);
    expect(definitions.Example).not.toHaveProperty("type");
    expect(overrides.Override).toEqual({ label: "from override" });
  });
});
