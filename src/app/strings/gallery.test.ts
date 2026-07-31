import { describe, expect, it } from "vitest";
import { gallery } from "./gallery";

const title = (count: number | null) => `${count === null ? gallery.heroFallback : gallery.heroAccent(count)} ${gallery.heroRest(count)}`;

describe("gallery hero copy", () => {
  it.each([
    [1, "1 прототип, который ощущается как продукт"],
    [2, "2 прототипа, которые ощущаются как продукт"],
    [5, "5 прототипов, которые ощущаются как продукт"],
    [11, "11 прототипов, которые ощущаются как продукт"],
    [21, "21 прототип, который ощущается как продукт"],
  ])("agrees the prototype count %i", (count, expected) => {
    expect(title(count)).toBe(expected);
  });

  it("uses the fallback title and singular subtitle deliberately", () => {
    expect(title(null)).toBe("Прототипы, которые ощущаются как продукт");
    expect(gallery.subtitle(1)).toBe("Агент быстро собирает его из компонентов вашей дизайн-системы.");
    expect(gallery.subtitle(2)).toBe("Агент быстро собирает их из компонентов вашей дизайн-системы.");
  });
});
