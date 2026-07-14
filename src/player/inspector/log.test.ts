import { describe, expect, it, vi } from "vitest";
import { INSPECTOR_LOG_CAPACITY, InspectorLog, InspectorLoggerSink } from "./log";

describe("InspectorLog", () => {
  it("appends entries with ids/timestamps and keeps only the latest 50", () => {
    const log = new InspectorLog();
    for (let i = 0; i < INSPECTOR_LOG_CAPACITY + 7; i++) {
      log.logRuntimeError(`error ${i}`);
    }
    const entries = log.getSnapshot();
    expect(entries).toHaveLength(INSPECTOR_LOG_CAPACITY);
    expect(entries[0]).toMatchObject({ kind: "runtime-error", message: "error 7" });
    expect(entries[entries.length - 1]).toMatchObject({ message: `error ${INSPECTOR_LOG_CAPACITY + 6}` });
    const ids = entries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(entries.every((entry) => typeof entry.time === "number")).toBe(true);
  });

  it("supports runtime record kinds without FONT entries", () => {
    const log = new InspectorLog();
    log.logEvent({ correlationId: "e1", elementId: "el", component: "Card", event: "press", payload: { id: "x" }, payloadValid: true });
    log.logAction({ correlationId: "e1", action: "setState", params: { statePath: "/a" }, result: { type: "state", statePath: "/a", previous: 1, next: 2 } });
    log.logRuntimeError("boom", { component: "Card" });
    expect(log.getSnapshot().map((entry) => entry.kind)).toEqual(["event", "action", "runtime-error"]);
  });

  it("notifies subscribers on append and clear, and returns immutable snapshots", () => {
    const log = new InspectorLog();
    const listener = vi.fn();
    const unsubscribe = log.subscribe(listener);
    const empty = log.getSnapshot();
    log.logRuntimeError("loading");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(log.getSnapshot()).not.toBe(empty);
    expect(empty).toHaveLength(0);
    const one = log.getSnapshot();
    expect(log.getSnapshot()).toBe(one); // stable between changes
    log.clear();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(log.getSnapshot()).toHaveLength(0);
    log.clear(); // empty clear is a no-op
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    log.logRuntimeError("loaded");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("connects and disconnects a logger without replacing the sink", () => {
    const sink = new InspectorLoggerSink();
    const log = new InspectorLog();
    sink.connect(log);
    sink.logRuntimeError("visible");
    sink.connect(null);
    sink.logRuntimeError("hidden");
    sink.connect(log);
    sink.logRuntimeError("visible again");
    expect(log.getSnapshot().map((entry) => entry.kind === "runtime-error" ? entry.message : "")).toEqual(["visible", "visible again"]);
  });
});
