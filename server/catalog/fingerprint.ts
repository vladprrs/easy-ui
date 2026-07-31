/**
 * Отпечатки каталога (план 2026-07-31 §3.2, спека §3) — **чистые функции**: ноль обращений
 * к БД, ноль HTTP, ноль чтения env. Всё, что здесь считается, обязано быть детерминированным
 * и воспроизводимым задним числом: на этих значениях стоит решение «создавать компонент или
 * переиспользовать», которое пишется в append-only аудит.
 *
 * Сигнатуры намеренно **структурные**: имена/формы, но не значения. Ни `default`, ни
 * `description`/`title`, ни литералы исходника сюда не попадают — иначе переформулировка
 * описания или смена дефолта «чинила» бы дубликат.
 */

import ts from "typescript";
import { canonicalStringify } from "../../src/capture/canonicalJson";

/** Длина шингла нормализованного исходника (спека §3: token-shingles). */
export const SHINGLE_SIZE = 5;

// ────────────────────────────────── props ──────────────────────────────────

/** Форма одного свойства: имя + required + примитив/enum-форма. Значения не хранятся. */
export interface PropSignature {
  name: string;
  required: boolean;
  /** Нормализованная форма типа: `string`, `enum:a|b`, `array<object>`, `union:number|string`, … */
  shape: string;
}

export interface PropsSignature {
  properties: PropSignature[];
  /** Политика дополнительных свойств: `open` (по умолчанию), `closed` или `schema`. */
  additionalProperties: "open" | "closed" | "schema";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Форма подсхемы одной строкой. Рекурсия ограничена глубиной: JSON Schema от zod бывает
 * с `$defs`/`$ref`, и бесконечный спуск по циклической ссылке недопустим в синхронном
 * блоке транзакции. Всё, что не распозналось, схлопывается в `unknown` — сигнал деградирует
 * в «одинаково непонятно», а не врёт.
 */
function shapeOf(schema: unknown, depth = 0): string {
  if (!isRecord(schema)) return "unknown";
  if (depth >= 4) return "deep";
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.map((value) => (typeof value === "string" ? value : JSON.stringify(value)));
    return `enum:${[...new Set(values)].sort().join("|")}`;
  }
  if ("const" in schema) return `enum:${typeof schema.const === "string" ? schema.const : JSON.stringify(schema.const)}`;
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      const shapes = [...new Set(branches.map((branch) => shapeOf(branch, depth + 1)))].sort();
      return `${key === "allOf" ? "all" : "union"}:${shapes.join("|")}`;
    }
  }
  if (typeof schema.$ref === "string") return "ref";
  const type = schema.type;
  if (Array.isArray(type)) return `union:${[...new Set(type.map(String))].sort().join("|")}`;
  if (type === "array") return `array<${shapeOf(schema.items, depth + 1)}>`;
  if (type === "object") {
    const properties = isRecord(schema.properties) ? Object.keys(schema.properties).sort() : [];
    return properties.length > 0 ? `object{${properties.join(",")}}` : "object";
  }
  return typeof type === "string" ? type : "unknown";
}

/**
 * Сигнатура props из JSON Schema (`definition_meta.propsJsonSchema`).
 * `undefined`/не-объект даёт `undefined` — это «сигнал не объявлен», а не «сигнал пуст»:
 * различие критично для инварианта неприменимого сигнала в матчере.
 */
export function propsSignature(schema: unknown): PropsSignature | undefined {
  if (!isRecord(schema)) return undefined;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : []);
  const additional = schema.additionalProperties;
  return {
    properties: Object.keys(properties).sort().map((name) => ({ name, required: required.has(name), shape: shapeOf(properties[name]) })),
    additionalProperties: additional === false ? "closed" : additional === true || additional === undefined ? "open" : "schema",
  };
}

// ─────────────────────────────────── io ────────────────────────────────────

export interface IoSignature { events: string[]; slots: string[] }

/** Отсортированные уникальные события и именованные слоты. */
export function ioSignature(events: readonly string[] | undefined, slots: readonly string[] | undefined): IoSignature {
  const normalize = (values: readonly string[] | undefined): string[] =>
    [...new Set((values ?? []).filter((value): value is string => typeof value === "string" && value.length > 0))].sort();
  return { events: normalize(events), slots: normalize(slots) };
}

// ───────────────────────────────── source ──────────────────────────────────

/**
 * Нормализация TSX через AST `typescript` (тот же пакет, что уже используется в
 * `server/components/pipeline.ts` для `materializeClientSource`), а не через регулярки:
 * различить «локальный идентификатор» и «имя пропа/JSX-тега» лексически невозможно, а именно
 * это различие и делает сигнал устойчивым к переименованиям.
 *
 * Что выбрасывается: комментарии, пробелы, значения литералов, имена локальных биндингов
 * (переменные, параметры, деструктуризация, импортированные имена, функции/классы).
 * Что сохраняется: пунктуация и ключевые слова (каркас кода), имена JSX-тегов и JSX-атрибутов,
 * имена свойств объектов и обращений `.foo` — то есть публичная форма компонента.
 *
 * `ts.createSourceFile` не бросает на синтаксической ошибке (восстанавливается сам), поэтому
 * функция безопасна и на драфтовом/битом исходнике: в худшем случае вернёт мало шинглов.
 */
export function normalizedSourceTokens(source: string): string[] {
  const file = ts.createSourceFile("component.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const locals = collectLocalNames(file);
  const tokens: string[] = [];
  emitTokens(file, file, locals, tokens);
  return tokens;
}

/** Имена, объявленные в самом файле: любое их вхождение нормализуется в `_`. */
function collectLocalNames(file: ts.SourceFile): Set<string> {
  const locals = new Set<string>();
  const add = (name: ts.Node | undefined): void => {
    if (name === undefined) return;
    if (ts.isIdentifier(name)) locals.add(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) for (const element of name.elements) if (ts.isBindingElement(element)) add(element.name);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) || ts.isBindingElement(node) || ts.isParameter(node)) add(node.name);
    else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) add(node.name);
    else if (ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node)) add(node.name);
    else if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeParameterDeclaration(node)) add(node.name);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return locals;
}

/** Позиции, где идентификатор — это **имя** (пропа, тега, свойства), а не ссылка на биндинг. */
function isNamePosition(node: ts.Node): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (parent === undefined) return false;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
  if (ts.isQualifiedName(parent)) return parent.right === node;
  if (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodSignature(parent)) return parent.name === node;
  if (ts.isShorthandPropertyAssignment(parent)) return parent.name === node;
  if (ts.isJsxAttribute(parent)) return parent.name === node;
  if (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent)) return parent.tagName === node;
  if (ts.isBindingElement(parent)) return parent.propertyName === node;
  return false;
}

const LITERAL_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NumericLiteral, ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.RegularExpressionLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail,
]);

function emitTokens(node: ts.Node, file: ts.SourceFile, locals: ReadonlySet<string>, out: string[]): void {
  const children = node.getChildren(file);
  if (children.length > 0) { for (const child of children) emitTokens(child, file, locals, out); return; }
  const kind = node.kind;
  if (kind === ts.SyntaxKind.EndOfFileToken) return;
  if (kind === ts.SyntaxKind.JsxText) { if (node.getText(file).trim().length > 0) out.push("#txt"); return; }
  if (LITERAL_KINDS.has(kind)) { out.push("#lit"); return; }
  if (kind === ts.SyntaxKind.Identifier || kind === ts.SyntaxKind.PrivateIdentifier) {
    const text = (node as ts.Identifier).text;
    out.push(isNamePosition(node) ? text : locals.has(text) ? "_" : text);
    return;
  }
  const text = ts.tokenToString(kind);
  if (text !== undefined) out.push(text);
}

/**
 * k-шинглы нормализованных токенов (k=5). Сравнение — Jaccard по множествам (см. матчер).
 * Короткий исходник (< k токенов) даёт один шингл из всего, что есть, иначе крошечные
 * компоненты вообще выпадали бы из сигнала.
 */
export function sourceShingles(source: string, size = SHINGLE_SIZE): Set<string> {
  const tokens = normalizedSourceTokens(source);
  const shingles = new Set<string>();
  if (tokens.length === 0) return shingles;
  if (tokens.length <= size) { shingles.add(tokens.join("")); return shingles; }
  for (let index = 0; index + size <= tokens.length; index += 1) shingles.add(tokens.slice(index, index + size).join(""));
  return shingles;
}

// ──────────────────────────── structural fingerprint ────────────────────────

/** Мета, из которой считается структурный отпечаток (подмножество `DefinitionMeta`). */
export interface StructuralMeta {
  propsJsonSchema?: unknown;
  events?: readonly string[];
  slots?: readonly string[];
  atomicLevel?: string;
  scope?: string;
}

/**
 * sha256 канонического JSON `{props, io, atomicLevel, scope}` — единственный сигнал,
 * блокирующий **без порога**. `scope` сегодня пуст у всех прод-записей, то есть фактически
 * отпечаток опирается на `{props, io, atomicLevel}`; число коллизий на прод-дампе замеряет T0.
 *
 * `undefined` возвращается, если props не объявлены: без них отпечаток вырождается в
 * «одинаково пусто» и заблокировал бы любые два безпропсовых компонента.
 */
export function structuralFingerprint(meta: StructuralMeta): string | undefined {
  const props = propsSignature(meta.propsJsonSchema);
  if (props === undefined) return undefined;
  const io = ioSignature(meta.events, meta.slots);
  // Отпечаток блокирует **без порога**, поэтому он обязан на чём-то различать. Компонент без
  // единого пропа, события и слота не описан ничем, кроме атомарного уровня, и совпал бы с
  // любым другим таким же: калибровка (docs/audit/2026-07-31-matcher-calibration.md, замер 5)
  // нашла на проде ровно такую пару — `yp-no-pay-card-info ↔ yp-separator`. Пустая схема здесь
  // равнозначна отсутствующей: сигнал неприменим, решение остаётся за порогом.
  if (props.properties.length === 0 && io.events.length === 0 && io.slots.length === 0) return undefined;
  const payload = {
    props,
    io,
    atomicLevel: meta.atomicLevel ?? null,
    scope: meta.scope ?? null,
  };
  return new Bun.CryptoHasher("sha256").update(canonicalStringify(payload)).digest("hex");
}
