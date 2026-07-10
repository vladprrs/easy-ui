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

declare global {
  var __easyUiShared: typeof easyUiShared | undefined;
}

globalThis.__easyUiShared ??= easyUiShared;
