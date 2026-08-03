import { z } from "zod";
import {
  COMPOSITION_KEY_SEPARATOR, COMPOSITION_TYPE, SLOT_TYPE,
} from "../catalog/hostPrimitives/composition.definition";
import { FLOW_ROOT_TYPE } from "../catalog/hostPrimitives/flowRoot.definition";
import {
  authoredElementKeySchema, elementSchema, jsonValueSchema, slugSchema,
  type JsonValue, type PrototypeDoc,
} from "./schema";
import type { ValidationIssue } from "./types";
import {
  compositionParamV3Schema, paramValueMatches,
  type CompositionParamV3,
} from "./compositionV3/params";
import {
  compositionSwitchSchema, compositionWhenSchema, evaluateWhen, hiddenElementKeys,
  isSwitchDirective, resolveSwitch, switchCaseKey, type CompositionWhen,
} from "./compositionV3/conditions";
import { COMPOSITION_REPEAT_SEPARATOR } from "./compositionV3/repeat";
import type { CompositionTrace } from "./compositionV3/trace";
import {
  checkSlotContents, compositionSlotNames, compositionSlotsV3Schema, normalizeCompositionSlots,
  COMPOSITION_SLOTS_LIMIT, type CompositionSlotMeta, type CompositionSlotsDeclaration,
} from "./compositionV3/slots";
import {
  compositionRepeatParamSchema, isIndexDirective, isItemDirective, isReservedRepeatKey,
  materializeRepeats, subtreeKeys, type CompositionRepeatParam, type RepeatScope,
} from "./compositionV3/repeat";
import {
  compositionHandlerV3Schema, isActionParamDirective, substituteHandlers,
} from "./compositionV3/actions";
import {
  compiledLayoutProps, compileLayout, compositionLayoutSchema, layoutSupportIssues,
  type CompositionLayout,
} from "./compositionV3/layout";
import {
  compositionVariantsSchema, resolveVariant, variantsIssues,
  type CompositionVariants,
} from "./compositionV3/variants";
import type { ComponentLayout } from "../designSystems/types";

/**
 * Версионированная композиция (волна 5, план 2026-07-27 §5.1).
 *
 * Композиция — декларативный фрагмент экрана с параметрами и именованными слотами.
 * Её внутренности остаются видимыми в дереве компонентов и линтуемыми: перед
 * сохранением документ прототипа **раскрывается** (`expandCompositions`), и уже
 * раскрытый документ идёт в `snapshotDefinitions`/`collectAndValidateAssetRefs`,
 * поэтому пины компонентов и ассетов полны (B3 адверсариального ревью).
 *
 * Ограничения v1:
 * - композиции **не содержат** `region`-маркеров и `@eui/FlowRoot` (B4: регионы
 *   анализируются по авторской спеке экрана);
 * - композиции **не вкладываются** друг в друга;
 * - `@eui/Slot` допустим только внутри композиции;
 * - параметры подставляют **только props**, никогда не state-указатели: события
 *   внутри композиции адресуют `doc.state` прототипа-хоста как на обычном экране.
 */

export const COMPOSITION_PARAM_TYPES = ["string", "number", "boolean", "json", "asset"] as const;
export type CompositionParamType = (typeof COMPOSITION_PARAM_TYPES)[number];

export const COMPOSITION_PARAMS_LIMIT = 50;
export { COMPOSITION_SLOTS_LIMIT };
export const COMPOSITION_ELEMENTS_LIMIT = 300;

/** Hard limits for the client-side expansion guard. */
export const COMPOSITION_DEPTH_LIMIT = 5;
export const COMPOSITION_NESTING_DEPTH_LIMIT = COMPOSITION_DEPTH_LIMIT;
export const EXPANDED_ELEMENTS_LIMIT = 500;
export const EXPANDED_TREE_DEPTH_LIMIT = 50;

const compositionParamSchema = z.strictObject({
  type: z.enum(COMPOSITION_PARAM_TYPES),
  required: z.boolean().optional(),
  default: jsonValueSchema.optional(),
  description: z.string().trim().min(1).max(300).optional(),
});

const compositionSpecSchema = z.strictObject({
  root: z.string().min(1),
  elements: z.record(authoredElementKeySchema, elementSchema),
});

const compositionProvenanceSchema = z.strictObject({
  source: z.string().trim().min(1).max(500).optional(),
  figmaNodeId: z.string().trim().min(1).max(200).optional(),
});

const compositionDocV1Shape = {
  version: z.literal(1),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  params: z.record(slugSchema, compositionParamSchema).default({}),
  slots: z.array(slugSchema).max(COMPOSITION_SLOTS_LIMIT).default([]),
  spec: compositionSpecSchema,
  provenance: compositionProvenanceSchema.optional(),
} as const;

const compositionDocV2Shape = {
  version: z.literal(2),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  atomicLevel: z.enum(["molecule", "organism", "template", "page"]),
  scope: z.enum(["section", "shell", "screen"]).optional(),
  canonicalFor: z.array(slugSchema).optional(),
  ownership: z.strictObject({
    reason: z.string().trim().min(1).max(500),
    provenance: z.string().trim().min(1).max(500).optional(),
  }).optional(),
  replacement: z.string().trim().min(1).max(64).optional(),
  params: z.record(slugSchema, compositionParamSchema).default({}),
  slots: z.array(slugSchema).max(COMPOSITION_SLOTS_LIMIT).default([]),
  spec: compositionSpecSchema,
  provenance: compositionProvenanceSchema.optional(),
} as const;

/**
 * Тело композиции v3: тот же строгий `elementSchema` плюс параметрическое условие `when`
 * (план 2026-08-03 W8a). Поле живёт **только** внутри композиции v3 и полностью исчезает
 * при раскрытии — авторский/раскрытый документ прототипа его не знает.
 */
const compositionElementV3Schema = elementSchema.extend({
  // W8d: обработчик тела v3 дополнительно принимает `{"$param": …}` — параметр-действие.
  on: z.record(z.string(), compositionHandlerV3Schema).optional(),
  when: compositionWhenSchema.optional(),
  repeatParam: compositionRepeatParamSchema.optional(),
  layout: compositionLayoutSchema.optional(),
});

const compositionSpecV3Schema = z.strictObject({
  root: z.string().min(1),
  elements: z.record(authoredElementKeySchema, compositionElementV3Schema),
});

interface RefinableCompositionDoc {
  slots: CompositionSlotsDeclaration;
  params: Record<string, { type: string; required?: boolean; default?: JsonValue }>;
  spec: { root: string; elements: Record<string, { type: string; props: Record<string, unknown>; children?: string[]; region?: string; slot?: string; when?: CompositionWhen }> };
}

const refineCompositionDoc = (doc: RefinableCompositionDoc, context: z.RefinementCtx, allowNested: boolean) => {
  const { elements, root } = doc.spec;
  // W8c: `slots` — массив имён (v1/v2 и простой v3) **или** словарь с метаданными.
  // Правила ниже работают с именами, поэтому обе формы дают одинаковую диагностику.
  const slotNames = compositionSlotNames(doc.slots);
  const keys = Object.keys(elements);
  if (keys.length > COMPOSITION_ELEMENTS_LIMIT) {
    context.addIssue({ code: "custom", path: ["spec", "elements"], message: `composition exceeds ${COMPOSITION_ELEMENTS_LIMIT} elements` });
  }
  if (Object.keys(doc.params).length > COMPOSITION_PARAMS_LIMIT) {
    context.addIssue({ code: "custom", path: ["params"], message: `composition exceeds ${COMPOSITION_PARAMS_LIMIT} params` });
  }
  if (new Set(slotNames).size !== slotNames.length) {
    context.addIssue({ code: "custom", path: ["slots"], message: "slot names must be unique" });
  }
  if (!elements[root]) {
    context.addIssue({ code: "custom", path: ["spec", "root"], message: "root must reference an existing element" });
  }
  if (elements[root]?.type === SLOT_TYPE) {
    context.addIssue({ code: "custom", path: ["spec", "root"], message: `${SLOT_TYPE} cannot be the composition root` });
  }
  const seenSlotNames = new Set<string>();
  const parentCount = new Map<string, number>();
  for (const [key, element] of Object.entries(elements)) {
    const at = ["spec", "elements", key];
    for (const child of element.children ?? []) {
      parentCount.set(child, (parentCount.get(child) ?? 0) + 1);
      if (!elements[child]) context.addIssue({ code: "custom", path: [...at, "children"], message: `unknown child element: ${child}` });
    }
    if (element.region !== undefined) {
      context.addIssue({ code: "custom", path: [...at, "region"], message: "a composition cannot carry region markers; mark the region on the screen element that references the composition" });
    }
    if (element.type === FLOW_ROOT_TYPE) {
      context.addIssue({ code: "custom", path: [...at, "type"], message: `${FLOW_ROOT_TYPE} is not allowed inside a composition; it is the screen root only` });
    }
    if (element.type === COMPOSITION_TYPE && !allowNested) {
      context.addIssue({ code: "custom", path: [...at, "type"], message: "compositions do not nest in v1" });
    }
    if (element.type === SLOT_TYPE) {
      const name = element.props.name;
      if (typeof name !== "string") {
        context.addIssue({ code: "custom", path: [...at, "props", "name"], message: `${SLOT_TYPE} requires a static string name` });
      } else {
        if (!slotNames.includes(name)) context.addIssue({ code: "custom", path: [...at, "props", "name"], message: `slot is not declared in slots: ${name}` });
        if (seenSlotNames.has(name)) context.addIssue({ code: "custom", path: [...at, "props", "name"], message: `duplicate slot: ${name}` });
        seenSlotNames.add(name);
      }
      if (element.children?.length) context.addIssue({ code: "custom", path: [...at, "children"], message: `${SLOT_TYPE} cannot declare children` });
      // `slot` на самом `@eui/Slot` — это его собственное размещение в named-slot родителя:
      // при раскрытии оно переезжает на маршрутизированных детей (см. expandCompositions).
    }
  }
  for (const slot of slotNames) {
    if (!seenSlotNames.has(slot)) context.addIssue({ code: "custom", path: ["slots"], message: `declared slot has no ${SLOT_TYPE} element: ${slot}` });
  }
  for (const [key, count] of parentCount) {
    if (count > 1) context.addIssue({ code: "custom", path: ["spec", "elements", key], message: "element has more than one parent" });
  }
  if (parentCount.get(root)) context.addIssue({ code: "custom", path: ["spec", "root"], message: "root element must not be a child" });
};

/**
 * v3 = всё из v2 + типизированные параметры (`enum`/`object`/`array`) и параметрические
 * условия (`element.when`, `{"$switch": …}` в props). Ветка аддитивна: v1/v2 не меняются.
 */
const compositionDocV3Shape = {
  ...compositionDocV2Shape,
  version: z.literal(3),
  params: z.record(slugSchema, compositionParamV3Schema).default({}),
  slots: compositionSlotsV3Schema.default([]),
  variants: compositionVariantsSchema.optional(),
  spec: compositionSpecV3Schema,
} as const;

const SWITCH_KEY = "$switch";

type CompositionElementV3 = {
  type: string;
  props: Record<string, unknown>;
  children?: string[];
  slot?: string;
  repeat?: unknown;
  on?: Record<string, unknown>;
  when?: CompositionWhen;
  repeatParam?: CompositionRepeatParam;
  layout?: CompositionLayout;
};

/** Дополнительные статические правила v3: все ветки разрешимы от объявленных параметров. */
function refineCompositionDocV3(doc: {
  slots: CompositionSlotsDeclaration;
  params: Record<string, CompositionParamV3>;
  variants?: CompositionVariants;
  spec: { root: string; elements: Record<string, CompositionElementV3> };
}, context: z.RefinementCtx): void {
  const { elements, root } = doc.spec;
  const declaredOf = (name: string): CompositionParamV3 | undefined =>
    Object.hasOwn(doc.params, name) ? doc.params[name] : undefined;

  // --- W8f: варианты --------------------------------------------------------
  if (doc.variants) {
    for (const issue of variantsIssues(doc.variants)) {
      context.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
    doc.variants.tuples?.forEach((tuple, index) => {
      for (const [name, value] of Object.entries(tuple.params ?? {})) {
        const at = ["variants", "tuples", index, "params", name];
        const declared = declaredOf(name);
        if (!declared) {
          context.addIssue({ code: "custom", path: at, message: `variant tuple sets an undeclared param: ${name}` });
          continue;
        }
        if (declared.type === "action") {
          context.addIssue({ code: "custom", path: at, message: `variant tuples must not set the action param "${name}"; handler bindings belong to the reference point` });
          continue;
        }
        if (!paramValueMatches(declared, value)) {
          context.addIssue({ code: "custom", path: at, message: `variant tuple value for "${name}" must be of type ${declared.type}` });
        }
      }
    });
  }

  // --- W8b: ключевое пространство `repeatParam` -----------------------------
  // `<innerKey>__r<suffix>` живёт в **авторском** пространстве композиции, поэтому
  // подстрока-разделитель зарезервирована: коллизий с авторскими ключами не бывает.
  for (const key of Object.keys(elements)) {
    if (!isReservedRepeatKey(key)) continue;
    context.addIssue({ code: "custom", path: ["spec", "elements", key], message: 'element key must not contain "__r" (reserved for repeatParam expansion)' });
  }

  const parentOf = new Map<string, string>();
  for (const [key, element] of Object.entries(elements)) {
    for (const child of element.children ?? []) if (!parentOf.has(child)) parentOf.set(child, key);
  }

  /** Ключ поддерева → ключ его `repeatParam`-элемента (область видимости `$item`/`$index`). */
  const repeatScope = new Map<string, string>();
  for (const [key, element] of Object.entries(elements)) {
    const directive = element.repeatParam;
    if (!directive) continue;
    const at = ["spec", "elements", key];
    if (key === root) {
      context.addIssue({ code: "custom", path: [...at, "repeatParam"], message: "the composition root must not declare repeatParam" });
    }
    if (element.type === SLOT_TYPE) {
      context.addIssue({ code: "custom", path: [...at, "repeatParam"], message: `${SLOT_TYPE} must not declare repeatParam` });
    }
    if (element.repeat !== undefined) {
      context.addIssue({ code: "custom", path: [...at, "repeatParam"], message: "repeatParam is not compatible with the state-driven repeat on the same element" });
    }
    const declared = declaredOf(directive.param);
    if (!declared) {
      context.addIssue({ code: "custom", path: [...at, "repeatParam", "param"], message: `repeatParam references an undeclared param: ${directive.param}` });
    } else if (declared.type !== "array") {
      context.addIssue({ code: "custom", path: [...at, "repeatParam", "param"], message: `repeatParam requires an array param, but "${directive.param}" is ${declared.type}` });
    } else {
      if (directive.maxItems !== undefined && directive.maxItems > declared.maxItems) {
        context.addIssue({ code: "custom", path: [...at, "repeatParam", "maxItems"], message: `repeatParam maxItems must not exceed the ${declared.maxItems} declared by param "${directive.param}"` });
      }
      if (directive.key !== undefined) {
        if (declared.items.type !== "object") {
          context.addIssue({ code: "custom", path: [...at, "repeatParam", "key"], message: `repeatParam key requires object items, but "${directive.param}" holds ${declared.items.type} items` });
        } else if (!Object.hasOwn(declared.items.schema, directive.key)) {
          context.addIssue({ code: "custom", path: [...at, "repeatParam", "key"], message: `repeatParam key is not a field of "${directive.param}" items: ${directive.key}` });
        }
      }
    }
    for (const inner of subtreeKeys(elements, key)) {
      if (inner !== key && elements[inner]?.repeatParam !== undefined) {
        context.addIssue({ code: "custom", path: ["spec", "elements", inner, "repeatParam"], message: "repeatParam must not nest inside another repeatParam subtree" });
      }
      if (elements[inner]?.type === SLOT_TYPE) {
        context.addIssue({ code: "custom", path: [...at, "repeatParam"], message: `repeatParam must not gate a subtree containing ${SLOT_TYPE}` });
      }
      if (!repeatScope.has(inner)) repeatScope.set(inner, key);
    }
  }

  // --- W8c: метаданные слотов ------------------------------------------------
  const slots = normalizeCompositionSlots(doc.slots);
  const fallbackOwner = new Map<string, string>();
  for (const [name, meta] of Object.entries(slots)) {
    for (const key of meta.fallback ?? []) {
      const at = ["slots", name, "fallback"];
      const element = elements[key];
      if (!element) {
        context.addIssue({ code: "custom", path: at, message: `slot "${name}" fallback references an unknown element: ${key}` });
        continue;
      }
      if (key === root) {
        context.addIssue({ code: "custom", path: at, message: `slot "${name}" fallback must not be the composition root` });
        continue;
      }
      if (parentOf.has(key)) {
        context.addIssue({ code: "custom", path: at, message: `slot "${name}" fallback element "${key}" is already a child of "${parentOf.get(key)!}"` });
        continue;
      }
      const owner = fallbackOwner.get(key);
      if (owner !== undefined) {
        context.addIssue({ code: "custom", path: at, message: `fallback element "${key}" is already used by slot "${owner}"` });
        continue;
      }
      fallbackOwner.set(key, name);
      for (const inner of subtreeKeys(elements, key)) {
        if (elements[inner]?.type !== SLOT_TYPE) continue;
        context.addIssue({ code: "custom", path: at, message: `slot "${name}" fallback must not contain ${SLOT_TYPE}` });
      }
    }
  }
  // Элемент без родителя, не являющийся ни корнем, ни fallback'ом, в дерево не попадает.
  for (const key of Object.keys(elements)) {
    if (key === root || parentOf.has(key) || fallbackOwner.has(key)) continue;
    context.addIssue({ code: "custom", path: ["spec", "elements", key], message: `element "${key}" is unreachable: it has no parent and is not declared as a slot fallback` });
  }

  const subtreeHasSlot = (key: string): boolean => {
    const seen = new Set<string>();
    const stack = [key];
    while (stack.length) {
      const current = stack.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const element = elements[current];
      if (!element) continue;
      if (element.type === SLOT_TYPE) return true;
      for (const child of element.children ?? []) stack.push(child);
    }
    return false;
  };

  for (const [key, element] of Object.entries(elements)) {
    const at = ["spec", "elements", key];

    // --- W8e: token layout занимает канонические props — конфликт виден статически ---
    if (element.layout) {
      for (const prop of compiledLayoutProps(element.layout)) {
        if (!Object.hasOwn(element.props, prop)) continue;
        context.addIssue({ code: "custom", path: [...at, "layout"], message: `layout compiles into props.${prop}, which the element already declares` });
      }
    }

    // --- W8d: `$param` в `on` — только action-параметры и только в позиции обработчика ---
    for (const [event, binding] of Object.entries(element.on ?? {})) {
      const eventAt = [...at, "on", event];
      const checkDirective = (value: unknown, path: (string | number)[]): void => {
        if (!isActionParamDirective(value)) return;
        const declared = declaredOf(value.$param);
        if (!declared) {
          context.addIssue({ code: "custom", path, message: `on references an undeclared param: ${value.$param}` });
          return;
        }
        if (declared.type !== "action") {
          context.addIssue({ code: "custom", path, message: `on may only bind an action param; "${value.$param}" is ${declared.type}` });
        }
      };
      // Подстановка не ходит глубже позиции действия: `$param` внутри самого действия
      // (например, в его `params`) молча не сработал бы — поэтому он запрещён.
      const rejectDeep = (value: unknown, path: (string | number)[]): void => {
        if (Array.isArray(value)) { value.forEach((item, index) => rejectDeep(item, [...path, index])); return; }
        if (!isObject(value)) return;
        if (isActionParamDirective(value)) {
          context.addIssue({ code: "custom", path, message: "$param inside an action is not substituted; bind the whole handler to an action param instead" });
          return;
        }
        for (const [name, item] of Object.entries(value)) rejectDeep(item, [...path, name]);
      };
      if (isActionParamDirective(binding)) { checkDirective(binding, eventAt); continue; }
      if (Array.isArray(binding)) {
        binding.forEach((item, index) => {
          if (isActionParamDirective(item)) { checkDirective(item, [...eventAt, index]); return; }
          rejectDeep(item, [...eventAt, index]);
        });
        continue;
      }
      rejectDeep(binding, eventAt);
    }

    const when = element.when;
    if (when !== undefined) {
      if (key === root) {
        context.addIssue({ code: "custom", path: [...at, "when"], message: "the composition root must not declare when" });
      }
      const declared = declaredOf(when.param);
      if (!declared) {
        context.addIssue({ code: "custom", path: [...at, "when", "param"], message: `when references an undeclared param: ${when.param}` });
      } else if (declared.type === "action") {
        context.addIssue({ code: "custom", path: [...at, "when", "param"], message: `when cannot branch on the action param "${when.param}"` });
      } else if (declared.type === "enum") {
        const candidates = [
          ...(Object.hasOwn(when, "eq") ? [when.eq] : []),
          ...(Object.hasOwn(when, "neq") ? [when.neq] : []),
          ...(when.in ?? []),
        ];
        for (const candidate of candidates) {
          if (typeof candidate === "string" && declared.values.includes(candidate)) continue;
          context.addIssue({ code: "custom", path: [...at, "when"], message: `when compares param "${when.param}" with a value outside its enum: ${JSON.stringify(candidate)}` });
        }
      }
      // Слоты — контракт композиции с точкой ссылки; их условная материализация въезжает
      // вместе со слотами-объектами (W8c), иначе маршрутизированные дети осиротеют.
      if (subtreeHasSlot(key)) {
        context.addIssue({ code: "custom", path: [...at, "when"], message: `when must not gate a subtree containing ${SLOT_TYPE}` });
      }
    }

    const walk = (value: unknown, relative: (string | number)[]): void => {
      if (Array.isArray(value)) { value.forEach((item, index) => walk(item, [...relative, index])); return; }
      if (!isObject(value)) return;
      // W8d: action-параметр — это обработчик, а не значение props.
      if (isParamDirective(value) && declaredOf(value.$param)?.type === "action") {
        context.addIssue({ code: "custom", path: [...at, "props", ...relative], message: `action param "${value.$param}" must be bound in on, not in props` });
        return;
      }
      if (isItemDirective(value) || isIndexDirective(value)) {
        const item = value as { $item?: unknown; $index?: unknown };
        const directive = isItemDirective(value) ? "$item" : "$index";
        const at2 = [...at, "props", ...relative, directive];
        const owner = repeatScope.get(key);
        if (owner === undefined) {
          context.addIssue({ code: "custom", path: at2, message: `${directive} is only allowed inside a repeatParam subtree` });
          return;
        }
        const declared = declaredOf(elements[owner]!.repeatParam!.param);
        const items = declared?.type === "array" ? declared.items : undefined;
        if (directive === "$index") {
          if (item.$index !== true) context.addIssue({ code: "custom", path: at2, message: "$index must be true" });
          return;
        }
        const field = item.$item;
        if (field === true) {
          if (items && items.type === "object") {
            context.addIssue({ code: "custom", path: at2, message: `$item: true requires scalar items, but "${elements[owner]!.repeatParam!.param}" holds object items` });
          }
          return;
        }
        if (typeof field !== "string") {
          context.addIssue({ code: "custom", path: at2, message: "$item must be true or a field name" });
          return;
        }
        if (items && items.type !== "object") {
          context.addIssue({ code: "custom", path: at2, message: `$item field access requires object items, but "${elements[owner]!.repeatParam!.param}" holds ${items.type} items` });
          return;
        }
        if (items && !Object.hasOwn(items.schema, field)) {
          context.addIssue({ code: "custom", path: at2, message: `$item references an undeclared field of "${elements[owner]!.repeatParam!.param}" items: ${field}` });
        }
        return;
      }
      if (!isSwitchDirective(value)) {
        for (const [name, item] of Object.entries(value)) walk(item, [...relative, name]);
        return;
      }
      const parsed = compositionSwitchSchema.safeParse(value[SWITCH_KEY]);
      const path = [...at, "props", ...relative, SWITCH_KEY];
      if (!parsed.success) {
        context.addIssue({ code: "custom", path, message: `invalid $switch directive: ${parsed.error.issues.map((issue) => issue.message).join("; ")}` });
        return;
      }
      const directive = parsed.data;
      const declared = declaredOf(directive.param);
      if (!declared) {
        context.addIssue({ code: "custom", path: [...path, "param"], message: `$switch references an undeclared param: ${directive.param}` });
      } else if (declared.type === "action") {
        context.addIssue({ code: "custom", path: [...path, "param"], message: `$switch cannot select on the action param "${directive.param}"` });
      } else if (declared.type === "enum" || declared.type === "boolean") {
        const universe = declared.type === "enum" ? declared.values : ["true", "false"];
        for (const caseKey of Object.keys(directive.cases)) {
          if (universe.includes(caseKey)) continue;
          context.addIssue({ code: "custom", path: [...path, "cases"], message: `$switch case "${caseKey}" is not a value of param "${directive.param}"` });
        }
        // Исчерпаемость — статическая: без default каждое значение обязано иметь case.
        if (directive.default === undefined) {
          const missing = universe.filter((value) => !Object.hasOwn(directive.cases, value));
          if (missing.length) {
            context.addIssue({ code: "custom", path: [...path, "cases"], message: `$switch on param "${directive.param}" has no default and is missing cases: ${missing.join(", ")}` });
          }
        }
      }
      for (const [caseKey, caseValue] of Object.entries(directive.cases)) walk(caseValue, [...relative, SWITCH_KEY, "cases", caseKey]);
      if (directive.default !== undefined) walk(directive.default, [...relative, SWITCH_KEY, "default"]);
    };
    walk(element.props, []);
  }
}

const compositionDocV1Schema = z.strictObject(compositionDocV1Shape).superRefine((doc, context) => refineCompositionDoc(doc, context, false));
const compositionDocV2Schema = z.strictObject(compositionDocV2Shape).superRefine((doc, context) => refineCompositionDoc(doc, context, true));
const compositionDocV3Schema = z.strictObject(compositionDocV3Shape).superRefine((doc, context) => {
  refineCompositionDoc(doc, context, true);
  refineCompositionDocV3(doc, context);
});

/** Version 1 is deliberately kept as a separate branch: its shape and rules are frozen. */
export const compositionDocSchema = z.discriminatedUnion("version", [compositionDocV1Schema, compositionDocV2Schema, compositionDocV3Schema]);
export type CompositionDocV1 = z.output<typeof compositionDocV1Schema>;
export type CompositionDocV2 = z.output<typeof compositionDocV2Schema>;
export type CompositionDocV3 = z.output<typeof compositionDocV3Schema>;
export type CompositionDoc = z.output<typeof compositionDocSchema>;
export type CompositionParam = z.output<typeof compositionParamSchema>;

/**
 * Единая форма слотов для всех потребителей (`slots` может быть массивом имён
 * или словарём с метаданными — W8c).
 */
export { compositionSlotNames, normalizeCompositionSlots };
export type { CompositionSlotMeta, CompositionSlotsDeclaration };
export type { CompositionRepeatParam };
/** W8d–W8f: параметр-действие, token layout и варианты — публичная поверхность v3. */
export { compileLayout, layoutSupportIssues } from "./compositionV3/layout";
export type { CompositionLayout } from "./compositionV3/layout";
export { resolveVariant, variantDimensionsOf } from "./compositionV3/variants";
export type { CompositionVariants } from "./compositionV3/variants";
export { actionValueMatches, substituteHandlers } from "./compositionV3/actions";
/** W8g: трассировка решений раскрытия (preview-tree). */
export { createCompositionTrace } from "./compositionV3/trace";
export type { CompositionTrace, CompositionTraceLog } from "./compositionV3/trace";

/**
 * Документы, несущие каталожные метаданные (`atomicLevel`/`scope`/`canonicalFor`/`ownership`):
 * v2 и всё, что старше. Сервер использует это вместо точечной сверки с `version === 2`.
 */
export type CompositionDocWithMetadata = CompositionDocV2 | CompositionDocV3;
export const isCompositionWithMetadata = (doc: { version?: unknown }): doc is CompositionDocWithMetadata =>
  doc.version === 2 || doc.version === 3;

// --- Раскрытие -------------------------------------------------------------

export interface CompositionRef {
  screenIndex: number;
  screenId: string;
  elementKey: string;
  compositionId: string;
}

/** One layer in the reversible origin of a v2-expanded element. */
export interface ExpandedOriginLayer {
  compositionId: string;
  version: number;
  hostKey: string;
  innerKey: string;
}

/**
 * v1 consumers use the three top-level fields. v2 adds `chain` while retaining
 * those fields so runtime/editor consumers can migrate without a flag day.
 */
export interface ExpandedOrigin {
  compositionId: string;
  hostKey: string;
  innerKey: string;
  chain?: ExpandedOriginLayer[];
}

/** A published composition document as supplied by a pin-aware client. */
export interface CompositionSource {
  doc: CompositionDoc;
  version?: number;
  designSystem?: string;
  status?: string;
}

export type CompositionCatalogEntry = CompositionDoc | CompositionSource;

export interface ExpandCompositionsOptions {
  /** Bare docs remain supported for the existing v1 API. */
  compositions: Record<string, CompositionCatalogEntry>;
  /** Optional publication versions for callers that keep docs and pins separately. */
  compositionVersions?: Readonly<Record<string, number>>;
  /** Expected active design system; defaults to `doc.designSystem`. */
  designSystem?: string;
  /** Exact historical prototype pins may render deprecated publications unchanged. */
  allowInactivePins?: boolean;
  /**
   * Роли `canonicalFor` по имени типа компонента (W8c). Есть только у сервера
   * (`definition_meta`), поэтому `allowedRoles` слота проверяется, лишь когда карта
   * передана; клиентское раскрытие ограничивается `allowedTypes`/кардинальностью.
   */
  componentRoles?: Readonly<Record<string, readonly string[]>>;
  /**
   * Layout-контракты v1 по имени типа компонента (W8e). Как и `componentRoles`, есть
   * только у сервера (`definition_meta`), поэтому `composition/layout-unsupported`
   * эмитится, лишь когда карта передана. **Компиляция props от карты не зависит** —
   * иначе клиентское раскрытие давало бы другое дерево.
   */
  componentLayouts?: Readonly<Record<string, ComponentLayout | undefined>>;
  /**
   * Контракт слотов (`required`/`cardinality`/`allowedTypes`/`allowedRoles`) проверяется в
   * **точке ссылки**. Probe-раскрытие публикации композиции ссылки не имеет — детей у слотов
   * там нет по построению, поэтому оно выключает проверку (`false`), а не выдумывает детей.
   */
  validateSlotContract?: boolean;
  /**
   * W8g: опциональный коллектор решений раскрытия (`when`/`$switch`/`repeatParam`/слоты/layout).
   * Без него раскрытие ничего не собирает и работает ровно как раньше; события эмитятся
   * только на nested-пути (legacy-путь v1 заморожен, D8).
   */
  trace?: CompositionTrace;
  /** Testable overrides for the same production safety limits. */
  maxCompositionDepth?: number;
  maxExpandedElements?: number;
  maxTreeDepth?: number;
}

export interface ExpandedCompositionsResult {
  /** Раскрытый документ: `@eui/Composition` заменён элементами композиции. */
  doc: PrototypeDoc;
  /** Фатальные проблемы раскрытия (неизвестная композиция, плохой параметр, слот). */
  issues: ValidationIssue[];
  /** Ссылки на композиции в авторском документе (источник пинов). */
  refs: CompositionRef[];
  /** Раскрытый ключ → происхождение (для `toRuntimeSpec({compositionRefs})` и дерева). */
  expandedFrom: Record<string, ExpandedOrigin>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isParamDirective = (value: unknown): value is { $param: string } =>
  isObject(value) && Object.keys(value).length === 1 && typeof value.$param === "string";

const DEFAULT_SLOT = "default";

/** Ключ элемента композиции после раскрытия: `<hostKey>$<innerKey>`. */
export const expandedKey = (hostKey: string, innerKey: string): string =>
  `${hostKey}${COMPOSITION_KEY_SEPARATOR}${innerKey}`;

/** Обратное отображение раскрытого ключа на авторский host-ключ (для UI/выделения). */
export const hostKeyOf = (key: string): string => {
  const index = key.indexOf(COMPOSITION_KEY_SEPARATOR);
  return index === -1 ? key : key.slice(0, index);
};

/** Все ссылки `@eui/Composition` авторского документа, по порядку экранов. */
export function collectCompositionRefs(doc: PrototypeDoc): CompositionRef[] {
  const refs: CompositionRef[] = [];
  doc.screens.forEach((screen, screenIndex) => {
    for (const [elementKey, element] of Object.entries(screen.spec.elements)) {
      if (element.type !== COMPOSITION_TYPE) continue;
      const id = element.props.composition;
      refs.push({ screenIndex, screenId: screen.id, elementKey, compositionId: typeof id === "string" ? id : "" });
    }
  });
  return refs;
}

const path = (parts: (string | number)[]) => "/" + parts.map(String).join("/");

/**
 * Раскрывает все `@eui/Composition` документа.
 *
 * Правила:
 * - внутренние ключи получают префикс `<hostKey>$`;
 * - `{"$param":"name"}` в props заменяется значением параметра (или его default);
 *   незаполненный необязательный параметр удаляет ключ props;
 * - дети host-элемента маршрутизируются в `@eui/Slot` по полю `slot`
 *   (без `slot` — в слот `default`); сам `@eui/Slot` из дерева исчезает;
 * - `region`/`visible`/`slot` host-элемента переезжают на корень раскрытой композиции,
 *   поэтому регионы и named-slot-размещение продолжают работать.
 */
function expandV1Compositions(
  doc: PrototypeDoc,
  options: { compositions: Record<string, CompositionDoc> },
): ExpandedCompositionsResult {
  const refs = collectCompositionRefs(doc);
  const issues: ValidationIssue[] = [];
  const expandedFrom: ExpandedCompositionsResult["expandedFrom"] = {};
  if (!refs.length) return { doc, issues, refs, expandedFrom };

  const screens = doc.screens.map((screen, screenIndex) => {
    const hostKeys = Object.entries(screen.spec.elements)
      .filter(([, element]) => element.type === COMPOSITION_TYPE)
      .map(([key]) => key);
    if (!hostKeys.length) return screen;

    const base = ["screens", screenIndex, "spec", "elements"];
    const elements: Record<string, PrototypeDoc["screens"][number]["spec"]["elements"][string]> =
      Object.fromEntries(Object.entries(screen.spec.elements).map(([key, element]) => [key, { ...element }]));
    // Ключ, которым заменяется host-элемент у родителя (корень раскрытой композиции).
    const replacement = new Map<string, string>();

    for (const hostKey of hostKeys) {
      const host = screen.spec.elements[hostKey]!;
      const at = [...base, hostKey];
      const compositionId = host.props.composition;
      if (typeof compositionId !== "string") {
        issues.push({ path: path([...at, "props", "composition"]), message: "composition reference must be a static slug" });
        continue;
      }
      const composition = options.compositions[compositionId];
      if (!composition) {
        issues.push({ path: path([...at, "props", "composition"]), message: `unknown or unpublished composition: ${compositionId}` });
        continue;
      }
      if (host.repeat) issues.push({ path: path([...at, "repeat"]), message: "repeat is not allowed on a composition reference" });
      // События живут внутри композиции: на самой ссылке их некому обработать (элемент исчезает).
      if (host.on && Object.keys(host.on).length) issues.push({ path: path([...at, "on"]), message: "events are not allowed on a composition reference; declare them inside the composition" });

      // --- параметры ---
      const provided = isObject(host.props.params) ? host.props.params : {};
      const values = new Map<string, JsonValue | undefined>();
      for (const name of Object.keys(provided)) {
        if (!Object.hasOwn(composition.params, name)) {
          issues.push({ path: path([...at, "props", "params", name]), message: `unknown composition param: ${name}` });
        }
      }
      for (const [name, declared] of Object.entries(composition.params)) {
        // У параметра-действия (W8d) `default` не бывает; v1-путь его и не встретит.
        const declaredDefault = "default" in declared ? declared.default : undefined;
        const raw = Object.hasOwn(provided, name) ? (provided[name] as JsonValue) : declaredDefault;
        if (raw === undefined) {
          if (declared.required) issues.push({ path: path([...at, "props", "params", name]), message: `required composition param is missing: ${name}` });
          values.set(name, undefined);
          continue;
        }
        if (!paramValueMatches(declared, raw)) {
          issues.push({ path: path([...at, "props", "params", name]), message: `composition param ${name} must be of type ${declared.type}` });
        }
        values.set(name, raw);
      }

      const substitute = (value: unknown, innerKey: string, relative: (string | number)[]): unknown => {
        if (isParamDirective(value)) {
          const name = value.$param;
          if (!Object.hasOwn(composition.params, name)) {
            issues.push({ path: path([...at, "props", "params"]), message: `composition ${compositionId} references an undeclared param "${name}" at ${innerKey}/${relative.join("/")}` });
            return undefined;
          }
          return values.get(name);
        }
        if (Array.isArray(value)) return value.map((item, index) => substitute(item, innerKey, [...relative, index]));
        if (isObject(value)) {
          const entries = Object.entries(value)
            .map(([key, item]) => [key, substitute(item, innerKey, [...relative, key])] as const)
            .filter(([, item]) => item !== undefined);
          return Object.fromEntries(entries);
        }
        return value;
      };

      // --- маршрутизация детей по слотам ---
      const filled = new Map<string, string[]>();
      for (const child of host.children ?? []) {
        const slot = (screen.spec.elements[child] as { slot?: string } | undefined)?.slot ?? DEFAULT_SLOT;
        if (!compositionSlotNames(composition.slots).includes(slot)) {
          issues.push({ path: path([...base, child, "slot"]), message: `unknown slot for composition ${compositionId}: ${slot}` });
          continue;
        }
        (filled.get(slot) ?? filled.set(slot, []).get(slot)!).push(child);
      }

      const slotNames = new Map<string, string>(); // innerKey -> slot name
      for (const [innerKey, element] of Object.entries(composition.spec.elements)) {
        if (element.type !== SLOT_TYPE || typeof element.props.name !== "string") continue;
        slotNames.set(innerKey, element.props.name);
        // Родителем маршрутизированных детей становится родитель `@eui/Slot`, поэтому
        // side-channel `slot` ребёнка заменяется размещением самого слота (или снимается).
        for (const child of filled.get(element.props.name) ?? []) {
          const routed = { ...elements[child]! };
          if (element.slot === undefined) delete (routed as { slot?: unknown }).slot;
          else (routed as { slot?: unknown }).slot = element.slot;
          elements[child] = routed;
        }
      }
      // Ребёнок, чей слот в композиции не объявлен `@eui/Slot`-элементом, не попадёт в дерево.
      for (const [slot, children] of filled) {
        if ([...slotNames.values()].includes(slot)) continue;
        for (const child of children) issues.push({ path: path([...base, child, "slot"]), message: `composition ${compositionId} declares slot "${slot}" but has no ${SLOT_TYPE} element for it` });
      }
      const resolveChildren = (children: string[] | undefined): string[] => (children ?? []).flatMap((innerChild) => {
        const slot = slotNames.get(innerChild);
        if (slot !== undefined) return filled.get(slot) ?? [];
        return [expandedKey(hostKey, innerChild)];
      });

      for (const [innerKey, element] of Object.entries(composition.spec.elements)) {
        if (element.type === SLOT_TYPE) continue;
        const key = expandedKey(hostKey, innerKey);
        if (Object.hasOwn(elements, key)) {
          issues.push({ path: path([...at]), message: `expanded element key collides with an authored key: ${key}` });
          continue;
        }
        const props = substitute(element.props, innerKey, []) as Record<string, unknown>;
        const children = resolveChildren(element.children);
        elements[key] = {
          ...element,
          props,
          ...(children.length ? { children } : {}),
        } as (typeof elements)[string];
        if (!children.length) delete (elements[key] as { children?: unknown }).children;
        expandedFrom[key] = { compositionId, hostKey, innerKey };
      }

      const rootKey = expandedKey(hostKey, composition.spec.root);
      const expandedRoot = elements[rootKey];
      if (expandedRoot) {
        // Позиционные поля host-элемента переезжают на корень раскрытой композиции.
        if (host.region !== undefined) (expandedRoot as { region?: unknown }).region = host.region;
        if (host.visible !== undefined) (expandedRoot as { visible?: unknown }).visible = host.visible;
        if (host.slot !== undefined) (expandedRoot as { slot?: unknown }).slot = host.slot;
        replacement.set(hostKey, rootKey);
      }
      delete elements[hostKey];
    }

    if (!replacement.size) return { ...screen, spec: { ...screen.spec, elements } };
    for (const [key, element] of Object.entries(elements)) {
      if (!element.children?.length) continue;
      elements[key] = { ...element, children: element.children.map((child) => replacement.get(child) ?? child) };
    }
    const root = replacement.get(screen.spec.root) ?? screen.spec.root;
    return { ...screen, spec: { root, elements } };
  });

  return { doc: { ...doc, screens } as PrototypeDoc, issues, refs, expandedFrom };
}

type ScreenElement = PrototypeDoc["screens"][number]["spec"]["elements"][string];
type ScreenElements = Record<string, ScreenElement>;

interface NormalizedComposition {
  id: string;
  doc: CompositionDoc;
  /** Publication version, not the document schema version. */
  version: number;
  designSystem?: string;
  status?: string;
}

interface CompositionIdentity {
  id: string;
  version: number;
}

interface RecursiveExpansionContext {
  depth: number;
  stack: CompositionIdentity[];
  chain: ExpandedOriginLayer[];
}

const isCompositionSource = (value: CompositionCatalogEntry): value is CompositionSource => {
  if (!isObject(value) || !Object.hasOwn(value, "doc")) return false;
  const candidate = (value as unknown as { doc: unknown }).doc;
  return isObject(candidate) && (candidate.version === 1 || candidate.version === 2 || candidate.version === 3);
};

function normalizedComposition(id: string, options: ExpandCompositionsOptions): NormalizedComposition | undefined {
  const raw = options.compositions[id];
  if (!raw) return undefined;
  const source = isCompositionSource(raw) ? raw : undefined;
  const doc: CompositionDoc = source ? source.doc : raw as CompositionDoc;
  const requestedVersion = source?.version ?? options.compositionVersions?.[id] ?? 1;
  const version = Number.isInteger(requestedVersion) && requestedVersion > 0 ? requestedVersion : 1;
  return { id, doc, version, designSystem: source?.designSystem, status: source?.status };
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function compositionLabel(identity: CompositionIdentity): string {
  return `${identity.id}@${identity.version}`;
}

/**
 * Expands v2 composition graphs depth-first. The legacy path above is kept
 * intentionally separate so a v1 document has byte-for-byte compatible
 * expansion metadata and diagnostics.
 */
function expandRecursiveCompositions(
  doc: PrototypeDoc,
  options: ExpandCompositionsOptions,
): ExpandedCompositionsResult {
  const refs = collectCompositionRefs(doc);
  const issues: ValidationIssue[] = [];
  const expandedFrom: ExpandedCompositionsResult["expandedFrom"] = {};
  if (!refs.length) return { doc, issues, refs, expandedFrom };

  const maxCompositionDepth = positiveLimit(options.maxCompositionDepth, COMPOSITION_DEPTH_LIMIT);
  const maxExpandedElements = positiveLimit(options.maxExpandedElements, EXPANDED_ELEMENTS_LIMIT);
  const maxTreeDepth = positiveLimit(options.maxTreeDepth, EXPANDED_TREE_DEPTH_LIMIT);
  const issueKeys = new Set<string>();
  const addIssue = (at: (string | number)[], message: string, code?: string): void => {
    const issuePath = path(at);
    const key = `${issuePath}\0${code ?? ""}\0${message}`;
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    issues.push({ path: issuePath, message, ...(code ? { code } : {}) });
  };

  const screens = doc.screens.map((screen, screenIndex) => {
    const originalElements = screen.spec.elements as ScreenElements;
    const hostKeys = Object.entries(originalElements)
      .filter(([, element]) => element.type === COMPOSITION_TYPE)
      .map(([key]) => key);
    if (!hostKeys.length) return screen;

    const base = ["screens", screenIndex, "spec", "elements"] as (string | number)[];
    const elements: ScreenElements = Object.fromEntries(
      Object.entries(originalElements).map(([key, element]) => [key, { ...element }]),
    );
    const replacement = new Map<string, string>();
    let screenRoot = screen.spec.root;

    const resolveReplacement = (key: string): string => {
      let current = key;
      const seen = new Set<string>();
      while (replacement.has(current) && !seen.has(current)) {
        seen.add(current);
        current = replacement.get(current)!;
      }
      return current;
    };

    const replaceReferences = (from: string, to: string): void => {
      for (const [key, element] of Object.entries(elements)) {
        if (!element.children?.length) continue;
        let changed = false;
        const children = element.children.map((child) => {
          if (child !== from) return child;
          changed = true;
          return to;
        });
        if (changed) elements[key] = { ...element, children };
      }
    };

    const setReplacement = (from: string, to: string): void => {
      if (from === to) return;
      replacement.set(from, to);
      replaceReferences(from, to);
    };

    const expandHost = (hostKey: string, source: NormalizedComposition, context: RecursiveExpansionContext): string | undefined => {
      const host = elements[hostKey];
      if (!host) return undefined;
      const at = [...base, hostKey];
      const identity: CompositionIdentity = { id: source.id, version: source.version };
      const labels = [...context.stack, identity].map(compositionLabel).join(" → ");

      if (context.stack.some((entry) => entry.id === identity.id)) {
        addIssue([...at, "props", "composition"], `composition cycle detected: ${labels}`, "composition/cycle");
        return hostKey;
      }
      if (context.depth > maxCompositionDepth) {
        addIssue([...at, "props", "composition"], `composition nesting exceeds ${maxCompositionDepth}: ${labels}`, "composition/depth");
        return hostKey;
      }

      const expectedDesignSystem = options.designSystem ?? doc.designSystem;
      if (source.designSystem !== undefined && expectedDesignSystem !== undefined && source.designSystem !== expectedDesignSystem) {
        addIssue([...at, "props", "composition"], `composition ${source.id} belongs to design system ${source.designSystem}, expected ${expectedDesignSystem}`, "composition/design-system");
      }
      if (source.status !== undefined && source.status !== "active" && options.allowInactivePins !== true) {
        addIssue([...at, "props", "composition"], `composition ${source.id} is not active (status: ${source.status})`, "composition/not-active");
      }

      if (host.repeat) addIssue([...at, "repeat"], "repeat is not allowed on a composition reference");
      // События живут внутри композиции: на самой ссылке их некому обработать (элемент исчезает).
      if (host.on && Object.keys(host.on).length) {
        addIssue([...at, "on"], "events are not allowed on a composition reference; declare them inside the composition");
      }

      const explicit = isObject(host.props.params) ? host.props.params : {};
      // --- W8f: вариант точки ссылки резолвится в значения параметров -----------
      // Явный `params` и вариант — две записи одной величины: пересечение ключей
      // отвергается, а не разрешается приоритетом (молчаливый приоритет скрыл бы
      // расхождение между заявленным вариантом и фактическим деревом).
      const declaredVariants = source.doc.version === 3 ? source.doc.variants : undefined;
      let variantParams: Record<string, unknown> = {};
      if (host.props.variant !== undefined) {
        const resolved = resolveVariant(declaredVariants, host.props.variant);
        if (!resolved.ok) {
          for (const issue of resolved.issues) addIssue([...at, "props", "variant"], `composition ${source.id}: ${issue.message}`, issue.code);
        } else {
          variantParams = resolved.params;
          for (const name of Object.keys(variantParams)) {
            if (!Object.hasOwn(explicit, name)) continue;
            addIssue([...at, "props", "params", name], `composition ${source.id}: param "${name}" is set both by the variant and explicitly`, "composition/variant-param-conflict");
          }
        }
      }
      const provided: Record<string, unknown> = { ...variantParams, ...explicit };
      const values = new Map<string, unknown | undefined>();
      for (const name of Object.keys(provided)) {
        if (!Object.hasOwn(source.doc.params, name)) {
          addIssue([...at, "props", "params", name], `unknown composition param: ${name}`);
        }
      }
      for (const [name, declared] of Object.entries(source.doc.params)) {
        // У параметра-действия (W8d) `default` не бывает — незаполненный необязательный
        // action просто снимает событие при подстановке.
        const fallback = "default" in declared ? declared.default : undefined;
        const raw = Object.hasOwn(provided, name) ? provided[name] : fallback;
        if (raw === undefined) {
          if (declared.required) addIssue([...at, "props", "params", name], `required composition param is missing: ${name}`);
          values.set(name, undefined);
          continue;
        }
        if (!paramValueMatches(declared, raw)) {
          addIssue([...at, "props", "params", name], `composition param ${name} must be of type ${declared.type}`);
        }
        values.set(name, raw);
      }
      // W8g: значения после варианта, явного `params` и дефолтов — вход всех решений ниже.
      options.trace?.params?.({
        compositionId: source.id, version: source.version, hostKey,
        params: Object.fromEntries(values),
      });

      // v3-конструкции разрешаются **только** для тела v3: в v1/v2 объект с ключом `$switch`
      // — обычное значение props, и раскрытие обязано остаться байт-в-байт прежним (D8).
      const isV3Body = source.doc.version === 3;

      // --- W8b: разворачивание `repeatParam` до всего остального ---------------
      // Клоны попадают в тело до условий/подстановки/маршрутизации, поэтому дальше
      // работает обычный конвейер, а бюджеты считают реально построенное дерево.
      const authoredBody = source.doc.spec.elements as Record<string, CompositionElementV3>;
      const materialized = isV3Body
        ? materializeRepeats(
          authoredBody,
          (param) => values.get(param),
          (message, code) => addIssue([...at, "props", "params"], `composition ${source.id}: ${message}`, code),
          maxExpandedElements,
        )
        : { elements: authoredBody, scopes: new Map<string, RepeatScope>() };
      const bodyElements = materialized.elements;
      const repeatScopes = materialized.scopes;
      // W8g: сколько клонов реально построено — считается по телу, а не по длине параметра
      // (после `maxItems`, бюджета элементов и коллизий ключей).
      if (options.trace?.repeat && isV3Body) {
        for (const [innerKey, element] of Object.entries(authoredBody)) {
          const directive = element.repeatParam;
          if (!directive) continue;
          const prefix = `${innerKey}${COMPOSITION_REPEAT_SEPARATOR}`;
          const count = Object.keys(bodyElements).filter((key) => key.startsWith(prefix)).length;
          options.trace.repeat({
            compositionId: source.id, version: source.version, hostKey,
            elementKey: expandedKey(hostKey, innerKey), innerKey, param: directive.param, count,
          });
        }
      }

      const substitute = (value: unknown, innerKey: string, relative: (string | number)[], scope?: RepeatScope): unknown => {
        if (isV3Body && (isItemDirective(value) || isIndexDirective(value))) {
          const where = `${innerKey}/${relative.join("/")}`;
          if (!scope) {
            addIssue([...at, "props", "params"], `composition ${source.id} uses ${isItemDirective(value) ? "$item" : "$index"} outside a repeatParam subtree at ${where}`);
            return undefined;
          }
          if (isIndexDirective(value)) return scope.index;
          const field = (value as { $item: unknown }).$item;
          if (field === true) return scope.item;
          if (typeof field !== "string") {
            addIssue([...at, "props", "params"], `composition ${source.id} has an invalid $item at ${where}`);
            return undefined;
          }
          return isObject(scope.item) ? scope.item[field] : undefined;
        }
        if (isParamDirective(value)) {
          const name = value.$param;
          if (!Object.hasOwn(source.doc.params, name)) {
            addIssue([...at, "props", "params"], `composition ${source.id} references an undeclared param "${name}" at ${innerKey}/${relative.join("/")}`);
            return undefined;
          }
          return values.get(name);
        }
        if (isV3Body && isSwitchDirective(value)) {
          const where = `${innerKey}/${relative.join("/")}`;
          const parsed = compositionSwitchSchema.safeParse(value.$switch);
          if (!parsed.success) {
            addIssue([...at, "props", "params"], `composition ${source.id} has an invalid $switch at ${where}`);
            return undefined;
          }
          const directive = parsed.data;
          if (!Object.hasOwn(source.doc.params, directive.param)) {
            addIssue([...at, "props", "params"], `composition ${source.id} references an undeclared param "${directive.param}" at ${where}`);
            return undefined;
          }
          const resolved = resolveSwitch(directive, values.get(directive.param));
          if (!resolved.ok) {
            addIssue([...at, "props", "params"], `composition ${source.id}: ${resolved.message} at ${where}`, "composition/switch-unresolved");
            return undefined;
          }
          if (options.trace?.switch) {
            const caseKey = switchCaseKey(values.get(directive.param));
            options.trace.switch({
              compositionId: source.id, version: source.version, hostKey,
              elementKey: expandedKey(hostKey, innerKey), innerKey,
              prop: relative.join("/"), param: directive.param,
              case: caseKey !== undefined && Object.hasOwn(directive.cases, caseKey) ? caseKey : "default",
            });
          }
          return substitute(resolved.value, innerKey, relative, scope);
        }
        if (Array.isArray(value)) return value.map((item, index) => substitute(item, innerKey, [...relative, index], scope));
        if (isObject(value)) {
          const entries = Object.entries(value)
            .map(([key, item]) => [key, substitute(item, innerKey, [...relative, key], scope)] as const)
            .filter(([, item]) => item !== undefined);
          return Object.fromEntries(entries);
        }
        return value;
      };

      // --- маршрутизация детей по слотам ---
      // W8c: `slots` может быть словарём с метаданными; имена берутся из нормализованной формы.
      const declaredSlots = normalizeCompositionSlots(source.doc.slots);
      const filled = new Map<string, string[]>();
      for (const child of host.children ?? []) {
        const childElement = elements[child];
        const slot = childElement?.slot ?? DEFAULT_SLOT;
        if (!Object.hasOwn(declaredSlots, slot)) {
          addIssue([...base, child, "slot"], `unknown slot for composition ${source.id}: ${slot}`);
          continue;
        }
        (filled.get(slot) ?? filled.set(slot, []).get(slot)!).push(child);
      }

      const slotNames = new Map<string, string>(); // innerKey -> slot name
      for (const [innerKey, element] of Object.entries(bodyElements)) {
        if (element.type !== SLOT_TYPE || typeof element.props.name !== "string") continue;
        slotNames.set(innerKey, element.props.name);
        // Родителем маршрутизированных детей становится родитель `@eui/Slot`, поэтому
        // side-channel `slot` ребёнка заменяется размещением самого слота (или снимается).
        for (const child of filled.get(element.props.name) ?? []) {
          const routed = elements[child];
          if (!routed) continue;
          const next = { ...routed };
          if (element.slot === undefined) delete (next as { slot?: unknown }).slot;
          else (next as { slot?: unknown }).slot = element.slot;
          elements[child] = next;
        }
      }
      // Ребёнок, чей слот в композиции не объявлен `@eui/Slot`-элементом, не попадёт в дерево.
      for (const [slot, children] of filled) {
        if ([...slotNames.values()].includes(slot)) continue;
        for (const child of children) {
          addIssue([...base, child, "slot"], `composition ${source.id} declares slot "${slot}" but has no ${SLOT_TYPE} element for it`);
        }
      }
      // --- параметрические условия v3 (`when`) ---
      // Ложное условие снимает элемент **и всё его поддерево** до подсчёта раскрытых
      // элементов, поэтому лимиты после раскрытия действуют на реально построенное дерево.
      const hidden = isV3Body
        ? hiddenElementKeys(bodyElements as Record<string, { children?: string[]; when?: CompositionWhen }>, (when, innerKey) => {
          if (!Object.hasOwn(source.doc.params, when.param)) {
            addIssue([...at, "props", "params"], `composition ${source.id} references an undeclared param "${when.param}" in when`);
            return true;
          }
          const taken = evaluateWhen(when, values.get(when.param));
          options.trace?.branch?.({
            compositionId: source.id, version: source.version, hostKey,
            elementKey: expandedKey(hostKey, innerKey), innerKey, when, taken,
          });
          return taken;
        })
        : new Set<string>();

      // --- W8c: контракт слотов в точке ссылки ---------------------------------
      // Fallback материализуется **только** для пустого слота; поддеревья fallback'ов
      // заполненных слотов снимаются тем же механизмом, что и ложный `when`.
      const activeFallback = new Map<string, string[]>(); // slot → корни fallback'а
      for (const [name, meta] of Object.entries(declaredSlots)) {
        const children = filled.get(name) ?? [];
        const fallback = meta.fallback ?? [];
        const usesFallback = children.length === 0 && fallback.length > 0;
        if (usesFallback) activeFallback.set(name, fallback);
        else for (const key of fallback) for (const inner of subtreeKeys(bodyElements, key)) hidden.add(inner);
        options.trace?.slot?.({
          compositionId: source.id, version: source.version, hostKey,
          slot: name, required: meta.required === true, filled: children.length > 0,
          fallbackUsed: usesFallback, children: [...children],
        });
        if (options.validateSlotContract === false) continue;
        // Ребёнок, уже раскрытый как вложенная композиция, живёт под ключом-заменой:
        // тип берётся с корня его раскрытия, иначе `allowedTypes` дал бы ложный вердикт.
        const contents = children
          .map((key) => ({ key, type: elements[resolveReplacement(key)]?.type }))
          .filter((child): child is { key: string; type: string } => child.type !== undefined);
        for (const issue of checkSlotContents(name, meta, contents, {
          usesFallback,
          roles: options.componentRoles,
        })) {
          addIssue([...at, "props", "composition"], `composition ${source.id}: ${issue.message}`, issue.code);
        }
      }

      const resolveChildren = (children: string[] | undefined): string[] => (children ?? []).flatMap((innerChild) => {
        if (hidden.has(innerChild)) return [];
        const slot = slotNames.get(innerChild);
        if (slot === undefined) return [expandedKey(hostKey, innerChild)];
        const routed = filled.get(slot) ?? [];
        if (routed.length) return routed.map(resolveReplacement);
        return (activeFallback.get(slot) ?? []).map((key) => expandedKey(hostKey, key));
      });

      const nestedHosts: Array<{ key: string; chain: ExpandedOriginLayer[] }> = [];
      const nextStack = [...context.stack, identity];
      for (const [innerKey, element] of Object.entries(bodyElements)) {
        if (element.type === SLOT_TYPE) continue;
        if (hidden.has(innerKey)) continue;
        const key = expandedKey(hostKey, innerKey);
        if (Object.hasOwn(elements, key)) {
          addIssue([...at], `expanded element key collides with an authored key: ${key}`);
          continue;
        }
        const props = substitute(element.props, innerKey, [], repeatScopes.get(innerKey)) as Record<string, unknown>;
        const children = resolveChildren(element.children);
        elements[key] = {
          ...element,
          props,
          ...(children.length ? { children } : {}),
        } as ScreenElement;
        if (!children.length) delete (elements[key] as { children?: unknown }).children;
        // `when` — авторская конструкция композиции: раскрытый элемент её не несёт
        // (спека экрана строга, и никакого рантайм-условия из v3 не возникает).
        if (isV3Body) {
          delete (elements[key] as { when?: unknown }).when;
          delete (elements[key] as { repeatParam?: unknown }).repeatParam;
          // --- W8d: параметр-действие вписывается в `on` целевого элемента ---
          const substitutedOn = substituteHandlers(element.on, innerKey, {
            paramType: (name) => (Object.hasOwn(source.doc.params, name) ? source.doc.params[name]!.type : undefined),
            paramValue: (name) => values.get(name),
            addIssue: (message, code) => addIssue([...at, "props", "params"], `composition ${source.id} ${message}`, code),
          });
          if (substitutedOn === undefined) delete (elements[key] as { on?: unknown }).on;
          else (elements[key] as { on?: unknown }).on = substitutedOn;
          // --- W8e: token layout компилируется в props контракта v1 ---
          const layout = element.layout;
          delete (elements[key] as { layout?: unknown }).layout;
          if (layout) {
            const compiled = compileLayout(layout);
            options.trace?.layout?.({
              compositionId: source.id, version: source.version, hostKey,
              elementKey: key, innerKey, type: element.type, props: compiled,
            });
            (elements[key] as { props: Record<string, unknown> }).props = { ...compiled, ...props };
            if (options.componentLayouts) {
              for (const issue of layoutSupportIssues(element.type, layout, options.componentLayouts[element.type])) {
                addIssue([...base, key, "layout"], `composition ${source.id}: ${issue.message}`, issue.code);
              }
            }
          }
        }

        const layer: ExpandedOriginLayer = {
          compositionId: source.id,
          version: source.version,
          hostKey,
          innerKey,
        };
        const chain = [...context.chain, layer];
        if (source.doc.version === 1 && context.chain.length === 0) {
          expandedFrom[key] = { compositionId: source.id, hostKey, innerKey };
        } else {
          expandedFrom[key] = { compositionId: source.id, hostKey, innerKey, chain };
        }
        if (element.type === COMPOSITION_TYPE) nestedHosts.push({ key, chain });
      }

      // Nested references are expanded in document order. This makes both key
      // allocation and the first diagnostic deterministic.
      for (const nested of nestedHosts) {
        const nestedHost = elements[nested.key];
        const nestedId = nestedHost?.props.composition;
        if (typeof nestedId !== "string") {
          addIssue([...base, nested.key, "props", "composition"], "composition reference must be a static slug");
          continue;
        }
        const nestedSource = normalizedComposition(nestedId, options);
        if (!nestedSource) {
          addIssue([...base, nested.key, "props", "composition"], `unknown or unpublished composition: ${nestedId}`);
          continue;
        }
        expandHost(nested.key, nestedSource, {
          depth: context.depth + 1,
          stack: nextStack,
          chain: nested.chain,
        });
      }

      const rawRootKey = expandedKey(hostKey, source.doc.spec.root);
      const rootKey = resolveReplacement(rawRootKey);
      const expandedRoot = elements[rootKey];
      if (expandedRoot) {
        // Позиционные поля host-элемента переезжают на корень раскрытой композиции.
        if (host.region !== undefined) (expandedRoot as { region?: unknown }).region = host.region;
        if (host.visible !== undefined) (expandedRoot as { visible?: unknown }).visible = host.visible;
        if (host.slot !== undefined) (expandedRoot as { slot?: unknown }).slot = host.slot;
        setReplacement(hostKey, rootKey);
      }
      delete elements[hostKey];
      // A nested host has an intermediate origin entry, but the host itself is removed
      // from the expanded tree. Keep expandedFrom a projection of surviving elements only.
      delete expandedFrom[hostKey];
      return rootKey;
    };

    for (const hostKey of hostKeys) {
      const host = elements[hostKey];
      if (!host) continue;
      const compositionId = host.props.composition;
      if (typeof compositionId !== "string") {
        addIssue([...base, hostKey, "props", "composition"], "composition reference must be a static slug");
        continue;
      }
      const source = normalizedComposition(compositionId, options);
      if (!source) {
        addIssue([...base, hostKey, "props", "composition"], `unknown or unpublished composition: ${compositionId}`);
        continue;
      }
      const rootKey = expandHost(hostKey, source, { depth: 1, stack: [], chain: [] });
      if (hostKey === screenRoot && rootKey !== undefined) screenRoot = resolveReplacement(rootKey);
    }

    screenRoot = resolveReplacement(screenRoot);
    const elementCount = Object.keys(elements).length;
    if (elementCount > maxExpandedElements) {
      addIssue([...base, "elements"], `expanded composition output exceeds ${maxExpandedElements} elements`, "composition/expanded-elements");
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const checkDepth = (key: string, depth: number): void => {
      if (depth > maxTreeDepth) {
        addIssue([...base, key], `expanded tree depth exceeds ${maxTreeDepth}`, "composition/tree-depth");
      }
      if (visiting.has(key)) {
        addIssue([...base, key], "expanded composition tree contains a cycle", "composition/tree-cycle");
        return;
      }
      if (visited.has(key)) return;
      const element = elements[key];
      if (!element) return;
      visiting.add(key);
      for (const child of element.children ?? []) checkDepth(child, depth + 1);
      visiting.delete(key);
      visited.add(key);
    };
    checkDepth(screenRoot, 1);

    return { ...screen, spec: { root: screenRoot, elements } };
  });

  return { doc: { ...doc, screens } as PrototypeDoc, issues, refs, expandedFrom };
}

/**
 * Expands v1, v2 and v3 composition documents. Bare v1 maps take the frozen
 * implementation above; a versioned entry can be passed directly (for example
 * the API's `{ id, version, doc }` pin shape).
 */
export function expandCompositions(
  doc: PrototypeDoc,
  options: ExpandCompositionsOptions,
): ExpandedCompositionsResult {
  const refs = collectCompositionRefs(doc);
  // Keep the legacy algorithm selected for a wholly-v1 authored document even when one
  // reference is missing. This is important for frozen v1 diagnostics: an unresolved v1
  // reference must not acquire v2 depth/budget/origin behavior merely because its source is
  // unavailable. Mixed v1/v2 documents use the recursive path.
  //
  // D8 (план 2026-08-03): v3 обязан идти тем же nested-путём — тело v3 несёт `when`/`$switch`
  // и вложенные композиции, которых legacy-раскрытие не знает; документ, ссылающийся только на
  // v3, ушёл бы в v1-ветку и молча потерял бы обе конструкции.
  const hasNestingCapableReference = refs.some((ref) => {
    const version = normalizedComposition(ref.compositionId, options)?.doc.version;
    return version === 2 || version === 3;
  });
  if (!hasNestingCapableReference) {
    const legacyCompositions: Record<string, CompositionDoc> = {};
    for (const [id] of Object.entries(options.compositions)) {
      const source = normalizedComposition(id, options);
      if (source) legacyCompositions[id] = source.doc;
    }
    return expandV1Compositions(doc, { compositions: legacyCompositions });
  }
  return expandRecursiveCompositions(doc, options);
}
