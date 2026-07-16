import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as ReactDOM from "react-dom";
import * as zod from "zod";
import * as jsonRenderReact from "@json-render/react";

export const easyUiShared = {
  react: React,
  "react-jsx-runtime": jsxRuntime,
  "react-dom": ReactDOM,
  zod,
  "json-render-react": jsonRenderReact,
};

/** Flat token snapshot read by the `easy-ui/runtime` shim's `token(key)`. */
export type EasyUiSharedTokens = Record<string, string | number>;
/** Icon registry entry read by the shim's `Icon`; asset URLs are pre-resolved. */
export interface EasyUiSharedIcon { assetUrl: string; viewBox?: string; themes?: { light?: string; dark?: string } }
/** Runtime-injected theme snapshot (populated by the design-system theme injector, T8). */
export interface EasyUiSharedTheme {
  tokens?: EasyUiSharedTokens;
  icons?: Record<string, EasyUiSharedIcon>;
}

declare global {
  var __easyUiShared: (typeof easyUiShared & EasyUiSharedTheme) | undefined;
}

/**
 * Installs the host modules without replacing theme state that may already have
 * been installed by the theme manager. This intentionally fills individual
 * keys: an older/partially initialized global must be repairable in-place.
 */
export function ensureEasyUiShared(): NonNullable<typeof globalThis.__easyUiShared> {
  const shared = globalThis.__easyUiShared ?? (globalThis.__easyUiShared = {} as NonNullable<typeof globalThis.__easyUiShared>);
  for (const [key, value] of Object.entries(easyUiShared)) {
    const moduleKey = key as keyof typeof easyUiShared;
    if (shared[moduleKey] === undefined) Object.assign(shared, { [moduleKey]: value });
  }
  return shared;
}

ensureEasyUiShared();
