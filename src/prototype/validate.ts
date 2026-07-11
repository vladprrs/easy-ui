import { validateSpec, type Spec } from "@json-render/core";
import type { ComponentDefinition } from "../catalog/definitions";
import { prototypeActionSchemas } from "../catalog/actions";
import { atomicRank, type AtomicLevel } from "../designSystems/types";
import { getDesignSystem } from "../designSystems";
import type { PrototypeDoc } from "./schema";
import { FORBIDDEN_STATE_KEYS, mergeScreenState, STATE_OVERRIDE_DEPTH_LIMIT } from "./stateOverrides";
import type { PrototypeValidationResult, ValidationIssue } from "./types";

type Obj = Record<string, unknown>;
const terminals = new Set(["navigate", "back", "restart", "openUrl"]);
const forbiddenPaths = ["/currentScreen", "/navStack", "/_viewer"];
const pointerPattern = /^\/(?:[^~/]|~0|~1)*(?:\/(?:[^~/]|~0|~1)*)*$/;

const object = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const pathString = (parts: (string | number)[]) => "/" + parts.map(String).join("/");
const issue = (list: ValidationIssue[], path: (string | number)[], message: string): void => { list.push({ path: pathString(path), message }); };
export const isDynamicValue = (value: unknown): boolean => object(value) && Object.keys(value).some((key) => key.startsWith("$"));
const isStatic = (value: unknown): boolean => !isDynamicValue(value) && (!Array.isArray(value) ? !object(value) || Object.values(value).every(isStatic) : value.every(isStatic));

function stateAt(state: Obj, pointer: string): { exists: boolean; value: unknown } {
  if (pointer === "") return { exists: true, value: state };
  let current: unknown = state;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!object(current) || !Object.hasOwn(current, key)) return { exists: false, value: undefined };
    current = current[key];
  }
  return { exists: true, value: current };
}

function checkPointer(value: unknown, path: (string | number)[], errors: ValidationIssue[], warnings: ValidationIssue[], state: Obj, warnMissing: boolean) {
  if (typeof value !== "string" || !pointerPattern.test(value)) return issue(errors, path, "state path must be an absolute RFC 6901 JSON Pointer");
  if (forbiddenPaths.some((reserved) => value === reserved || value.startsWith(reserved + "/"))) issue(errors, path, "state path uses a reserved viewer namespace");
  if (warnMissing && !stateAt(state, value).exists) issue(warnings, path, "state path is not present in document state");
}

function checkCondition(value: unknown, path: (string | number)[], errors: ValidationIssue[], warnings: ValidationIssue[], state: Obj): void {
  if (typeof value === "boolean") return;
  if (!object(value)) return issue(errors, path, "condition must use the closed v1 condition grammar");
  if ("$and" in value || "$or" in value) {
    const key = "$and" in value ? "$and" : "$or";
    if (Object.keys(value).length !== 1 || !Array.isArray(value[key]) || value[key].length === 0) return issue(errors, path, `${key} must be the only key and contain conditions`);
    value[key].forEach((item, index) => checkCondition(item, [...path, key, index], errors, warnings, state));
    return;
  }
  const allowed = new Set(["$state", "eq", "neq", "gt", "gte", "lt", "lte", "not"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) issue(errors, path, `unknown condition operator: ${unknown.join(", ")}`);
  if (!("$state" in value)) issue(errors, path, "condition requires $state");
  else checkPointer(value.$state, [...path, "$state"], errors, warnings, state, true);
  const comparisons = ["eq", "neq", "gt", "gte", "lt", "lte"].filter((key) => key in value);
  if (comparisons.length > 1) issue(errors, path, "condition may contain at most one comparison operator");
  if ("not" in value && value.not !== true) issue(errors, [...path, "not"], "not must be true");
  comparisons.forEach((key) => {
    if (!isStatic(value[key])) issue(errors, [...path, key], "condition operand must be a static literal");
    else if (["gt", "gte", "lt", "lte"].includes(key) && typeof value[key] !== "number") issue(errors, [...path, key], `${key} operand must be a number`);
  });
}

function checkDynamic(value: unknown, path: (string | number)[], errors: ValidationIssue[], warnings: ValidationIssue[], state: Obj): boolean {
  if (!isDynamicValue(value)) return false;
  if (!object(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) { issue(errors, path, "dynamic value must contain exactly one v1 directive"); return true; }
  const key = keys[0]!;
  if (key === "$state" || key === "$bindState") checkPointer(value[key], [...path, key], errors, warnings, state, key === "$state");
  else if (key === "$template") { if (typeof value[key] !== "string") issue(errors, [...path, key], "$template must be a string"); }
  else if (key === "$cond") {
    const cond = value[key];
    if (!object(cond) || !Object.hasOwn(cond, "if") || !Object.hasOwn(cond, "then") || !Object.hasOwn(cond, "else") || Object.keys(cond).some((k) => !["if", "then", "else"].includes(k))) issue(errors, [...path, key], "$cond must be {if, then, else}");
    else {
      checkCondition(cond.if, [...path, key, "if"], errors, warnings, state);
      if (!isStatic(cond.then)) issue(errors, [...path, key, "then"], "$cond branches must be static literals");
      if (!isStatic(cond.else)) issue(errors, [...path, key, "else"], "$cond branches must be static literals");
    }
  } else issue(errors, path, `unknown dynamic directive: ${key}`);
  return true;
}

export function validateElementProps({
  definition,
  props,
  state,
  path,
}: {
  definition: ComponentDefinition;
  props: Obj;
  state: Obj;
  path: (string | number)[];
}): PrototypeValidationResult {
  const errors: ValidationIssue[] = [], warnings: ValidationIssue[] = [];
  if (isDynamicValue(props)) {
    issue(errors, path, "a directive cannot be the entire props object");
    return { errors, warnings };
  }
  const dynamicPaths = new Set<string>();
  const visit = (value: unknown, relative: (string | number)[]): unknown => {
    if (checkDynamic(value, [...path, ...relative], errors, warnings, state)) {
      dynamicPaths.add(relative.join("/"));
      return undefined;
    }
    if (Array.isArray(value)) return value.map((item, index) => visit(item, [...relative, index]));
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, [...relative, key])]));
    return value;
  };
  const staticCopy = visit(props, []) as Obj;
  const parsed = definition.props.safeParse(staticCopy);
  if (!parsed.success) for (const zIssue of parsed.error?.issues ?? []) {
    const zPath = zIssue.path.map(String).join("/");
    if ([...dynamicPaths].some((dynamicPath) => zPath === dynamicPath || zPath.startsWith(dynamicPath + "/"))) continue;
    issue(errors, [...path, ...zIssue.path.map(String)], zIssue.message);
  }
  return { errors, warnings };
}

export function validatePrototype(
  doc: PrototypeDoc,
  options?: { definitions?: Record<string, ComponentDefinition> },
): PrototypeValidationResult {
  const errors: ValidationIssue[] = [], warnings: ValidationIssue[] = [];
  let definitions = options?.definitions;
  if (!definitions) {
    try {
      definitions = getDesignSystem(doc.designSystem).definitions;
    } catch {
      issue(errors, ["designSystem"], `unknown design system: ${doc.designSystem}`);
      return { errors, warnings };
    }
  }
  const screenIds = new Set(doc.screens.map((screen) => screen.id));
  const navigation = new Map<string, Set<string>>();
  for (const [screenIndex, screen] of doc.screens.entries()) {
    const base = ["screens", screenIndex, "spec"];
    const overrideBase = ["screens", screenIndex, "stateOverrides"];
    const reservedOverrideKeys = new Set(["currentScreen", "navStack", "_viewer"]);
    const scanOverride = (value: unknown, path: (string | number)[], depth: number): void => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => scanOverride(item, [...path, index], depth + 1));
        return;
      }
      if (!object(value)) return;
      if (depth > STATE_OVERRIDE_DEPTH_LIMIT) issue(errors, path, `state override depth exceeds ${STATE_OVERRIDE_DEPTH_LIMIT}`);
      for (const key of Object.keys(value)) {
        if (FORBIDDEN_STATE_KEYS.has(key)) issue(errors, [...path, key], `state override key is forbidden: ${key}`);
        scanOverride(value[key], [...path, key], depth + 1);
      }
    };
    if (screen.stateOverrides) {
      for (const key of Object.keys(screen.stateOverrides)) if (reservedOverrideKeys.has(key)) issue(errors, [...overrideBase, key], `state override key is reserved: ${key}`);
      scanOverride(screen.stateOverrides, overrideBase, 0);
    }
    const effectiveState = mergeScreenState(doc.state, screen.stateOverrides);
    const structural = validateSpec(screen.spec as Spec, { checkOrphans: true });
    structural.issues.forEach((entry) => issue(errors, base, entry.message));
    const elements = screen.spec.elements;
    if (Object.keys(elements).length > 500) issue(errors, [...base, "elements"], "screen exceeds 500 elements");
    const parents = new Map<string, number>();
    for (const [key, element] of Object.entries(elements)) {
      const ep = [...base, "elements", key];
      const definition = definitions[element.type];
      if (!definition) { issue(errors, [...ep, "type"], `unknown component type: ${element.type}`); continue; }
      const propIssues = validateElementProps({ definition, props: element.props, state: effectiveState, path: [...ep, "props"] });
      errors.push(...propIssues.errors);
      warnings.push(...propIssues.warnings);
      if (element.visible !== undefined) checkCondition(element.visible, [...ep, "visible"], errors, warnings, effectiveState);
      for (const child of element.children ?? []) parents.set(child, (parents.get(child) ?? 0) + 1);
      if (element.type === "Hotspot") {
        if (!screen.canvas) issue(errors, ep, "Hotspot requires a screen canvas");
        const p = element.props;
        for (const name of ["x", "y", "width", "height"] as const) if (isDynamicValue(p[name])) issue(errors, [...ep, "props", name], "Hotspot coordinates must be static");
        if (screen.canvas && [p.x,p.y,p.width,p.height].every((v) => typeof v === "number") && ((p.x as number) < 0 || (p.y as number) < 0 || (p.x as number)+(p.width as number)>screen.canvas.width || (p.y as number)+(p.height as number)>screen.canvas.height)) issue(errors, [...ep, "props"], "Hotspot is outside canvas bounds");
      }
      if (element.type === "Image") checkUrl(element.props.src, [...ep,"props","src"], true, errors);
      if (element.type === "Link") checkUrl(element.props.href, [...ep,"props","href"], false, errors);
      for (const [event, bindings] of Object.entries(element.on ?? {})) {
        const events = "events" in definition ? definition.events : [];
        if (!(events ?? []).includes(event)) issue(errors, [...ep,"on",event], `unknown event for ${element.type}: ${event}`);
        const actions = Array.isArray(bindings) ? bindings : [bindings];
        const terminalIndexes = actions.map((a,i) => terminals.has(a.action) ? i : -1).filter((i) => i >= 0);
        if (terminalIndexes.length > 1) issue(errors, [...ep,"on",event], "event may contain at most one terminal action");
        if (terminalIndexes.length === 1 && terminalIndexes[0] !== actions.length - 1) issue(errors, [...ep,"on",event], "terminal action must be last");
        actions.forEach((action, actionIndex) => {
          const ap = [...ep,"on",event,actionIndex];
          const actionDef = prototypeActionSchemas[action.action as keyof typeof prototypeActionSchemas];
          if (!actionDef) return issue(errors, [...ap,"action"], `unknown action: ${action.action}`);
          if (!isStatic(action.params ?? {})) issue(errors, [...ap,"params"], "action params must contain only static literals");
          const parsed = actionDef.params.safeParse(action.params ?? {});
          if (!parsed.success) parsed.error.issues.forEach((zIssue) => issue(errors, [...ap,"params",...zIssue.path.map(String)], zIssue.message));
          const statePath = action.params?.statePath;
          if (["setState","pushState","removeState"].includes(action.action)) checkPointer(statePath, [...ap,"params","statePath"], errors, warnings, effectiveState, false);
          if (action.action === "navigate" && typeof action.params?.screenId === "string") {
            if (!screenIds.has(action.params.screenId)) issue(errors, [...ap,"params","screenId"], "navigate target does not exist");
            else {
              const targets = navigation.get(screen.id) ?? new Set<string>();
              targets.add(action.params.screenId);
              navigation.set(screen.id, targets);
            }
          }
          if (action.action === "openUrl") checkUrl(action.params?.url, [...ap,"params","url"], false, errors);
        });
        if (element.type === "Link" && actions.some((action) => terminals.has(action.action)) && !actions.some((action) => action.preventDefault === true)) issue(errors, [...ep,"on",event], "Link navigation requires preventDefault: true");
      }
    }
    for (const [child, count] of parents) if (count > 1) issue(errors, [...base,"elements",child], "element has more than one parent");
    const visiting = new Set<string>(), visited = new Set<string>();
    const dfs = (key: string, depth: number, ancestorLevel?: AtomicLevel) => {
      if (depth > 50) issue(errors, [...base,"elements",key], "tree depth exceeds 50");
      if (visiting.has(key)) { issue(errors, [...base,"elements",key], "children cycle detected"); return; }
      if (visited.has(key)) return;
      visiting.add(key);
      const element = elements[key];
      const definition = element ? definitions[element.type] : undefined;
      const level = definition?.atomicLevel;
      if (element && level && !definition.layoutNeutral && ancestorLevel && atomicRank[level] > atomicRank[ancestorLevel]) {
        issue(warnings, [...base, "elements", key], `atomic-design: ${element.type} (${level}) should not be nested inside a ${ancestorLevel}`);
      }
      const nextAncestor = level && !definition?.layoutNeutral ? level : ancestorLevel;
      for (const child of element?.children ?? []) dfs(child, depth + 1, nextAncestor);
      visiting.delete(key);
      visited.add(key);
    };
    dfs(screen.spec.root, 1);
  }
  const reachableScreens = new Set<string>();
  const visitScreen = (id: string) => { if (reachableScreens.has(id)) return; reachableScreens.add(id); navigation.get(id)?.forEach(visitScreen); };
  visitScreen(doc.startScreen);
  doc.screens.forEach((screen, index) => { if (!reachableScreens.has(screen.id)) issue(warnings, ["screens",index,"id"], "screen is not reachable by navigate actions"); });
  return { errors, warnings };
}

function checkUrl(value: unknown, path: (string | number)[], image: boolean, errors: ValidationIssue[]) {
  if (typeof value !== "string" || isDynamicValue(value)) return issue(errors, path, "URL must be a static string");
  if (image && value.startsWith("/")) return;
  try { const url = new URL(value); if (url.protocol !== "http:" && url.protocol !== "https:") issue(errors, path, "URL must use http(s)"); }
  catch { issue(errors, path, image ? "Image URL must be http(s) or an absolute /path" : "URL must use http(s)"); }
}
