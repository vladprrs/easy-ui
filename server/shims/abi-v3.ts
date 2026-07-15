import { canonicalSpacingScale } from "../../src/designSystems/spacingScale";
import { spaceTokens } from "../../src/designSystems/types";
import { ABI_V1, emitShim, type ShimName } from "./abi-v1";

export const EASY_UI_RUNTIME_V3_FILE = "easy-ui-runtime.js";

export function isV3StandardShim(name: string): name is ShimName {
  return Object.hasOwn(ABI_V1, name);
}

/** ABI v3 preserves token()/Icon from v2 and adds typed, surface-scoped spacing. */
export function emitEasyUiRuntimeV3Shim(): string {
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
