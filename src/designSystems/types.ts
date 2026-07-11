import type { ComponentType } from "react";
import type { ComponentDefinition } from "../catalog/normalize";

export const atomicLevels = ["atom", "molecule", "organism", "template", "page"] as const;
export type AtomicLevel = (typeof atomicLevels)[number];

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
