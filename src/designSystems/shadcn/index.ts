import { shadcnComponents } from "@json-render/shadcn";
import { shadcnComponentDefinitions } from "@json-render/shadcn/catalog";
import { hotspotDefinition } from "../../catalog/hotspot.definition";
import { Hotspot } from "../../catalog/hotspot";
import { normalizeDefinitions, type ComponentDefinition } from "../../catalog/normalize";
import { createFixtures } from "../fixtures";
import type { DesignSystem } from "../types";
import { shadcnAtomicLevels, shadcnLayoutNeutral } from "./atomicLevels";
import { ShadcnImage } from "./image";
import { shadcnFixtureOverrides } from "./overrides";

export const sourceComponentDefinitions = {
  ...shadcnComponentDefinitions,
  Hotspot: hotspotDefinition,
};

const classifiedDefinitions = Object.fromEntries(
  Object.entries(sourceComponentDefinitions).map(([name, definition]) => [name, {
    ...definition,
    atomicLevel: shadcnAtomicLevels[name as keyof typeof shadcnAtomicLevels],
    ...(shadcnLayoutNeutral.has(name) ? { layoutNeutral: true } : {}),
  }]),
) as unknown as {
  [Name in keyof typeof sourceComponentDefinitions]:
    (typeof sourceComponentDefinitions)[Name] & Pick<ComponentDefinition, "atomicLevel" | "layoutNeutral">;
};

export const componentDefinitions = normalizeDefinitions(classifiedDefinitions);
// Image is a local wrapper: adds an onError placeholder over the upstream component (W0-2).
export const shadcnComponentsWithHotspot = { ...shadcnComponents, Image: ShadcnImage, Hotspot };
export const fixtures = createFixtures(componentDefinitions, shadcnFixtureOverrides);

export const shadcnSystem: DesignSystem = {
  id: "shadcn",
  name: "Shadcn",
  description: "Accessible shadcn/ui components for polished product interfaces.",
  definitions: componentDefinitions,
  components: shadcnComponentsWithHotspot as unknown as DesignSystem["components"],
  fixtures: fixtures as unknown as DesignSystem["fixtures"],
};
