import { describe, expect, it } from "vitest";
import type { ScenarioStep } from "../prototype/scenario";
import { SCENARIO_STEPS_LIMIT } from "../prototype/scenario";
import {
  appendClickStep, appendScreenStep, appendStep, elementKeyFromPath, removeStep, scenarioIdFromName, startRecording,
} from "./scenarioRecording";
import { buildStep, describeStep } from "./scenarioPanel";

// Правила рекордера (волна 6): что именно попадает в шаги при клике и навигации.

describe("scenario recording", () => {
  it("starts a recording by pinning the entry screen", () => {
    expect(startRecording("home")).toEqual([{ type: "expectScreen", screenId: "home" }]);
  });

  it("does not repeat the same screen twice in a row", () => {
    const steps = appendScreenStep(startRecording("home"), "home");
    expect(steps).toHaveLength(1);
    expect(appendScreenStep(steps, "done")).toHaveLength(2);
  });

  it("records clicks with a trimmed label and drops the label when the node has no text", () => {
    const withLabel = appendClickStep([], { elementKey: "cta", label: "Продолжить" });
    expect(withLabel[0]).toEqual({ type: "click", elementKey: "cta", label: "Продолжить" });
    expect(appendClickStep([], { elementKey: "cta" })[0]).toEqual({ type: "click", elementKey: "cta" });
  });

  it("stops appending at the step limit", () => {
    const full: ScenarioStep[] = Array.from({ length: SCENARIO_STEPS_LIMIT }, () => ({ type: "expectText", text: "x" }));
    expect(appendStep(full, { type: "expectText", text: "y" })).toHaveLength(SCENARIO_STEPS_LIMIT);
  });

  it("removes a step by index", () => {
    const steps: ScenarioStep[] = [{ type: "expectText", text: "a" }, { type: "expectText", text: "b" }];
    expect(removeStep(steps, 0)).toEqual([{ type: "expectText", text: "b" }]);
  });

  it("finds the nearest data-eui-key ancestor with its label", () => {
    const outer = document.createElement("div");
    outer.setAttribute("data-eui-key", "card");
    const inner = document.createElement("span");
    inner.setAttribute("data-eui-key", "cta");
    inner.textContent = "  Продолжить\n ";
    outer.append(inner);
    expect(elementKeyFromPath([inner, outer])).toEqual({ elementKey: "cta", label: "Продолжить" });
    expect(elementKeyFromPath([document.createElement("p")])).toBeNull();
  });

  it("slugifies scenario names and falls back when nothing is left", () => {
    expect(scenarioIdFromName("Оплата бонусами 5/5")).toMatch(/^scenario-|^5-5$/);
    expect(scenarioIdFromName("Bonus Flow")).toBe("bonus-flow");
  });

  it("builds expectation steps from form fields and rejects malformed input", () => {
    expect(buildStep("expectText", { text: " начислено ", pointer: "", value: "" })).toEqual({ type: "expectText", text: "начислено" });
    expect(buildStep("expectScreen", { text: "not a slug!", pointer: "", value: "" })).toBeNull();
    expect(buildStep("setState", { text: "", pointer: "/a", value: "[1,2]" })).toEqual({ type: "setState", pointer: "/a", value: [1, 2] });
    expect(buildStep("setState", { text: "", pointer: "/a", value: "not json" })).toBeNull();
    expect(buildStep("expectState", { text: "", pointer: "__proto__", value: "1" })).toBeNull();
  });

  it("describes every step type for the panel", () => {
    const steps: ScenarioStep[] = [
      { type: "click", elementKey: "cta", label: "Продолжить" },
      { type: "expectScreen", screenId: "done" },
      { type: "expectText", text: "ок" },
      { type: "setState", pointer: "/a", value: 1 },
      { type: "expectState", pointer: "/a", value: 1 },
      { type: "expectDisabled", elementKey: "sixth" },
    ];
    for (const step of steps) expect(describeStep(step)).toBeTruthy();
  });
});
