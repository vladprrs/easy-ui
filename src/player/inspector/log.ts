// Interaction inspector log model (plan H.1, feedback §12): a ring buffer of the
// latest 50 runtime records (events, actions with state diffs, runtime errors and
// font statuses) with a subscribe/snapshot contract for useSyncExternalStore.

export const INSPECTOR_LOG_CAPACITY = 50;

/** Outcome of a dispatched action, as shown in the inspector ledger. */
export type InspectorActionResult =
  | { type: "state"; statePath: string; previous: unknown; next: unknown }
  | { type: "nav"; target: string }
  | { type: "url"; url: string }
  | { type: "skipped" }
  | { type: "error"; message: string };

export interface InspectorEventRecord {
  kind: "event";
  correlationId: string;
  elementId: string;
  component: string;
  event: string;
  payload: unknown;
  payloadValid: boolean;
}

export interface InspectorActionRecord {
  kind: "action";
  correlationId: string;
  action: string;
  /** Params with `$event`/`$elementId`/`$itemIndex`/`$itemKey` sources resolved to literals. */
  params: Record<string, unknown>;
  result: InspectorActionResult;
}

export interface InspectorRuntimeErrorRecord {
  kind: "runtime-error";
  message: string;
  detail?: Record<string, unknown>;
}

export interface InspectorFontStatusRecord {
  kind: "font-status";
  family: string;
  status: string;
}

export type InspectorRecord =
  | InspectorEventRecord
  | InspectorActionRecord
  | InspectorRuntimeErrorRecord
  | InspectorFontStatusRecord;

export type InspectorEntry = InspectorRecord & { id: number; time: number };

/** Write-side contract consumed by the action runtime and the event adapter. */
export interface InspectorLogger {
  logEvent(record: Omit<InspectorEventRecord, "kind">): void;
  logAction(record: Omit<InspectorActionRecord, "kind">): void;
  logRuntimeError(message: string, detail?: Record<string, unknown>): void;
  logFontStatus(family: string, status: string): void;
}

/**
 * Ring buffer of the latest {@link INSPECTOR_LOG_CAPACITY} inspector entries.
 * Snapshots are immutable arrays (a new array per change), so the log plugs
 * directly into `useSyncExternalStore`.
 */
export class InspectorLog implements InspectorLogger {
  private entries: readonly InspectorEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private nextId = 1;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly getSnapshot = (): readonly InspectorEntry[] => this.entries;

  readonly clear = (): void => {
    if (this.entries.length === 0) return;
    this.entries = [];
    this.notify();
  };

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private append(record: InspectorRecord): void {
    const entry: InspectorEntry = { ...record, id: this.nextId++, time: Date.now() };
    const next = [...this.entries, entry];
    if (next.length > INSPECTOR_LOG_CAPACITY) next.splice(0, next.length - INSPECTOR_LOG_CAPACITY);
    this.entries = next;
    this.notify();
  }

  logEvent(record: Omit<InspectorEventRecord, "kind">): void {
    this.append({ kind: "event", ...record });
  }

  logAction(record: Omit<InspectorActionRecord, "kind">): void {
    this.append({ kind: "action", ...record });
  }

  logRuntimeError(message: string, detail?: Record<string, unknown>): void {
    this.append({ kind: "runtime-error", message, ...(detail ? { detail } : {}) });
  }

  logFontStatus(family: string, status: string): void {
    this.append({ kind: "font-status", family, status });
  }
}
