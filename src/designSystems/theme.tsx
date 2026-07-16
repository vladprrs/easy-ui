import { useEffect, useInsertionEffect, useState } from "react";
import { getDesignSystemById, getDesignSystemVersion, type ThemeContent } from "../api/client";
import { ensureEasyUiShared, type EasyUiSharedIcon, type EasyUiSharedTokens } from "../customComponents/shared";

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

interface ThemeOwner { order: number; content: ThemeContent | null }
interface ThemeManagerState {
  nextOrder: number;
  owners: Map<symbol, ThemeOwner>;
  style: HTMLStyleElement | null;
  baseline: {
    tokens: EasyUiSharedTokens | undefined;
    icons: Record<string, EasyUiSharedIcon> | undefined;
    hadTokens: boolean;
    hadIcons: boolean;
  } | null;
}

const themeManagerKey = Symbol.for("easy-ui.theme-manager.v1");
type GlobalWithThemeManager = typeof globalThis & { [themeManagerKey]?: ThemeManagerState };

function themeManager(): ThemeManagerState {
  const host = globalThis as GlobalWithThemeManager;
  return host[themeManagerKey] ?? (host[themeManagerKey] = { nextOrder: 0, owners: new Map(), style: null, baseline: null });
}

function allocateThemeOwner(): { id: symbol; order: number } {
  const manager = themeManager();
  return { id: Symbol("easy-ui-theme-owner"), order: ++manager.nextOrder };
}

function applyActiveTheme(manager: ThemeManagerState) {
  const shared = ensureEasyUiShared();
  const active = [...manager.owners.values()]
    .filter((owner): owner is ThemeOwner & { content: ThemeContent } => owner.content !== null)
    .reduce<(ThemeOwner & { content: ThemeContent }) | null>((winner, owner) => !winner || owner.order > winner.order ? owner : winner, null);

  if (!active) {
    manager.style?.remove();
    manager.style = null;
    if (manager.baseline) {
      if (manager.baseline.hadTokens) shared.tokens = manager.baseline.tokens;
      else delete shared.tokens;
      if (manager.baseline.hadIcons) shared.icons = manager.baseline.icons;
      else delete shared.icons;
    }
    if (manager.owners.size === 0) manager.baseline = null;
    return;
  }

  if (!manager.style || !manager.style.isConnected) {
    manager.style = document.createElement("style");
    manager.style.dataset.euiTheme = "";
    document.head.append(manager.style);
  }
  manager.style.textContent = serializeThemeCss(active.content);
  shared.tokens = flattenTokens(active.content);
  shared.icons = iconRegistry(active.content);
}

function registerThemeOwner(id: symbol, order: number) {
  const manager = themeManager();
  if (manager.owners.size === 0 && manager.baseline === null) {
    const shared = ensureEasyUiShared();
    manager.baseline = {
      tokens: shared.tokens,
      icons: shared.icons,
      hadTokens: Object.hasOwn(shared, "tokens"),
      hadIcons: Object.hasOwn(shared, "icons"),
    };
  }
  manager.owners.set(id, { order, content: null });
  applyActiveTheme(manager);
}

function updateThemeOwner(id: symbol, content: ThemeContent | null) {
  const manager = themeManager();
  const owner = manager.owners.get(id);
  if (!owner) return;
  owner.content = content;
  applyActiveTheme(manager);
}

function unregisterThemeOwner(id: symbol) {
  const manager = themeManager();
  manager.owners.delete(id);
  applyActiveTheme(manager);
}

/** Thin owner client for the document-wide, single-active-theme manager. */
export function ThemeStyle({ content }: { content: ThemeContent | null }) {
  const [owner] = useState(allocateThemeOwner);
  useInsertionEffect(() => {
    registerThemeOwner(owner.id, owner.order);
    return () => unregisterThemeOwner(owner.id);
  }, [owner]);
  useInsertionEffect(() => updateThemeOwner(owner.id, content), [content, owner]);
  return null;
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
