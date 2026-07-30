import { describe, expect, it } from "vitest";
import { parseNavigateBinding } from "../navigateBinding";

const screenNames = new Map([["checkout", "Оплата"], ["done", "Готово"]]);

describe("parseNavigateBinding", () => {
  it("reads a single static navigate action", () => {
    expect(parseNavigateBinding({ action: "navigate", params: { screenId: "checkout" } }, screenNames))
      .toEqual([{ kind: "static", screenId: "checkout", screenName: "Оплата", conditional: false }]);
  });

  it("falls back to the screen id when the screen is unknown", () => {
    expect(parseNavigateBinding({ action: "navigate", params: { screenId: "ghost" } }, screenNames))
      .toEqual([{ kind: "static", screenId: "ghost", screenName: "ghost", conditional: false }]);
  });

  it("keeps a navigate under $if static and only flags it as conditional", () => {
    expect(parseNavigateBinding({ action: "navigate", params: { screenId: "done" }, $if: { $state: "/ready" } }, screenNames))
      .toEqual([{ kind: "static", screenId: "done", screenName: "Готово", conditional: true }]);
  });

  it("classifies a non-string screenId as dynamic and carries $if separately", () => {
    expect(parseNavigateBinding([
      { action: "navigate", params: { screenId: { $state: "/target" } } },
      { action: "navigate", params: { screenId: { $state: "/other" } }, $if: true },
    ], screenNames)).toEqual([
      { kind: "dynamic", conditional: false },
      { kind: "dynamic", conditional: true },
    ]);
  });

  it("keeps authored order and duplicates of several navigate actions", () => {
    expect(parseNavigateBinding([
      { action: "setState", params: { path: "/x", value: 1 } },
      { action: "navigate", params: { screenId: "done" } },
      { action: "navigate", params: { screenId: "checkout" } },
      { action: "navigate", params: { screenId: "done" } },
    ], screenNames)).toEqual([
      { kind: "static", screenId: "done", screenName: "Готово", conditional: false },
      { kind: "static", screenId: "checkout", screenName: "Оплата", conditional: false },
      { kind: "static", screenId: "done", screenName: "Готово", conditional: false },
    ]);
  });

  it("yields nothing for non-navigate actions, missing params and malformed bindings", () => {
    expect(parseNavigateBinding({ action: "back" }, screenNames)).toEqual([]);
    expect(parseNavigateBinding({ action: "restart" }, screenNames)).toEqual([]);
    expect(parseNavigateBinding({ action: "navigate" }, screenNames)).toEqual([]);
    expect(parseNavigateBinding({ action: "navigate", params: {} }, screenNames)).toEqual([]);
    expect(parseNavigateBinding(undefined, screenNames)).toEqual([]);
    expect(parseNavigateBinding("navigate", screenNames)).toEqual([]);
    expect(parseNavigateBinding([null, 42], screenNames)).toEqual([]);
  });
});
