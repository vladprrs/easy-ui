import { describe, expect, it } from "vitest";
import {
  FLOWS_LIMIT,
  FLOW_STEPS_LIMIT,
  FLOW_TOTAL_STEPS_LIMIT,
  inputPrototypeDocSchema,
  storedPrototypeDocSchema,
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
  const result = inputPrototypeDocSchema.safeParse(value);
  return result.success ? [] : result.error.issues;
};

describe("prototype flows schema", () => {
  it("accepts omitted flows and rejects an explicitly empty array", () => {
    expect(inputPrototypeDocSchema.safeParse(doc(["a"])).success).toBe(true);
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
    expect(inputPrototypeDocSchema.safeParse(doc(["a", "b", "x"], [
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
    expect(inputPrototypeDocSchema.safeParse(doc(["a", "b", "c"], base)).success).toBe(true);
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
    expect(inputPrototypeDocSchema.safeParse(doc(screens, flows)).success).toBe(true);
  });
});

// План docs/plans/2026-07-29-scrn-gallery-ux.md §4 / T0: авторские правила и лимиты —
// input-only, чтобы откат образа читал и round-trip'ил документы без потерь.
describe("stored branch is rollback-safe", () => {
  const storedIssues = (value: unknown) => {
    const result = storedPrototypeDocSchema.safeParse(value);
    return result.success ? [] : result.error.issues;
  };
  const child = (id: string, parentId: string, steps: string[]) => ({ ...flow(id, steps), parentId });

  it("reads a document with parentId and a violated authoring rule that the input branch rejects", () => {
    // Соседние неконсекутивные main-якоря: [a, c] при главной линии [a, b, c].
    const value = doc(["a", "b", "c"], [flow("main", ["a", "b", "c"]), child("slice", "main", ["a", "c"])]);
    const stored = storedPrototypeDocSchema.safeParse(value);
    expect(stored.success).toBe(true);
    expect(stored.data?.flows?.[1]).toMatchObject({ id: "slice", parentId: "main" });
    expect(issues(value))
      .toContainEqual(expect.objectContaining({ message: "adjacent main-flow anchors must be consecutive in the forward direction" }));
  });

  it.each([
    {
      name: "FLOWS_LIMIT",
      value: () => doc(["a"], Array.from({ length: FLOWS_LIMIT + 1 }, (_, index) => flow(`flow-${index}`, ["a"]))),
    },
    {
      name: "FLOW_STEPS_LIMIT",
      value: () => {
        const ids = Array.from({ length: FLOW_STEPS_LIMIT + 1 }, (_, index) => `s-${index}`);
        return doc(ids, [flow("main", ids)]);
      },
    },
    {
      name: "FLOW_TOTAL_STEPS_LIMIT",
      value: () => {
        const ids = Array.from({ length: 50 }, (_, index) => `s-${index}`);
        return doc(ids, Array.from({ length: Math.floor(FLOW_TOTAL_STEPS_LIMIT / 50) + 1 }, (_, index) => flow(`flow-${index}`, ids)));
      },
    },
    {
      name: "adjacent equal steps",
      value: () => doc(["a", "x"], [flow("main", ["a"]), flow("retry", ["a", "x", "x"])]),
    },
    {
      name: "main flow must start at startScreen",
      value: () => doc(["a", "b"], [flow("main", ["b"])]),
    },
    {
      name: "unique screens in the main flow",
      value: () => doc(["a", "b"], [flow("main", ["a", "b", "a"])]),
    },
  ])("reads a document violating $name that the input branch rejects", ({ value }) => {
    const input = value();
    expect(storedPrototypeDocSchema.safeParse(input).success).toBe(true);
    expect(inputPrototypeDocSchema.safeParse(input).success).toBe(false);
  });

  it("round-trips parentId through both branches without loss", () => {
    const value = doc(["a", "b"], [flow("main", ["a", "b"]), child("leaf", "main", ["b"])]);
    for (const schema of [inputPrototypeDocSchema, storedPrototypeDocSchema]) {
      const parsed = schema.parse(value);
      expect(parsed.flows?.[1]?.parentId).toBe("main");
      // Повторный проход по обеим ветками: сохранение (input) и чтение (stored) идемпотентны.
      expect(inputPrototypeDocSchema.safeParse(parsed).success).toBe(true);
      expect(storedPrototypeDocSchema.parse(parsed).flows?.[1]?.parentId).toBe("main");
    }
  });

  it("still rejects structural invariants on the stored branch", () => {
    expect(storedIssues({ ...doc(["a", "b"]), startScreen: "missing" }))
      .toContainEqual(expect.objectContaining({ path: ["startScreen"], message: "startScreen must reference an existing screen" }));
    expect(storedIssues(doc(["a"], [flow("main", ["a", "missing"])])))
      .toContainEqual(expect.objectContaining({ path: ["flows", 0, "steps", 1, "screenId"], message: "flow step must reference an existing screen" }));
    expect(storedIssues(doc(["a", "a"])))
      .toContainEqual(expect.objectContaining({ path: ["screens", 1, "id"], message: "screen id must be unique" }));
    expect(storedIssues(doc(["a"], [flow("main", ["a"]), flow("main", ["a"])])))
      .toContainEqual(expect.objectContaining({ path: ["flows", 1, "id"], message: "flow id must be unique" }));
    // Неизвестный ключ по-прежнему отвергается обеими ветками (strictObject).
    expect(storedIssues(doc(["a"], [{ ...flow("main", ["a"]), tags: ["x"] }]))).not.toEqual([]);
  });

  it("accepts every repository fixture on both branches", () => {
    const files = import.meta.glob("../../../test/fixtures/*.json", { eager: true, import: "default" });
    expect(Object.keys(files).length).toBeGreaterThan(0);
    for (const [filename, document] of Object.entries(files)) {
      // Часть фикстур предшествует полю designSystem (stored-ветка подставляет дефолт).
      const input = { designSystem: "shadcn", ...(document as Record<string, unknown>) };
      expect(inputPrototypeDocSchema.safeParse(input).success, `${filename} (input)`).toBe(true);
      expect(storedPrototypeDocSchema.safeParse(document).success, `${filename} (stored)`).toBe(true);
    }
  });
});
