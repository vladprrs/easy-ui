import { canonicalStringify } from "../src/capture/canonicalJson";

/**
 * Ревизия каталога — sha256 канонического JSON **стабильной discovery-проекции** собранных
 * строк read-model.
 *
 * `kind` в сигнатуре с самого начала: проект 2 добавит композиции в тот же набор,
 * и порядок сортировки не должен поменяться задним числом.
 * Считать её можно только от **нефильтрованного** каталога: иначе два клиента с разными
 * `?designSystem=` получили бы разные «ревизии каталога» на одном состоянии БД.
 *
 * Почему проекция, а не запись целиком (план 2026-07-31 §2 D2 / §3.4): `canonicalStringify`
 * хэширует фактические ключи объекта, поэтому полная `LibraryCatalogEntry` затаскивала в
 * ревизию `headUsageCount`, `status.verified`, `figma`, `preview` и `bundleUrl`. Ревизия
 * дёргалась от правки чужого прототипа и от завершения фонового visual-run, а проект 2
 * использует её как защиту админского override от гонки каталога — такой override протухал бы
 * от чужой работы. В хэш входит только то, что меняет **картину переиспользования**:
 * состав активных версий и discovery-мета.
 *
 * Регресс-гард: проекция обязана собирать новые объекты **явным перечислением полей**, без
 * spread входной строки — иначе новое поле `LibraryCatalogEntry` снова протечёт в ревизию
 * (тест «добавление поля в LibraryCatalogEntry не меняет catalogRevision»).
 *
 * `propsSignature`/`ioSignature` считаются здесь локально и намеренно дублируют идею
 * `server/catalog/fingerprint.ts`: тот модуль решает другую задачу (сходство кандидатов) и
 * волен менять свою нормализацию, а ревизия обязана быть стабильной сама по себе.
 */
export interface CatalogRevisionSourceMeta {
  propsJsonSchema?: unknown;
  events?: readonly string[];
  slots?: readonly string[];
}

/**
 * Вход проекции — уже собранная строка read-model плюс её `definition_meta`. Второго прохода
 * по БД быть не должно: `libraryCatalog()` собирает всё через `assemble(db)` в одной
 * транзакции, и повторные `activeCatalogRows` + `JSON.parse` ударили бы по горячему
 * read-model (перф-гейт `npm run perf:library`).
 */
export interface CatalogRevisionSource {
  kind: string;
  designSystem: string;
  id: string;
  version: number;
  description?: string;
  atomicLevel?: string;
  scope?: string;
  canonicalFor?: readonly string[];
  replacement?: string;
  meta: CatalogRevisionSourceMeta;
}

export interface CatalogRevisionRow {
  kind: string;
  designSystem: string;
  id: string;
  version: number;
  metaHash: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const inline = (value: unknown): string => JSON.stringify(value) ?? "null";

const MAX_SHAPE_DEPTH = 3;

/**
 * Форма пропа: примитив, enum/const или массив. Всё, что глубже допустимого или незнакомо,
 * схлопывается в `unknown` — сигнатура фиксирует **состав и форму** пропов, а не схему
 * целиком: иначе ревизия дёргалась бы от косметической правки описания в zod.
 */
function shapeOf(schema: unknown, depth = 0): string {
  if (!isObject(schema)) return "unknown";
  if (Array.isArray(schema.enum)) return `enum(${schema.enum.map(inline).sort().join("|")})`;
  if (Object.hasOwn(schema, "const")) return `const(${inline(schema.const)})`;
  const type = typeof schema.type === "string" ? schema.type : null;
  if (type === "array") return depth < MAX_SHAPE_DEPTH ? `array<${shapeOf(schema.items, depth + 1)}>` : "array";
  return type ?? "unknown";
}

type PropSignature = { name: string; required: boolean; shape: string };

/** `null` — схемы нет или её корень не объект со свойствами (сигнатура неприменима). */
function propsSignature(schema: unknown): PropSignature[] | null {
  if (!isObject(schema) || !isObject(schema.properties)) return null;
  const properties = schema.properties;
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : []);
  return Object.keys(properties).sort().map((name) => ({ name, required: required.has(name), shape: shapeOf(properties[name]) }));
}

const ioSignature = (meta: CatalogRevisionSourceMeta): { events: string[]; slots: string[] } => ({
  events: [...(meta.events ?? [])].sort(),
  slots: [...(meta.slots ?? [])].sort(),
});

function metaHash(row: CatalogRevisionSource): string {
  const projection = {
    description: row.description ?? "",
    atomicLevel: row.atomicLevel ?? null,
    scope: row.scope ?? null,
    canonicalFor: [...(row.canonicalFor ?? [])],
    replacement: row.replacement ?? null,
    propsSignature: propsSignature(row.meta.propsJsonSchema),
    ioSignature: ioSignature(row.meta),
  };
  return new Bun.CryptoHasher("sha256").update(canonicalStringify(projection)).digest("hex");
}

/** Чистая проекция уже собранных строк — без обращений к БД и без spread входной строки. */
export function catalogRevisionRows(rows: readonly CatalogRevisionSource[]): CatalogRevisionRow[] {
  return rows.map((row) => ({
    kind: row.kind,
    designSystem: row.designSystem,
    id: row.id,
    version: row.version,
    metaHash: metaHash(row),
  }));
}

export function catalogRevision(rows: readonly CatalogRevisionSource[]): string {
  const sorted = catalogRevisionRows(rows)
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.designSystem.localeCompare(b.designSystem) || a.id.localeCompare(b.id));
  return new Bun.CryptoHasher("sha256").update(canonicalStringify(sorted)).digest("hex");
}
