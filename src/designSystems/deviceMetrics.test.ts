import { describe, expect, it } from "vitest";
import { canonicalViewport, playerDesktopMinStageHeight, previewNativeWidth, previewTile } from "./deviceMetrics";

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

  it("фиксирует размеры превью-тайла", () => {
    expect(previewTile).toEqual({ width: 280, heightCap: 420, fallbackHeight: 360 });
    expect(previewTile.fallbackHeight).toBeLessThanOrEqual(previewTile.heightCap);
  });

  it("player-only min-height — положительное число, не пересекающееся с каноническим viewport", () => {
    expect(playerDesktopMinStageHeight).toBeGreaterThan(0);
  });
});
