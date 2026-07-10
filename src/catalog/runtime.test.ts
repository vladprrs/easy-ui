import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createPlayerRuntime } from "./runtime";

const deps = { navigate: () => {}, back: () => {}, openUrl: () => {}, restart: () => {} };

describe("createPlayerRuntime custom manifest", () => {
  it("rejects mismatched definition and component keys", () => {
    expect(() => createPlayerRuntime(deps, {
      definitions: { RatingStars: { description: "rating", props: z.object({ value: z.number() }) } },
      components: {},
    })).toThrow(/keys must match/);
  });
});
