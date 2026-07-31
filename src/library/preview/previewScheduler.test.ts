import { render } from "@testing-library/react";
import { createElement, StrictMode, useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { PREVIEW_LOAD_LIMIT, PreviewScheduler, previewScheduler, resetPreviewSchedulerForTests } from "./previewScheduler";

afterEach(() => resetPreviewSchedulerForTests());

/** Task that never settles on its own; the test decides when. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("PreviewScheduler", () => {
  it("never runs more than PREVIEW_LOAD_LIMIT tasks at once", async () => {
    const scheduler = new PreviewScheduler();
    const gates = Array.from({ length: 10 }, () => deferred());
    let peak = 0;
    const results = gates.map((gate, index) => scheduler.run(`k${index}`, 1, async () => {
      peak = Math.max(peak, scheduler.inFlight);
      await gate.promise;
    }, new AbortController().signal));

    await flush();
    expect(scheduler.inFlight).toBe(PREVIEW_LOAD_LIMIT);
    for (const gate of gates) gate.resolve();
    await Promise.all(results);
    expect(peak).toBe(PREVIEW_LOAD_LIMIT);
    expect(scheduler.inFlight).toBe(0);
  });

  it("keeps FIFO order at equal priority and runs stricter priorities first", async () => {
    const scheduler = new PreviewScheduler();
    const order: string[] = [];
    const gate = deferred();
    const signal = new AbortController().signal;
    // Occupy every slot so the rest of the batch has to queue.
    const blockers = Array.from({ length: PREVIEW_LOAD_LIMIT }, (_, index) =>
      scheduler.run(`block${index}`, 0, () => gate.promise, signal));
    const queued = [
      scheduler.run("a", 2, async () => { order.push("a"); }, signal),
      scheduler.run("b", 2, async () => { order.push("b"); }, signal),
      scheduler.run("c", 1, async () => { order.push("c"); }, signal),
      scheduler.run("d", 2, async () => { order.push("d"); }, signal),
      scheduler.run("e", 0, async () => { order.push("e"); }, signal),
    ];
    await flush();
    expect(order).toEqual([]);
    gate.resolve();
    await Promise.all([...blockers, ...queued]);
    expect(order).toEqual(["e", "c", "a", "b", "d"]);
  });

  it("dedupes by key, returns the same promise and raises priority only when stricter", async () => {
    const scheduler = new PreviewScheduler();
    const gate = deferred();
    const signal = new AbortController().signal;
    const blockers = Array.from({ length: PREVIEW_LOAD_LIMIT }, (_, index) =>
      scheduler.run(`block${index}`, 0, () => gate.promise, signal));

    const order: string[] = [];
    let runs = 0;
    const first = scheduler.run("dup", 3, async () => { runs += 1; order.push("dup"); return "value"; }, signal);
    const second = scheduler.run("dup", 1, async () => { runs += 1; return "other"; }, signal);
    const third = scheduler.run("dup", 3, async () => { runs += 1; return "other"; }, signal);
    scheduler.run("rival", 2, async () => { order.push("rival"); }, signal);
    expect(second).toBe(first);
    expect(third).toBe(first);

    gate.resolve();
    await Promise.all([...blockers, first, second, third]);
    expect(runs).toBe(1);
    expect(await first).toBe("value");
    // priority 1 (from the second call) beats the rival at 2, the third call did not relax it back.
    expect(order).toEqual(["dup", "rival"]);
  });

  it("reprioritizes a queued task", async () => {
    const scheduler = new PreviewScheduler();
    const gate = deferred();
    const signal = new AbortController().signal;
    const blockers = Array.from({ length: PREVIEW_LOAD_LIMIT }, (_, index) =>
      scheduler.run(`block${index}`, 0, () => gate.promise, signal));
    const order: string[] = [];
    const queued = [
      scheduler.run("far", 3, async () => { order.push("far"); }, signal),
      scheduler.run("near", 1, async () => { order.push("near"); }, signal),
    ];
    scheduler.reprioritize("far", 0);
    gate.resolve();
    await Promise.all([...blockers, ...queued]);
    expect(order).toEqual(["far", "near"]);
  });

  it("drops a queued task on abort and rejects with the signal reason", async () => {
    const scheduler = new PreviewScheduler();
    const gate = deferred();
    const idle = new AbortController().signal;
    const blockers = Array.from({ length: PREVIEW_LOAD_LIMIT }, (_, index) =>
      scheduler.run(`block${index}`, 0, () => gate.promise, idle));
    const controller = new AbortController();
    let started = false;
    const queued = scheduler.run("late", 1, async () => { started = true; }, controller.signal);
    const reason = new Error("gone");
    controller.abort(reason);
    await expect(queued).rejects.toBe(reason);
    gate.resolve();
    await Promise.all(blockers);
    await flush();
    expect(started).toBe(false);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const scheduler = new PreviewScheduler();
    const controller = new AbortController();
    const reason = new Error("stale");
    controller.abort(reason);
    let started = false;
    await expect(scheduler.run("k", 0, async () => { started = true; }, controller.signal)).rejects.toBe(reason);
    await flush();
    expect(started).toBe(false);
  });

  it("forwards an abort after start to the task signal without cancelling it for the scheduler", async () => {
    const scheduler = new PreviewScheduler();
    const controller = new AbortController();
    const gate = deferred<string>();
    let taskSignal: AbortSignal | null = null;
    const running = scheduler.run("k", 0, async (signal) => { taskSignal = signal; return gate.promise; }, controller.signal);
    await flush();
    expect(taskSignal!.aborted).toBe(false);
    controller.abort(new Error("scrolled away"));
    expect(taskSignal!.aborted).toBe(true);
    expect(scheduler.inFlight).toBe(1);
    gate.resolve("done"); // начатый import() не отменяем — задача сама решает, что делать с сигналом
    await expect(running).resolves.toBe("done");
    expect(scheduler.inFlight).toBe(0);
  });

  it("keeps running while at least one subscriber is alive", async () => {
    const scheduler = new PreviewScheduler();
    const first = new AbortController();
    const second = new AbortController();
    const gate = deferred<string>();
    let taskSignal: AbortSignal | null = null;
    const a = scheduler.run("k", 0, async (signal) => { taskSignal = signal; return gate.promise; }, first.signal);
    const b = scheduler.run("k", 0, async () => "unused", second.signal);
    expect(b).toBe(a);
    first.abort();
    await flush();
    expect(taskSignal!.aborted).toBe(false);
    gate.resolve("done");
    await expect(b).resolves.toBe("done");
  });

  it("loads once under a StrictMode double mount", async () => {
    let runs = 0;
    function Card() {
      useEffect(() => {
        const controller = new AbortController();
        void previewScheduler.run("card", 1, async () => { runs += 1; }, controller.signal).catch(() => {});
        return () => controller.abort();
      }, []);
      return null;
    }
    render(createElement(StrictMode, null, createElement(Card)));
    await flush();
    expect(runs).toBe(1);
  });
});
