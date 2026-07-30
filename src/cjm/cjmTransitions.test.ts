import { describe, expect, it } from "vitest";
import type { PrototypeDoc } from "../prototype/schema";
import { getCjmTransitions } from "./CjmScreenTile";

type Screen = PrototypeDoc["screens"][number];

const screens = [
  { id: "home", name: "Главная", spec: { root: "root", elements: {} } },
  { id: "checkout", name: "Оплата", spec: { root: "root", elements: {} } },
  { id: "done", name: "Готово", spec: { root: "root", elements: {} } },
] as unknown as PrototypeDoc["screens"];

const screenWith = (elements: Record<string, unknown>): Screen =>
  ({ id: "home", name: "Главная", spec: { root: "root", elements } }) as unknown as Screen;

/**
 * Гейт T3: перевод `getCjmTransitions` на общий `parseNavigateBinding` не меняет
 * чипы CJM — ни порядок, ни дедупликацию, ни трактовку `$if` как статического перехода.
 */
describe("getCjmTransitions", () => {
  it("dedupes by target, keeps authored order and ignores non-press events", () => {
    const transitions = getCjmTransitions(screenWith({
      root: { type: "Stack", props: {}, children: ["a", "b", "c", "d"] },
      a: { type: "Button", props: {}, on: { press: { action: "navigate", params: { screenId: "checkout" } } } },
      b: { type: "Button", props: {}, on: { press: [{ action: "setState", params: {} }, { action: "navigate", params: { screenId: "done" } }] } },
      c: { type: "Button", props: {}, on: { press: { action: "navigate", params: { screenId: "checkout" } } } },
      d: { type: "Button", props: {}, on: { change: { action: "navigate", params: { screenId: "home" } } } },
    }), screens);
    expect(transitions).toEqual([
      { kind: "static", screenId: "checkout", screenName: "Оплата" },
      { kind: "static", screenId: "done", screenName: "Готово" },
    ]);
  });

  it("keeps a navigate under $if static and dedupes dynamic targets into one chip", () => {
    const transitions = getCjmTransitions(screenWith({
      root: { type: "Stack", props: {}, children: ["guarded", "dyn1", "dyn2"] },
      guarded: { type: "Button", props: {}, on: { press: { action: "navigate", params: { screenId: "done" }, $if: { $state: "/ready" } } } },
      dyn1: { type: "Button", props: {}, on: { press: { action: "navigate", params: { screenId: { $state: "/target" } } } } },
      dyn2: { type: "Button", props: {}, on: { press: { action: "navigate", params: { screenId: { $state: "/other" } } } } },
    }), screens);
    expect(transitions).toEqual([
      { kind: "static", screenId: "done", screenName: "Готово" },
      { kind: "dynamic" },
    ]);
  });

  it("ignores back/restart and navigate without params", () => {
    expect(getCjmTransitions(screenWith({
      root: { type: "Stack", props: {}, children: ["back", "restart", "bare"] },
      back: { type: "Button", props: {}, on: { press: { action: "back" } } },
      restart: { type: "Button", props: {}, on: { press: { action: "restart" } } },
      bare: { type: "Button", props: {}, on: { press: { action: "navigate" } } },
    }), screens)).toEqual([]);
  });
});
