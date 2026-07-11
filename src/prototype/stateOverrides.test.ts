import { describe, expect, it } from "vitest";
import { mergeScreenState } from "./stateOverrides";

describe("mergeScreenState", () => {
  it("deep-merges objects without treating an empty object as deletion", () => {
    expect(mergeScreenState({ nested: { a: 1, b: 2 } }, { nested: {} })).toEqual({ nested: { a: 1, b: 2 } });
  });

  it("replaces nulls, arrays, scalars, and mismatched types", () => {
    expect(mergeScreenState(
      { nil: { old: true }, array: [1, 2], scalar: 1, mismatch: { old: true } },
      { nil: null, array: [3], scalar: 2, mismatch: "new" },
    )).toEqual({ nil: null, array: [3], scalar: 2, mismatch: "new" });
  });

  it("ignores inherited and prototype-polluting keys", () => {
    const inherited = Object.create({ inherited: true }) as Record<string, unknown>;
    inherited.own = 1;
    Object.defineProperty(inherited, "__proto__", { value: { polluted: true }, enumerable: true });
    const result = mergeScreenState({}, inherited as never);
    expect(result).toEqual({ own: 1 });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("does not mutate inputs or share override object references", () => {
    const base = { keep: { value: 1 } };
    const override = { add: { nested: [1, { value: 2 }] } };
    const baseBefore = structuredClone(base), overrideBefore = structuredClone(override);
    const result = mergeScreenState(base, override);
    expect(base).toEqual(baseBefore); expect(override).toEqual(overrideBefore);
    expect(result.add).not.toBe(override.add);
    expect((result.add as typeof override.add).nested).not.toBe(override.add.nested);
    expect((result.add as typeof override.add).nested[1]).not.toBe(override.add.nested[1]);
  });

  it("keeps base instead of inserting an object beyond depth 32", () => {
    const base = { root: { retained: true } };
    const override: Record<string, unknown> = { root: {} };
    let cursor = override.root as Record<string, unknown>;
    for (let i=0;i<32;i++) cursor = cursor.next={};
    cursor.next = { replacement: true };
    const result = mergeScreenState(base, override as never);
    let current: unknown = (result.root as Record<string, unknown>).next;
    for (let i=0;i<31;i++) current = (current as Record<string, unknown>)?.next;
    expect((current as Record<string, unknown>)?.next).toBeUndefined();
    expect((result.root as Record<string, unknown>).retained).toBe(true);
  });

  it("does not admit forbidden keys hidden below the depth limit", () => {
    const override: Record<string, unknown> = {};
    let cursor = override;
    for (let i=0;i<40;i++) cursor = cursor.next={};
    Object.defineProperty(cursor, "constructor", { value: { polluted: true }, enumerable: true });
    const result = mergeScreenState({}, override as never);
    expect(JSON.stringify(result)).not.toContain("polluted");
  });
});
