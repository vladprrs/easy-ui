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

/**
 * Синтетический документ **мимо zod**: гейт масштабирования для T4 (подъём
 * `FLOW_TOTAL_STEPS_LIMIT`). Каждый дочерний флоу — вставка `stepsPerFlow`
 * собственных экранов в gap главной линии; флоу раскладываются по gap'ам по кругу.
 */
function syntheticDoc(mainLength: number, flowCount: number, stepsPerFlow: number): PrototypeDoc {
  const main = Array.from({ length: mainLength }, (_, index) => `main-${index}`);
  const flows = [
    { id: "main", name: "Main", steps: main.map((screenId) => ({ screenId })) },
    ...Array.from({ length: flowCount }, (_, flowIndex) => {
      const gap = flowIndex % (mainLength - 1);
      const inner = Array.from({ length: stepsPerFlow }, (_, step) => `branch-${flowIndex}-${step}`);
      return {
        id: `branch-${flowIndex}`,
        name: `Branch ${flowIndex}`,
        steps: [main[gap]!, ...inner, main[gap + 1]!].map((screenId) => ({ screenId })),
      };
    }),
  ];
  const ids = [...new Set(flows.flatMap((flow) => flow.steps.map((step) => step.screenId)))];
  return {
    version: 1, id: "synthetic", name: "Synthetic", designSystem: "shadcn", device: "mobile",
    startScreen: main[0]!, state: {}, screens: ids.map(screen), flows,
  } as unknown as PrototypeDoc;
}

const authoredSteps = (doc: PrototypeDoc) => doc.flows!.reduce((sum, flow) => sum + flow.steps.length, 0);

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

  // Гейт масштабирования для T4: рост геометрии — функция шагов и занятых gap'ов,
  // а не числа флоу (обоснование подъёма FLOWS_LIMIT, план §7 T1).
  it.each([
    [6, 3, 2, 6 + 2 * 3, 6 + 3 * 2, 18],
    [6, 11, 2, 6 + 2 * 5, 6 + 11 * 2, 50],
    [10, 23, 3, 10 + 3 * 9, 10 + 23 * 3, 125],
    [20, 20, 12, 20 + 12 * 19, 20 + 20 * 12, 300],
  ])("scales lanes for main=%i branches=%i inner steps=%i", (mainLength, flowCount, stepsPerFlow, columns, tileCount, steps) => {
    const doc = syntheticDoc(mainLength, flowCount, stepsPerFlow);
    expect(authoredSteps(doc)).toBe(steps);
    const result = layout(doc);
    expect(result.lanes).toHaveLength(flowCount + 1);
    expect(result.columns).toBe(columns);
    expect(result.tileCount).toBe(tileCount);
    expect(result.unassigned).toEqual([]);
    expectCoreInvariants(doc, result);
  });

  // План §3: фильтр «дорожки только по корневым флоу» действует **исключительно** на
  // геометрию; покрытие (`assigned`/`unassigned`) считается по `doc.flows` целиком.
  describe("child flows (parentId)", () => {
    const withChild = (childSteps: string[]) => prototypeDocSchema.parse({
      version: 1, id: "tree", name: "Tree", device: "desktop", startScreen: "a", state: {},
      screens: ["a", "b", "x", "deep", "outside"].map(screen),
      flows: [
        { id: "main", name: "Main", steps: ["a", "b"].map((screenId) => ({ screenId })) },
        { id: "branch", name: "Branch", steps: ["a", "x", "b"].map((screenId) => ({ screenId })) },
        { id: "leaf", name: "Leaf", parentId: "branch", steps: childSteps.map((screenId) => ({ screenId })) },
      ],
    });

    it("gives a child flow no lane of its own and leaves the geometry untouched", () => {
      const baseline = layout(makeDoc(["a", "b"], [{ id: "branch", steps: ["a", "x", "b"] }], ["deep", "outside"]));
      const result = layout(withChild(["deep"]));
      expect(result.lanes.map((lane) => lane.key)).toEqual(["flow:main", "flow:branch"]);
      expect(result.columns).toBe(baseline.columns);
      expect(result.tileCount).toBe(baseline.tileCount);
      expect(result.edges).toEqual(baseline.edges);
      expect(result.linear).toBe(false);
    });

    it("counts screens of child flows as assigned: unassigned must not include them", () => {
      const result = layout(withChild(["deep"]));
      // `deep` живёт только в дочернем флоу — дорожки его не рисуют, но покрытие видит.
      expect(result.unassigned).toEqual(["outside"]);
      expect(result.lanes.flatMap((lane) => lane.nodes).some((node) => node.screenId === "deep")).toBe(false);
    });

    it("keeps a child flow out of the branch-segment indexing (columns stay aligned)", () => {
      // Дочерний флоу объявлен раньше второй корневой ветки: если бы фильтр применялся
      // не везде, индексы branchSegments разъехались бы на единицу.
      const doc = prototypeDocSchema.parse({
        version: 1, id: "order", name: "Order", device: "desktop", startScreen: "a", state: {},
        screens: ["a", "b", "c", "x", "y", "deep"].map(screen),
        flows: [
          { id: "main", name: "Main", steps: ["a", "b", "c"].map((screenId) => ({ screenId })) },
          { id: "leaf", name: "Leaf", parentId: "main", steps: ["deep"].map((screenId) => ({ screenId })) },
          { id: "first", name: "First", steps: ["a", "x", "b"].map((screenId) => ({ screenId })) },
          { id: "second", name: "Second", steps: ["b", "y", "c"].map((screenId) => ({ screenId })) },
        ],
      });
      const result = layout(doc);
      expect(result.lanes.map((lane) => lane.key)).toEqual(["flow:main", "flow:first", "flow:second"]);
      expect(result.lanes[1]!.nodes.map((node) => node.column)).toEqual([1]);
      expect(result.lanes[2]!.nodes.map((node) => node.column)).toEqual([3]);
      expect(result.lanes[0]!.nodes.map((node) => node.column)).toEqual([0, 2, 4]);
      expect(result.columns).toBe(5);
      expect(result.unassigned).toEqual([]);
    });

    it("falls back to the linear layout when no root flow is left", () => {
      const doc = prototypeDocSchema.parse({
        version: 1, id: "degenerate", name: "Degenerate", device: "desktop", startScreen: "a", state: {},
        screens: ["a", "b"].map(screen),
        // Stored-ветка авторских правил не исполняет: такой документ может прийти с отката.
        flows: [{ id: "orphan", name: "Orphan", parentId: "gone", steps: [{ screenId: "a" }] }],
      });
      const result = layout(doc);
      expect(result.linear).toBe(true);
      expect(result.columns).toBe(2);
    });
  });

  /**
   * Подпись дорожки (план 2026-07-31, W3-3). Сегментов у ветки несколько, и `gap`
   * для anchorless равен −1, поэтому подпись выводится из явных якорей сегмента,
   * а не из `gap`.
   */
  describe("lane origin", () => {
    it("labels the first fork, a merge-only branch and an anchorless one", () => {
      const doc = makeDoc(["a", "b", "c"], [
        // Ветка отходит от «b» и позже ещё раз от «a» — подписывается первая по шагам.
        { id: "fork", steps: ["b", "x", "c"] },
        { id: "leading", steps: ["y", "b"] },
        { id: "detached", steps: ["z1", "z2"] },
      ]);
      const result = layout(doc);
      // Главная дорожка соотносить не с чем — подписи у неё нет.
      expect(result.lanes[0]!.origin).toBeUndefined();
      expect(result.lanes[1]!.origin).toEqual({ kind: "fork", step: 2 });
      expect(result.lanes[2]!.origin).toEqual({ kind: "merge", step: 2 });
      expect(result.lanes[3]!.origin).toEqual({ kind: "detached" });
      expectCoreInvariants(doc, result);
    });

    it("takes the earliest fork when a branch leaves the main line several times", () => {
      const doc = makeDoc(["a", "b", "c"], [{ id: "twice", steps: ["a", "x", "b", "y", "c"] }]);
      expect(layout(doc).lanes[1]!.origin).toEqual({ kind: "fork", step: 1 });
    });

    it("gives no caption to a branch that owns no tiles at all", () => {
      // Все шаги ветки — якоря главной линии: собственных сегментов нет, и подписывать
      // в дорожках нечего.
      const doc = makeDoc(["a", "b", "c"], [{ id: "anchors-only", steps: ["a", "b"] }]);
      const result = layout(doc);
      expect(result.lanes[1]!.nodes).toEqual([]);
      expect(result.lanes[1]!.origin).toBeUndefined();
    });
  });

  it("grows inserted columns with steps per flow, not with the number of flows", () => {
    const wide = layout(syntheticDoc(6, 5, 4));
    const manyFlows = layout(syntheticDoc(6, 20, 4));
    // Пять флоу уже заняли все пять gap'ов: следующие 15 добавляют только дорожки.
    expect(manyFlows.columns).toBe(wide.columns);
    expect(manyFlows.lanes).toHaveLength(21);
    expect(layout(syntheticDoc(6, 5, 8)).columns).toBe(6 + 8 * 5);
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
