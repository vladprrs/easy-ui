/**
 * Deterministic JSON serialization used for content hashing (propsHash and the
 * capture readiness/expected comparison). Object keys are emitted in sorted
 * order at every depth so semantically-equal values hash identically on both
 * the Bun server (enqueue snapshot) and the browser capture shell.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) out[key] = canonicalize(record[key]);
  return out;
}
