import { canonicalStringify } from "../../src/capture/canonicalJson";

export const MAX_EXAMPLE_BYTES = 16 * 1024;
export const MAX_COMPONENT_EXAMPLES_BYTES = 64 * 1024;

const bytes = (value: unknown): number => new TextEncoder().encode(canonicalStringify(value)).byteLength;

function fail(path: string, message: string): never {
  throw new Error(`${path} ${message}`);
}

/** Validates the capture boundary shared by persisted named examples. */
export function validateExample(value: unknown, label = "example"): asserts value is Record<string, unknown> {
  const seen = new Set<object>();
  const visit = (node: unknown, path: string): void => {
    if (node === null || typeof node === "string" || typeof node === "boolean") return;
    if (typeof node === "number") {
      if (!Number.isFinite(node)) fail(path, "must contain only finite numbers");
      return;
    }
    if (typeof node !== "object") fail(path, "must be plain JSON (functions, symbols, BigInt, and undefined are forbidden)");
    if (seen.has(node)) fail(path, "must not contain cycles");
    seen.add(node);
    if (Array.isArray(node)) {
      if (Object.getOwnPropertySymbols(node).length) fail(path, "must not contain symbol keys");
      const descriptors = Object.getOwnPropertyDescriptors(node);
      for (let index = 0; index < node.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor)) fail(`${path}[${index}]`, "must be a dense array data property");
        visit(descriptor.value, `${path}[${index}]`);
      }
      for (const key of Object.keys(descriptors)) {
        if (key === "length") continue;
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= node.length || String(index) !== key) fail(`${path}.${key}`, "must not be a custom array property");
      }
    } else {
      const prototype = Object.getPrototypeOf(node);
      if (prototype !== Object.prototype && prototype !== null) fail(path, "must contain only plain JSON objects");
      if (Object.getOwnPropertySymbols(node).length) fail(path, "must not contain symbol keys");
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(node))) {
        if (!descriptor.enumerable || !("value" in descriptor)) fail(`${path}.${key}`, "must be an enumerable data property");
        if (key.startsWith("$") || key.startsWith("__eui")) fail(`${path}.${key}`, "uses a reserved key");
        visit(descriptor.value, `${path}.${key}`);
      }
    }
    seen.delete(node);
  };

  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(label, "must be a plain JSON object");
  visit(value, label);
  const size = bytes(value);
  if (size > MAX_EXAMPLE_BYTES) fail(label, `exceeds the ${MAX_EXAMPLE_BYTES}-byte canonical JSON limit`);
}

export function validateExamplesByteLimit(examples: Record<string, Record<string, unknown>>): void {
  const size = bytes(examples);
  if (size > MAX_COMPONENT_EXAMPLES_BYTES) throw new Error(`examples exceed the ${MAX_COMPONENT_EXAMPLES_BYTES}-byte canonical JSON limit per component`);
}
