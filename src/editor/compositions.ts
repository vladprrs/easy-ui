import type { PrototypeCompositionPin } from "../api/client";
import { editor } from "../app/strings/editor";
import { COMPOSITION_TYPE, SLOT_TYPE } from "../catalog/hostPrimitives/composition.definition";
import { FLOW_ROOT_TYPE } from "../catalog/hostPrimitives/flowRoot.definition";
import {
  compositionDocSchema, expandCompositions, expandedKey,
  type CompositionCatalogEntry, type CompositionDoc, type CompositionSource,
  type ExpandedOrigin,
} from "../prototype/composition";
import { paramPlaceholder } from "../prototype/compositionV3/params";
import { slugSchema, type JsonValue, type PrototypeDoc } from "../prototype/schema";
import type { ValidationIssue } from "../prototype/types";

/**
 * Композиции в редакторе (волна 5, план 2026-07-27 §5).
 *
 * Редактор правит **авторский** документ (`@eui/Composition` в спеке экрана) — именно он
 * уходит в save. Рендер (холст и лента) работает по **раскрытому** документу: раскрытие
 * пересчитывается на каждую правку (`expandForEditor`), а выделение раскрытого элемента
 * возвращается к host-ключу (`hostKeyOf`), потому что внутренности композиции не авторские
 * и редактировать их на экране нельзя.
 */

export type Screen = PrototypeDoc["screens"][number];
export type ScreenElement = Screen["spec"]["elements"][string];

export interface EditorExpansion {
  /** Раскрытый документ для рендера; при отсутствии композиций — исходный (по ссылке). */
  doc: PrototypeDoc;
  /** Раскрытый ключ → происхождение (в `toRuntimeSpec({compositionRefs})`). */
  compositionRefs: Record<string, ExpandedOrigin>;
  /** Проблемы раскрытия (неизвестная композиция, плохой параметр, слот). */
  issues: ValidationIssue[];
  /** Авторский host-ключ → ключ корня раскрытой композиции (подсветка выделения на холсте). */
  hostRootKeys: Record<string, string>;
}

/** Карта `id → документ` из пинов ревизии. */
export function compositionMapFromPins(pins: readonly PrototypeCompositionPin[] | undefined): Record<string, CompositionDoc> {
  return Object.fromEntries((pins ?? []).map((pin) => {
    const source: CompositionSource = {
      doc: pin.doc,
      version: pin.version,
      ...(pin.designSystem !== undefined ? { designSystem: pin.designSystem } : {}),
      ...(pin.status !== undefined ? { status: pin.status } : {}),
    };
    // Keep the old document-shaped read surface for InspectorPanel/session callers,
    // while allowing expandCompositions to consume the exact pin source.
    const documentView = new Proxy(source, {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
        return Reflect.get(target.doc, property, target.doc);
      },
      has(target, property) {
        return Reflect.has(target, property) || Reflect.has(target.doc, property);
      },
    });
    return [pin.id, documentView];
  })) as unknown as Record<string, CompositionDoc>;
}

/** Раскрытие авторского документа для рендера + карты, нужные UI редактора. */
export function expandForEditor(doc: PrototypeDoc, compositions: Record<string, CompositionCatalogEntry>): EditorExpansion {
  const { doc: expanded, issues, refs, expandedFrom } = expandCompositions(doc, {
    compositions,
    designSystem: doc.designSystem,
    allowInactivePins: true,
  });
  const hostRootKeys: Record<string, string> = {};
  for (const ref of refs) {
    const entry = compositions[ref.compositionId];
    if (!entry) continue;
    const composition = "doc" in entry ? entry.doc : entry;
    const key = expandedKey(ref.elementKey, composition.spec.root);
    if (Object.hasOwn(expandedFrom, key)) hostRootKeys[ref.elementKey] = key;
  }
  return { doc: expanded, compositionRefs: expandedFrom, issues, hostRootKeys };
}

// --- Вставка ---------------------------------------------------------------

/**
 * Пустышка для обязательного параметра без `default`. Плоские типы v1/v2 сохраняют
 * прежние значения; типизированные параметры v3 берут пустышку из объявления
 * (`enum` → первое значение, `object` → обязательные поля, `array` → пустой список).
 */
const fallbackForParam = (declared: CompositionDoc["params"][string]): JsonValue | undefined => {
  switch (declared.type) {
    case "string": return "";
    case "number": return 0;
    case "boolean": return false;
    case "json": return {};
    case "asset": return undefined;
    default: return paramPlaceholder(declared);
  }
};

/** Значения обязательных параметров при вставке: объявленный default, иначе пустышка по типу. */
export function defaultParams(composition: CompositionDoc): Record<string, JsonValue> {
  const params: Record<string, JsonValue> = {};
  for (const [name, declared] of Object.entries(composition.params)) {
    const declaredDefault = "default" in declared ? declared.default : undefined;
    if (declaredDefault !== undefined) { params[name] = declaredDefault; continue; }
    if (!declared.required) continue;
    const fallback = fallbackForParam(declared);
    if (fallback !== undefined) params[name] = fallback;
  }
  return params;
}

/** Свободный авторский ключ на базе slug'а (без `$` по построению). */
export function freeElementKey(elements: Record<string, unknown>, base: string): string {
  if (!Object.hasOwn(elements, base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!Object.hasOwn(elements, candidate)) return candidate;
  }
}

/** Добавляет `@eui/Composition` последним ребёнком `parentKey` (по умолчанию — корень экрана). */
export function insertComposition(
  doc: PrototypeDoc,
  screenId: string,
  options: { parentKey?: string | null; compositionId: string; composition: CompositionDoc },
): { doc: PrototypeDoc; elementKey: string | null } {
  const screenIndex = doc.screens.findIndex((screen) => screen.id === screenId);
  if (screenIndex < 0) return { doc, elementKey: null };
  const screen = doc.screens[screenIndex]!;
  const parentKey = options.parentKey && screen.spec.elements[options.parentKey] ? options.parentKey : screen.spec.root;
  const parent = screen.spec.elements[parentKey];
  if (!parent) return { doc, elementKey: null };

  const elementKey = freeElementKey(screen.spec.elements, options.compositionId);
  const params = defaultParams(options.composition);
  const element = {
    type: COMPOSITION_TYPE,
    props: { composition: options.compositionId, ...(Object.keys(params).length ? { params } : {}) },
  } as ScreenElement;
  const elements = {
    ...screen.spec.elements,
    [parentKey]: { ...parent, children: [...(parent.children ?? []), elementKey] },
    [elementKey]: element,
  };
  const screens = [...doc.screens];
  screens[screenIndex] = { ...screen, spec: { ...screen.spec, elements } };
  return { doc: { ...doc, screens }, elementKey };
}

// --- Извлечение ------------------------------------------------------------

export interface ExtractOptions {
  name: string;
  description?: string;
  /** Оставить прямых детей на экране и принять их в слот композиции. */
  keepChildren?: boolean;
  /** Имя слота для оставленных детей (slug). */
  slotName?: string;
  source?: string;
}

export type ExtractResult =
  | { ok: true; doc: CompositionDoc; keptChildren: string[] }
  | { ok: false; errors: string[] };

function collectSubtree(elements: Record<string, ScreenElement>, rootKey: string, stopAt: ReadonlySet<string>): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const walk = (key: string) => {
    if (seen.has(key) || stopAt.has(key)) return;
    seen.add(key);
    const element = elements[key];
    if (!element) return;
    keys.push(key);
    for (const child of element.children ?? []) walk(child);
  };
  walk(rootKey);
  return keys;
}

/**
 * Собирает документ композиции из поддерева экрана.
 *
 * Отказы (v1): регионы и `@eui/FlowRoot` внутри поддерева, вложенные композиции,
 * `@eui/Slot` на экране, ссылки на поддерево извне. Итог обязательно проходит
 * `compositionDocSchema` — иначе возвращаются его замечания, а не исключение.
 */
export function buildCompositionFromSubtree(screen: Screen, rootKey: string, options: ExtractOptions): ExtractResult {
  const elements = screen.spec.elements;
  const root = elements[rootKey];
  if (!root) return { ok: false, errors: [editor.extractMissingRoot] };
  if (!options.name.trim()) return { ok: false, errors: [editor.compositionExtractNameError] };

  const keepChildren = Boolean(options.keepChildren);
  const keptChildren = keepChildren ? [...(root.children ?? [])].filter((key) => Object.hasOwn(elements, key)) : [];
  if (keepChildren && !keptChildren.length) return { ok: false, errors: [editor.extractKeepChildrenNoChildren] };
  const slotName = options.slotName?.trim() || "default";
  if (keepChildren && !slugSchema.safeParse(slotName).success) return { ok: false, errors: [editor.compositionExtractSlotError] };

  const subtree = collectSubtree(elements, rootKey, new Set(keptChildren));
  const inSubtree = new Set(subtree);
  const errors: string[] = [];
  for (const key of subtree) {
    const element = elements[key]!;
    if (element.region !== undefined) errors.push(editor.extractRegionError(key));
    if (element.type === FLOW_ROOT_TYPE) errors.push(editor.extractFlowRootError(key));
    if (element.type === COMPOSITION_TYPE) errors.push(editor.extractNestedError(key));
    if (element.type === SLOT_TYPE) errors.push(editor.extractSlotError(key));
  }
  for (const [key, element] of Object.entries(elements)) {
    if (inSubtree.has(key)) continue;
    for (const child of element.children ?? []) {
      if (child !== rootKey && inSubtree.has(child)) errors.push(editor.extractExternalRefError(child));
    }
  }
  if (errors.length) return { ok: false, errors };

  const specElements: Record<string, ScreenElement> = {};
  for (const key of subtree) {
    const element = { ...elements[key]! };
    if (key === rootKey) {
      // Позиционные поля host-элемента остаются на экране: их несёт `@eui/Composition`.
      delete (element as { slot?: unknown }).slot;
      delete (element as { visible?: unknown }).visible;
      if (keepChildren) element.children = [];
    }
    specElements[key] = element;
  }
  if (keepChildren) {
    const slotKey = freeElementKey(specElements, `slot-${slotName}`);
    specElements[slotKey] = { type: SLOT_TYPE, props: { name: slotName } } as ScreenElement;
    specElements[rootKey] = { ...specElements[rootKey]!, children: [slotKey] };
  }

  const candidate = {
    version: 1,
    name: options.name.trim(),
    ...(options.description?.trim() ? { description: options.description.trim() } : {}),
    params: {},
    slots: keepChildren ? [slotName] : [],
    spec: { root: rootKey, elements: specElements },
    ...(options.source ? { provenance: { source: options.source } } : {}),
  };
  const parsed = compositionDocSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((issue) => editor.extractSchemaIssue(issue.path.join("/") || "doc", issue.message)) };
  }
  return { ok: true, doc: parsed.data, keptChildren };
}

/**
 * Заменяет поддерево `rootKey` ссылкой `@eui/Composition` с тем же ключом:
 * родительские `children` остаются валидными, а `region`/`visible`/`slot` корня
 * переезжают на host-элемент (при раскрытии они вернутся на корень композиции).
 */
export function replaceSubtreeWithComposition(
  doc: PrototypeDoc,
  screenId: string,
  rootKey: string,
  options: { compositionId: string; keptChildren?: readonly string[]; slotName?: string; params?: Record<string, JsonValue> },
): PrototypeDoc {
  const screenIndex = doc.screens.findIndex((screen) => screen.id === screenId);
  if (screenIndex < 0) return doc;
  const screen = doc.screens[screenIndex]!;
  const root = screen.spec.elements[rootKey];
  if (!root) return doc;

  const kept = (options.keptChildren ?? []).filter((key) => Object.hasOwn(screen.spec.elements, key));
  const removed = new Set(collectSubtree(screen.spec.elements, rootKey, new Set(kept)));
  removed.delete(rootKey);

  const elements: Record<string, ScreenElement> = {};
  for (const [key, element] of Object.entries(screen.spec.elements)) {
    if (removed.has(key)) continue;
    if (kept.includes(key)) {
      // Слот-размещение внутри прежнего родителя больше не действует: дети едут в слот композиции
      // (без имени — в слот `default`, который раскрытие подставляет само).
      const child = { ...element };
      if (options.slotName && options.slotName !== "default") child.slot = options.slotName;
      else delete (child as { slot?: unknown }).slot;
      elements[key] = child;
      continue;
    }
    elements[key] = element;
  }
  const host = {
    type: COMPOSITION_TYPE,
    props: {
      composition: options.compositionId,
      ...(options.params && Object.keys(options.params).length ? { params: options.params } : {}),
    },
    ...(kept.length ? { children: [...kept] } : {}),
    ...(root.region !== undefined ? { region: root.region } : {}),
    ...(root.visible !== undefined ? { visible: root.visible } : {}),
    ...(root.slot !== undefined ? { slot: root.slot } : {}),
  } as ScreenElement;
  elements[rootKey] = host;

  const screens = [...doc.screens];
  screens[screenIndex] = { ...screen, spec: { ...screen.spec, elements } };
  return { ...doc, screens };
}
