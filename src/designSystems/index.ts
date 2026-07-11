import { shadcnSystem } from "./shadcn";

export const DEFAULT_DESIGN_SYSTEM_ID = "shadcn";

export const designSystems = {
  shadcn: shadcnSystem,
} as const;

export function getDesignSystem(id: string) {
  const system = designSystems[id as keyof typeof designSystems];
  if (!system) throw new Error(`Unknown design system: ${id}`);
  return system;
}

export function resolveDefinitions(id: string) {
  return getDesignSystem(id).definitions;
}
