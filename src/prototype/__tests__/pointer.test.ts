import { describe, expect, it } from "vitest";
import {
  getAtPointer,
  getAtRelativePath,
  isSafeJsonPointer,
  isSafeRelativeFieldPath,
  parseJsonPointer,
  parseRelativeFieldPath,
} from "../pointer";

describe("parseJsonPointer", () => {
  it("parses and decodes RFC 6901 segments", () => {
    expect(parseJsonPointer("/a/b~1c/d~0e")).toEqual(["a", "b/c", "d~e"]);
    expect(parseJsonPointer("/items/0")).toEqual(["items", "0"]);
  });

  it.each(["", "a/b", "a", null, undefined, 42])("rejects non-absolute or non-string input: %j", (value) => {
    expect(parseJsonPointer(value as never)).toBeNull();
  });

  it.each(["__proto__", "prototype", "constructor"])("rejects forbidden segment %s at any depth", (segment) => {
    expect(parseJsonPointer(`/${segment}`)).toBeNull();
    expect(parseJsonPointer(`/safe/${segment}/deep`)).toBeNull();
  });

  it("rejects a malformed escape sequence", () => {
    expect(parseJsonPointer("/a~b")).toBeNull();
  });
});

describe("isSafeJsonPointer", () => {
  it("accepts safe pointers and rejects unsafe ones", () => {
    expect(isSafeJsonPointer("/a/b")).toBe(true);
    expect(isSafeJsonPointer("/__proto__/polluted")).toBe(false);
    expect(isSafeJsonPointer("relative")).toBe(false);
    expect(isSafeJsonPointer(42)).toBe(false);
  });
});

describe("getAtPointer", () => {
  it("resolves nested object and array segments", () => {
    const root = { items: [{ label: "A" }, { label: "B" }], meta: { count: 2 } };
    expect(getAtPointer(root, "/items/1/label")).toEqual({ exists: true, value: "B" });
    expect(getAtPointer(root, "/meta/count")).toEqual({ exists: true, value: 2 });
  });

  it("reports non-existence for missing paths, out-of-range indices, and unsafe pointers", () => {
    const root = { items: [1, 2] };
    expect(getAtPointer(root, "/missing").exists).toBe(false);
    expect(getAtPointer(root, "/items/9").exists).toBe(false);
    expect(getAtPointer(root, "/items/__proto__").exists).toBe(false);
    expect(getAtPointer(root, "not-a-pointer").exists).toBe(false);
  });
});

describe("parseRelativeFieldPath / getAtRelativePath ($item semantics)", () => {
  it("parses a bare field name and nested paths, tolerating a leading slash", () => {
    expect(parseRelativeFieldPath("label")).toEqual(["label"]);
    expect(parseRelativeFieldPath("a/b")).toEqual(["a", "b"]);
    expect(parseRelativeFieldPath("/a/b")).toEqual(["a", "b"]);
    expect(parseRelativeFieldPath("")).toEqual([]);
  });

  it("rejects forbidden segments", () => {
    expect(parseRelativeFieldPath("__proto__")).toBeNull();
    expect(parseRelativeFieldPath("a/constructor")).toBeNull();
  });

  it("resolves the whole item for an empty path and a field otherwise", () => {
    const item = { label: "A", nested: { deep: 1 } };
    expect(getAtRelativePath(item, "")).toEqual({ exists: true, value: item });
    expect(getAtRelativePath(item, "nested/deep")).toEqual({ exists: true, value: 1 });
    expect(isSafeRelativeFieldPath("nested/deep")).toBe(true);
    expect(isSafeRelativeFieldPath("__proto__")).toBe(false);
  });
});
