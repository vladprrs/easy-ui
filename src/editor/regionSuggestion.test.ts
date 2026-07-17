import { describe, expect, it } from "vitest";
import { FLOW_ROOT_TYPE } from "../catalog/hostPrimitives/flowRoot.definition";
import type { PrototypeDoc, RegionKind } from "../prototype/schema";
import { suggestRegion } from "./regionSuggestion";

type Screen = PrototypeDoc["screens"][number];

function makeScreen({
  type,
  position,
  canvas,
  rootType = FLOW_ROOT_TYPE,
  region,
  occupied,
}: {
  type: string;
  position: "first" | "middle" | "last" | "only" | "nested";
  canvas?: boolean;
  rootType?: string;
  region?: RegionKind;
  occupied?: RegionKind;
}): Screen {
  const rootChildren = position === "first"
    ? ["target", "middle", "tail"]
    : position === "last"
      ? ["head", "middle", "target"]
      : position === "only"
        ? ["target"]
        : position === "nested"
          ? ["wrapper", "tail"]
          : ["head", "target", "tail"];
  return {
    id: "home",
    name: "Home",
    ...(canvas ? { canvas: { width: 390, height: 844 } } : {}),
    spec: {
      root: "root",
      elements: {
        root: { type: rootType, props: {}, children: rootChildren },
        head: { type: "Content", props: {}, ...(occupied ? { region: occupied } : {}) },
        middle: { type: "Content", props: {}, ...(occupied && position === "first" ? { region: occupied } : {}) },
        tail: { type: "Content", props: {} },
        wrapper: { type: "Stack", props: {}, children: ["target"] },
        target: { type, props: {}, ...(region ? { region } : {}) },
      },
    },
  };
}

describe("suggestRegion", () => {
  it.each([
    ["StatusBar", "first", "statusBar"],
    ["STATUS-BAR", "first", "statusBar"],
    ["status_bar", "only", "statusBar"],
    ["App Bar", "first", "header"],
    ["top_bar", "first", "header"],
    ["NavBar", "first", "header"],
    ["Footer", "last", "footer"],
    ["tab-bar", "last", "footer"],
    ["BottomNav", "last", "footer"],
    ["bottom_bar", "last", "footer"],
  ] as const)("suggests %s at %s as %s", (type, position, expected) => {
    expect(suggestRegion(makeScreen({ type, position }), "target")).toBe(expected);
  });

  it("prioritizes statusBar when the first child name matches statusBar and header", () => {
    expect(suggestRegion(makeScreen({ type: "StatusBarHeader", position: "only" }), "target")).toBe("statusBar");
  });

  it.each([
    ["status bar without the first position", makeScreen({ type: "StatusBar", position: "middle" })],
    ["header without the first position", makeScreen({ type: "Header", position: "middle" })],
    ["footer without the last position", makeScreen({ type: "Footer", position: "middle" })],
    ["a nested element", makeScreen({ type: "Header", position: "nested" })],
    ["an ineligible root", makeScreen({ type: "Header", position: "first", rootType: "CustomRoot" })],
    ["a canvas screen", makeScreen({ type: "Header", position: "first", canvas: true })],
    ["an existing marker", makeScreen({ type: "Header", position: "first", region: "header" })],
    ["an occupied kind", makeScreen({ type: "Header", position: "first", occupied: "header" })],
    ["a non-matching name", makeScreen({ type: "Toolbar", position: "first" })],
  ])("does not suggest for %s", (_label, screen) => {
    expect(suggestRegion(screen, "target")).toBeNull();
  });
});
