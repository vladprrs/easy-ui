import { FLOW_ROOT_TYPE } from "../catalog/hostPrimitives/flowRoot.definition";
import { analyzeScreenRegions } from "./runtimeSpec";
import type { PrototypeDoc } from "./schema";
import type { ValidationIssue } from "./types";

type Screen = PrototypeDoc["screens"][number];

export type RegionEligibility =
  | { eligible: true; reason: null }
  | { eligible: false; reason: "canvas" | "flow-root" };

/** Shared coarse authoring gate. Detailed structural checks live in preflight. */
export function regionEligibility(screen: Screen): RegionEligibility {
  if (screen.canvas) return { eligible: false, reason: "canvas" };
  const root = screen.spec.elements[screen.spec.root];
  if (root?.type !== FLOW_ROOT_TYPE) return { eligible: false, reason: "flow-root" };
  return { eligible: true, reason: null };
}

const pointer = (parts: (string | number)[]) => `/${parts.map(String).join("/")}`;

/** Adapts the common authored-spec preflight into prototype validation issues. */
export function validateRegionRules(doc: PrototypeDoc): ValidationIssue[] {
  return doc.screens.flatMap((screen, screenIndex) => analyzeScreenRegions(screen).issues.map((entry) => ({
    path: pointer(["screens", screenIndex, "spec", ...entry.path]),
    message: entry.message,
  })));
}

