import { describe, expect, it } from "vitest";
import { buildNavigationGraph } from "../prototype/navigationGraph";
import { prototypeDocSchema, type PrototypeDoc } from "../prototype/schema";
import { computeLogicalEdgeRoutes } from "./CjmEdgesOverlay";
import { computeCjmLanes, type CjmLayout } from "./lanesLayout";

const screen = (id: string) => ({
  id,
  name: id,
  spec: { root: "root", elements: { root: { type: "Button", props: { label: id } } } },
});

function makeDoc(main: string[], branches: { id: string; steps: (string | { screenId: string; note: string })[] }[], extra: string[] = []): PrototypeDoc {
  const ids = [...new Set([...main, ...branches.flatMap((flow) => flow.steps.map((step) => typeof step === "string" ? step : step.screenId)), ...extra])];
  return prototypeDocSchema.parse({
    version: 1,
    id: "layout",
    name: "Layout",
    device: "desktop",
    startScreen: main[0],
    state: {},
    screens: ids.map(screen),
    flows: [
      { id: "main", name: "Main", steps: main.map((screenId) => ({ screenId })) },
      ...branches.map((flow) => ({
        id: flow.id,
        name: flow.id,
        steps: flow.steps.map((step) => typeof step === "string" ? { screenId: step } : step),
      })),
    ],
  });
}

const layout = (doc: PrototypeDoc) => computeCjmLanes(doc, buildNavigationGraph(doc));

function expectCoreInvariants(doc: PrototypeDoc, result: CjmLayout) {
  const nodes = result.lanes.flatMap((lane) => lane.nodes);
  expect(new Set(nodes.map((node) => node.key)).size).toBe(nodes.length);
  expect(new Set(nodes.map((node) => `${node.lane}:${node.column}`)).size).toBe(nodes.length);
  expect(new Set(result.edges.map((edge) => edge.key)).size).toBe(result.edges.length);
  const nodeKeys = new Set(nodes.map((node) => node.key));
  for (const edge of result.edges) {
    expect(nodeKeys.has(edge.from), edge.key).toBe(true);
    expect(nodeKeys.has(edge.to), edge.key).toBe(true);
  }
  const mainIndexes = new Map(doc.flows![0]!.steps.map((step, index) => [step.screenId, index]));
  for (const [flowIndex, flow] of doc.flows!.entries()) {
    for (let stepIndex = 0; stepIndex < flow.steps.length - 1; stepIndex += 1) {
      const fromAnchor = mainIndexes.get(flow.steps[stepIndex]!.screenId);
      const toAnchor = mainIndexes.get(flow.steps[stepIndex + 1]!.screenId);
      const expected = flowIndex === 0 || (fromAnchor !== undefined && toAnchor !== undefined)
        ? `main:${fromAnchor ?? stepIndex}`
        : `flow:${flow.id}:${stepIndex}`;
      expect(result.edges.filter((edge) => edge.key === expected), `${flow.id}:${stepIndex}`).toHaveLength(1);
    }
  }
  expect(layout(doc)).toEqual(result);
}

describe("computeCjmLanes", () => {
  it("preserves the legacy linear layout when flows are absent", () => {
    const doc = prototypeDocSchema.parse({
      version: 1, id: "linear", name: "Linear", device: "desktop", startScreen: "a", state: {},
      screens: ["a", "b", "c"].map(screen),
    });
    const result = layout(doc);
    expect(result.linear).toBe(true);
    expect(result.columns).toBe(3);
    expect(result.lanes[0]!.nodes.map((node) => node.column)).toEqual([0, 1, 2]);
    expect(result.tileCount).toBe(3);
  });

  it.each([
    ["leading", ["x", "b"], [1], [0, 2, 3]],
    ["trailing", ["a", "x"], [1], [0, 2, 3]],
    ["anchorless", ["x", "y"], [0, 1], [2, 3, 4]],
  ] as const)("allocates a %s segment in its sentinel gap", (_name, steps, branchColumns, mainColumns) => {
    const doc = makeDoc(["a", "b", "c"], [{ id: "case", steps: [...steps] }]);
    const result = layout(doc);
    expect(result.lanes[0]!.nodes.map((node) => node.column)).toEqual(mainColumns);
    expect(result.lanes[1]!.nodes.map((node) => node.column)).toEqual(branchColumns);
    expect(result.columns).toBe(4 + (steps.length === 2 && steps[0] === "x" && steps[1] === "y" ? 1 : 0));
    expectCoreInvariants(doc, result);
  });

  it.each([
    ["same fork", ["a", "x", "a", "y", "b"], [1, 2]],
    ["retry in the same gap", ["a", "x", "a", "x", "a", "b"], [1, 2]],
    ["leading plus repeated fork", ["x", "b", "y", "a", "z", "b", "c"], [2, 4, 1]],
  ] as const)("uses block allocation for %s", (_name, steps, expectedColumns) => {
    const doc = makeDoc(["a", "b", "c"], [{ id: "branch", steps: [...steps] }]);
    const result = layout(doc);
    expect(result.lanes[1]!.nodes.map((node) => node.column)).toEqual(expectedColumns);
    expectCoreInvariants(doc, result);
  });

  it("covers checkout-declined, backward KYC, and repeated MFA screen scenarios", () => {
    const cases = [
      makeDoc(["catalog", "cart", "delivery", "payment", "success"], [{ id: "declined", steps: ["catalog", "cart", "delivery", "payment", "declined", "payment", "success"] }]),
      makeDoc(["profile", "documents", "review", "approved"], [{ id: "kyc", steps: ["profile", "documents", "review", "missing-document", "documents", "review", "approved"] }]),
      makeDoc(["password", "otp", "dashboard"], [{ id: "mfa", steps: ["password", "otp", "invalid-code", "otp", "dashboard"] }]),
    ];
    for (const doc of cases) expectCoreInvariants(doc, layout(doc));
    expect(layout(cases[1]!).edges.some((edge) => edge.kind === "return")).toBe(true);
    expect(layout(cases[2]!).lanes[1]!.nodes[0]!.screenId).toBe("invalid-code");
  });

  it("keeps branch-owned screen ids and anchor notes on their specified representations", () => {
    const doc = makeDoc(["a", "b"], [
      { id: "first", steps: ["a", "shared", "b"] },
      { id: "second", steps: ["a", { screenId: "shared", note: "Own tile" }, { screenId: "b", note: "Hidden anchor note" }] },
    ]);
    const result = layout(doc);
    expect(result.lanes[2]!.nodes[0]).toMatchObject({ screenId: "shared", note: "Own tile", anchor: false });
    expect(result.lanes[2]!.nodes).toHaveLength(1);
    expectCoreInvariants(doc, result);
  });

  it("does not let unassigned screens affect grid columns or tileCount", () => {
    const baseline = layout(makeDoc(["a", "b"], [{ id: "branch", steps: ["a", "x", "b"] }]));
    const withUnassigned = layout(makeDoc(["a", "b"], [{ id: "branch", steps: ["a", "x", "b"] }], ["u1", "u2"]));
    expect(withUnassigned.columns).toBe(baseline.columns);
    expect(withUnassigned.tileCount).toBe(baseline.tileCount);
    expect(withUnassigned.unassigned).toEqual(["u1", "u2"]);
  });

  it("uses the maximum per-lane footprint and the reviewed columns formula", () => {
    const doc = makeDoc(["a", "b", "c"], [
      { id: "wide", steps: ["a", "x", "a", "y", "b", "c"] },
      { id: "narrow", steps: ["a", "z", "b", "c"] },
    ]);
    const result = layout(doc);
    // gap(0)=max(2,1), all other gaps are zero: L + ΣgapWidth = 3 + 2.
    expect(result.columns).toBe(5);
    expect(result.lanes[0]!.nodes.map((node) => node.column)).toEqual([0, 3, 4]);
    expectCoreInvariants(doc, result);
  });
});

describe("computeLogicalEdgeRoutes", () => {
  const intersectsInterior = (a: { x: number; y: number }, b: { x: number; y: number }, node: { column: number; lane: number }) => {
    const left = node.column - 0.32;
    const right = node.column + 0.32;
    const top = node.lane - 0.32;
    const bottom = node.lane + 0.32;
    if (a.x === b.x) return a.x > left && a.x < right && Math.max(Math.min(a.y, b.y), top) < Math.min(Math.max(a.y, b.y), bottom);
    if (a.y === b.y) return a.y > top && a.y < bottom && Math.max(Math.min(a.x, b.x), left) < Math.min(Math.max(a.x, b.x), right);
    return true;
  };

  it("keeps every logical segment out of every non-endpoint tile", () => {
    const doc = makeDoc(["a", "b", "c"], [
      { id: "backward", steps: ["a", "x", "b", "y", "a", "b", "c"] },
      { id: "forward", steps: ["a", "z", "b", "c"] },
    ]);
    const result = layout(doc);
    const routing = computeLogicalEdgeRoutes(result);
    const nodes = result.lanes.flatMap((lane) => lane.nodes);
    for (const route of routing.routes) {
      for (let index = 0; index < route.points.length - 1; index += 1) {
        for (const node of nodes.filter((item) => item.key !== route.edge.from && item.key !== route.edge.to)) {
          expect(intersectsInterior(route.points[index]!, route.points[index + 1]!, node), `${route.edge.key} crosses ${node.key}`).toBe(false);
        }
      }
    }
  });

  it("colors both row and column channels deterministically at maximum flow density", () => {
    const branches = Array.from({ length: 11 }, (_, index) => ({ id: `flow-${index}`, steps: ["a", `x-${index}`, "b"] }));
    const doc = makeDoc(["a", "b"], branches);
    const result = layout(doc);
    const routing = computeLogicalEdgeRoutes(result);
    expect(doc.flows).toHaveLength(12);
    expect(routing.maxRowChannels).toBeGreaterThan(1);
    expect(routing.maxColumnChannels).toBeGreaterThan(1);
    expect(routing.rowGap).toBe(32 + 8 * routing.maxRowChannels);
    expect(routing.columnGap).toBe(40 + 8 * routing.maxColumnChannels);
    expect(computeLogicalEdgeRoutes(result)).toEqual(routing);
  });
});
