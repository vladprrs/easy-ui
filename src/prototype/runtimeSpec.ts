import type { Spec } from "@json-render/core";
import type { PrototypeDoc } from "./schema";

type PrototypeSpec = PrototypeDoc["screens"][number]["spec"];
type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function adaptProp(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(adaptProp);
  if (!isObject(value)) return value;

  if (Object.hasOwn(value, "$asset") && Object.keys(value).length === 1 && typeof value.$asset === "string") {
    return `/api/assets/${value.$asset}`;
  }

  if (Object.hasOwn(value, "$cond")) {
    const keys = Object.keys(value);
    const condition = value.$cond;
    if (
      keys.length === 1
      && isObject(condition)
      && Object.keys(condition).length === 3
      && Object.hasOwn(condition, "if")
      && Object.hasOwn(condition, "then")
      && Object.hasOwn(condition, "else")
    ) {
      return { $cond: condition.if, $then: condition.then, $else: condition.else };
    }
    return value;
  }

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, adaptProp(item)]));
}

export function toRuntimeSpec(spec: PrototypeSpec): Spec {
  return {
    root: spec.root,
    elements: Object.fromEntries(Object.entries(spec.elements).map(([key, element]) => [key, {
      ...element,
      props: adaptProp(element.props) as Record<string, unknown>,
    }])) as Spec["elements"],
  };
}
