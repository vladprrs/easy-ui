import { z } from "zod";
import { authoredElementKeySchema, slugSchema } from "../schema";

/**
 * Слоты композиций v3 с метаданными (план 2026-08-03 §5 W8c, граница D7).
 *
 * `slots` остаётся **аддитивным**: массив имён (v1/v2 и простой v3) и словарь
 * `имя → метаданные` — две ветки одного объединения. Внутри раскрытия обе формы
 * приводятся к одной (`normalizeCompositionSlots`), поэтому v1/v2-поведение
 * байт-в-байт прежнее: у массива метаданных просто нет.
 *
 * Все правила слотов проверяются **в точке ссылки, на этапе раскрытия** — никакого
 * рантайм-контракта из них не возникает.
 */

export const COMPOSITION_SLOTS_LIMIT = 20;
export const COMPOSITION_SLOT_ALLOWED_TYPES_LIMIT = 30;
export const COMPOSITION_SLOT_ALLOWED_ROLES_LIMIT = 20;
export const COMPOSITION_SLOT_FALLBACK_LIMIT = 10;

const cardinalitySchema = z.strictObject({
  min: z.number().int().min(0).max(100).optional(),
  max: z.number().int().min(0).max(100).optional(),
}).superRefine((value, context) => {
  if (value.min === undefined && value.max === undefined) {
    context.addIssue({ code: "custom", message: "cardinality requires min or max" });
  }
  if (value.min !== undefined && value.max !== undefined && value.min > value.max) {
    context.addIssue({ code: "custom", message: "cardinality min must not exceed max" });
  }
});

export const compositionSlotMetaSchema = z.strictObject({
  required: z.boolean().optional(),
  /** Роли `canonicalFor`-глоссария; известность слага проверяет сервер (roles.json). */
  allowedRoles: z.array(slugSchema).min(1).max(COMPOSITION_SLOT_ALLOWED_ROLES_LIMIT).optional(),
  allowedTypes: z.array(z.string().trim().min(1).max(120)).min(1).max(COMPOSITION_SLOT_ALLOWED_TYPES_LIMIT).optional(),
  cardinality: cardinalitySchema.optional(),
  /** Ключи элементов **того же тела**, материализуемые, когда слот пуст. */
  fallback: z.array(authoredElementKeySchema).min(1).max(COMPOSITION_SLOT_FALLBACK_LIMIT).optional(),
  description: z.string().trim().min(1).max(300).optional(),
}).superRefine((meta, context) => {
  if (meta.allowedTypes && new Set(meta.allowedTypes).size !== meta.allowedTypes.length) {
    context.addIssue({ code: "custom", path: ["allowedTypes"], message: "allowedTypes must be unique" });
  }
  if (meta.allowedRoles && new Set(meta.allowedRoles).size !== meta.allowedRoles.length) {
    context.addIssue({ code: "custom", path: ["allowedRoles"], message: "allowedRoles must be unique" });
  }
  if (meta.fallback && new Set(meta.fallback).size !== meta.fallback.length) {
    context.addIssue({ code: "custom", path: ["fallback"], message: "fallback keys must be unique" });
  }
});

export type CompositionSlotMeta = z.output<typeof compositionSlotMetaSchema>;

/** Объявление слотов v3: массив имён (как в v1/v2) **или** словарь с метаданными. */
export const compositionSlotsV3Schema = z.union([
  z.array(slugSchema).max(COMPOSITION_SLOTS_LIMIT),
  z.record(slugSchema, compositionSlotMetaSchema)
    .refine((slots) => Object.keys(slots).length <= COMPOSITION_SLOTS_LIMIT,
      `composition exceeds ${COMPOSITION_SLOTS_LIMIT} slots`),
]);

export type CompositionSlotsDeclaration = string[] | Record<string, CompositionSlotMeta>;

/** Имена слотов в порядке объявления — единая форма для обеих веток. */
export const compositionSlotNames = (slots: CompositionSlotsDeclaration): string[] =>
  Array.isArray(slots) ? slots : Object.keys(slots);

/** Нормализованная форма: у массива метаданных нет (пустой объект на каждое имя). */
export const normalizeCompositionSlots = (slots: CompositionSlotsDeclaration): Record<string, CompositionSlotMeta> =>
  Array.isArray(slots)
    ? Object.fromEntries(slots.map((name) => [name, {} as CompositionSlotMeta]))
    : slots;

export interface SlotCheckChild {
  key: string;
  type: string;
}

export interface SlotCheckIssue {
  message: string;
  code?: string;
}

/**
 * Проверка содержимого слота в точке ссылки. `roles` — карта «тип компонента → его
 * `canonicalFor`»; она есть только у сервера (definition_meta), поэтому `allowedRoles`
 * проверяется, лишь когда карта передана (клиент валидирует типы и кардинальность).
 */
export function checkSlotContents(
  slot: string,
  meta: CompositionSlotMeta,
  children: SlotCheckChild[],
  options: { usesFallback: boolean; roles?: Readonly<Record<string, readonly string[]>> },
): SlotCheckIssue[] {
  const issues: SlotCheckIssue[] = [];
  if (children.length === 0) {
    // Fallback покрывает контракт пустого слота: и `required`, и нижнюю границу.
    if (options.usesFallback) return issues;
    if (meta.required) {
      issues.push({ message: `required slot "${slot}" has no children and no fallback`, code: "composition/slot-required" });
    }
  }
  const { min, max } = meta.cardinality ?? {};
  if (!(children.length === 0 && options.usesFallback)) {
    if (min !== undefined && children.length < min) {
      issues.push({ message: `slot "${slot}" requires at least ${min} child(ren), got ${children.length}`, code: "composition/slot-cardinality" });
    }
    if (max !== undefined && children.length > max) {
      issues.push({ message: `slot "${slot}" accepts at most ${max} child(ren), got ${children.length}`, code: "composition/slot-cardinality" });
    }
  }
  if (meta.allowedTypes) {
    for (const child of children) {
      if (meta.allowedTypes.includes(child.type)) continue;
      issues.push({
        message: `slot "${slot}" does not accept element type ${child.type} (allowed: ${meta.allowedTypes.join(", ")})`,
        code: "composition/slot-type",
      });
    }
  }
  if (meta.allowedRoles && options.roles) {
    for (const child of children) {
      const roles = options.roles[child.type] ?? [];
      if (roles.some((role) => meta.allowedRoles!.includes(role))) continue;
      issues.push({
        message: `slot "${slot}" requires a component with canonical role ${meta.allowedRoles.join(" | ")}; ${child.type} has ${roles.length ? roles.join(", ") : "none"}`,
        code: "composition/slot-role",
      });
    }
  }
  return issues;
}
