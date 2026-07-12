/**
 * Safe JSON Pointer (RFC 6901) parsing and resolution.
 *
 * Shared foundation reused across prototype validation (`$state`, `repeat.statePath`,
 * action `statePath`) and, going forward, server-side pointer handling. All parsers
 * reject segments that could be used for prototype pollution (`__proto__`,
 * `prototype`, `constructor`) at any depth.
 */

const SEGMENT_PATTERN = /^(?:[^~/]|~0|~1)*$/;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export type PointerLookup = { exists: boolean; value: unknown };

function decodeSegment(raw: string): string {
  return raw.replace(/~1/g, "/").replace(/~0/g, "~");
}

function parseSegments(raw: string[]): string[] | null {
  if (!raw.every((segment) => SEGMENT_PATTERN.test(segment))) return null;
  const segments = raw.map(decodeSegment);
  if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) return null;
  return segments;
}

/**
 * Parses an absolute RFC 6901 JSON Pointer ("/a/b/0") into decoded, safe segments.
 * Returns `null` when the pointer is malformed, is not absolute (missing leading
 * `/`), or contains a forbidden segment at any depth.
 */
export function parseJsonPointer(pointer: string): string[] | null {
  if (typeof pointer !== "string" || pointer === "" || pointer[0] !== "/") return null;
  return parseSegments(pointer.slice(1).split("/"));
}

/**
 * Parses a repeat-item field path ("field", "a/b", or "" for the whole item) —
 * the relative addressing form used by `$item` / `$bindItem`. Leading `/` is
 * tolerated (treated the same as its absence) to match `getByPath` from
 * `@json-render/core`. Returns `null` when malformed or containing a forbidden
 * segment.
 */
export function parseRelativeFieldPath(path: string): string[] | null {
  if (typeof path !== "string") return null;
  if (path === "") return [];
  const raw = path.startsWith("/") ? path.slice(1) : path;
  return parseSegments(raw.split("/"));
}

export function isSafeJsonPointer(value: unknown): value is string {
  return typeof value === "string" && parseJsonPointer(value) !== null;
}

export function isSafeRelativeFieldPath(value: unknown): value is string {
  return typeof value === "string" && parseRelativeFieldPath(value) !== null;
}

function lookupSegments(root: unknown, segments: string[]): PointerLookup {
  let current: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(segment)) return { exists: false, value: undefined };
      const index = Number(segment);
      if (index >= current.length) return { exists: false, value: undefined };
      current = current[index];
      continue;
    }
    if (typeof current !== "object" || current === null) return { exists: false, value: undefined };
    if (!Object.hasOwn(current, segment)) return { exists: false, value: undefined };
    current = (current as Record<string, unknown>)[segment];
  }
  return { exists: true, value: current };
}

/** Resolves an absolute JSON Pointer against `root`. Unsafe/malformed pointers resolve to "not found". */
export function getAtPointer(root: unknown, pointer: string): PointerLookup {
  const segments = parseJsonPointer(pointer);
  if (segments === null) return { exists: false, value: undefined };
  return lookupSegments(root, segments);
}

/** Resolves a relative field path (as used by `$item`) against `root`. */
export function getAtRelativePath(root: unknown, path: string): PointerLookup {
  const segments = parseRelativeFieldPath(path);
  if (segments === null) return { exists: false, value: undefined };
  return lookupSegments(root, segments);
}
