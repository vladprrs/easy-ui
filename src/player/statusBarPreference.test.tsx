// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStatusBarPreference } from "./statusBarPreference";

describe("useStatusBarPreference", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("strictly parses the persisted value and keeps it between mounts", () => {
    window.localStorage.setItem("eui.statusBarHidden", "true");
    const first = renderHook(() => useStatusBarPreference());
    expect(first.result.current[0]).toBe(true);
    act(() => first.result.current[1](false));
    expect(window.localStorage.getItem("eui.statusBarHidden")).toBe("false");
    first.unmount();

    const second = renderHook(() => useStatusBarPreference());
    expect(second.result.current[0]).toBe(false);
    second.unmount();

    window.localStorage.setItem("eui.statusBarHidden", "TRUE");
    const malformed = renderHook(() => useStatusBarPreference());
    expect(malformed.result.current[0]).toBe(false);
  });

  it("continues in memory when localStorage reads or writes throw", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const view = renderHook(() => useStatusBarPreference());
    expect(view.result.current[0]).toBe(false);

    vi.mocked(Storage.prototype.getItem).mockRestore();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    act(() => view.result.current[1](true));
    expect(view.result.current[0]).toBe(true);
  });
});
