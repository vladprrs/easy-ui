import { ABI_V1, emitShim, type ShimName } from "./abi-v1";

/**
 * ABI v2 = ABI v1 (react/react-dom/jsx-runtime/zod/json-render-react) plus the
 * `easy-ui/runtime` module. The standard shim code is identical to v1 (it reads
 * from `globalThis.__easyUiShared`); only the served URL prefix differs, so ABI
 * v2 components resolve a coherent set of `/api/shims/v2/*` URLs.
 */
export const EASY_UI_RUNTIME_FILE = "easy-ui-runtime.js";

export function isV2StandardShim(name: string): name is ShimName {
  return Object.hasOwn(ABI_V1, name);
}

/**
 * Source of the `/api/shims/v2/easy-ui-runtime.js` module. `token(key)` and
 * `Icon` read from the `globalThis.__easyUiShared` theme snapshot populated by
 * the design-system theme injector; without an injected theme both degrade to
 * empty string / null.
 */
export function emitEasyUiRuntimeShim(): string {
  return [
    "const shared = globalThis.__easyUiShared ?? {};",
    "const React = shared.react;",
    "export function token(key) {",
    "  const tokens = shared.tokens ?? {};",
    "  return Object.prototype.hasOwnProperty.call(tokens, key) ? String(tokens[key]) : \"\";",
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
