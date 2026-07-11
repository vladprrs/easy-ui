import type { DesignSystem } from "../types";
import { createFixtures } from "../fixtures";
import { wireframeComponents } from "./components";
import { wireframeDefinitions } from "./definitions";

export { wireframeComponents } from "./components";
export { wireframeDefinitions, wireframeSourceDefinitions } from "./definitions";

export const wireframeFixtures = createFixtures(wireframeDefinitions);

export const wireframeSystem: DesignSystem = {
  id: "wireframe",
  name: "Wireframe",
  description: "Schematic low-fidelity components for rapidly mapping interface structure.",
  definitions: wireframeDefinitions,
  components: wireframeComponents as unknown as DesignSystem["components"],
  fixtures: wireframeFixtures as unknown as DesignSystem["fixtures"],
};
