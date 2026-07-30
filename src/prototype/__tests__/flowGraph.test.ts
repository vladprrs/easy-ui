import { describe, expect, it } from "vitest";
import { buildFlowTree, flattenFlowTree, flowBreadcrumb, screenFlowIndex, type DocFlow } from "../flowGraph";

const flow = (id: string, steps: string[], parentId?: string): DocFlow => ({
  id,
  name: id.toUpperCase(),
  steps: steps.map((screenId) => ({ screenId })),
  ...(parentId === undefined ? {} : { parentId }),
});

/** Дерево из §1 плана: главный экран → переводы → перевод по телефону → квитанция. */
const tree: DocFlow[] = [
  flow("main", ["home", "transfers"]),
  flow("transfers", ["transfers", "phone"], "main"),
  flow("phone", ["phone", "receipt"], "transfers"),
  flow("receipt", ["receipt"], "phone"),
  flow("cards", ["home", "cards"], "main"),
];

const shape = (nodes: ReturnType<typeof buildFlowTree>) =>
  flattenFlowTree(nodes).map((node) => [node.flow.id, node.depth, node.path.join("/")]);

describe("buildFlowTree", () => {
  it("returns an empty forest for absent or empty flows", () => {
    expect(buildFlowTree(undefined)).toEqual([]);
    expect(buildFlowTree([])).toEqual([]);
  });

  it("treats a flat list as a forest of roots at depth 1", () => {
    const roots = buildFlowTree([flow("main", ["a"]), flow("branch", ["a", "b"])]);
    expect(roots).toHaveLength(2);
    expect(shape(roots)).toEqual([["main", 1, "main"], ["branch", 1, "branch"]]);
    expect(roots.every((node) => node.children.length === 0)).toBe(true);
  });

  it("nests by parentId with root = level 1 and a DFS traversal order", () => {
    const roots = buildFlowTree(tree);
    expect(roots.map((node) => node.flow.id)).toEqual(["main"]);
    // DFS, а не порядок массива: `cards` (индекс 4) идёт после всего поддерева `transfers`.
    expect(shape(roots)).toEqual([
      ["main", 1, "main"],
      ["transfers", 2, "main/transfers"],
      ["phone", 3, "main/transfers/phone"],
      ["receipt", 4, "main/transfers/phone/receipt"],
      ["cards", 2, "main/cards"],
    ]);
    expect(roots[0]!.children.map((node) => node.flow.id)).toEqual(["transfers", "cards"]);
  });

  it("keeps children in array order under the same parent", () => {
    const roots = buildFlowTree([flow("main", ["a"]), flow("b", ["a"], "main"), flow("c", ["a"], "main"), flow("d", ["a"], "main")]);
    expect(roots[0]!.children.map((node) => node.flow.id)).toEqual(["b", "c", "d"]);
  });

  it.each([
    ["a dangling parentId", [flow("main", ["a"]), flow("orphan", ["a"], "nope")]],
    ["a self reference", [flow("main", ["a"]), flow("self", ["a"], "self")]],
    ["a forward reference", [flow("main", ["a"]), flow("early", ["a"], "late"), flow("late", ["a"])]],
  ])("degrades %s to a root instead of throwing", (_name, flows) => {
    const roots = buildFlowTree(flows);
    expect(roots.map((node) => node.flow.id)).toContain(flows[1]!.id);
    expect(flattenFlowTree(roots)).toHaveLength(flows.length);
    expect(flattenFlowTree(roots).every((node) => node.depth >= 1)).toBe(true);
  });

  it("binds children to the first flow with a duplicated id", () => {
    const flows = [flow("main", ["a"]), flow("dup", ["a"], "main"), flow("dup", ["a"], "main"), flow("leaf", ["a"], "dup")];
    const roots = buildFlowTree(flows);
    const dup = roots[0]!.children[0]!;
    expect(dup.index).toBe(1);
    expect(dup.children.map((node) => node.flow.id)).toEqual(["leaf"]);
    expect(flattenFlowTree(roots)).toHaveLength(4);
  });

  it("exposes the array index of every node", () => {
    expect(flattenFlowTree(buildFlowTree(tree)).map((node) => node.index)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("flowBreadcrumb", () => {
  it("returns the chain from the root down to the flow itself", () => {
    expect(flowBreadcrumb(tree, "receipt").map((item) => item.id)).toEqual(["main", "transfers", "phone", "receipt"]);
    expect(flowBreadcrumb(tree, "main").map((item) => item.id)).toEqual(["main"]);
    expect(flowBreadcrumb(tree, "cards").map((item) => item.id)).toEqual(["main", "cards"]);
  });

  it("returns an empty chain for unknown flows and absent flows", () => {
    expect(flowBreadcrumb(tree, "missing")).toEqual([]);
    expect(flowBreadcrumb(undefined, "main")).toEqual([]);
  });

  it("terminates on a self reference", () => {
    const flows = [flow("main", ["a"]), flow("self", ["a"], "self")];
    expect(flowBreadcrumb(flows, "self").map((item) => item.id)).toEqual(["self"]);
  });
});

describe("screenFlowIndex", () => {
  it("maps every screen to the flows and step indexes it participates in", () => {
    const index = screenFlowIndex({ flows: tree });
    expect(index.get("home")).toEqual([{ flowId: "main", stepIndex: 0 }, { flowId: "cards", stepIndex: 0 }]);
    expect(index.get("receipt")).toEqual([{ flowId: "phone", stepIndex: 1 }, { flowId: "receipt", stepIndex: 0 }]);
    expect(index.get("cards")).toEqual([{ flowId: "cards", stepIndex: 1 }]);
  });

  it("works on today's flat flows and omits screens outside any scenario", () => {
    const index = screenFlowIndex({ flows: [flow("main", ["a", "b"]), flow("branch", ["a", "x", "b"])] });
    expect([...index.keys()]).toEqual(["a", "b", "x"]);
    expect(index.get("a")).toEqual([{ flowId: "main", stepIndex: 0 }, { flowId: "branch", stepIndex: 0 }]);
    expect(index.has("unassigned")).toBe(false);
  });

  it("returns an empty index for a document without flows", () => {
    expect(screenFlowIndex({ flows: undefined }).size).toBe(0);
  });
});
