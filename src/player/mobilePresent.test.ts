import { act, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectMobilePresent, useMobilePresent } from "./mobilePresent";

function matchMedia(matches: boolean): typeof window.matchMedia {
  return vi.fn((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as typeof window.matchMedia;
}

function env(coarse: boolean, innerWidth: number, innerHeight: number) {
  return { matchMedia: matchMedia(coarse), innerWidth, innerHeight };
}

function Probe() {
  return createElement("output", null, String(useMobilePresent()));
}

describe("detectMobilePresent", () => {
  it("honors exact single-value overrides", () => {
    expect(detectMobilePresent("?mobile=1", env(false, 1280, 900))).toBe(true);
    expect(detectMobilePresent("?mobile=0", env(true, 390, 844))).toBe(false);
  });

  it("ignores invalid and duplicate overrides", () => {
    expect(detectMobilePresent("?mobile=yes", env(true, 390, 844))).toBe(true);
    expect(detectMobilePresent("?mobile=1&mobile=0", env(false, 390, 844))).toBe(false);
  });

  it("requires a coarse pointer and a compact short side", () => {
    expect(detectMobilePresent("", env(true, 390, 844))).toBe(true);
    expect(detectMobilePresent("", env(true, 834, 1112))).toBe(false);
    expect(detectMobilePresent("", env(false, 390, 844))).toBe(false);
  });

  it("falls back safely when matchMedia is unavailable", () => {
    expect(detectMobilePresent("", { innerWidth: 390, innerHeight: 844 })).toBe(false);
  });

  it("uses the short side in landscape", () => {
    expect(detectMobilePresent("", env(true, 844, 390))).toBe(true);
  });

  it("keeps the 768px boundary outside mobile present", () => {
    expect(detectMobilePresent("", env(true, 767, 1024))).toBe(true);
    expect(detectMobilePresent("", env(true, 768, 1024))).toBe(false);
  });
});

describe("useMobilePresent", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("latches the router search on mount", async () => {
    vi.stubGlobal("innerWidth", 1280);
    vi.stubGlobal("innerHeight", 900);
    vi.stubGlobal("matchMedia", matchMedia(false));
    const router = createMemoryRouter([{ path: "*", element: createElement(Probe) }], {
      initialEntries: ["/present?mobile=1"],
    });
    render(createElement(RouterProvider, { router }));
    expect(screen.getByText("true")).toBeTruthy();

    await act(async () => router.navigate("/present?mobile=0"));

    expect(router.state.location.search).toBe("?mobile=0");
    expect(screen.getByText("true")).toBeTruthy();
  });
});
