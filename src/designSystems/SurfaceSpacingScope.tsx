import { cloneElement, type CSSProperties, type ReactElement } from "react";
import type { ThemeContent } from "../api/client";
import { resolveSpacingScale } from "./spacingScale";
import { spaceTokens } from "./types";

type SpacingStyle = CSSProperties & Record<`--eui-space-${string}`, string>;

export function surfaceSpacingStyle(systemId: string, themeTokens: ThemeContent["tokens"] = {}): SpacingStyle {
  const scale = resolveSpacingScale(systemId, themeTokens);
  return Object.fromEntries(spaceTokens.map((token) => [`--eui-space-${token}`, scale[token]])) as SpacingStyle;
}

/** Adds the spacing namespace directly to its single stage-root element. */
export function SurfaceSpacingScope({ systemId, themeTokens, children }: {
  systemId: string;
  themeTokens?: ThemeContent["tokens"];
  children: ReactElement<{ style?: CSSProperties }>;
}) {
  return cloneElement(children, { style: { ...children.props.style, ...surfaceSpacingStyle(systemId, themeTokens) } });
}
