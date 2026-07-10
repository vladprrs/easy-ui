import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchStorybookIndex, parseStorybookIndex } from "./storybookIndex";

afterEach(() => vi.unstubAllGlobals());

describe("storybook index", () => {
  it("parses valid v5 entries and ignores malformed entries", () => {
    expect(parseStorybookIndex({ entries: {
      "catalog-button--primary": { id: "catalog-button--primary", title: "Catalog/Button", name: "Primary", type: "story", extra: true },
      broken: { id: 1 },
    } })).toEqual({ entries: {
      "catalog-button--primary": { id: "catalog-button--primary", title: "Catalog/Button", name: "Primary", type: "story" },
    } });
  });

  it("returns null for malformed JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockRejectedValue(new SyntaxError("bad json")) }));
    await expect(fetchStorybookIndex()).resolves.toBeNull();
  });

  it("returns null when index is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(fetchStorybookIndex()).resolves.toBeNull();
  });
});
