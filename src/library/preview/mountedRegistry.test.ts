import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MOUNTED_PREVIEW_BUDGET,
  acquireMountedPreview,
  mountedPreviewCount,
  mountedPreviewKeys,
  resetMountedPreviewsForTests,
  viewportDistance,
} from "./mountedRegistry";

const handle = (distance: number, unmount = vi.fn()) => ({ distance: () => distance, unmount });

describe("mountedRegistry", () => {
  beforeEach(() => resetMountedPreviewsForTests());

  it("keeps everything up to the budget", () => {
    const releases = Array.from({ length: MOUNTED_PREVIEW_BUDGET }, (_, index) => acquireMountedPreview(`k${index}`, handle(index * 100)));
    expect(mountedPreviewCount()).toBe(MOUNTED_PREVIEW_BUDGET);
    releases.forEach((release) => release());
    expect(mountedPreviewCount()).toBe(0);
  });

  it("evicts the farthest preview once the budget is exceeded", () => {
    const unmounts = new Map<string, ReturnType<typeof vi.fn>>();
    for (let index = 0; index < MOUNTED_PREVIEW_BUDGET; index += 1) {
      const unmount = vi.fn();
      unmounts.set(`k${index}`, unmount);
      // k0 — на экране, дальше по нарастающей; k11 самый дальний.
      acquireMountedPreview(`k${index}`, handle(index * 100, unmount));
    }
    const newcomer = vi.fn();
    acquireMountedPreview("fresh", handle(0, newcomer));

    expect(mountedPreviewCount()).toBe(MOUNTED_PREVIEW_BUDGET);
    expect(unmounts.get(`k${MOUNTED_PREVIEW_BUDGET - 1}`)).toHaveBeenCalledTimes(1);
    expect(unmounts.get("k0")).not.toHaveBeenCalled();
    expect(newcomer).not.toHaveBeenCalled();
    expect(mountedPreviewKeys()).toContain("fresh");
  });

  it("evicts the newcomer when it is the farthest of all", () => {
    for (let index = 0; index < MOUNTED_PREVIEW_BUDGET; index += 1) acquireMountedPreview(`k${index}`, handle(0));
    const newcomer = vi.fn();
    acquireMountedPreview("far", handle(9000, newcomer));
    expect(newcomer).toHaveBeenCalledTimes(1);
    expect(mountedPreviewKeys()).not.toContain("far");
  });

  it("replaces a re-acquired key without unmounting the live card", () => {
    const first = vi.fn();
    acquireMountedPreview("k", handle(0, first));
    const release = acquireMountedPreview("k", handle(0));
    expect(first).not.toHaveBeenCalled();
    expect(mountedPreviewCount()).toBe(1);
    release();
    expect(mountedPreviewCount()).toBe(0);
  });

  it("release is idempotent and never drops a newer registration of the same key", () => {
    const release = acquireMountedPreview("k", handle(0));
    release();
    acquireMountedPreview("k", handle(0));
    release();
    expect(mountedPreviewCount()).toBe(1);
  });

  it("measures the vertical gap to the viewport", () => {
    const above = { getBoundingClientRect: () => ({ top: -400, bottom: -120 }) } as unknown as Element;
    const inside = { getBoundingClientRect: () => ({ top: -10, bottom: 200 }) } as unknown as Element;
    const below = { getBoundingClientRect: () => ({ top: window.innerHeight + 350, bottom: window.innerHeight + 500 }) } as unknown as Element;
    expect(viewportDistance(above)).toBe(120);
    expect(viewportDistance(inside)).toBe(0);
    expect(viewportDistance(below)).toBe(350);
    expect(viewportDistance(null)).toBe(Number.POSITIVE_INFINITY);
  });
});
