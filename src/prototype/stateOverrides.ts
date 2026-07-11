import type { JsonValue } from "./schema";

export const STATE_OVERRIDE_DEPTH_LIMIT = 32;
export const FORBIDDEN_STATE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

type JsonObject = { [key: string]: JsonValue };

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function clone(value: JsonValue, depth: number): JsonValue | undefined {
  if (isObject(value)) {
    if (depth > STATE_OVERRIDE_DEPTH_LIMIT) return undefined;
    return Object.fromEntries(Object.keys(value).flatMap((key) => {
      if (FORBIDDEN_STATE_KEYS.has(key)) return [];
      const copied = clone(value[key]!, depth + 1);
      return copied === undefined ? [] : [[key, copied]];
    }));
  }
  if (Array.isArray(value)) return value.map((item) => clone(item, depth + 1)).filter((item): item is JsonValue => item !== undefined);
  return value;
}

function merge(base: JsonValue | undefined, override: JsonValue, depth: number): JsonValue | undefined {
  if (isObject(override)) {
    if (depth > STATE_OVERRIDE_DEPTH_LIMIT) return base === undefined ? undefined : clone(base, depth);
    if (isObject(base)) {
      const result = clone(base, depth) as JsonObject;
      for (const key of Object.keys(override)) {
        if (FORBIDDEN_STATE_KEYS.has(key)) continue;
        const value = merge(base[key], override[key]!, depth + 1);
        if (value !== undefined) result[key] = value;
      }
      return result;
    }
  }
  return clone(override, depth);
}

export function mergeScreenState(base: JsonObject, override?: JsonObject): JsonObject {
  return (override === undefined ? clone(base, 0) : merge(base, override, 0)) as JsonObject;
}
