import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignSystemSummary } from "../api/client";
import { getDesignSystemById } from "../api/client";
import { resetThemeCacheForTests, themeCache } from "./themeCache";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  getDesignSystemById: vi.fn(),
}));

const mocked = vi.mocked(getDesignSystemById);

const summary = (overrides: Partial<DesignSystemSummary> = {}): DesignSystemSummary => ({
  id: "yandex-pay", name: "Pay", description: "", builtinCatalogHash: "", components: [],
  tokens: { "color.primary": "#111" }, fonts: [{ family: "YS Text", src: `asset_${"a".repeat(64)}` }], icons: [],
  latestMetaVersion: 7,
  ...overrides,
});

beforeEach(() => resetThemeCacheForTests());
afterEach(() => mocked.mockReset());

describe("themeCache", () => {
  it("issues one request per design system no matter how many cards ask", async () => {
    mocked.mockResolvedValue(summary());
    const results = await Promise.all(Array.from({ length: 20 }, () => themeCache.get("yandex-pay")));
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(results[0]).toBe(results[19]);
    expect(results[0].content.tokens).toEqual({ "color.primary": "#111" });
    expect(results[0].content.fonts).toHaveLength(1);
    expect(results[0].latestMetaVersion).toBe(7);
    await themeCache.get("yandex-pay");
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it("keeps systems apart and never passes a caller signal down", async () => {
    mocked.mockImplementation(async (id: string) => summary({ id, latestMetaVersion: id === "other" ? null : 7 }));
    const [first, second] = await Promise.all([themeCache.get("yandex-pay"), themeCache.get("other")]);
    expect(mocked).toHaveBeenCalledTimes(2);
    expect(mocked.mock.calls.every((call) => call[1] === undefined)).toBe(true);
    expect(first.latestMetaVersion).toBe(7);
    expect(second.latestMetaVersion).toBeNull();
  });

  it("normalizes a theme-less design system to an empty theme", async () => {
    mocked.mockResolvedValue({ id: "bare", name: "Bare", description: "", builtinCatalogHash: "", components: [] });
    await expect(themeCache.get("bare")).resolves.toEqual({ content: { tokens: {}, fonts: [], icons: [] }, latestMetaVersion: null });
  });

  it("resolves to an empty theme on failure and lets the next caller retry", async () => {
    mocked.mockRejectedValueOnce(new Error("boom"));
    await expect(themeCache.get("yandex-pay")).resolves.toEqual({ content: { tokens: {}, fonts: [], icons: [] }, latestMetaVersion: null });
    mocked.mockResolvedValue(summary());
    await expect(themeCache.get("yandex-pay")).resolves.toMatchObject({ latestMetaVersion: 7 });
    expect(mocked).toHaveBeenCalledTimes(2);
  });
});
