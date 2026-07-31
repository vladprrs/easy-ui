// Prioritized replacement for the gallery's PreviewLoadQueue (src/gallery/GalleryPreview.tsx):
// same concurrency cap, plus stable keys (dedupe) and priorities (explicit pick / visible tier /
// molecules / near-viewport prefetch).

export type PreviewPriority = 0 | 1 | 2 | 3;

export const PREVIEW_LOAD_LIMIT = 4;

interface SchedulerTask {
  key: string;
  priority: PreviewPriority;
  seq: number;
  run: (signal: AbortSignal) => Promise<unknown>;
  controller: AbortController;
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  started: boolean;
  subscribers: Set<AbortSignal>;
  detach: (() => void)[];
}

export class PreviewScheduler {
  private tasks = new Map<string, SchedulerTask>();
  private pending: SchedulerTask[] = [];
  private running = 0;
  private seq = 0;
  private drainScheduled = false;

  /** Number of tasks whose `task(signal)` has been invoked and not yet settled. */
  get inFlight(): number {
    return this.running;
  }

  run<T>(key: string, priority: PreviewPriority, task: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);

    const existing = this.tasks.get(key);
    if (existing) {
      // Same card asked twice (StrictMode double mount, re-entering the viewport, search focus):
      // never a second load — join the live task and only tighten its priority.
      if (priority < existing.priority) existing.priority = priority;
      this.subscribe(existing, signal);
      return existing.promise as Promise<T>;
    }

    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
    const entry: SchedulerTask = {
      key,
      priority,
      seq: ++this.seq,
      run: task as (signal: AbortSignal) => Promise<unknown>,
      controller: new AbortController(),
      promise,
      resolve,
      reject,
      started: false,
      subscribers: new Set(),
      detach: [],
    };
    this.tasks.set(key, entry);
    this.pending.push(entry);
    this.subscribe(entry, signal);
    // Start on a microtask so a mount/unmount/mount pair (StrictMode) collapses into one start
    // instead of starting, aborting, and starting again.
    this.scheduleDrain();
    return promise as Promise<T>;
  }

  /** Sets the priority of a still-queued task; running tasks are unaffected. */
  reprioritize(key: string, priority: PreviewPriority): void {
    const entry = this.tasks.get(key);
    if (entry) entry.priority = priority;
  }

  private subscribe(entry: SchedulerTask, signal: AbortSignal) {
    if (entry.subscribers.has(signal)) return;
    entry.subscribers.add(signal);
    const onAbort = () => {
      entry.subscribers.delete(signal);
      if (entry.subscribers.size === 0) this.abortTask(entry, signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    entry.detach.push(() => signal.removeEventListener("abort", onAbort));
  }

  private abortTask(entry: SchedulerTask, reason: unknown) {
    this.forget(entry);
    if (entry.started) {
      // An import()/fetch already in flight is not unwound; the task decides what the signal means.
      entry.controller.abort(reason);
      return;
    }
    const index = this.pending.indexOf(entry);
    if (index !== -1) this.pending.splice(index, 1);
    entry.reject(reason);
  }

  private forget(entry: SchedulerTask) {
    if (this.tasks.get(entry.key) === entry) this.tasks.delete(entry.key);
    for (const detach of entry.detach) detach();
    entry.detach = [];
  }

  private scheduleDrain() {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  private drain() {
    while (this.running < PREVIEW_LOAD_LIMIT && this.pending.length) {
      const next = this.takeNext();
      next.started = true;
      this.running += 1;
      void Promise.resolve()
        .then(() => next.run(next.controller.signal))
        .then(next.resolve, next.reject)
        .finally(() => {
          this.running = Math.max(0, this.running - 1);
          this.forget(next);
          this.drain();
        });
    }
  }

  /** Lowest numeric priority first; ties resolve FIFO through the monotonic seq. */
  private takeNext(): SchedulerTask {
    let best = 0;
    for (let index = 1; index < this.pending.length; index += 1) {
      const candidate = this.pending[index];
      const winner = this.pending[best];
      if (candidate.priority < winner.priority || (candidate.priority === winner.priority && candidate.seq < winner.seq)) best = index;
    }
    return this.pending.splice(best, 1)[0];
  }

  /** @internal */
  resetForTests(): void {
    for (const entry of this.pending) {
      this.forget(entry);
      entry.promise.catch(() => {}); // тест мог не подписаться на промис — не шуметь unhandled rejection
      entry.reject(new Error("preview scheduler reset"));
    }
    this.pending = [];
    this.tasks.clear();
    this.running = 0;
    this.seq = 0;
  }
}

export const previewScheduler = new PreviewScheduler();

export function resetPreviewSchedulerForTests(): void {
  previewScheduler.resetForTests();
}
