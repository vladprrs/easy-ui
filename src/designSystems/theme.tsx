import { useEffect, useInsertionEffect, useState } from "react";
import { getDesignSystemById, getDesignSystemVersion, type ThemeContent } from "../api/client";
import type { EasyUiSharedIcon, EasyUiSharedTokens } from "../customComponents/shared";

// Delivery of a versioned design-system theme (F.4): tokens become CSS custom properties, fonts
// become @font-face rules, and both tokens and the icon registry are mirrored into the shared
// runtime snapshot so the `easy-ui/runtime` shim's token()/Icon resolve them. Every string that
// reaches CSS is produced only from the server-validated grammar and additionally escaped here.

const assetUrl = (id: string): string => `/api/assets/${encodeURIComponent(id)}`;

/** CSS-safe escaping for a token string value (grammar already bans ;{}<>; this hardens the rest). */
export function cssEscapeString(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    // Escape backslash, control chars, and quotes so a value cannot break out of the declaration.
    if (ch === "\\" || ch === '"' || ch === "'" || code < 0x20 || code === 0x7f) out += `\\${code.toString(16)} `;
    else out += ch;
  }
  return out;
}

/** `color.bg-muted` -> `--eui-color-bg-muted`. */
export function tokenCssVar(key: string): string {
  return `--eui-${key.replace(/\./g, "-")}`;
}

function tokenValueCss(value: string | number): string {
  return typeof value === "number" ? String(value) : cssEscapeString(value);
}

/** Flat map key -> string|number for the runtime snapshot (shim `token()` reads this). */
export function flattenTokens(content: ThemeContent): EasyUiSharedTokens {
  const out: EasyUiSharedTokens = {};
  for (const [key, value] of Object.entries(content.tokens)) out[key] = value;
  return out;
}

/** name -> {assetUrl, viewBox?, themes?} for the runtime snapshot (shim `Icon` reads this). */
export function iconRegistry(content: ThemeContent): Record<string, EasyUiSharedIcon> {
  const out: Record<string, EasyUiSharedIcon> = {};
  for (const icon of content.icons) {
    out[icon.name] = {
      assetUrl: assetUrl(icon.assetId),
      ...(icon.viewBox ? { viewBox: icon.viewBox } : {}),
      ...(icon.themes ? { themes: { ...(icon.themes.light ? { light: assetUrl(icon.themes.light) } : {}), ...(icon.themes.dark ? { dark: assetUrl(icon.themes.dark) } : {}) } } : {}),
    };
  }
  return out;
}

/** Serializes a validated theme into a stylesheet: :root custom properties + @font-face rules. */
export function serializeThemeCss(content: ThemeContent): string {
  const declarations = Object.entries(content.tokens)
    .filter(([key]) => !key.startsWith("space."))
    .map(([key, value]) => `${tokenCssVar(key)}: ${tokenValueCss(value)};`);
  const root = declarations.length ? `:root{${declarations.join("")}}` : "";
  const fonts = content.fonts.map((font) => {
    const parts = [`font-family: "${cssEscapeString(font.family)}";`, `src: url("${assetUrl(font.src)}");`];
    if (font.weight !== undefined) parts.push(`font-weight: ${typeof font.weight === "number" ? font.weight : cssEscapeString(font.weight)};`);
    if (font.style !== undefined) parts.push(`font-style: ${cssEscapeString(font.style)};`);
    return `@font-face{${parts.join("")}}`;
  }).join("");
  return `${root}${fonts}`;
}

/**
 * Renders a `<style data-eui-theme>` tag and mirrors the theme into the shared runtime snapshot.
 * The style tag is committed to the DOM before the surface's settle effect runs, so `document.fonts`
 * reflects the injected @font-face. The snapshot is populated in an insertion effect and restored on
 * cleanup so unmount leaves no stale tokens/icons behind.
 */
export function ThemeStyle({ content }: { content: ThemeContent | null }) {
  useInsertionEffect(() => {
    if (typeof globalThis === "undefined") return;
    const shared = (globalThis.__easyUiShared ??= {} as unknown as NonNullable<typeof globalThis.__easyUiShared>);
    const prevTokens = shared.tokens;
    const prevIcons = shared.icons;
    shared.tokens = content ? flattenTokens(content) : {};
    shared.icons = content ? iconRegistry(content) : {};
    return () => { shared.tokens = prevTokens; shared.icons = prevIcons; };
  }, [content]);

  if (!content) return null;
  return <style data-eui-theme>{serializeThemeCss(content)}</style>;
}

/** Fetches the theme content for a system: the pinned version, or the latest for head (metaVersion null). */
export function useDesignSystemTheme(designSystem: string | undefined, metaVersion: number | null | undefined): ThemeContent | null {
  const [content, setContent] = useState<ThemeContent | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      if (!designSystem) { if (!controller.signal.aborted) setContent(null); return; }
      try {
        const data = metaVersion != null
          ? await getDesignSystemVersion(designSystem, metaVersion, controller.signal)
          : await getDesignSystemById(designSystem, controller.signal);
        if (!controller.signal.aborted) setContent({ tokens: data.tokens ?? {}, fonts: data.fonts ?? [], icons: data.icons ?? [] });
      } catch { if (!controller.signal.aborted) setContent({ tokens: {}, fonts: [], icons: [] }); }
    })();
    return () => controller.abort();
  }, [designSystem, metaVersion]);
  return content;
}
