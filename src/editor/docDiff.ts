// W2-4: структурный diff документов и человекочитаемые адреса (JSON Pointer → термины документа).
// Чистые функции без React — используются диалогом конфликта 409 и 422-форматтером в EditorView.

import type { PrototypeDoc } from "../prototype/schema";
import { editor } from "../app/strings/editor";

export type DocChangeKind = "added" | "removed" | "changed" | "renamed";

/**
 * Одно структурное расхождение между двумя документами.
 * `segments` — уже человекочитаемый адрес («Экран „Корзина"», "cart-total", "text"),
 * рендер соединяет через " › ". `detail` — короткое уточнение (например, «A» → «B»).
 */
export type DocChange = { kind: DocChangeKind; segments: string[]; detail?: string };

type Screen = PrototypeDoc["screens"][number];
type Element = Screen["spec"]["elements"][string];

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const keysA = Object.keys(a as object);
  const keysB = Object.keys(b as object);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) =>
    Object.prototype.hasOwnProperty.call(b, key)
    && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/** «A» → «B» для скаляров; для структур detail не строим — адреса достаточно. */
function scalarDetail(before: unknown, after: unknown): string | undefined {
  if (before !== undefined && after !== undefined && isScalar(before) && isScalar(after)) {
    return editor.diffScalarDetail(String(before), String(after));
  }
  return undefined;
}

/** added/removed/changed для одного значения по ключам base/next. */
function diffValue(changes: DocChange[], segments: string[], before: unknown, after: unknown): void {
  if (before === undefined && after === undefined) return;
  if (before === undefined) changes.push({ kind: "added", segments });
  else if (after === undefined) changes.push({ kind: "removed", segments });
  else if (!deepEqual(before, after)) changes.push({ kind: "changed", segments, detail: scalarDetail(before, after) });
}

/** Пообъектный diff record'а (state, props, on, stateOverrides): ключи — адреса. */
function diffRecord(changes: DocChange[], prefix: string[], before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined, label: (key: string) => string = (key) => key): void {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of keys) diffValue(changes, [...prefix, label(key)], before?.[key], after?.[key]);
}

function diffElement(changes: DocChange[], prefix: string[], before: Element, after: Element): void {
  if (before.type !== after.type) changes.push({ kind: "changed", segments: [...prefix, editor.diffTypeLabel], detail: scalarDetail(before.type, after.type) });
  diffRecord(changes, prefix, before.props, after.props);
  diffRecord(changes, prefix, before.on, after.on, (event) => editor.diffHandlerLabel(event));
  diffValue(changes, [...prefix, editor.diffRepeatLabel], before.repeat, after.repeat);
  diffValue(changes, [...prefix, editor.diffSlotLabel], before.slot, after.slot);
  diffValue(changes, [...prefix, editor.diffChildrenLabel], before.children, after.children);
  diffValue(changes, [...prefix, editor.diffVisibleLabel], before.visible, after.visible);
}

function diffScreen(changes: DocChange[], before: Screen, after: Screen): void {
  const label = editor.diffScreenLabel(after.name);
  if (before.name !== after.name) {
    changes.push({ kind: "renamed", segments: [editor.diffScreenLabel(before.name)], detail: editor.diffScalarDetail(before.name, after.name) });
  }
  diffValue(changes, [label, editor.diffNoteLabel], before.note, after.note);
  diffValue(changes, [label, editor.diffCanvasLabel], before.canvas, after.canvas);
  diffRecord(changes, [label, editor.diffOverridesLabel], before.stateOverrides, after.stateOverrides);
  if (before.spec.root !== after.spec.root) changes.push({ kind: "changed", segments: [label, editor.diffRootLabel], detail: scalarDetail(before.spec.root, after.spec.root) });
  const keys = new Set([...Object.keys(before.spec.elements), ...Object.keys(after.spec.elements)]);
  for (const key of keys) {
    const beforeElement = before.spec.elements[key];
    const afterElement = after.spec.elements[key];
    if (!beforeElement) changes.push({ kind: "added", segments: [label, key] });
    else if (!afterElement) changes.push({ kind: "removed", segments: [label, key] });
    else diffElement(changes, [label, key], beforeElement, afterElement);
  }
}

const DOC_FIELD_LABELS: Partial<Record<keyof PrototypeDoc, string>> = {
  name: editor.nameLabel,
  description: editor.descriptionLabel,
  device: editor.deviceLabel,
  startScreen: editor.startScreenLabel,
  designSystem: editor.diffDesignSystemLabel,
};

/**
 * Структурный diff base → next: метаданные документа, state (по ключам верхнего
 * уровня), экраны (матчинг по id: rename отличается от добавления+удаления),
 * элементы (по ключам), props/on/repeat/slot/children/visible.
 */
export function diffDocs(base: PrototypeDoc, next: PrototypeDoc): DocChange[] {
  const changes: DocChange[] = [];
  for (const field of Object.keys(DOC_FIELD_LABELS) as (keyof typeof DOC_FIELD_LABELS)[]) {
    diffValue(changes, [DOC_FIELD_LABELS[field]!], base[field], next[field]);
  }
  diffRecord(changes, [editor.diffStateLabel], base.state, next.state);
  const nextById = new Map(next.screens.map((screen) => [screen.id, screen]));
  for (const screen of base.screens) {
    const counterpart = nextById.get(screen.id);
    if (!counterpart) changes.push({ kind: "removed", segments: [editor.diffScreenLabel(screen.name)] });
    else diffScreen(changes, screen, counterpart);
  }
  const baseIds = new Set(base.screens.map((screen) => screen.id));
  for (const screen of next.screens) {
    if (!baseIds.has(screen.id)) changes.push({ kind: "added", segments: [editor.diffScreenLabel(screen.name)] });
  }
  return changes;
}

/** Полная строка расхождения для списка в диалоге конфликта. */
export function formatDocChange(change: DocChange): string {
  const kindLabel = { added: editor.diffKindAdded, removed: editor.diffKindRemoved, changed: editor.diffKindChanged, renamed: editor.diffKindRenamed }[change.kind];
  return `${change.segments.join(" › ")} — ${kindLabel}${change.detail ? ` (${change.detail})` : ""}`;
}

/** RFC 6901: "/screens/0/spec/elements/a~1b" → ["screens","0","spec","elements","a/b"]. */
export function decodeJsonPointer(pointer: string): string[] {
  if (pointer === "" || pointer === "/") return [];
  const body = pointer.startsWith("/") ? pointer.slice(1) : pointer;
  return body.split("/").map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function describeElementPath(rest: string[]): string[] {
  const [head, ...tail] = rest;
  if (head === undefined) return [];
  if (head === "props") return tail; // «…cart-total › text» — props в адресе не показываем
  if (head === "type") return [editor.diffTypeLabel, ...tail];
  if (head === "on") { const [event, ...more] = tail; return [event === undefined ? editor.diffHandlerLabel("") : editor.diffHandlerLabel(event), ...more]; }
  if (head === "repeat") return [editor.diffRepeatLabel, ...tail];
  if (head === "slot") return [editor.diffSlotLabel, ...tail];
  if (head === "children") return [editor.diffChildrenLabel, ...tail];
  if (head === "visible") return [editor.diffVisibleLabel, ...tail];
  return rest;
}

function describeScreenPath(screen: Screen | undefined, index: string, rest: string[]): string[] {
  const label = screen ? editor.diffScreenLabel(screen.name) : `screens[${index}]`;
  const [head, ...tail] = rest;
  if (head === undefined) return [label];
  if (head === "name") return [label, editor.nameLabel];
  if (head === "note") return [label, editor.diffNoteLabel];
  if (head === "canvas") return [label, editor.diffCanvasLabel, ...tail];
  if (head === "stateOverrides") return [label, editor.diffOverridesLabel, ...tail];
  if (head === "spec") {
    const [specHead, ...specTail] = tail;
    if (specHead === "root") return [label, editor.diffRootLabel];
    if (specHead === "elements") {
      const [elementKey, ...elementRest] = specTail;
      if (elementKey === undefined) return [label];
      return [label, elementKey, ...describeElementPath(elementRest)];
    }
    return [label, ...tail];
  }
  return [label, ...rest];
}

/**
 * Человекочитаемый адрес по JSON Pointer / zod-path в терминах документа:
 * "/screens/0/spec/elements/cart-total/props/text" → «Экран „Корзина" › cart-total › text».
 */
export function describeDocPath(doc: PrototypeDoc, path: string | (string | number)[]): string {
  const segments = (typeof path === "string" ? decodeJsonPointer(path) : path.map(String));
  if (segments.length === 0) return editor.diffDocLabel;
  const [head, ...rest] = segments as [string, ...string[]];
  if (head === "screens") {
    const [index, ...screenRest] = rest;
    if (index === undefined) return editor.diffScreensLabel;
    const screen = /^\d+$/.test(index) ? doc.screens[Number(index)] : doc.screens.find((item) => item.id === index);
    return describeScreenPath(screen, index, screenRest).join(" › ");
  }
  if (head === "state") return [editor.diffStateLabel, ...rest].join(" › ");
  const docLabel = DOC_FIELD_LABELS[head as keyof typeof DOC_FIELD_LABELS];
  if (docLabel && rest.length === 0) return docLabel;
  return segments.join(" › ");
}

export type DisplayIssue = { path: string; message: string };

/**
 * 422-форматтер: приводит issues сервера (zod path-массив или строковый JSON
 * Pointer из validatePrototype) и локальные zod-issues к русским адресам.
 */
export function humanizeIssues(doc: PrototypeDoc, issues: unknown[] | undefined): DisplayIssue[] {
  return (issues ?? []).map((value) => {
    const issue = value && typeof value === "object" ? value as { path?: unknown; message?: unknown } : {};
    const path = Array.isArray(issue.path) || typeof issue.path === "string"
      ? describeDocPath(doc, issue.path as string | (string | number)[])
      : editor.diffDocLabel;
    return { path, message: typeof issue.message === "string" ? issue.message : String(value) };
  });
}
