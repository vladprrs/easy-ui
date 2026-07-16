import { componentDocsStrings as strings } from "./strings";

export const RAW_JSON_MAX_DEPTH = 6;
export const RAW_JSON_MAX_CHARS = 12_000;
const RAW_JSON_MAX_NODES = 1_000;

type TraversalState = { remainingNodes: number; sizeCapped: boolean };

function boundedValue(value: unknown, depth: number, seen: WeakSet<object>, state: TraversalState): unknown {
  state.remainingNodes -= 1;
  if (state.remainingNodes < 0) {
    state.sizeCapped = true;
    return `[${strings.rawSizeLimit}]`;
  }
  if (depth >= RAW_JSON_MAX_DEPTH && value !== null && typeof value === "object") return `[${strings.rawDepthLimit}]`;
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && value.length > RAW_JSON_MAX_CHARS) {
      state.sizeCapped = true;
      return `${value.slice(0, RAW_JSON_MAX_CHARS)}… [${strings.rawSizeLimit}]`;
    }
    if (typeof value === "bigint") return `${value.toString()}n`;
    if (typeof value === "undefined") return "[undefined]";
    if (typeof value === "function") return "[function]";
    if (typeof value === "symbol") return value.toString();
    return value;
  }
  if (seen.has(value)) return "[Циклическая ссылка]";
  seen.add(value);
  if (Array.isArray(value)) {
    const limit = Math.max(0, state.remainingNodes);
    const items = value.slice(0, limit).map((item) => boundedValue(item, depth + 1, seen, state));
    if (value.length > limit) {
      state.sizeCapped = true;
      items.push(`[${strings.rawSizeLimit}]`);
    }
    return items;
  }
  const entries = Object.entries(value);
  const limit = Math.max(0, state.remainingNodes);
  const result = Object.fromEntries(entries.slice(0, limit).map(([key, item]) => [key, boundedValue(item, depth + 1, seen, state)]));
  if (entries.length > limit) {
    state.sizeCapped = true;
    result["…"] = `[${strings.rawSizeLimit}]`;
  }
  return result;
}

export function formatRawJson(value: unknown): string {
  let text: string;
  const state: TraversalState = { remainingNodes: RAW_JSON_MAX_NODES, sizeCapped: false };
  try {
    text = JSON.stringify(boundedValue(value, 0, new WeakSet(), state), null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  if (text.length <= RAW_JSON_MAX_CHARS) return state.sizeCapped && !text.includes(strings.rawSizeLimit)
    ? `${text}\n… [${strings.rawSizeLimit}]`
    : text;
  return `${text.slice(0, RAW_JSON_MAX_CHARS)}\n… [${strings.rawSizeLimit}]`;
}

export function RawJson({ value, summary = strings.showRawSchema }: { value: unknown; summary?: string }) {
  return <details>
    <summary>{summary}</summary>
    <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words">{formatRawJson(value)}</pre>
  </details>;
}
