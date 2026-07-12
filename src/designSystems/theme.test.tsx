import { render, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ThemeContent } from "../api/client";
import { cssEscapeString, flattenTokens, iconRegistry, serializeThemeCss, ThemeStyle, tokenCssVar } from "./theme";

// cleanup() unmounts, which triggers ThemeStyle's insertion-effect cleanup to restore the prior
// runtime snapshot — so we must not delete the shared global (that would pollute other test files
// sharing the worker realm).
afterEach(() => { cleanup(); });

const theme: ThemeContent = {
  tokens: { "color.primary": "#123456", "spacing.lg": 24, "font.family": "Inter, sans-serif" },
  fonts: [{ family: "Inter", src: `asset_${"a".repeat(64)}`, weight: 500, style: "italic" }],
  icons: [{ name: "close", assetId: `asset_${"b".repeat(64)}`, viewBox: "0 0 24 24", themes: { dark: `asset_${"c".repeat(64)}` } }],
};

describe("theme serialization", () => {
  it("maps dotted token keys to --eui- CSS custom properties", () => {
    expect(tokenCssVar("color.bg-muted")).toBe("--eui-color-bg-muted");
  });

  it("serializes tokens into :root custom properties and fonts into @font-face", () => {
    const css = serializeThemeCss(theme);
    expect(css).toContain(":root{");
    expect(css).toContain("--eui-color-primary: #123456;");
    expect(css).toContain("--eui-spacing-lg: 24;");
    expect(css).toContain('@font-face{font-family: "Inter";');
    expect(css).toContain(`src: url("/api/assets/asset_${"a".repeat(64)}");`);
    expect(css).toContain("font-weight: 500;");
    expect(css).toContain("font-style: italic;");
  });

  it("escapes dangerous characters in string token values", () => {
    // Grammar bans ;{}<> but backslashes/quotes are still escaped as CSS hex sequences.
    expect(cssEscapeString('a"b\\c')).toBe("a\\22 b\\5c c");
    const css = serializeThemeCss({ tokens: { "x.y": 'a"b' }, fonts: [], icons: [] });
    expect(css).toContain("--eui-x-y: a\\22 b;");
  });

  it("builds a flat token map and an icon registry with resolved asset URLs", () => {
    expect(flattenTokens(theme)).toEqual({ "color.primary": "#123456", "spacing.lg": 24, "font.family": "Inter, sans-serif" });
    expect(iconRegistry(theme)).toEqual({
      close: { assetUrl: `/api/assets/asset_${"b".repeat(64)}`, viewBox: "0 0 24 24", themes: { dark: `/api/assets/asset_${"c".repeat(64)}` } },
    });
  });
});

describe("ThemeStyle runtime snapshot", () => {
  it("populates __easyUiShared.tokens/icons and injects a data-eui-theme style", () => {
    const { container } = render(<ThemeStyle content={theme} />);
    const style = container.querySelector("style[data-eui-theme]");
    expect(style).not.toBeNull();
    expect(style!.textContent).toContain("--eui-color-primary");
    expect(globalThis.__easyUiShared?.tokens).toEqual(flattenTokens(theme));
    expect(globalThis.__easyUiShared?.icons?.close?.assetUrl).toBe(`/api/assets/asset_${"b".repeat(64)}`);
  });

  it("restores the previous snapshot on unmount (cleanup)", () => {
    const { unmount } = render(<ThemeStyle content={theme} />);
    expect(globalThis.__easyUiShared?.tokens).toEqual(flattenTokens(theme));
    unmount();
    // Cleanup restores the prior (undefined) snapshot values.
    expect(globalThis.__easyUiShared?.tokens).toBeUndefined();
    expect(globalThis.__easyUiShared?.icons).toBeUndefined();
  });

  it("renders nothing and clears the snapshot when content is null", () => {
    const { container } = render(<ThemeStyle content={null} />);
    expect(container.querySelector("style[data-eui-theme]")).toBeNull();
    expect(globalThis.__easyUiShared?.tokens).toEqual({});
  });
});
