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
 * Source of the `/api/shims/v2/easy-ui-runtime.js` module. `token(key)` reads
 * from the (currently empty) `globalThis.__easyUiShared.tokens` snapshot that
 * T8 will populate; `Icon` is a signature-fixed stub that renders nothing until
 * T8 wires the icon registry.
 */
export function emitEasyUiRuntimeShim(): string {
  return [
    "const shared = globalThis.__easyUiShared ?? {};",
    "const React = shared.react;",
    "export function token(key) {",
    "  const tokens = shared.tokens ?? {};",
    "  return Object.prototype.hasOwnProperty.call(tokens, key) ? String(tokens[key]) : \"\";",
    "}",
    "export function Icon(_props) {",
    "  return null;",
    "}",
    "void React;",
    "",
  ].join("\n");
}

export { emitShim };
