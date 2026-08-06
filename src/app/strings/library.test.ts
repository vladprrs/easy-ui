import { describe, expect, it } from "vitest";
import { figmaBadgeTitle } from "./library";

// План 2026-08-06 §W1: тултип чипа Figma показывает primary-документ и, если lineage
// многодокументный, количество дополнительных источников.
describe("figma badge title", () => {
  it("keeps the pre-W1 wording when there are no extra sources", () => {
    expect(figmaBadgeTitle("core-file", 2)).toBe("Figma core-file · 2 узла");
    expect(figmaBadgeTitle("core-file", 2, 0)).toBe("Figma core-file · 2 узла");
  });

  it.each([
    [1, "Figma core-file · 1 узел · +1 источник"],
    [2, "Figma core-file · 1 узел · +2 источника"],
    [5, "Figma core-file · 1 узел · +5 источников"],
  ])("appends %i extra sources", (sourceCount, expected) => {
    expect(figmaBadgeTitle("core-file", 1, sourceCount)).toBe(expected);
  });
});
