import { describe, expect, it } from "vitest";
import { buildNavigationGraph, verifyEdge } from "../navigationGraph";
import { prototypeDocSchema } from "../schema";

const makeScreen = (id: string, elements: Record<string, unknown> = {}) => ({
  id,
  name: id,
  spec: { root: "root", elements: { root: { type: "Text", props: { text: id } }, ...elements } },
});

describe("navigationGraph", () => {
  it("collects static navigate targets from every event and action, including $if actions", () => {
    const doc = prototypeDocSchema.parse({
      version: 1, id: "graph", name: "Graph", designSystem: "shadcn", startScreen: "a", state: {},
      screens: [
        makeScreen("a", {
          control: {
            type: "Widget", props: {},
            on: {
              press: [{ action: "setState", params: {} }, { action: "navigate", params: { screenId: "b" }, $if: { $event: "/ok" } }],
              submit: { action: "navigate", params: { screenId: "c" } },
            },
          },
        }),
        makeScreen("b"),
        makeScreen("c"),
      ],
    });
    const graph = buildNavigationGraph(doc);
    expect(graph.edges.get("a")).toEqual(new Set(["b", "c"]));
    expect(verifyEdge(graph, "a", "b")).toBe("static");
    expect(verifyEdge(graph, "b", "a")).toBe("missing");
  });

  it("records dynamic sources without making an edge and gives static precedence", () => {
    const doc = prototypeDocSchema.parse({
      version: 1, id: "dynamic", name: "Dynamic", designSystem: "shadcn", startScreen: "a", state: {},
      screens: [
        makeScreen("a", { control: { type: "Widget", props: {}, on: { press: [
          { action: "navigate", params: { screenId: { $event: "/target" } } },
          { action: "navigate", params: { screenId: "b" } },
          { action: "back", params: {} },
          { action: "restart", params: {} },
        ] } } }),
        makeScreen("b"), makeScreen("c"),
      ],
    });
    const graph = buildNavigationGraph(doc);
    expect(graph.dynamicSources).toEqual(new Set(["a"]));
    expect(graph.edges.get("a")).toEqual(new Set(["b"]));
    expect(verifyEdge(graph, "a", "b")).toBe("static");
    expect(verifyEdge(graph, "a", "c")).toBe("dynamic");
    expect(verifyEdge(graph, "b", "c")).toBe("missing");
  });
});
