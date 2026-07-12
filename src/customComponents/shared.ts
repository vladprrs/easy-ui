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

globalThis.__easyUiShared ??= easyUiShared;
