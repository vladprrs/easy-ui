import { validateSpec, type Spec } from "@json-render/core";
import type { ComponentDefinition } from "../catalog/definitions";
import { BUILTIN_SEMANTICS, isPublicRuntimePath, type BuiltinSemantics } from "../catalog/builtinSemantics";
import { prototypeActionSchemas } from "../catalog/actions";
import { atomicRank, type AtomicLevel } from "../designSystems/types";
import { getAtPointer, isSafeJsonPointer, isSafeRelativeFieldPath } from "./pointer";
import { isAssetId, type PrototypeDoc } from "./schema";
import { FORBIDDEN_STATE_KEYS, mergeScreenState, STATE_OVERRIDE_DEPTH_LIMIT } from "./stateOverrides";
import { lintPrototypeLayouts } from "./layoutLints";
import type { PrototypeValidationResult, ValidationIssue } from "./types";
import { hostPrimitiveDefinitions, hostPrimitiveNames } from "../catalog/hostPrimitives/definitions";
import { validateOverlayRules } from "./overlayRules";
import { buildNavigationGraph, verifyEdge } from "./navigationGraph";
import { validateRegionRules } from "./regionRules";

type Obj = Record<string, unknown>;
const terminals = new Set(["navigate", "back", "restart", "openUrl"]);
const forbiddenPaths = ["/currentScreen", "/navStack", "/_viewer"];
export const REPEAT_ELEMENT_LIMIT = 20;
export const REPEAT_RENDER_COST_BUDGET = 2000;
export const ELEMENTS_PER_SCREEN_LIMIT = 500;
export const TREE_DEPTH_LIMIT = 50;

const object = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const pathString = (parts: (string | number)[]) => "/" + parts.map(String).join("/");
const issue = (list: ValidationIssue[], path: (string | number)[], message: string): void => { list.push({ path: pathString(path), message }); };
export const isDynamicValue = (value: unknown): boolean => object(value) && Object.keys(value).some((key) => key.startsWith("$"));
const isStatic = (value: unknown): boolean => !isDynamicValue(value) && (!Array.isArray(value) ? !object(value) || Object.values(value).every(isStatic) : value.every(isStatic));

// --- Semantic-validation helpers (warnings; never errors) ---

// Inline base64 / data-URL string props larger than this are flagged (upload as an asset instead).
export const INLINE_BASE64_WARN_BYTES = 100 * 1024;
// Payload property names that identify which repeated item an event refers to.
const ITEM_IDENTITY_KEYS = new Set(["itemId", "id", "key", "value"]);

// Resolves the semantic metadata for an element: builtin values come from the
// static table; custom values come from the definition's own additive fields.
function elementSemantics(type: string, definition: ComponentDefinition, isCustom: boolean): BuiltinSemantics {
  if (!isCustom) return BUILTIN_SEMANTICS[type] ?? {};
  return {
    interactive: definition.interactive === true,
    accessibleLabelProps: definition.accessibleLabelProps,
    urlProps: definition.urlProps,
  };
}

// True when any (possibly nested) prop value is a two-way binding directive.
function hasTwoWayBinding(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasTwoWayBinding);
  if (!object(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 1 && (keys[0] === "$bindState" || keys[0] === "$bindItem")) return true;
  return Object.values(value).some(hasTwoWayBinding);
}

// A label prop counts as provided when it is a non-blank string or any dynamic directive.
function labelProvided(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return isDynamicValue(value);
}

// Top-level property names declared by an event's payload schema (zod shape or JSON Schema).
function payloadPropertyNames(definition: ComponentDefinition, event: string): Set<string> {
  const zodSchema = definition.eventPayloadSchemas?.[event] as { shape?: Record<string, unknown> } | undefined;
  if (zodSchema && object(zodSchema.shape)) return new Set(Object.keys(zodSchema.shape));
  const jsonSchema = definition.eventPayloads?.[event] as { properties?: Record<string, unknown> } | undefined;
  if (jsonSchema && object(jsonSchema.properties)) return new Set(Object.keys(jsonSchema.properties));
  return new Set();
}

// Flags any string prop that carries a large inline base64 / data-URL payload.
function scanInlineBase64(value: unknown, at: (string | number)[], warnings: ValidationIssue[]): void {
  if (Array.isArray(value)) { value.forEach((item, index) => scanInlineBase64(item, [...at, index], warnings)); return; }
  if (object(value)) { for (const [key, item] of Object.entries(value)) scanInlineBase64(item, [...at, key], warnings); return; }
  if (typeof value !== "string" || value.length <= INLINE_BASE64_WARN_BYTES) return;
  const looksBase64 = value.startsWith("data:") || /^[A-Za-z0-9+/\s]+={0,2}$/.test(value);
  if (looksBase64) issue(warnings, at, `inline base64/data-URL value exceeds ${Math.round(INLINE_BASE64_WARN_BYTES / 1024)}KB; upload it as an asset instead`);
}

function checkPointer(value: unknown, path: (string | number)[], errors: ValidationIssue[], warnings: ValidationIssue[], state: Obj, warnMissing: boolean) {
  if (!isSafeJsonPointer(value)) return issue(errors, path, "state path must be an absolute RFC 6901 JSON Pointer");
  if (forbiddenPaths.some((reserved) => value === reserved || value.startsWith(reserved + "/"))) issue(errors, path, "state path uses a reserved viewer namespace");
  if (warnMissing && !getAtPointer(state, value).exists) issue(warnings, path, "state path is not present in document state");
}

function checkCondition(value: unknown, path: (string | number)[], errors: ValidationIssue[], warnings: ValidationIssue[], state: Obj, insideRepeat: boolean): void {
  if (typeof value === "boolean") return;
  if (!object(value)) return issue(errors, path, "condition must use the closed v1 condition grammar");
  if ("$and" in value || "$or" in value) {
    const key = "$and" in value ? "$and" : "$or";
    if (Object.keys(value).length !== 1 || !Array.isArray(value[key]) || value[key].length === 0) return issue(errors, path, `${key} must be the only key and contain conditions`);
    value[key].forEach((item, index) => checkCondition(item, [...path, key, index], errors, warnings, state, insideRepeat));
    return;
  }
  const allowed = new Set(["$state", "$item", "$index", "eq", "neq", "gt", "gte", "lt", "lte", "not"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) issue(errors, path, `unknown condition operator: ${unknown.join(", ")}`);
  const subjectKeys = (["$state", "$item", "$index"] as const).filter((key) => key in value);
  if (subjectKeys.length !== 1) issue(errors, path, "condition requires exactly one of $state, $item, $index");
  else {
    const subject = subjectKeys[0]!;
    if (subject === "$state") checkPointer(value.$state, [...path, "$state"], errors, warnings, state, true);
    else if (subject === "$item") {
      if (!insideRepeat) issue(errors, [...path, "$item"], "$item is only allowed inside a repeat subtree");
      if (!isSafeRelativeFieldPath(value.$item)) issue(errors, [...path, "$item"], "$item must be a safe relative field path");
    } else {
      if (!insideRepeat) issue(errors, [...path, "$index"], "$index is only allowed inside a repeat subtree");
      if (value.$index !== true) issue(errors, [...path, "$index"], "$index must be true");
    }
  }
  const comparisons = ["eq", "neq", "gt", "gte", "lt", "lte"].filter((key) => key in value);
  if (comparisons.length > 1) issue(errors, path, "condition may contain at most one comparison operator");
  if ("not" in value && value.not !== true) issue(errors, [...path, "not"], "not must be true");
  comparisons.forEach((key) => {
    if (!isStatic(value[key])) issue(errors, [...path, key], "condition operand must be a static literal");
    else if (["gt", "gte", "lt", "lte"].includes(key) && typeof value[key] !== "number") issue(errors, [...path, key], `${key} operand must be a number`);
  });
}

function checkDynamic(value: unknown, path: (string | number)[], errors: ValidationIssue[], warnings: ValidationIssue[], state: Obj, insideRepeat: boolean): boolean {
  if (!isDynamicValue(value)) return false;
  if (!object(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) { issue(errors, path, "dynamic value must contain exactly one v1 directive"); return true; }
  const key = keys[0]!;
  if (key === "$state" || key === "$bindState") checkPointer(value[key], [...path, key], errors, warnings, state, key === "$state");
  else if (key === "$item" || key === "$bindItem") {
    if (!insideRepeat) issue(errors, [...path, key], `${key} is only allowed inside a repeat subtree`);
    if (!isSafeRelativeFieldPath(value[key])) issue(errors, [...path, key], `${key} must be a safe relative field path`);
  } else if (key === "$index") {
    if (!insideRepeat) issue(errors, [...path, key], "$index is only allowed inside a repeat subtree");
    if (value[key] !== true) issue(errors, [...path, key], "$index must be true");
  }
  else if (key === "$asset") { if (!isAssetId(value[key])) issue(errors, [...path, key], "$asset must be an asset id (asset_ followed by 64 hex chars)"); }
  else if (key === "$template") { if (typeof value[key] !== "string") issue(errors, [...path, key], "$template must be a string"); }
  else if (key === "$cond") {
    const cond = value[key];
    if (!object(cond) || !Object.hasOwn(cond, "if") || !Object.hasOwn(cond, "then") || !Object.hasOwn(cond, "else") || Object.keys(cond).some((k) => !["if", "then", "else"].includes(k))) issue(errors, [...path, key], "$cond must be {if, then, else}");
    else {
      checkCondition(cond.if, [...path, key, "if"], errors, warnings, state, insideRepeat);
      if (!isStatic(cond.then)) issue(errors, [...path, key, "then"], "$cond branches must be static literals");
      if (!isStatic(cond.else)) issue(errors, [...path, key, "else"], "$cond branches must be static literals");
    }
  } else issue(errors, path, `unknown dynamic directive: ${key}`);
  return true;
}

const PARAM_SOURCE_KEYS = new Set(["$event", "$elementId", "$itemIndex", "$itemKey"]);
const isParamSource = (value: unknown): value is Obj => object(value) && Object.keys(value).length === 1 && PARAM_SOURCE_KEYS.has(Object.keys(value)[0]!);

// Replaces every param-source directive with `undefined` so the remaining literal
// structure can be static-checked and validated against the action's Zod schema.
function stripSources(value: unknown): unknown {
  if (isParamSource(value)) return undefined;
  if (Array.isArray(value)) return value.map(stripSources);
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stripSources(item)]));
  return value;
}

// Validates an action-level `$if` condition (custom events only): boolean, $and/$or,
// or a `{$event}`-operand truthiness/eq/neq check. `hasPayload` gates `$event`.
function checkActionCondition(value: unknown, path: (string | number)[], errors: ValidationIssue[], hasPayload: boolean): void {
  if (typeof value === "boolean") return;
  if (!object(value)) return issue(errors, path, "$if condition must use the closed v1 condition grammar");
  if ("$and" in value || "$or" in value) {
    const key = "$and" in value ? "$and" : "$or";
    if (Object.keys(value).length !== 1 || !Array.isArray(value[key]) || value[key].length === 0) return issue(errors, path, `${key} must be the only key and contain conditions`);
    value[key].forEach((item, index) => checkActionCondition(item, [...path, key, index], errors, hasPayload));
    return;
  }
  const allowed = new Set(["$event", "eq", "neq", "not"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) return issue(errors, path, `unknown $if operator: ${unknown.join(", ")}`);
  if (!("$event" in value)) return issue(errors, path, "$if condition requires a $event operand");
  if (!hasPayload) issue(errors, [...path, "$event"], "$event is only allowed on an event with a declared payload schema");
  if (typeof value.$event !== "string") issue(errors, [...path, "$event"], "$event must be a JSON Pointer string");
  const comparisons = ["eq", "neq"].filter((key) => key in value);
  if (comparisons.length > 1) issue(errors, path, "$if may contain at most one comparison operator");
  comparisons.forEach((key) => { if (!isStatic(value[key])) issue(errors, [...path, key], "$if operand must be a static literal"); });
  if ("not" in value && value.not !== true) issue(errors, [...path, "not"], "not must be true");
}

export function validateElementProps({
  definition,
  props,
  state,
  path,
  insideRepeat = false,
}: {
  definition: ComponentDefinition;
  props: Obj;
  state: Obj;
  path: (string | number)[];
  insideRepeat?: boolean;
}): PrototypeValidationResult {
  const errors: ValidationIssue[] = [], warnings: ValidationIssue[] = [];
  if (isDynamicValue(props)) {
    issue(errors, path, "a directive cannot be the entire props object");
    return { errors, warnings };
  }
  const scanEui = (value: unknown, at: (string | number)[]): void => {
    if (Array.isArray(value)) { value.forEach((item, index) => scanEui(item, [...at, index])); return; }
    if (!object(value)) return;
    for (const key of Object.keys(value)) {
      if (key.startsWith("__eui")) issue(errors, [...at, key], "the __eui* namespace is reserved and cannot appear in props");
      scanEui(value[key], [...at, key]);
    }
  };
  scanEui(props, path);
  const dynamicPaths = new Set<string>();
  const visit = (value: unknown, relative: (string | number)[]): unknown => {
    if (checkDynamic(value, [...path, ...relative], errors, warnings, state, insideRepeat)) {
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
  errors.push(...validateOverlayRules(doc));
  errors.push(...validateRegionRules(doc));
  // Custom definitions are followed by reserved host definitions. The server
  // supplies the exact pinned custom snapshot; host-only documents need no snapshot.
  const testGlobal = globalThis as typeof globalThis & { __EUI_LEGACY_TEST_RUNTIME__?: { definitions: Record<string, ComponentDefinition> } };
  const testDefinitions = import.meta.env?.MODE === "test" && (doc.designSystem === "shadcn" || doc.designSystem === "wireframe")
    ? testGlobal.__EUI_LEGACY_TEST_RUNTIME__?.definitions : undefined;
  const suppliedDefinitions = options?.definitions && Object.keys(options.definitions).length ? options.definitions : undefined;
  const definitions: Record<string, ComponentDefinition> = { ...(suppliedDefinitions ?? testDefinitions ?? {}), ...hostPrimitiveDefinitions };
  const builtinNames = new Set<string>();
  const screenIds = new Set(doc.screens.map((screen) => screen.id));
  const navigation = buildNavigationGraph(doc);
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
    if (Object.keys(elements).length > ELEMENTS_PER_SCREEN_LIMIT) issue(errors, [...base, "elements"], `screen exceeds ${ELEMENTS_PER_SCREEN_LIMIT} elements`);

    const insideRepeat = new Set<string>();
    const nearestRepeatHasKey = new Map<string, boolean>();
    const repeatKeys: string[] = [];
    {
      const seen = new Set<string>();
      const walkRepeat = (key: string, ancestorRepeat: boolean, ancestorHasKey: boolean, depth: number) => {
        if (seen.has(key) || depth > 60) return;
        seen.add(key);
        const element = elements[key];
        if (!element) return;
        const hasRepeat = Boolean(element.repeat);
        if (hasRepeat) {
          repeatKeys.push(key);
          if (ancestorRepeat) issue(errors, [...base, "elements", key, "repeat"], "nested repeat is not allowed");
        }
        const childAncestorRepeat = ancestorRepeat || hasRepeat;
        const childAncestorHasKey = hasRepeat ? Boolean(element.repeat!.key) : ancestorHasKey;
        for (const child of element.children ?? []) {
          if (childAncestorRepeat) { insideRepeat.add(child); nearestRepeatHasKey.set(child, childAncestorHasKey); }
          walkRepeat(child, childAncestorRepeat, childAncestorHasKey, depth + 1);
        }
      };
      walkRepeat(screen.spec.root, false, false, 0);
    }
    if (repeatKeys.length > REPEAT_ELEMENT_LIMIT) issue(errors, [...base, "elements"], `screen exceeds ${REPEAT_ELEMENT_LIMIT} repeat elements (found ${repeatKeys.length})`);
    for (const key of repeatKeys) {
      const repeat = elements[key]!.repeat!;
      const repeatPath = [...base, "elements", key, "repeat", "statePath"];
      checkPointer(repeat.statePath, repeatPath, errors, warnings, effectiveState, false);
      if (isSafeJsonPointer(repeat.statePath) && !Array.isArray(getAtPointer(effectiveState, repeat.statePath).value)) {
        issue(warnings, repeatPath, "repeat state path is not an array in the effective initial state; it may be populated dynamically");
      }
    }
    {
      const memo = new Map<string, number>();
      const visiting = new Set<string>();
      const renderCost = (key: string): number => {
        if (memo.has(key)) return memo.get(key)!;
        if (visiting.has(key)) return 0;
        visiting.add(key);
        const element = elements[key];
        if (!element) { visiting.delete(key); memo.set(key, 0); return 0; }
        const childrenCost = (element.children ?? []).reduce((sum, child) => sum + renderCost(child), 0);
        let repeatLength = 0;
        if (element.repeat && isSafeJsonPointer(element.repeat.statePath)) {
          const at = getAtPointer(effectiveState, element.repeat.statePath).value;
          repeatLength = Array.isArray(at) ? at.length : 0;
        }
        const total = element.repeat ? 1 + repeatLength * childrenCost : 1 + childrenCost;
        visiting.delete(key);
        memo.set(key, total);
        return total;
      };
      const totalCost = renderCost(screen.spec.root);
      if (totalCost > REPEAT_RENDER_COST_BUDGET) issue(errors, base, `screen render cost (${totalCost}) exceeds the budget of ${REPEAT_RENDER_COST_BUDGET}`);
    }

    const parentOf = new Map<string, string>();
    for (const [parentKey, element] of Object.entries(elements)) for (const child of element.children ?? []) parentOf.set(child, parentKey);
    const parents = new Map<string, number>();
    for (const [key, element] of Object.entries(elements)) {
      const ep = [...base, "elements", key];
      const definition = definitions[element.type];
      if (!definition) { issue(errors, [...ep, "type"], `unknown component type: ${element.type}`); continue; }
      // Named slots: `slot` is valid only on a child of a custom component with capabilities.namedSlots,
      // and only for a slot name declared by that parent's definition.
      const childSlot = (element as { slot?: unknown }).slot;
      if (typeof childSlot === "string") {
        const parentKey = parentOf.get(key);
        const parent = parentKey ? elements[parentKey] : undefined;
        const parentDef = parent ? definitions[parent.type] : undefined;
        const parentIsCustom = Boolean(parent) && !builtinNames.has(parent!.type) && !hostPrimitiveNames.has(parent!.type) && Boolean(parentDef);
        if (!parent) issue(errors, [...ep, "slot"], "slot requires a parent element");
        else if (!parentIsCustom || parentDef?.capabilities?.namedSlots !== true) issue(errors, [...ep, "slot"], "slot is only allowed on a child of a custom component with named slots");
        else if (!(parentDef.slots ?? []).includes(childSlot)) issue(errors, [...ep, "slot"], `unknown slot for ${parent.type}: ${childSlot}`);
      }
      // A repeat element renders its children as a single RepeatChildren node, so slot indices are
      // inapplicable: named-slot custom parents may not also repeat.
      if (element.repeat && definition.capabilities?.namedSlots === true) issue(errors, [...ep, "repeat"], "repeat is not allowed on a custom component with named slots");
      const elementInsideRepeat = insideRepeat.has(key);
      const propIssues = validateElementProps({ definition, props: element.props, state: effectiveState, path: [...ep, "props"], insideRepeat: elementInsideRepeat });
      errors.push(...propIssues.errors);
      warnings.push(...propIssues.warnings);
      if (element.visible !== undefined) checkCondition(element.visible, [...ep, "visible"], errors, warnings, effectiveState, elementInsideRepeat);
      for (const child of element.children ?? []) parents.set(child, (parents.get(child) ?? 0) + 1);
      if (element.type === "Hotspot") {
        if (elementInsideRepeat) issue(errors, ep, "Hotspot is not allowed inside a repeat subtree");
        const p = element.props;
        for (const name of ["x", "y", "width", "height"] as const) if (isDynamicValue(p[name])) issue(errors, [...ep, "props", name], "Hotspot coordinates must be static");
        if (screen.canvas && [p.x,p.y,p.width,p.height].every((v) => typeof v === "number") && ((p.x as number) < 0 || (p.y as number) < 0 || (p.x as number)+(p.width as number)>screen.canvas.width || (p.y as number)+(p.height as number)>screen.canvas.height)) issue(errors, [...ep, "props"], "Hotspot is outside canvas bounds");
      }
      if (element.type === "Image") checkUrl(element.props.src, [...ep,"props","src"], true, errors);
      const isCustomType = !builtinNames.has(element.type) && !hostPrimitiveNames.has(element.type) && Boolean(definitions[element.type]);
      // --- Semantic warnings (never block validation) ---
      const sem = elementSemantics(element.type, definition, isCustomType);
      const hasHandler = Boolean(element.on) && Object.keys(element.on!).length > 0;
      if (sem.interactive && !sem.selfDriven && !hasHandler && !hasTwoWayBinding(element.props)) {
        issue(warnings, ep, `interactive ${element.type} has no event handler and no two-way binding`);
      }
      if (sem.interactive && sem.accessibleLabelProps?.length) {
        const hasLabel = sem.accessibleLabelProps.some((prop) => labelProvided(element.props[prop]));
        const hasTextChild = (element.children ?? []).some((childKey) => {
          const child = elements[childKey];
          if (!child) return false;
          const text = child.props.text ?? child.props.label ?? child.props.title;
          return labelProvided(text);
        });
        if (!hasLabel && !hasTextChild) issue(warnings, ep, `interactive ${element.type} has no accessible label`);
      }
      scanInlineBase64(element.props, [...ep, "props"], warnings);
      if (sem.urlProps) for (const prop of sem.urlProps) {
        const value = element.props[prop];
        if (typeof value === "string" && value.startsWith("/") && !isPublicRuntimePath(value)) {
          issue(warnings, [...ep, "props", prop], `${prop} points to a local path (${value}) that may be unavailable in the player runtime`);
        }
      }
      const eventPayloadNames = new Set<string>([
        ...Object.keys(definition.eventPayloadSchemas ?? {}),
        ...Object.keys((definition as { eventPayloads?: Record<string, unknown> }).eventPayloads ?? {}),
      ]);
      for (const [event, bindings] of Object.entries(element.on ?? {})) {
        const events = "events" in definition ? definition.events : [];
        if (!(events ?? []).includes(event)) issue(errors, [...ep,"on",event], `unknown event for ${element.type}: ${event}`);
        const hasPayload = eventPayloadNames.has(event);
        let eventUsesEventSource = false;
        const actions = Array.isArray(bindings) ? bindings : [bindings];
        const terminalIndexes = actions.map((a,i) => terminals.has(a.action) ? i : -1).filter((i) => i >= 0);
        if (terminalIndexes.length > 1) issue(errors, [...ep,"on",event], "event may contain at most one terminal action");
        if (terminalIndexes.length === 1 && terminalIndexes[0] !== actions.length - 1) issue(errors, [...ep,"on",event], "terminal action must be last");
        actions.forEach((action, actionIndex) => {
          const ap = [...ep,"on",event,actionIndex];
          const actionDef = prototypeActionSchemas[action.action as keyof typeof prototypeActionSchemas];
          if (!actionDef) return issue(errors, [...ap,"action"], `unknown action: ${action.action}`);
          // $if is a custom-only conditional; the native Renderer cannot evaluate it.
          if ((action as { $if?: unknown }).$if !== undefined) {
            if (!isCustomType) issue(errors, [...ap,"$if"], "conditional actions ($if) are only allowed on custom component events");
            else checkActionCondition((action as { $if?: unknown }).$if, [...ap,"$if"], errors, hasPayload);
          }
          // Collect param-source directives; they are allowed only in custom events
          // and only under value (setState/pushState), index (removeState) or screenId (navigate).
          const sourcePaths = new Set<string>();
          const scanParams = (value: unknown, rel: (string | number)[]): void => {
            if (isParamSource(value)) {
              sourcePaths.add(rel.join("/"));
              const srcKey = Object.keys(value)[0]!;
              const rootAllowed = (action.action === "setState" || action.action === "pushState") ? rel[0] === "value"
                : action.action === "removeState" ? (rel.length === 1 && rel[0] === "index")
                : action.action === "navigate" ? (rel.length === 1 && rel[0] === "screenId") : false;
              if (!isCustomType) issue(errors, [...ap,"params",...rel], "param sources are only allowed on custom component events");
              else if (!rootAllowed) issue(errors, [...ap,"params",...rel], `${srcKey} is not allowed here`);
              else {
                if (srcKey === "$event") {
                  eventUsesEventSource = true;
                  if (!hasPayload) issue(errors, [...ap,"params",...rel], "$event is only allowed on an event with a declared payload schema");
                  else if (typeof value.$event !== "string") issue(errors, [...ap,"params",...rel], "$event must be a JSON Pointer string");
                }
                if (srcKey === "$elementId" && value.$elementId !== true) issue(errors, [...ap,"params",...rel], "$elementId must be true");
                if (srcKey === "$itemIndex") {
                  if (value.$itemIndex !== true) issue(errors, [...ap,"params",...rel], "$itemIndex must be true");
                  if (!elementInsideRepeat) issue(errors, [...ap,"params",...rel], "$itemIndex is only allowed inside a repeat subtree");
                }
                if (srcKey === "$itemKey") {
                  if (value.$itemKey !== true) issue(errors, [...ap,"params",...rel], "$itemKey must be true");
                  if (!elementInsideRepeat) issue(errors, [...ap,"params",...rel], "$itemKey is only allowed inside a repeat subtree");
                  else if (!nearestRepeatHasKey.get(key)) issue(errors, [...ap,"params",...rel], "$itemKey requires the repeat element to declare a key");
                }
              }
              return;
            }
            if (Array.isArray(value)) { value.forEach((item, index) => scanParams(item, [...rel, index])); return; }
            if (object(value)) { for (const [k, v] of Object.entries(value)) scanParams(v, [...rel, k]); return; }
          };
          scanParams(action.params ?? {}, []);
          // Remaining literals must be static (no non-source directives) and match the schema.
          const staticized = stripSources(action.params ?? {});
          if (!isStatic(staticized)) issue(errors, [...ap,"params"], "action params must contain only static literals or param sources");
          const parsed = actionDef.params.safeParse(staticized);
          if (!parsed.success) parsed.error.issues.forEach((zIssue) => {
            const zPath = zIssue.path.map(String).join("/");
            if ([...sourcePaths].some((sourcePath) => zPath === sourcePath || zPath.startsWith(sourcePath + "/"))) return;
            issue(errors, [...ap,"params",...zIssue.path.map(String)], zIssue.message);
          });
          const statePath = action.params?.statePath;
          if (["setState","pushState","removeState"].includes(action.action)) checkPointer(statePath, [...ap,"params","statePath"], errors, warnings, effectiveState, false);
          if (action.action === "navigate" && typeof action.params?.screenId === "string") {
            if (!screenIds.has(action.params.screenId)) issue(errors, [...ap,"params","screenId"], "navigate target does not exist");
          }
          if (action.action === "openUrl") checkUrl(action.params?.url, [...ap,"params","url"], false, errors);
        });
        // A repeated element that reads $event out of a payload lacking item identity cannot tell
        // which item was acted on — warn so authors add an itemId/id/key/value field to the payload.
        if (elementInsideRepeat && hasPayload && eventUsesEventSource) {
          const names = payloadPropertyNames(definition, event);
          if (![...names].some((name) => ITEM_IDENTITY_KEYS.has(name))) {
            issue(warnings, [...ep,"on",event], `event payload has no item identity (itemId/id/key/value) for a repeated element`);
          }
        }
      }
    }
    for (const [child, count] of parents) if (count > 1) issue(errors, [...base,"elements",child], "element has more than one parent");
    const visiting = new Set<string>(), visited = new Set<string>();
    const dfs = (key: string, depth: number, ancestorLevel?: AtomicLevel) => {
      if (depth > TREE_DEPTH_LIMIT) issue(errors, [...base,"elements",key], `tree depth exceeds ${TREE_DEPTH_LIMIT}`);
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

    // Monolithic screen: the whole screen is a single custom organism/page with no children —
    // a hint that the screen reconstructs a page in one component instead of composing the system.
    const rootElement = elements[screen.spec.root];
    const rootDefinition = rootElement ? definitions[rootElement.type] : undefined;
    const rootIsCustom = Boolean(rootElement) && !builtinNames.has(rootElement!.type) && !hostPrimitiveNames.has(rootElement!.type) && Boolean(rootDefinition);
    const rootLevel = rootDefinition?.atomicLevel;
    if (rootIsCustom && (rootLevel === "organism" || rootLevel === "page") && !(rootElement!.children?.length) && Object.keys(elements).length === 1) {
      issue(warnings, [...base, "elements", screen.spec.root], `monolithic screen: root ${rootElement!.type} is a single custom ${rootLevel} with no children; consider composing it from design-system elements`);
    }
  }
  const reachableScreens = new Set<string>();
  const visitScreen = (id: string) => { if (reachableScreens.has(id)) return; reachableScreens.add(id); navigation.edges.get(id)?.forEach(visitScreen); };
  visitScreen(doc.startScreen);
  doc.screens.forEach((screen, index) => { if (!reachableScreens.has(screen.id)) issue(warnings, ["screens",index,"id"], "screen is not reachable by navigate actions"); });
  // Multiple screens with no navigate action moving between two different screens: likely
  // disconnected screens (back/restart/openUrl don't count as inter-screen navigation).
  if (doc.screens.length >= 2) {
    const hasCrossScreenNavigate = [...navigation.edges.entries()].some(([source, targets]) => [...targets].some((target) => target !== source));
    if (!hasCrossScreenNavigate) issue(warnings, ["screens"], "prototype has multiple screens but no navigate action moves between different screens");
  }
  if (doc.flows) {
    const mainScreenIds = new Set(doc.flows[0]!.steps.map((step) => step.screenId));
    doc.flows.forEach((flow, flowIndex) => {
      if (flow.steps.length === 1) issue(warnings, ["flows", flowIndex, "steps"], "flow has a single step");
      flow.steps.forEach((step, stepIndex) => {
        // Anchors are branch-flow steps referencing a main-flow screen; main-flow steps own their tiles and display notes.
        if (flowIndex > 0 && step.note !== undefined && mainScreenIds.has(step.screenId)) {
          issue(warnings, ["flows", flowIndex, "steps", stepIndex, "note"], "flow step note on a main-flow anchor is not displayed");
        }
        if (stepIndex > 0 && verifyEdge(navigation, flow.steps[stepIndex - 1]!.screenId, step.screenId) === "missing") {
          issue(warnings, ["flows", flowIndex, "steps", stepIndex, "screenId"], "flow step is not connected to the previous step by a navigate action");
        }
      });
    });
  }
  warnings.push(...lintPrototypeLayouts(doc, definitions));
  return { errors, warnings };
}

const isAssetDirective = (value: unknown): value is { $asset: unknown } => object(value) && Object.keys(value).length === 1 && Object.hasOwn(value, "$asset");

function checkUrl(value: unknown, path: (string | number)[], image: boolean, errors: ValidationIssue[]) {
  // {"$asset":"asset_<sha256>"} resolves to /api/assets/<id>; its id is validated by checkDynamic
  // (via validateElementProps), so accept it here to avoid a duplicate/spurious "static string" error.
  if (isAssetDirective(value)) return;
  if (typeof value !== "string" || isDynamicValue(value)) return issue(errors, path, "URL must be a static string");
  if (image && value.startsWith("/")) return;
  try { const url = new URL(value); if (url.protocol !== "http:" && url.protocol !== "https:") issue(errors, path, "URL must use http(s)"); }
  catch { issue(errors, path, image ? "Image URL must be http(s) or an absolute /path" : "URL must use http(s)"); }
}
