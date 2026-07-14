import { describe, expect, it } from "vitest";
import { canonicalViewport, editorStripTile, playerDesktopMinStageHeight, previewNativeWidth, previewTileSizes } from "./deviceMetrics";

describe("deviceMetrics", () => {
  it("фиксирует канонический viewport капчера/валидации (mobile/tablet), desktop — auto-height", () => {
    // Канонический viewport неприкосновенен: эти значения — контракт capture
    // и visual-истории. Менять их — значит инвалидировать все baseline.
    expect(canonicalViewport.mobile).toEqual({ width: 390, height: 844 });
    expect(canonicalViewport.tablet).toEqual({ width: 834, height: 1112 });
    expect(canonicalViewport.desktop).toBeNull();
  });

  it("native-ширина превью совпадает с каноническим viewport для mobile/tablet", () => {
    expect(previewNativeWidth.mobile).toBe(canonicalViewport.mobile.width);
    expect(previewNativeWidth.tablet).toBe(canonicalViewport.tablet.width);
    expect(previewNativeWidth.desktop).toBe(1280);
  });

  it("фиксирует размеры CJM-превью по типу устройства", () => {
    expect(previewTileSizes).toEqual({
      mobile: { width: 280, heightCap: 608, fallbackHeight: 360 },
      tablet: { width: 420, heightCap: 560, fallbackHeight: 420 },
      desktop: { width: 560, heightCap: 560, fallbackHeight: 420 },
    });
    expect(Object.values(previewTileSizes).every(({ fallbackHeight, heightCap }) => fallbackHeight <= heightCap)).toBe(true);
  });

  it("фиксирует размеры тайла ленты редактора (W2-1): cap ~180px, компактнее CJM-превью", () => {
    expect(editorStripTile).toEqual({ width: 280, heightCap: 180, fallbackHeight: 180 });
    expect(editorStripTile.fallbackHeight).toBeLessThanOrEqual(editorStripTile.heightCap);
    expect(editorStripTile.heightCap).toBeLessThan(Math.min(...Object.values(previewTileSizes).map(({ heightCap }) => heightCap)));
  });

  it("player-only min-height — положительное число, не пересекающееся с каноническим viewport", () => {
    expect(playerDesktopMinStageHeight).toBeGreaterThan(0);
  });
});
