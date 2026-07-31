import { afterEach, describe, expect, it } from "vitest";
import type { ThemeContent } from "../api/client";
import { acquireThemeFonts, fontRegistryKey, resetFontRegistryForTests } from "./fontRegistry";

afterEach(() => {
  resetFontRegistryForTests();
  Reflect.deleteProperty(document, "fonts");
});

const asset = (letter: string) => `asset_${letter.repeat(64)}`;
const theme = (families: string[]): ThemeContent =>
  ({ tokens: {}, fonts: families.map((family, index) => ({ family, src: asset(String.fromCharCode(97 + index)) })), icons: [] });

/** jsdom не даёт настоящий FontFaceSet — подменяем итерацию по семействам документа. */
function stubDocumentFonts(families: string[]) {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { forEach: (fn: (face: { family: string }) => void) => families.map((family) => ({ family })).forEach(fn) },
  });
}

const styles = () => Array.from(document.head.querySelectorAll<HTMLStyleElement>("style[data-eui-fonts]"));

describe("fontRegistry", () => {
  it("emits one style per designSystem@metaVersion and refcounts it", () => {
    const content = theme(["Inter"]);
    const first = acquireThemeFonts("yandex-pay", 7, content);
    const second = acquireThemeFonts("yandex-pay", 7, content);
    expect(styles()).toHaveLength(1);
    expect(styles()[0].dataset.euiFonts).toBe(fontRegistryKey("yandex-pay", 7));
    expect(styles()[0].textContent).toContain('font-family: "Inter";');

    first();
    expect(styles()).toHaveLength(1);
    first(); // release идемпотентен
    expect(styles()).toHaveLength(1);
    second();
    expect(styles()).toHaveLength(0);
  });

  it("keeps different systems and different meta versions apart", () => {
    const release = [
      acquireThemeFonts("yandex-pay", 7, theme(["Inter"])),
      acquireThemeFonts("yandex-pay", 8, theme(["Inter"])),
      acquireThemeFonts("other", 7, theme(["Inter"])),
    ];
    expect(styles().map((style) => style.dataset.euiFonts)).toEqual(["yandex-pay@7", "yandex-pay@8", "other@7"]);
    for (const dispose of release) dispose();
    expect(styles()).toHaveLength(0);
  });

  it("treats a missing metaVersion as head", () => {
    expect(fontRegistryKey("ds", null)).toBe("ds@head");
    expect(fontRegistryKey("ds", undefined)).toBe("ds@head");
  });

  it("does not redeclare a family already available to the document", () => {
    stubDocumentFonts(['"YS Text"']);
    const release = acquireThemeFonts("yandex-pay", 7, theme(["YS Text", "Inter"]));
    const css = styles()[0].textContent ?? "";
    expect(css).not.toContain("YS Text");
    expect(css).toContain('font-family: "Inter";');
    release();
  });

  it("injects no style at all when every family is already available", () => {
    stubDocumentFonts(["YS Text"]);
    const release = acquireThemeFonts("yandex-pay", 7, theme(["YS Text"]));
    expect(styles()).toHaveLength(0);
    release();
    expect(styles()).toHaveLength(0);
  });
});
