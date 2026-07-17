import { z } from "zod";
import type { ComponentDefinition } from "../definitions";

/** Collision-proof host-owned type used as the neutral root of flow screens. */
export const FLOW_ROOT_TYPE = "@eui/FlowRoot" as const;

export const flowRootDefinition = {
  props: z.strictObject({}),
  slots: ["default"],
  layoutNeutral: true,
  description: "Neutral block root for flow screens with independently renderable regions.",
} satisfies ComponentDefinition;

