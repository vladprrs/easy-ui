import { z } from "zod";
import type { ComponentDefinition } from "../definitions";

/**
 * Composition primitives (волна 5, план 2026-07-27 §5).
 *
 * `@eui/Composition` — ссылка на версионированную композицию внутри документа прототипа.
 * `@eui/Slot` — точка вставки детей, допустима **только внутри документа композиции**.
 *
 * Оба типа host-owned: имена зарезервированы от публикации компонентов, а элементы
 * раскрываются (`expandCompositions`) до рендера, поэтому их React-компоненты —
 * оборонительный passthrough, который не должен встречаться в рантайме.
 */
export const COMPOSITION_TYPE = "@eui/Composition" as const;
export const SLOT_TYPE = "@eui/Slot" as const;

/**
 * Разделитель ключей раскрытой композиции: `<hostKey>$<innerKey>`.
 * Символ `$` запрещён в авторских ключах элементов (`inputPrototypeDocSchema`),
 * поэтому коллизии исключены по построению. Контракт зафиксирован в
 * `docs/prototype-format.md` — ключи доезжают до `__euiKey` → `data-eui-key`.
 */
export const COMPOSITION_KEY_SEPARATOR = "$";

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const compositionDefinition = {
  props: z.strictObject({
    /** Slug-идентификатор композиции (`compositions.id`). */
    composition: z.string().regex(slugPattern, "must be a slug"),
    /** Значения объявленных параметров композиции. */
    params: z.record(z.string(), z.unknown()).optional(),
  }),
  // Список слотов динамический — берётся из документа композиции (см. validate.ts).
  slots: [],
  capabilities: { namedSlots: true },
  layoutNeutral: true,
  description: "Reference to a versioned composition; expanded into its elements before render.",
} satisfies ComponentDefinition;

export const slotDefinition = {
  props: z.strictObject({ name: z.string().regex(slugPattern, "must be a slug") }),
  layoutNeutral: true,
  description: "Insertion point for slotted children inside a composition document.",
} satisfies ComponentDefinition;

export const compositionPrimitiveDefinitions = {
  [COMPOSITION_TYPE]: compositionDefinition,
  [SLOT_TYPE]: slotDefinition,
} satisfies Record<string, ComponentDefinition>;
