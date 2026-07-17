import { describe, expect, it } from "vitest";
import {
  FLOWS_LIMIT,
  FLOW_STEPS_LIMIT,
  FLOW_TOTAL_STEPS_LIMIT,
  prototypeDocSchema,
} from "../schema";

const screen = (id: string) => ({
  id,
  name: id,
  spec: { root: "root", elements: { root: { type: "Text", props: { text: id } } } },
});

function doc(screenIds: string[], flows?: unknown) {
  return {
    version: 1,
    id: "flow-test",
    name: "Flow test",
    designSystem: "shadcn",
    startScreen: screenIds[0],
    state: {},
    screens: screenIds.map(screen),
    ...(flows === undefined ? {} : { flows }),
  };
}

const flow = (id: string, steps: string[]) => ({ id, name: id, steps: steps.map((screenId) => ({ screenId })) });
const issues = (value: unknown) => {
  const result = prototypeDocSchema.safeParse(value);
  return result.success ? [] : result.error.issues;
};

describe("prototype flows schema", () => {
  it("accepts omitted flows and rejects an explicitly empty array", () => {
    expect(prototypeDocSchema.safeParse(doc(["a"])).success).toBe(true);
    expect(issues(doc(["a"], [])).some((entry) => entry.path.join("/") === "flows")).toBe(true);
  });

  it("enforces unique flow ids", () => {
    expect(issues(doc(["a"], [flow("main", ["a"]), flow("main", ["a"])])))
      .toContainEqual(expect.objectContaining({ path: ["flows", 1, "id"], message: "flow id must be unique" }));
  });

  it("requires every step to reference an existing screen", () => {
    expect(issues(doc(["a"], [flow("main", ["a", "missing"])])))
      .toContainEqual(expect.objectContaining({ path: ["flows", 0, "steps", 1, "screenId"], message: "flow step must reference an existing screen" }));
  });

  it("rejects equal adjacent steps but permits repeated non-adjacent non-anchors", () => {
    expect(issues(doc(["a", "x"], [flow("main", ["a"]), flow("retry", ["a", "x", "x"])])))
      .toContainEqual(expect.objectContaining({ path: ["flows", 1, "steps", 2, "screenId"], message: "adjacent flow steps must reference different screens" }));
    expect(prototypeDocSchema.safeParse(doc(["a", "b", "x"], [
      flow("main", ["a", "b"]),
      flow("retry", ["a", "x", "a", "x", "b"]),
    ])).success).toBe(true);
  });

  it("requires the main flow to start at startScreen and contain unique screens", () => {
    expect(issues(doc(["a", "b"], [flow("main", ["b"])])))
      .toContainEqual(expect.objectContaining({ path: ["flows", 0, "steps", 0, "screenId"], message: "main flow must start at startScreen" }));
    expect(issues(doc(["a", "b"], [flow("main", ["a", "b", "a"])])))
      .toContainEqual(expect.objectContaining({ path: ["flows", 0, "steps", 2, "screenId"], message: "screen ids in the main flow must be unique" }));
  });

  it("allows only forward-adjacent pairs of main anchors", () => {
    const base = [flow("main", ["a", "b", "c"]), flow("branch", ["a", "b", "c"])];
    expect(prototypeDocSchema.safeParse(doc(["a", "b", "c"], base)).success).toBe(true);
    for (const steps of [["a", "c"], ["c", "b"]]) {
      expect(issues(doc(["a", "b", "c"], [flow("main", ["a", "b", "c"]), flow("branch", steps)])))
        .toContainEqual(expect.objectContaining({ message: "adjacent main-flow anchors must be consecutive in the forward direction" }));
    }
  });

  it("enforces per-document and per-flow limits", () => {
    const tooManyFlows = Array.from({ length: FLOWS_LIMIT + 1 }, (_, index) => flow(`flow-${index}`, ["a"]));
    expect(issues(doc(["a"], tooManyFlows)).some((entry) => entry.path.join("/") === "flows")).toBe(true);

    const ids = Array.from({ length: FLOW_STEPS_LIMIT + 1 }, (_, index) => `s-${index}`);
    expect(issues(doc(ids, [flow("main", ids)])).some((entry) => entry.path.join("/") === "flows/0/steps")).toBe(true);

    const totalIds = Array.from({ length: 50 }, (_, index) => `s-${index}`);
    const totalFlows = Array.from({ length: Math.floor(FLOW_TOTAL_STEPS_LIMIT / 50) + 1 }, (_, index) => flow(`flow-${index}`, totalIds));
    expect(issues(doc(totalIds, totalFlows)))
      .toContainEqual(expect.objectContaining({ path: ["flows"], message: `flows exceed the total limit of ${FLOW_TOTAL_STEPS_LIMIT} steps` }));
  });

  it.each([
    {
      name: "checkout-declined",
      screens: ["catalog", "cart", "delivery", "payment", "declined", "success"],
      flows: [flow("main", ["catalog", "cart", "delivery", "payment", "success"]), flow("declined", ["catalog", "cart", "delivery", "payment", "declined", "payment", "success"])],
    },
    {
      name: "KYC correction",
      screens: ["profile", "documents", "review", "missing-document", "approved"],
      flows: [flow("main", ["profile", "documents", "review", "approved"]), flow("correction", ["profile", "documents", "review", "missing-document", "documents", "review", "approved"])],
    },
    {
      name: "MFA retry",
      screens: ["password", "otp", "invalid-code", "dashboard"],
      flows: [flow("main", ["password", "otp", "dashboard"]), flow("retry", ["password", "otp", "invalid-code", "otp", "dashboard"])],
    },
  ])("accepts the canonical $name scenario", ({ screens, flows }) => {
    expect(prototypeDocSchema.safeParse(doc(screens, flows)).success).toBe(true);
  });
});
