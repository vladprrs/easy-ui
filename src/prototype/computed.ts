/**
 * `doc.computed` — декларативные производные значения стейта (план
 * `docs/plans/2026-08-02-computed-state.md`, D2–D4).
 *
 * Записи вычисляются **последовательно в порядке ключей объекта**: каждая видит plain
 * state и уже посчитанные computed-значения (`add` может ссылаться только на ранее
 * объявленный ключ — ацикличность по построению, детекция циклов не нужна).
 *
 * Числовая семантика (D3) детерминирована и намеренно «тихая»: не-массив в `from` ⇒ 0;
 * поле item засчитывается только если это finite number, иначе item даёт 0; в
 * `sumProduct` любое отсутствующее/нечисловое поле обнуляет item целиком (не ×1); терм
 * `add` не-finite ⇒ 0; финальный аккумулятор — `Number.isFinite(total) ? total : 0`.
 * Ни округления, ни коэрции строк: деньги авторятся целыми минорными единицами.
 *
 * Эвалюатор **оборонителен к stored-форме** (`z.record(z.string(), z.unknown())`):
 * не-объектная запись (`null`, число, строка, массив) и неизвестная `op` дают 0 и
 * никогда не бросают — иначе документ, сохранённый более новой версией, ронял бы
 * плеер на каждой мутации стейта.
 *
 * **Инвариант пересчёта.** Computed выводится только из закоммиченных записей стора:
 * `createHardenedStore` пропускает reference-identical запись (`getByPath(path) === value`,
 * `src/prototype/hardenedStore.ts`), поэтому in-place мутация массива с последующей
 * пере-записью той же ссылки не коммитится и не пересчитывает computed. Это существующее
 * поведение стора (раньше — безобидный no-op), и чистота эвалюатора делает пропуск
 * безопасным: полноту пересчёта при мутациях по месту мы не заявляем, кастомные
 * компоненты обязаны писать иммутабельно.
 */

import { getAtPointer, getAtRelativePath } from "./pointer";

/**
 * Спека в том виде, в каком она приезжает из документа: у input-ветки это
 * `ComputedSpec`, у stored-ветки — произвольная запись. Эвалюатор принимает обе,
 * а также отсутствие поля.
 */
export type ComputedSpecLike = Readonly<Record<string, unknown>> | null | undefined;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Ключи спеки в порядке объявления. Оборонительно к не-объектной спеке. */
export function computedKeys(spec: ComputedSpecLike): string[] {
  const record = asRecord(spec);
  return record === null ? [] : Object.keys(record);
}

/**
 * Префиксный предикат в **pointer-форме**: `/key` и `/key/...` считаются computed.
 * Единая точка для validate/store/runtime (в сторе сравниваются bare-сегменты).
 */
export function isComputedPath(pointer: string, keys: readonly string[]): boolean {
  if (typeof pointer !== "string" || pointer === "") return false;
  return keys.some((key) => pointer === `/${key}` || pointer.startsWith(`/${key}/`));
}

function evaluateEntry(scope: Record<string, unknown>, entry: unknown): number {
  const record = asRecord(entry);
  if (record === null) return 0;
  const op = record.op;

  if (op === "count") {
    const source = typeof record.from === "string" ? getAtPointer(scope, record.from).value : undefined;
    return Array.isArray(source) ? source.length : 0;
  }

  if (op === "sum" || op === "sumProduct") {
    const source = typeof record.from === "string" ? getAtPointer(scope, record.from).value : undefined;
    if (!Array.isArray(source)) return 0;

    if (op === "sum") {
      const field = typeof record.field === "string" ? record.field : null;
      let total = 0;
      for (const item of source) {
        const raw = field === null ? item : getAtRelativePath(item, field).value;
        total += finiteNumber(raw) ?? 0;
      }
      return Number.isFinite(total) ? total : 0;
    }

    const fields = Array.isArray(record.fields) ? record.fields : null;
    if (fields === null || fields.length === 0) return 0;
    let total = 0;
    for (const item of source) {
      let product = 1;
      for (const field of fields) {
        const raw = typeof field === "string" ? getAtRelativePath(item, field).value : undefined;
        const value = finiteNumber(raw);
        // D3: любое отсутствующее/нечисловое поле ⇒ item даёт 0 (не ×1).
        if (value === null) { product = 0; break; }
        product *= value;
      }
      total += Number.isFinite(product) ? product : 0;
    }
    return Number.isFinite(total) ? total : 0;
  }

  if (op === "add") {
    const terms = Array.isArray(record.terms) ? record.terms : null;
    if (terms === null) return 0;
    let total = 0;
    for (const term of terms) {
      if (typeof term === "string") {
        total += finiteNumber(getAtPointer(scope, term).value) ?? 0;
        continue;
      }
      total += finiteNumber(term) ?? 0;
    }
    return Number.isFinite(total) ? total : 0;
  }

  // Неизвестная (в т.ч. будущая) операция — 0, без throw.
  return 0;
}

/**
 * Считает все computed-значения по plain state. Вход не мутируется.
 * Возвращает запись `ключ → число` в порядке объявления ключей спеки.
 */
export function evaluateComputed(state: unknown, spec: ComputedSpecLike): Record<string, number> {
  const entries = asRecord(spec);
  if (entries === null) return {};
  const keys = Object.keys(entries);
  if (keys.length === 0) return {};

  // null-prototype: stored-форма допускает произвольные ключи, а присваивание
  // `scope["__proto__"]` на обычном литерале трогало бы прототип.
  const scope: Record<string, unknown> = Object.assign(Object.create(null) as Record<string, unknown>, asRecord(state) ?? {});
  const values: [string, number][] = [];
  for (const key of keys) {
    const value = evaluateEntry(scope, entries[key]);
    scope[key] = value;
    values.push([key, value]);
  }
  // fromEntries создаёт own-property даже для ключа "__proto__".
  return Object.fromEntries(values);
}

/**
 * Досев computed поверх plain state (инертные превью: CJM, редактор, галерея).
 * При пустой/отсутствующей спеке возвращает **тот же референс** `state` —
 * на это опираются `useMemo`-зависимости сид-сайтов.
 */
export function applyComputed<T extends Record<string, unknown>>(state: T, spec: ComputedSpecLike): T {
  if (computedKeys(spec).length === 0) return state;
  return { ...state, ...evaluateComputed(state, spec) } as T;
}
