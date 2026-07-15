import { describe, expect, it } from "vitest";
import { canonicalSpacingScale, resolveSpacingScale, shadcnSpacingScale, wireframeSpacingScale, yandexPaySpacingScale } from "./spacingScale";

describe("resolveSpacingScale", () => {
  it("uses explicit nine-token tables for every builtin family", () => {
    expect(resolveSpacingScale("custom", {})).toEqual(canonicalSpacingScale);
    expect(resolveSpacingScale("wireframe", {})).toEqual(wireframeSpacingScale);
    expect(resolveSpacingScale("yandex-pay", {})).toEqual(yandexPaySpacingScale);
    expect(resolveSpacingScale("shadcn", {})).toEqual(shadcnSpacingScale);
  });

  it("merges valid theme values and synthesizes missing tokens", () => {
    expect(resolveSpacingScale("custom", { "space.md": "14px", "color.brand": "red" })).toEqual({
      ...canonicalSpacingScale, md: "14px",
    });
  });

  it("uses canonical synthesis for missing theme keys even on a non-canonical builtin", () => {
    expect(resolveSpacingScale("wireframe", { "space.md": "14px" })).toEqual({ ...canonicalSpacingScale, md: "14px" });
  });

  it.each([
    { "space.md": 12 },
    { "space.md": "calc(12px)" },
    { "space.unknown": "12px" },
    { "space.none": "1px" },
    { "space.md": "30px" },
  ])("ignores a malformed space group as a whole: %o", (tokens) => {
    expect(resolveSpacingScale("wireframe", tokens as unknown as Record<string, string | number>)).toEqual(canonicalSpacingScale);
  });
});
