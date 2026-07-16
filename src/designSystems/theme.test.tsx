import { render, cleanup } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThemeContent } from "../api/client";
import { cssEscapeString, flattenTokens, iconRegistry, serializeThemeCss, ThemeStyle, tokenCssVar } from "./theme";

// cleanup() unmounts, which triggers ThemeStyle's insertion-effect cleanup to restore the prior
// runtime snapshot — so we must not delete the shared global (that would pollute other test files
// sharing the worker realm).
afterEach(() => {
  cleanup();
  if (globalThis.__easyUiShared) {
    delete globalThis.__easyUiShared.tokens;
    delete globalThis.__easyUiShared.icons;
  }
});

const token = (key: string) => {
  const tokens = globalThis.__easyUiShared?.tokens ?? {};
  return Object.hasOwn(tokens, key) ? String(tokens[key]) : "";
};
const activeCss = () => document.head.querySelector<HTMLStyleElement>("style[data-eui-theme]")?.textContent ?? "";
const colorTheme = (color: string): ThemeContent => ({ tokens: { "color.primary": color }, fonts: [], icons: [] });

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

  it("leaves the --eui-space-* namespace exclusively to SurfaceSpacingScope", () => {
    const css = serializeThemeCss({ tokens: { "space.md": "20px", "color.primary": "red" }, fonts: [], icons: [] });
    expect(css).not.toContain("--eui-space-md");
    expect(css).toContain("--eui-color-primary");
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
    render(<ThemeStyle content={theme} />);
    const style = document.head.querySelector("style[data-eui-theme]");
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
    render(<ThemeStyle content={null} />);
    expect(document.head.querySelector("style[data-eui-theme]")).toBeNull();
    expect(globalThis.__easyUiShared?.tokens).toBeUndefined();
  });

  it("keeps the later non-empty owner active through a non-LIFO unmount", () => {
    const a = render(<ThemeStyle content={colorTheme("A")} />);
    const b = render(<ThemeStyle content={colorTheme("B")} />);
    expect(document.head.querySelectorAll("style[data-eui-theme]")).toHaveLength(1);
    expect(activeCss()).toContain("--eui-color-primary: B");
    expect(token("color.primary")).toBe("B");
    a.unmount();
    expect(activeCss()).toContain("--eui-color-primary: B");
    expect(token("color.primary")).toBe("B");
    b.unmount();
  });

  it("uses registration order for opposite content resolve orders", () => {
    const first = render(<><ThemeStyle content={null} /><ThemeStyle content={null} /></>);
    first.rerender(<><ThemeStyle content={null} /><ThemeStyle content={colorTheme("B")} /></>);
    first.rerender(<><ThemeStyle content={colorTheme("A")} /><ThemeStyle content={colorTheme("B")} /></>);
    expect(activeCss()).toContain("--eui-color-primary: B");
    expect(token("color.primary")).toBe("B");
    first.unmount();

    const second = render(<><ThemeStyle content={null} /><ThemeStyle content={null} /></>);
    second.rerender(<><ThemeStyle content={colorTheme("A")} /><ThemeStyle content={null} /></>);
    second.rerender(<><ThemeStyle content={colorTheme("A")} /><ThemeStyle content={colorTheme("B")} /></>);
    expect(activeCss()).toContain("--eui-color-primary: B");
    expect(token("color.primary")).toBe("B");
  });

  it("updates content without changing owner priority and falls back when content becomes null", () => {
    const view = render(<><ThemeStyle content={colorTheme("A")} /><ThemeStyle content={colorTheme("B")} /></>);
    view.rerender(<><ThemeStyle content={colorTheme("A2")} /><ThemeStyle content={colorTheme("B2")} /></>);
    expect(activeCss()).toContain("--eui-color-primary: B2");
    expect(token("color.primary")).toBe("B2");
    view.rerender(<><ThemeStyle content={colorTheme("A2")} /><ThemeStyle content={null} /></>);
    expect(activeCss()).toContain("--eui-color-primary: A2");
    expect(token("color.primary")).toBe("A2");
  });

  it("is stable under StrictMode effect replay", () => {
    const view = render(<StrictMode><ThemeStyle content={colorTheme("strict")} /></StrictMode>);
    expect(document.head.querySelectorAll("style[data-eui-theme]")).toHaveLength(1);
    expect(token("color.primary")).toBe("strict");
    view.unmount();
    expect(document.head.querySelector("style[data-eui-theme]")).toBeNull();
  });

  it("reuses the manager across module reloads", async () => {
    const oldOwner = render(<ThemeStyle content={colorTheme("old")} />);
    vi.resetModules();
    const { ThemeStyle: ReloadedThemeStyle } = await import("./theme");
    const newOwner = render(<ReloadedThemeStyle content={colorTheme("new")} />);
    expect(document.head.querySelectorAll("style[data-eui-theme]")).toHaveLength(1);
    expect(token("color.primary")).toBe("new");
    newOwner.unmount();
    expect(token("color.primary")).toBe("old");
    oldOwner.unmount();
  });

  it("restores an exact pre-manager baseline after the last owner unmounts", () => {
    const shared = globalThis.__easyUiShared!;
    const baselineTokens = { baseline: "yes" };
    const baselineIcons = { baseline: { assetUrl: "/baseline.svg" } };
    shared.tokens = baselineTokens;
    shared.icons = baselineIcons;
    const a = render(<ThemeStyle content={colorTheme("A")} />);
    const b = render(<ThemeStyle content={colorTheme("B")} />);
    a.unmount();
    b.unmount();
    expect(shared.tokens).toBe(baselineTokens);
    expect(shared.icons).toBe(baselineIcons);
  });

  it("repairs a partial shared global when the theme effect runs before a later shared import", async () => {
    globalThis.__easyUiShared = { tokens: { baseline: "yes" } } as unknown as typeof globalThis.__easyUiShared;
    const view = render(<ThemeStyle content={null} />);
    expect(globalThis.__easyUiShared?.react).toBeDefined();
    expect(globalThis.__easyUiShared?.tokens).toEqual({ baseline: "yes" });
    const { ensureEasyUiShared } = await import("../customComponents/shared");
    expect(ensureEasyUiShared()).toMatchObject({ react: expect.any(Object), zod: expect.any(Object), tokens: { baseline: "yes" } });
    view.unmount();
  });
});
