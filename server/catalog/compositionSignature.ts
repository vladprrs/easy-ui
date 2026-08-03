/**
 * Структурная сигнатура композиции (план 2026-08-03 §5 W9, находка R1-M9).
 *
 * У композиции нет TSX, поэтому сигнала `sourceShingles` у неё быть не может: её «исходник» —
 * это **дерево тела** (типы элементов, форма дерева, имена props у каждого узла) плюс
 * контракт (`params`/`slots`). Модуль чист: ни БД, ни сети, ни env — как и `fingerprint.ts`,
 * потому что корпус собирается синхронно внутри `db.transaction`.
 *
 * Что **не** входит в сигнатуру: значения props, тексты, дефолты параметров и описания.
 * Иначе переписанный литерал «чинил» бы дубликат — та же граница, что у `sourceShingles`.
 *
 * Две выдачи:
 * - `shingles` — 3-шинглы токенов обхода тела; сравниваются Jaccard'ом в слоте сигнала
 *   `source` матчера (для композиций это единственный структурный сигнал тела);
 * - `fingerprint` — sha256 канонического `{tokens, params, slots}`: равенство отпечатков и есть
 *   «точный структурный дубль», единственный сигнал, работающий без порога.
 */

import { canonicalStringify } from "../../src/capture/canonicalJson";
import { SLOT_TYPE } from "../../src/catalog/hostPrimitives/composition.definition";

/** Длина шингла тела: композиции на порядок короче TSX, k=5 оставил бы мелкие тела без сигнала. */
export const COMPOSITION_SHINGLE_SIZE = 3;

/** Защита от битого черновика: цикл в `children` не должен вешать синхронный обход. */
const MAX_NODES = 1000;

export interface CompositionStructure {
  /** k-шинглы токенов обхода тела (k=3). */
  shingles: Set<string>;
  /** sha256 `{tokens, params, slots}` — точный структурный дубль. */
  fingerprint: string;
  /** Типы элементов тела (для объяснений), отсортированы. */
  elementTypes: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface LooseElement { type: string; propKeys: string[]; children: string[]; slotName?: string }

function readElements(spec: unknown): { root: string; elements: Record<string, LooseElement> } | undefined {
  if (!isRecord(spec) || !isRecord(spec.elements)) return undefined;
  const elements: Record<string, LooseElement> = {};
  for (const [key, raw] of Object.entries(spec.elements)) {
    if (!isRecord(raw)) continue;
    const props = isRecord(raw.props) ? raw.props : {};
    const slotName = raw.type === SLOT_TYPE && typeof props.name === "string" ? props.name : undefined;
    elements[key] = {
      type: typeof raw.type === "string" ? raw.type : "",
      // Имена props — часть формы узла; значения не берутся никогда.
      propKeys: Object.keys(props).sort(),
      children: Array.isArray(raw.children) ? raw.children.filter((child): child is string => typeof child === "string") : [],
      ...(slotName === undefined ? {} : { slotName }),
    };
  }
  const root = typeof spec.root === "string" ? spec.root : "";
  return { root, elements };
}

/**
 * Токены обхода: скобочная запись дерева. `(` и `)` несут форму, `type{propKeys}` — узел.
 * Порядок детей авторский (он же порядок рендера), поэтому перестановка детей — другая
 * структура, и это правильно: два разных макета не обязаны считаться одним.
 *
 * Корень недостижимых элементов (битый черновик) дописывается детерминированно по
 * сортировке ключей — иначе анализ черновика зависел бы от порядка вставки в JSON.
 */
function bodyTokens(spec: unknown): string[] {
  const parsed = readElements(spec);
  if (parsed === undefined) return [];
  const { root, elements } = parsed;
  const tokens: string[] = [];
  const visited = new Set<string>();
  const walk = (key: string, depth: number): void => {
    const element = elements[key];
    if (element === undefined || visited.has(key) || visited.size >= MAX_NODES || depth > 64) return;
    visited.add(key);
    tokens.push("(");
    tokens.push(element.slotName === undefined
      ? `${element.type}{${element.propKeys.join(",")}}`
      // Слот — контракт, а не узел: его различает имя, а не набор props.
      : `${SLOT_TYPE}:${element.slotName}`);
    for (const child of element.children) walk(child, depth + 1);
    tokens.push(")");
  };
  if (elements[root] !== undefined) walk(root, 0);
  for (const key of Object.keys(elements).sort()) walk(key, 0);
  return tokens;
}

/** Контракт параметров: имя + тип + обязательность. Дефолты и описания не берутся. */
function paramSignature(params: unknown): { name: string; type: string; required: boolean }[] {
  if (!isRecord(params)) return [];
  return Object.entries(params)
    .map(([name, param]) => ({
      name,
      type: isRecord(param) && typeof param.type === "string" ? param.type : "unknown",
      required: isRecord(param) && param.required === true,
    }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/** Имена слотов: массив строк (v1/v2) либо объектная декларация (v3). */
export function slotNamesOf(slots: unknown): string[] {
  if (Array.isArray(slots)) return [...new Set(slots.filter((slot): slot is string => typeof slot === "string"))].sort();
  if (isRecord(slots)) return Object.keys(slots).sort();
  return [];
}

/** k-шинглы: короткое тело даёт один шингл из всего потока (как `sourceShingles`). */
function shinglesOf(tokens: readonly string[], size = COMPOSITION_SHINGLE_SIZE): Set<string> {
  const shingles = new Set<string>();
  if (tokens.length === 0) return shingles;
  if (tokens.length <= size) { shingles.add(tokens.join("")); return shingles; }
  for (let index = 0; index + size <= tokens.length; index += 1) shingles.add(tokens.slice(index, index + size).join(""));
  return shingles;
}

/**
 * Сигнатура документа композиции. Документ **не обязан** проходить строгую схему: кандидат
 * приходит черновиком, и слепота к битому черновику означала бы «дубль не найден» ровно там,
 * где он вероятнее всего.
 *
 * `undefined` — тела нет вовсе (нет `spec.elements`): сигнал неприменим, а не пуст.
 */
export function compositionStructure(doc: unknown): CompositionStructure | undefined {
  if (!isRecord(doc)) return undefined;
  const tokens = bodyTokens(doc.spec);
  if (tokens.length === 0) return undefined;
  const params = paramSignature(doc.params);
  const slots = slotNamesOf(doc.slots);
  return {
    shingles: shinglesOf(tokens),
    fingerprint: new Bun.CryptoHasher("sha256").update(canonicalStringify({ tokens, params, slots })).digest("hex"),
    elementTypes: [...new Set(tokens
      .filter((token) => token !== "(" && token !== ")")
      .map((token) => token.replace(/\{.*$/, "")))].sort(),
  };
}

/**
 * JSON-схема параметров композиции для сигналов props матчера. Форма зеркалит
 * `activeCompositionRevisionSources`: тип параметра становится `type` свойства, поэтому
 * `propsSignature` видит те же формы, что и у компонента (`string`, `enum`, `array`, …).
 */
export function compositionPropsJsonSchema(params: unknown): { type: "object"; properties: Record<string, { type: string }>; required?: string[] } {
  const signature = paramSignature(params);
  const required = signature.filter((param) => param.required).map((param) => param.name);
  return {
    type: "object",
    properties: Object.fromEntries(signature.map((param) => [param.name, { type: param.type }])),
    ...(required.length ? { required } : {}),
  };
}
