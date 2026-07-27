import { describe, expect, it } from "vitest";
import type { AssetListItem } from "../api/assetsApi";
import {
  baseNameKey, filterAssets, formatBytes, isUnused, matchesAssetQuery, mimeFacets,
  rasterOverSvgWarnings, sameImageCandidates, shortAssetId, usageTotal, warningsByRasterId,
} from "./assetsModel";

const sha = (seed: string) => seed.repeat(64).slice(0, 64);

function asset(seed: string, patch: Partial<AssetListItem> = {}): AssetListItem {
  return {
    id: `asset_${sha(seed)}`,
    sha256: sha(seed),
    mime: "image/png",
    size: 2048,
    width: 24,
    height: 24,
    originalName: "logo.png",
    createdAt: "2026-07-27T10:00:00.000Z",
    url: `/api/assets/asset_${sha(seed)}`,
    usage: { prototypes: 0, components: 0, visualReferences: 0, visualRuns: 0 },
    ...patch,
  };
}

describe("assetsModel identity helpers", () => {
  it("shortens the opaque sha id but keeps both ends", () => {
    expect(shortAssetId(`asset_${sha("a")}`)).toBe("aaaaaaaa…aaaa");
    expect(shortAssetId("short")).toBe("short");
  });

  it("formats byte sizes in Russian units", () => {
    expect(formatBytes(512)).toBe("512 Б");
    expect(formatBytes(2048)).toBe("2.0 КБ");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 МБ");
  });

  it("normalizes file-name stems for the name heuristics", () => {
    expect(baseNameKey("assets/Logo Mark@2x.PNG")).toBe("logo-mark-2x");
    expect(baseNameKey(null)).toBe(null);
    expect(baseNameKey(".png")).toBe(null);
  });
});

describe("usage (exact, from the pin graph)", () => {
  it("sums all four pin kinds and flags unused assets", () => {
    const used = asset("a", { usage: { prototypes: 1, components: 0, visualReferences: 0, visualRuns: 2 } });
    expect(usageTotal(used)).toBe(3);
    expect(isUnused(used)).toBe(false);
    expect(isUnused(asset("b"))).toBe(true);
  });
});

describe("filters", () => {
  const assets = [
    asset("a", { originalName: "logo.svg", mime: "image/svg+xml" }),
    asset("b", { originalName: "hero.png", usage: { prototypes: 2, components: 0, visualReferences: 0, visualRuns: 0 } }),
    asset("c", { originalName: null, mime: "font/woff2" }),
  ];

  it("matches by id prefix with or without the asset_ prefix, and by file name", () => {
    expect(matchesAssetQuery(assets[0], "aaaa")).toBe(true);
    expect(matchesAssetQuery(assets[0], `asset_${"a".repeat(6)}`)).toBe(true);
    expect(matchesAssetQuery(assets[1], "HERO")).toBe(true);
    expect(matchesAssetQuery(assets[1], "aaaa")).toBe(false);
    expect(matchesAssetQuery(assets[2], "")).toBe(true);
  });

  it("combines mime and unused filters", () => {
    expect(filterAssets(assets, { query: "", mime: "font/woff2", unusedOnly: false }).map((item) => item.originalName)).toEqual([null]);
    expect(filterAssets(assets, { query: "", mime: null, unusedOnly: true })).toHaveLength(2);
    expect(filterAssets(assets, { query: "logo", mime: null, unusedOnly: true })).toHaveLength(1);
  });

  it("counts mime facets by frequency", () => {
    expect(mimeFacets([...assets, asset("d")])).toEqual([
      { mime: "image/png", count: 2 },
      { mime: "font/woff2", count: 1 },
      { mime: "image/svg+xml", count: 1 },
    ]);
  });
});

describe("same-image candidates (heuristic, name-based only)", () => {
  it("groups different ids that share a file-name stem", () => {
    const groups = sameImageCandidates([
      asset("a", { originalName: "logo.png", createdAt: "2026-07-26T10:00:00.000Z" }),
      asset("b", { originalName: "Logo@2X.png" }),
      asset("c", { originalName: "logo.PNG", createdAt: "2026-07-25T10:00:00.000Z" }),
      asset("d", { originalName: null }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("logo");
    expect(groups[0].assets.map((item) => item.createdAt)).toEqual([
      "2026-07-25T10:00:00.000Z", "2026-07-26T10:00:00.000Z",
    ]);
  });

  it("never groups assets without a stored name (nothing to compare honestly)", () => {
    expect(sameImageCandidates([asset("a", { originalName: null }), asset("b", { originalName: null })])).toEqual([]);
  });
});

describe("raster-over-svg warning (heuristic, name-based only)", () => {
  it("warns on a raster asset when an SVG shares the name stem", () => {
    const assets = [
      asset("a", { originalName: "logo.png", mime: "image/png" }),
      asset("b", { originalName: "logo.svg", mime: "image/svg+xml" }),
      asset("c", { originalName: "hero.jpg", mime: "image/jpeg" }),
    ];
    const warnings = rasterOverSvgWarnings(assets);
    expect(warnings).toEqual([{ rasterId: assets[0].id, svgIds: [assets[1].id], key: "logo" }]);
    expect(warningsByRasterId(warnings).has(assets[2].id)).toBe(false);
  });

  it("does not warn when the SVG name differs", () => {
    expect(rasterOverSvgWarnings([
      asset("a", { originalName: "logo.png" }),
      asset("b", { originalName: "mark.svg", mime: "image/svg+xml" }),
    ])).toEqual([]);
  });
});
