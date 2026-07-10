import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useApi } from "./hooks";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe("useApi", () => {
  it("aborts the old generation and discards its late response", async () => {
    const oldRequest = deferred<string>();
    const freshRequest = deferred<string>();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn((signal: AbortSignal, key: string) => {
      signals.push(signal);
      return key === "old" ? oldRequest.promise : freshRequest.promise;
    });
    const { result, rerender } = renderHook(
      ({ key }) => useApi((signal) => fetcher(signal, key), [key]),
      { initialProps: { key: "old" } },
    );

    rerender({ key: "fresh" });
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => freshRequest.resolve("fresh result"));
    expect(result.current).toMatchObject({ status: "ready", data: "fresh result" });
    await act(async () => oldRequest.resolve("stale result"));
    expect(result.current).toMatchObject({ status: "ready", data: "fresh result" });
  });

  it("aborts the active request on unmount", () => {
    let signal: AbortSignal | undefined;
    const { unmount } = renderHook(() => useApi((nextSignal) => {
      signal = nextSignal;
      return new Promise<string>(() => undefined);
    }, []));
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});
