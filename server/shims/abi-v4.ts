import { canonicalSpacingScale } from "../../src/designSystems/spacingScale";
import { spaceTokens } from "../../src/designSystems/types";
import { ABI_V1, emitShim, type ShimName } from "./abi-v1";

export const EASY_UI_RUNTIME_V4_FILE = "easy-ui-runtime.js";

export function isV4StandardShim(name: string): name is ShimName {
  return Object.hasOwn(ABI_V1, name);
}

/**
 * ABI v4 preserves token()/Icon/space() from v3 and adds color(key, fallback).
 * color() resolves an open-ended color token to `var(--eui-color-<key>, <fallback>)`,
 * matching `tokenCssVar` in src/designSystems/theme.tsx (a token `color.<key>` is
 * serialized to the custom property `--eui-color-<key>`). The key is an open string
 * (the theme owns the token set, so no closed allowlist is baked into the ABI). The
 * runtime shim is tolerant of a missing fallback; the .d.ts makes fallback mandatory.
 */
export function emitEasyUiRuntimeV4Shim(): string {
  const fallbacks = JSON.stringify(canonicalSpacingScale);
  const allowed = JSON.stringify(spaceTokens);
  return [
    "const shared = globalThis.__easyUiShared ?? {};",
    "const React = shared.react;",
    `const spaceFallbacks = ${fallbacks};`,
    `const spaceTokens = new Set(${allowed});`,
    "export function token(key) {",
    "  const tokens = shared.tokens ?? {};",
    "  return Object.prototype.hasOwnProperty.call(tokens, key) ? String(tokens[key]) : \"\";",
    "}",
    "export function space(key) {",
    "  if (!spaceTokens.has(key)) throw new TypeError(`Unknown space token: ${String(key)}`);",
    "  return `var(--eui-space-${key}, ${spaceFallbacks[key]})`;",
    "}",
    "export function color(key, fallback) {",
    "  const name = `--eui-color-${String(key).replace(/\\./g, \"-\")}`;",
    "  return fallback === undefined ? `var(${name})` : `var(${name}, ${fallback})`;",
    "}",
    "export function Icon(props) {",
    "  const icons = shared.icons ?? {};",
    "  const icon = props && Object.prototype.hasOwnProperty.call(icons, props.name) ? icons[props.name] : undefined;",
    "  if (!icon || !React) return null;",
    "  const themed = props.theme && icon.themes ? icon.themes[props.theme] : undefined;",
    "  const src = themed ?? icon.assetUrl;",
    "  const size = typeof props.size === \"number\" ? props.size : undefined;",
    "  return React.createElement(\"img\", { src, width: size, height: size, alt: props.name, \"data-eui-icon\": props.name });",
    "}",
    "",
  ].join("\n");
}

export { emitShim };
