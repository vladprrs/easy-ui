import type { ComponentType } from "react";
import type { ComponentDefinition } from "../catalog/normalize";

export const atomicLevels = ["atom", "molecule", "organism", "template", "page"] as const;
export type AtomicLevel = (typeof atomicLevels)[number];

export const spaceToken = ["none", "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"] as const;
export const spaceTokens = spaceToken;
export type SpaceToken = (typeof spaceToken)[number];
export const layoutSpacingProps = ["gap", "padding", "paddingX", "paddingY"] as const;
export type LayoutSpacingProp = (typeof layoutSpacingProps)[number];
export type LayoutJsonScalar = string | number | boolean | null;

export type LayoutFlow = {
  kind: "flex";
  direction: "vertical" | "horizontal" | {
    prop: string;
    vertical: LayoutJsonScalar[];
    horizontal: LayoutJsonScalar[];
    none?: LayoutJsonScalar[];
  };
  wrap?: { prop: string; enabled: LayoutJsonScalar[] };
  slot?: string;
};

export type ComponentLayout = {
  version: 1;
  spacing?: LayoutSpacingProp[];
  spacer?: true;
  flow?: LayoutFlow;
};

export const atomicRank: Record<AtomicLevel, number> = {
  atom: 1,
  molecule: 2,
  organism: 3,
  template: 4,
  page: 5,
};

export interface DesignSystem {
  id: string;
  name: string;
  description: string;
  definitions: Record<string, ComponentDefinition>;
  components: Record<string, ComponentType<never>>;
  fixtures: Record<string, Record<string, unknown>>;
}
