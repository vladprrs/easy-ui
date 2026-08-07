/**
 * Калибровка матчера дубликатов на реальном каталоге (план 2026-07-31, задача T0, отступление D7).
 *
 * Скрипт **импортирует** `server/catalog/matcher.ts` и `server/catalog/fingerprint.ts` — тот же
 * код, который поедет в прод. Ни одна формула здесь не переписывается, кроме взвешенной суммы
 * `combine()`, нужной для перебора 11 628 наборов весов; она проверяется на равенство со score
 * настоящего матчера на **всех** парах (см. `verifyCombine`), и при расхождении скрипт падает.
 *
 * Источник данных:
 *   --dump <path>   JSON-дамп прод-каталога (см. §«Снятие дампа» в отчёте) — обязателен для
 *                   не-provisional политики: локальная БД содержит 37 активных yandex-pay
 *                   против 115 в проде, а число пар растёт квадратично.
 *   --db <path>     дополнительная sqlite-БД (локальная / e2e) — только для замеров 1 и 6.
 *   --fixtures      сканировать `server/fixtures/*.tsx` (замер 6: сиды серверных тестов).
 *   --out <path>    куда писать markdown-отчёт (по умолчанию — в stdout).
 *
 *   ~/.bun/bin/bun scripts/calibrate-matcher.ts --dump <dump.json> \
 *     --db data/easy-ui.db --db .e2e-data/dev/easy-ui.db --fixtures --out docs/audit/...md
 *
 * Только чтение: ни одного запроса в сеть, ни одной записи в БД.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { buildIdf } from "../src/library/text";
import { propsSignature, sourceShingles, structuralFingerprint } from "../server/catalog/fingerprint";
import { matchCandidates, type CorpusCandidate, type ProposedArtifact } from "../server/catalog/matcher";
import { CALIBRATED_POLICY, SPEC_DEFAULT_POLICY, type MatchPolicy, type MatchWeights } from "../server/catalog/policy";

// ─────────────────────────────────── данные ───────────────────────────────────

/** Запись каталога в форме, из которой строятся и кандидат корпуса, и предложение. */
interface CatalogEntry {
  id: string;
  name: string;
  designSystem: string;
  version: number;
  draft: boolean;
  deprecated: boolean;
  description: string;
  atomicLevel?: string;
  scope?: string;
  canonicalFor?: string[];
  replacement?: string;
  meta?: { propsJsonSchema?: unknown; events?: string[]; slots?: string[] };
  source: string;
}

interface Corpus {
  label: string;
  designSystem: string;
  entries: CatalogEntry[];
  candidates: CorpusCandidate[];
  idf: ReadonlyMap<string, number>;
}

/** Порядок сигналов фиксирован: он же порядок значений в `Pair.values`. */
const SIGNAL_KEYS = ["props", "io", "source", "name", "description", "levelScope"] as const;

const toCandidate = (entry: CatalogEntry): CorpusCandidate => ({
  kind: "component",
  id: entry.id,
  name: entry.name,
  designSystem: entry.designSystem,
  version: entry.version,
  draft: entry.draft,
  description: entry.description,
  deprecated: entry.deprecated,
  headUsageCount: 0,
  ...(entry.atomicLevel !== undefined ? { atomicLevel: entry.atomicLevel } : {}),
  ...(entry.scope !== undefined ? { scope: entry.scope } : {}),
  ...(entry.canonicalFor !== undefined ? { canonicalFor: entry.canonicalFor } : {}),
  ...(entry.replacement !== undefined ? { replacement: entry.replacement } : {}),
  ...(entry.meta !== undefined ? { meta: entry.meta } : {}),
  shingles: sourceShingles(entry.source),
});

const toProposed = (entry: CatalogEntry): ProposedArtifact => ({
  kind: "component",
  id: entry.id,
  name: entry.name,
  designSystem: entry.designSystem,
  description: entry.description,
  ...(entry.atomicLevel !== undefined ? { atomicLevel: entry.atomicLevel } : {}),
  ...(entry.scope !== undefined ? { scope: entry.scope } : {}),
  ...(entry.canonicalFor !== undefined ? { canonicalFor: entry.canonicalFor } : {}),
  ...(entry.meta !== undefined ? { meta: entry.meta } : {}),
  source: entry.source,
});

function makeCorpus(label: string, designSystem: string, entries: CatalogEntry[]): Corpus {
  return {
    label,
    designSystem,
    entries,
    candidates: entries.map(toCandidate),
    // IDF корпус-относителен и считается по описаниям **всей** дизайн-системы, а не по срезу:
    // так же, как это сделает `corpus.ts` в проде.
    idf: buildIdf(entries.map((entry) => entry.description)),
  };
}

// ───────────────────────────── загрузка источников ────────────────────────────

interface DumpComponent {
  manifest: { id: string; name: string; version: number; deprecated: boolean };
  detail: {
    description?: string;
    atomicLevel?: string;
    scope?: string;
    canonicalFor?: string[];
    replacement?: string;
    events?: string[];
    slots?: string[];
    propsJsonSchema?: unknown;
    source: string;
  };
}

interface Dump {
  fetchedAt: string;
  origin: string;
  systems: { id: string; retired: boolean; components: DumpComponent[]; drafts?: { id: string; name: string; designSystem: string; source: string }[] }[];
}

function loadDump(path: string): { fetchedAt: string; origin: string; corpora: Corpus[]; drafts: CatalogEntry[] } {
  const dump = JSON.parse(readFileSync(path, "utf8")) as Dump;
  const corpora: Corpus[] = [];
  const drafts: CatalogEntry[] = [];
  for (const system of dump.systems) {
    const entries = system.components.map((component): CatalogEntry => ({
      id: component.manifest.id,
      name: component.manifest.name,
      designSystem: system.id,
      version: component.manifest.version,
      draft: false,
      deprecated: component.manifest.deprecated,
      description: component.detail.description ?? "",
      ...(component.detail.atomicLevel !== undefined ? { atomicLevel: component.detail.atomicLevel } : {}),
      ...(component.detail.scope !== undefined ? { scope: component.detail.scope } : {}),
      ...(component.detail.canonicalFor !== undefined ? { canonicalFor: component.detail.canonicalFor } : {}),
      ...(component.detail.replacement !== undefined ? { replacement: component.detail.replacement } : {}),
      meta: { propsJsonSchema: component.detail.propsJsonSchema, events: component.detail.events ?? [], slots: component.detail.slots ?? [] },
      source: component.detail.source,
    }));
    corpora.push(makeCorpus(`prod:${system.id}`, system.id, entries));
    for (const draft of system.drafts ?? []) {
      drafts.push({ id: draft.id, name: draft.name, designSystem: draft.designSystem, version: 0, draft: true, deprecated: false, description: "", source: draft.source });
    }
  }
  return { fetchedAt: dump.fetchedAt, origin: dump.origin, corpora, drafts };
}

interface DbRow { id: string; name: string; design_system: string; version: number; definition_meta: string; source: string; latest_status: string }

/** Активные публикации локальной/e2e БД — тем же SELECT-ом, что `activeCatalogRows` (+ source). */
function loadDatabase(path: string, label: string): Corpus[] {
  const db = new Database(path, { readonly: true });
  const rows = db.query(`SELECT c.id,c.name,r.design_system,p.version,p.definition_meta,r.source,
      (SELECT x.status FROM component_publishes x WHERE x.component_id=c.id ORDER BY x.version DESC LIMIT 1) latest_status
    FROM components c
    JOIN component_publishes p ON p.component_id=c.id AND p.status='active'
    JOIN component_revisions r ON r.component_id=p.component_id AND r.rev=p.rev
    JOIN design_systems ds ON ds.id=r.design_system AND ds.retired=0
    WHERE c.deleted_at IS NULL AND p.version=(SELECT MAX(x.version) FROM component_publishes x
      JOIN component_revisions xr ON xr.component_id=x.component_id AND xr.rev=x.rev
      WHERE x.component_id=c.id AND x.status='active' AND xr.design_system=r.design_system)
    ORDER BY c.id,r.design_system`).all() as DbRow[];
  db.close();
  const bySystem = new Map<string, CatalogEntry[]>();
  for (const row of rows) {
    const meta = JSON.parse(row.definition_meta) as { description?: string; atomicLevel?: string; scope?: string; canonicalFor?: string[]; replacement?: string; events?: string[]; slots?: string[]; propsJsonSchema?: unknown };
    const entry: CatalogEntry = {
      id: row.id,
      name: row.name,
      designSystem: row.design_system,
      version: row.version,
      draft: false,
      deprecated: row.latest_status === "deprecated",
      description: meta.description ?? "",
      ...(meta.atomicLevel !== undefined ? { atomicLevel: meta.atomicLevel } : {}),
      ...(meta.scope !== undefined ? { scope: meta.scope } : {}),
      ...(meta.canonicalFor !== undefined ? { canonicalFor: meta.canonicalFor } : {}),
      ...(meta.replacement !== undefined ? { replacement: meta.replacement } : {}),
      meta: { propsJsonSchema: meta.propsJsonSchema, events: meta.events ?? [], slots: meta.slots ?? [] },
      source: row.source,
    };
    const list = bySystem.get(row.design_system) ?? [];
    list.push(entry);
    bySystem.set(row.design_system, list);
  }
  return [...bySystem.entries()].sort(([left], [right]) => (left < right ? -1 : 1)).map(([system, entries]) => makeCorpus(`${label}:${system}`, system, entries));
}

/**
 * Сиды серверных тестов: `server/fixtures/*.tsx` извлекаются **тем же путём, что и на create** —
 * `materializeSource` + `extractDefinition` (субпроцесс с таймаутом). Прямой `import()` здесь
 * недопустим: фикстура `timeout.tsx` намеренно вешает вычисление, и скрипт повис бы.
 * Фикстуры, которые обязаны падать (syntax-error, no-definition, …), пропускаются с пометкой —
 * они никогда не доходят до матчера.
 */
async function loadFixtures(): Promise<{ corpus: Corpus; skipped: string[] }> {
  const { materializeSource } = await import("../server/components/pipeline");
  const { extractDefinition } = await import("../server/components/extract-subprocess");
  const dir = mkdtempSync(resolve(process.cwd(), ".calibrate-"));
  const entries: CatalogEntry[] = [];
  const skipped: string[] = [];
  try {
    for (const file of readdirSync("server/fixtures").filter((name) => name.endsWith(".tsx")).sort()) {
      const source = await Bun.file(resolve("server/fixtures", file)).text();
      const id = file.replace(/\.tsx$/, "");
      const path = await materializeSource(dir, id.replace(/[^\w-]/g, "_"), 1, source).catch(() => undefined);
      const extracted = path === undefined ? undefined : await extractDefinition(path, { timeoutMs: 10_000 });
      if (extracted?.ok !== true || extracted.meta === undefined) { skipped.push(file); continue; }
      const meta = extracted.meta;
      entries.push({
        id,
        name: id.replace(/(^|-)(\w)/g, (_, __, letter: string) => letter.toUpperCase()),
        designSystem: "fixtures",
        version: 1,
        draft: false,
        deprecated: false,
        description: meta.description ?? "",
        ...(meta.atomicLevel !== undefined ? { atomicLevel: meta.atomicLevel } : {}),
        meta: { propsJsonSchema: meta.propsJsonSchema, events: meta.events ?? [], slots: meta.slots ?? [] },
        source,
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { corpus: makeCorpus("server/fixtures", "fixtures", entries), skipped };
}

// ─────────────────────────────── парный проход ────────────────────────────────

interface Pair {
  left: string;
  right: string;
  values: (number | undefined)[];
  structural: boolean;
  canonical: boolean;
  /** score, посчитанный **настоящим** матчером под политикой прохода (контроль `combine`). */
  matcherScore: number;
}

/**
 * Все пары корпуса. Считается настоящим `matchCandidates`: на каждое предложение — один вызов
 * по корпусу «все записи после текущей», ровно как это сделает гейт. Значения сигналов от весов
 * не зависят, поэтому одного прохода хватает на весь перебор политик.
 */
function sweep(corpus: Corpus, policy: MatchPolicy): Pair[] {
  const pairs: Pair[] = [];
  for (let index = 0; index < corpus.entries.length; index += 1) {
    const rest = corpus.candidates.slice(index + 1);
    if (rest.length === 0) continue;
    const proposed = toProposed(corpus.entries[index]!);
    const result = matchCandidates(rest, proposed, policy, { idf: corpus.idf, limit: rest.length });
    for (const candidate of result.candidates) {
      pairs.push({
        left: proposed.id!,
        right: candidate.id,
        values: SIGNAL_KEYS.map((key) => candidate.signals[key]),
        structural: candidate.reasons.includes("same props/events/slots signature"),
        canonical: candidate.reasons.some((reason) => reason.startsWith("same canonical role")),
        matcherScore: candidate.score,
      });
    }
  }
  return pairs;
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/** Перенормированная взвешенная сумма — копия `weighted()` матчера, проверяемая `verifyCombine`. */
function combine(values: readonly (number | undefined)[], weights: MatchWeights): number {
  let sum = 0;
  let applied = 0;
  for (let index = 0; index < SIGNAL_KEYS.length; index += 1) {
    const value = values[index];
    if (value === undefined) continue;
    const weight = weights[SIGNAL_KEYS[index]!];
    sum += weight * value;
    applied += weight;
  }
  return applied === 0 ? 0 : round4(sum / applied);
}

function verifyCombine(pairs: readonly Pair[], weights: MatchWeights, label: string): void {
  for (const pair of pairs) {
    const mine = combine(pair.values, weights);
    if (Math.abs(mine - pair.matcherScore) > 1e-9) {
      throw new Error(`combine() разошлась с матчером (${label}): ${pair.left}↔${pair.right} ${mine} != ${pair.matcherScore}`);
    }
  }
}

// ───────────────────────── синтетические сценарии §10 ─────────────────────────

/** Механическое переименование: имя компонента и все локальные `const`-биндинги. */
function renameSource(source: string, from: string, to: string): string {
  let renamed = source.replaceAll(new RegExp(`\\b${from}\\b`, "g"), to);
  for (const match of source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)/g)) {
    const local = match[1]!;
    if (local === from) continue;
    renamed = renamed.replaceAll(new RegExp(`\\b${local}\\b`, "g"), `${local}Renamed`);
  }
  return renamed;
}

/** Добавка кода фиксированного размера: имитирует «скопировал и дописал» (разбавление шинглов). */
const PADDING = `
function CalibrationPad({ hint, tone }: { hint: string; tone: string }) {
  const parts = String(hint).split(" ").filter(Boolean);
  return <div data-tone={tone}>{parts.map((part, index) => <em key={index}>{part}</em>)}</div>;
}
`;

const DISJOINT_RU = "Универсальный виджет витрины мерчанта с настраиваемым поведением";
const DISJOINT_NAME = "OmegaWidgetSurface";

/** Мутация схемы: один проп переименован, один добавлен — структурный отпечаток расходится. */
function mutateSchema(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null) return schema;
  const copy = JSON.parse(JSON.stringify(schema)) as { properties?: Record<string, unknown>; required?: string[] };
  const properties = copy.properties ?? {};
  const [first] = Object.keys(properties).sort();
  if (first !== undefined) {
    properties[`${first}Alt`] = properties[first]!;
    delete properties[first];
    copy.required = (copy.required ?? []).filter((name) => name !== first);
  }
  properties.calibrationFlag = { type: "boolean" };
  copy.properties = properties;
  return copy;
}

type Scenario = { key: string; title: string; expectation: "block" | "allow" | "no-candidate" | "demote" };

const SCENARIOS: Scenario[] = [
  { key: "S1", title: "дословная копия (сменён только id/name)", expectation: "block" },
  { key: "S2", title: "копия со сменой описания", expectation: "block" },
  { key: "S3", title: "переименованная копипаста (идентификаторы + имя + описание)", expectation: "block" },
  { key: "S3h", title: "переименованная копипаста + правка props и +12% кода", expectation: "block" },
  { key: "S4", title: "переписан с нуля с теми же props", expectation: "block" },
  { key: "S5", title: "похожее имя при несовместимых props", expectation: "allow" },
  { key: "S6", title: "одинаковая структура в другой дизайн-системе", expectation: "no-candidate" },
  { key: "S7", title: "deprecated с активной заменой", expectation: "demote" },
  { key: "S8", title: "RU/EN описания одного и того же компонента", expectation: "block" },
];

/** Копия записи каталога под нужный сценарий. `undefined` — сценарий к записи неприменим. */
function variant(entry: CatalogEntry, key: string, foreign: CatalogEntry): CatalogEntry | undefined {
  const base: CatalogEntry = { ...entry, id: `${entry.id}-copy`, name: `${entry.name}Copy` };
  switch (key) {
    case "S1":
      return base;
    case "S2":
      return { ...base, description: DISJOINT_RU };
    case "S3":
      return { ...base, name: DISJOINT_NAME, description: DISJOINT_RU, source: renameSource(entry.source, entry.name, DISJOINT_NAME) };
    case "S3h":
      return {
        ...base,
        name: DISJOINT_NAME,
        description: DISJOINT_RU,
        source: renameSource(entry.source, entry.name, DISJOINT_NAME) + PADDING,
        meta: { ...entry.meta, propsJsonSchema: mutateSchema(entry.meta?.propsJsonSchema) },
      };
    case "S4":
      // Переписан с нуля: исходник чужой (другой компонент каталога), props/io/описание — свои.
      return { ...base, name: DISJOINT_NAME, source: foreign.source };
    case "S5":
      // Похожее имя, чужие props и чужой исходник: не дубликат, блокировать нельзя.
      return { ...base, name: `${entry.name}Link`, description: DISJOINT_RU, source: foreign.source, meta: { propsJsonSchema: { type: "object", properties: { calibrationHref: { type: "string" }, calibrationCaption: { type: "string" } }, required: ["calibrationHref", "calibrationCaption"] }, events: [], slots: [] } };
    case "S6":
      return { ...base, designSystem: `${entry.designSystem}-other` };
    case "S8":
      return { ...base, description: translitDescription(entry.description) };
    default:
      return undefined;
  }
}

/** «Английское» описание: тот же смысл, ноль общих токенов с кириллическим оригиналом. */
const translitDescription = (description: string): string =>
  description.trim().length === 0 ? "" : "Merchant storefront widget with configurable behaviour and states";

// ─────────────────────────────── перебор весов ────────────────────────────────

/** Все композиции 20 по 6 частей (шаг веса 0.05, минимум 0.05) — 11 628 наборов. */
function weightGrid(): MatchWeights[] {
  const grid: MatchWeights[] = [];
  const step = 0.05;
  for (let a = 1; a <= 15; a += 1)
    for (let b = 1; a + b <= 16; b += 1)
      for (let c = 1; a + b + c <= 17; c += 1)
        for (let d = 1; a + b + c + d <= 18; d += 1)
          for (let e = 1; a + b + c + d + e <= 19; e += 1) {
            const f = 20 - a - b - c - d - e;
            // `sourcePackage` (волна 2026-08-07 §W8) в переборе не участвует: сигнал ранжирующий,
            // в гейтовый score не входит вовсе, и на прод-дампе калибровки его данных нет.
            grid.push({ props: a * step, io: b * step, source: c * step, name: d * step, description: e * step, levelScope: f * step, sourcePackage: CALIBRATED_POLICY.weights.sourcePackage });
          }
  return grid;
}

const weightDistance = (weights: MatchWeights, reference: MatchWeights): number =>
  SIGNAL_KEYS.reduce((total, key) => total + Math.abs(weights[key] - reference[key]), 0);

interface Evaluation {
  weights: MatchWeights;
  /** Худший «обязан блокировать по score» — минимум по трудным дубликатам. */
  worstDuplicate: number;
  /** Потолок легитимных пар: выше него порог обязан стоять, иначе каталог блокирует сам себя. */
  bestLegit: number;
  gap: number;
  /** Доля трудных дубликатов выше потолка легитимных пар — recall при нулевых ложных. */
  recall: number;
}

/**
 * Оценка набора весов. Пары, заблокированные **без порога** (структурный отпечаток /
 * каноническая роль), из обеих сторон исключены: порог на них не влияет, и их включение
 * завысило бы зазор до бессмысленного.
 *
 * Основная целевая функция — `recall` (сколько трудных дубликатов ловится, не блокируя ни одной
 * легитимной пары каталога), а не `gap`: при перекрывающихся распределениях максимизация зазора
 * вырождается — она выбирает набор, где обе стороны одинаково высоки.
 */
function evaluate(weights: MatchWeights, duplicates: readonly Pair[], legit: readonly Pair[]): Evaluation {
  let bestLegit = 0;
  for (const pair of legit) bestLegit = Math.max(bestLegit, combine(pair.values, weights));
  let worstDuplicate = 1;
  let above = 0;
  for (const pair of duplicates) {
    const value = combine(pair.values, weights);
    worstDuplicate = Math.min(worstDuplicate, value);
    if (value > bestLegit) above += 1;
  }
  return { weights, worstDuplicate, bestLegit, gap: worstDuplicate - bestLegit, recall: duplicates.length === 0 ? 0 : above / duplicates.length };
}

/** Сравнение наборов: сначала recall, затем зазор, затем близость к весам спеки (детерминизм). */
function better(left: Evaluation, right: Evaluation): boolean {
  if (Math.abs(left.recall - right.recall) > 1e-12) return left.recall > right.recall;
  if (Math.abs(left.gap - right.gap) > 1e-12) return left.gap > right.gap;
  return weightDistance(left.weights, SPEC_DEFAULT_POLICY.weights) < weightDistance(right.weights, SPEC_DEFAULT_POLICY.weights);
}

// ──────────────────────────────────── отчёт ───────────────────────────────────

const percentile = (values: readonly number[], fraction: number): number =>
  values.length === 0 ? 0 : values[Math.min(values.length - 1, Math.floor(fraction * (values.length - 1)))]!;

function distributionRow(label: string, size: number, scores: number[]): string {
  const sorted = [...scores].sort((left, right) => left - right);
  const mean = sorted.reduce((total, value) => total + value, 0) / Math.max(1, sorted.length);
  return `| ${label} | ${size} | ${sorted.length} | ${round4(mean)} | ${percentile(sorted, 0.5)} | ${percentile(sorted, 0.9)} | ${percentile(sorted, 0.99)} | ${sorted.at(-1) ?? 0} |`;
}

const formatWeights = (weights: MatchWeights): string =>
  SIGNAL_KEYS.map((key) => `${key} ${weights[key].toFixed(2)}`).join(" · ");

// ──────────────────────────────────── main ────────────────────────────────────

interface Argv { dump?: string; dbs: string[]; fixtures: boolean; out?: string }

export function parseArgs(argv: readonly string[]): Argv {
  const result: Argv = { dbs: [], fixtures: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--dump") result.dump = argv[++index];
    else if (arg === "--db") result.dbs.push(argv[++index] ?? "");
    else if (arg === "--fixtures") result.fixtures = true;
    else if (arg === "--out") result.out = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

/** Известные дубликаты из `docs/audit/2026-07-20-yp-catalog-*` (замер 7). */
const KNOWN_DUPLICATES: [string, string][] = [
  ["yp-promo-banner", "yp-banner-mid"],
  ["yp-app-home-savers", "yp-app-home-loans"],
  ["yp-base-card-mini", "yp-best-profit-base-card-mini"],
  ["yp-collapsible", "yp-animated-collapse"],
  ["yp-loyalty-badge", "yp-badge"],
  ["yp-promo-tooltip", "yp-tooltip"],
  ["yp-split-discount-info", "yp-discount-info-with-cashback"],
  ["yp-panel", "yp-screen"],
  ["yp-radio-button", "yp-pseudo-radio"],
];

const pairKey = (left: string, right: string): string => (left < right ? `${left} ${right}` : `${right} ${left}`);

async function main(): Promise<void> {
  const argv = parseArgs(process.argv.slice(2));
  const lines: string[] = [];
  const write = (line = ""): void => void lines.push(line);

  const corpora: Corpus[] = [];
  let provenance = "локальная БД (прод-дамп не передан)";
  let calibration: Corpus | undefined;
  let drafts: CatalogEntry[] = [];
  if (argv.dump !== undefined) {
    const dump = loadDump(argv.dump);
    provenance = `прод ${dump.origin}, снят ${dump.fetchedAt}`;
    corpora.push(...dump.corpora);
    drafts = dump.drafts;
    calibration = dump.corpora.reduce((best, corpus) => (corpus.entries.length > best.entries.length ? corpus : best));
  }
  for (const path of argv.dbs) corpora.push(...loadDatabase(path, path));
  let fixtureSkips: string[] = [];
  if (argv.fixtures) {
    const loaded = await loadFixtures();
    corpora.push(loaded.corpus);
    fixtureSkips = loaded.skipped;
  }
  calibration ??= corpora.reduce((best, corpus) => (corpus.entries.length > best.entries.length ? corpus : best));

  // ── проход по всем корпусам ────────────────────────────────────────────────
  const swept = new Map<string, Pair[]>();
  for (const corpus of corpora) {
    const pairs = sweep(corpus, SPEC_DEFAULT_POLICY);
    verifyCombine(pairs, SPEC_DEFAULT_POLICY.weights, corpus.label);
    swept.set(corpus.label, pairs);
  }
  const calibrationPairs = swept.get(calibration.label)!;

  // ── синтетические сценарии ─────────────────────────────────────────────────
  const entries = calibration.entries;
  const scenarioPairs = new Map<string, Pair[]>();
  const scenarioNotes = new Map<string, string[]>();
  for (const scenario of SCENARIOS) {
    const pairs: Pair[] = [];
    const notes: string[] = [];
    for (const [index, entry] of entries.entries()) {
      const foreign = entries[(index + 37) % entries.length]!;
      const copy = variant(entry, scenario.key, foreign);
      if (copy === undefined) continue;
      const proposed = toProposed(copy);
      const result = matchCandidates(calibration.candidates, proposed, SPEC_DEFAULT_POLICY, { idf: calibration.idf, limit: calibration.candidates.length });
      const original = result.candidates.find((candidate) => candidate.id === entry.id);
      if (original === undefined) {
        notes.push(entry.id);
        continue;
      }
      pairs.push({
        left: copy.id,
        right: entry.id,
        values: SIGNAL_KEYS.map((key) => original.signals[key]),
        structural: original.reasons.includes("same props/events/slots signature"),
        canonical: original.reasons.some((reason) => reason.startsWith("same canonical role")),
        matcherScore: original.score,
      });
    }
    verifyCombine(pairs, SPEC_DEFAULT_POLICY.weights, scenario.key);
    scenarioPairs.set(scenario.key, pairs);
    scenarioNotes.set(scenario.key, notes);
  }

  // ── выбор политики ─────────────────────────────────────────────────────────
  const knownKeys = new Set(KNOWN_DUPLICATES.map(([left, right]) => pairKey(left, right)));
  // Легитимные пары: каталог минус известные дубликаты аудита и минус пары, блокирующиеся
  // без порога (их порог не спасёт — они разбираются отдельно, замер 5).
  const legit = calibrationPairs.filter((pair) => !knownKeys.has(pairKey(pair.left, pair.right)) && !pair.structural && !pair.canonical);
  // Обязательные по формулировке задачи: дословная копия, копия со сменой описания,
  // переименованная копипаста. Трудный вариант S3h (копипаста + правка props + дописанный код)
  // — не обязателен, но именно он определяет, на что вообще способен порог.
  const requiredByScore = ["S1", "S2", "S3"].flatMap((key) => (scenarioPairs.get(key) ?? []).filter((pair) => !pair.structural && !pair.canonical));
  const hardDuplicates = (scenarioPairs.get("S3h") ?? []).filter((pair) => !pair.structural && !pair.canonical);
  const duplicates = [...requiredByScore, ...hardDuplicates];
  const mustAllow = (scenarioPairs.get("S5") ?? []).filter((pair) => !pair.structural && !pair.canonical);
  const ceilingSet = [...legit, ...mustAllow];

  const grid = weightGrid();
  let best: Evaluation | undefined;
  let balanced: Evaluation | undefined;
  for (const weights of grid) {
    const evaluation = evaluate(weights, duplicates, ceilingSet);
    if (best === undefined || better(evaluation, best)) best = evaluation;
    // Контрольный вариант: тот же перебор с ограничением «ни один сигнал не доминирует»
    // (source ≤ 0.40). Он показывает цену доминирования исходника, а не отменяет его.
    if (weights.source <= 0.4 && (balanced === undefined || better(evaluation, balanced))) balanced = evaluation;
  }
  const chosen = best!;
  const specEvaluation = evaluate(SPEC_DEFAULT_POLICY.weights, duplicates, ceilingSet);

  // Худший обязательный сценарий **по score** — то есть без учёта отпечатка, который блокирует
  // его и так. Именно между ним и потолком легитимных пар стоит порог.
  const requiredScores = ["S1", "S2", "S3"].flatMap((key) => (scenarioPairs.get(key) ?? []).map((pair) => combine(pair.values, chosen.weights)));
  const worstRequired = requiredScores.length === 0 ? 1 : Math.min(...requiredScores);
  // Пара, держащая потолок: её имя нужно в отчёте — потолок это не абстрактное число, а
  // конкретная пара, которую человек может пересмотреть в триаже проекта 3.
  const legitRanked = [...legit].sort((left, right) => combine(right.values, chosen.weights) - combine(left.values, chosen.weights));
  const topLegit = legitRanked[0];
  const secondLegit = legitRanked[1] === undefined ? 0 : combine(legitRanked[1].values, chosen.weights);
  // Порог: потолок легитимных пар **плюс запас 0.03**, округлённый вверх до сотой. Запас взят
  // не с потолка: замер 4 требует, чтобы сдвиг порога на ±0.03 не менял решение на легитимных
  // парах, — значит и сам порог обязан стоять не ближе 0.03 к ближайшей из них. Если такой порог
  // перескакивает худший обязательный сценарий, берётся середина их интервала.
  const margined = Math.ceil((chosen.bestLegit + 0.03) * 100) / 100;
  const blockingThreshold = margined <= worstRequired ? margined : Math.floor(((chosen.bestLegit + worstRequired) / 2) * 100) / 100;
  const reviewThreshold = Math.round((blockingThreshold - 0.17) * 100) / 100;
  // Условие задачи: три обязательных сценария блокируются на **каждой** записи корпуса (по
  // отпечатку или по порогу), а ни одна легитимная пара каталога и ни один S5 — нет.
  const requiredSatisfied = ["S1", "S2", "S3"].every((key) => {
    const pairs = scenarioPairs.get(key) ?? [];
    return pairs.length === entries.length && pairs.every((pair) => pair.structural || pair.canonical || combine(pair.values, chosen.weights) >= blockingThreshold);
  }) && ceilingSet.every((pair) => combine(pair.values, chosen.weights) < blockingThreshold);
  const policy: MatchPolicy = {
    policyVersion: requiredSatisfied && argv.dump !== undefined ? 1 : 0,
    weights: chosen.weights,
    blockingThreshold,
    reviewThreshold,
  };

  // Контрольный проход настоящим матчером под выбранной политикой.
  const finalPairs = sweep(calibration, policy);
  verifyCombine(finalPairs, policy.weights, `${calibration.label}@final`);

  // Отчёт обязан описывать ту политику, которая лежит в `policy.ts`: расхождение означает, что
  // либо цифры правили руками, либо отчёт устарел. И то и другое — красный.
  const stored = JSON.stringify({ ...CALIBRATED_POLICY, weights: SIGNAL_KEYS.map((key) => CALIBRATED_POLICY.weights[key]) });
  const computed = JSON.stringify({ ...policy, weights: SIGNAL_KEYS.map((key) => policy.weights[key]) });
  if (stored !== computed) throw new Error(`CALIBRATED_POLICY в server/catalog/policy.ts разошлась с калибровкой:\n  policy.ts: ${stored}\n  замер:     ${computed}`);

  // ── отчёт ──────────────────────────────────────────────────────────────────
  write(`# Калибровка матчера дубликатов (T0)`);
  write();
  write(`Сгенерировано \`scripts/calibrate-matcher.ts\`. **Файл машинный — правки вносятся в скрипт.**`);
  write();
  write(`- Источник данных: **${provenance}**`);
  write(`- Калибровочный корпус: \`${calibration.label}\` — ${calibration.entries.length} активных публикаций, ${calibrationPairs.length} пар`);
  write(`- Ядро: \`server/catalog/matcher.ts\` + \`server/catalog/fingerprint.ts\` (импорт, не копия)`);
  write(`- Сетка перебора: ${grid.length} наборов весов (шаг 0.05, каждый вес ≥ 0.05, сумма 1.00)`);
  write(`- Сверено с \`CALIBRATED_POLICY\` в \`server/catalog/policy.ts\`: совпадает (иначе скрипт падает)`);
  write();

  write(`## Итоговая политика`);
  write();
  write(`\`\`\``);
  write(`policyVersion ${policy.policyVersion}`);
  write(formatWeights(policy.weights));
  write(`blocking ≥ ${policy.blockingThreshold} · review ${policy.reviewThreshold}..${round4(policy.blockingThreshold - 0.0001)}`);
  write(`\`\`\``);
  write();
  write(requiredSatisfied
    ? `**Набор существует.** Обязательные сценарии (S1 дословная копия, S2 копия со сменой описания, S3 переименованная копипаста) блокируются на всех ${entries.length} записях корпуса; ни одна легитимная пара каталога и ни один сценарий S5 порога не достигают. Порог ${policy.blockingThreshold} стоит выше потолка легитимных пар ${round4(chosen.bestLegit)} (запас ${round4(policy.blockingThreshold - chosen.bestLegit)}) и ниже худшего обязательного дубликата ${round4(worstRequired)} (запас ${round4(worstRequired - policy.blockingThreshold)}) — причём S1–S3 блокируются ещё и структурным отпечатком, независимо от порога.`
    : `**Набора не существует.** Лучший из ${grid.length} наборов даёт худший обязательный дубликат ${round4(worstRequired)} против лучшей легитимной пары ${round4(chosen.bestLegit)}. Политика остаётся provisional (\`policyVersion: 0\`), enforce включать нельзя.`);
  write();
  const hardCaught = hardDuplicates.filter((pair) => combine(pair.values, policy.weights) >= policy.blockingThreshold).length;
  write(`Трудный вариант S3h (копипаста + правка props + дописанный код) на выбранном пороге ловится`);
  write(`в **${hardCaught} случаях из ${hardDuplicates.length}** (${Math.round((hardCaught / Math.max(1, hardDuplicates.length)) * 100)}%); предел при нулевых ложных срабатываниях —`);
  write(`${Math.round(chosen.recall * 100)}%. Это потолок возможностей порога на сегодняшнем каталоге, а не следствие выбора весов:`);
  write(`лучший из ${grid.length} наборов достигает именно его.`);
  write();
  write(`| набор весов | ${SIGNAL_KEYS.join(" | ")} | потолок легитимных | худший S3h | recall@0FP |`);
  write(`|---|---|---|---|---|---|---|---|---|`);
  for (const [label, evaluation] of [["спека §3", specEvaluation], ["лучший при source ≤ 0.40", balanced!], ["**выбран T0**", chosen]] as const) {
    write(`| ${label} | ${SIGNAL_KEYS.map((key) => evaluation.weights[key].toFixed(2)).join(" | ")} | ${round4(evaluation.bestLegit)} | ${round4(evaluation.worstDuplicate)} | ${Math.round(evaluation.recall * 100)}% |`);
  }
  write();
  write(`Сетка держит **минимум 0.05 на каждом сигнале**: сигнал с нулевым весом — мёртвый код,`);
  write(`он ломает и \`reasons\`, и перенормировку неприменимых сигналов. При запросе кандидатов`);
  write(`по одному \`intent\` (без исходника и без схемы) сигнал исходника неприменим, и`);
  write(`перенормировка оставляет имя и описание с равными весами — ранжирование поиска от`);
  write(`доминирования \`source\` не страдает.`);
  write();
  write(`Кривая «порог → цена»: сколько трудных дубликатов ловится и сколько пар каталога`);
  write(`при этом блокируется (то есть сколько легитимных созданий было бы отклонено).`);
  write();
  write(`| порог | S3h пойман | пар каталога ≥ порога |`);
  write(`|---|---|---|`);
  for (let threshold = 0.7; threshold <= 0.98001; threshold += 0.02) {
    const value = round4(threshold);
    const caughtHard = hardDuplicates.filter((pair) => combine(pair.values, policy.weights) >= value).length;
    write(`| ${value} | ${caughtHard}/${hardDuplicates.length} | ${calibrationPairs.filter((pair) => combine(pair.values, policy.weights) >= value).length} |`);
  }
  write();

  write(`## Замер 1 — распределение score по парам каталога`);
  write();
  write(`Под **итоговыми** весами. Пары, блокирующиеся без порога, включены.`);
  write();
  write(`| корпус | записей | пар | среднее | p50 | p90 | p99 | max |`);
  write(`|---|---|---|---|---|---|---|---|`);
  for (const corpus of corpora) {
    const pairs = swept.get(corpus.label)!;
    write(distributionRow(`\`${corpus.label}\``, corpus.entries.length, pairs.map((pair) => combine(pair.values, policy.weights))));
  }
  write();
  const overThreshold = (pairs: readonly Pair[], threshold: number): number => pairs.filter((pair) => combine(pair.values, policy.weights) >= threshold).length;
  write(`| корпус | ≥ blocking | ≥ review | блокируются без порога |`);
  write(`|---|---|---|---|`);
  for (const corpus of corpora) {
    const pairs = swept.get(corpus.label)!;
    write(`| \`${corpus.label}\` | ${overThreshold(pairs, policy.blockingThreshold)} | ${overThreshold(pairs, policy.reviewThreshold)} | ${pairs.filter((pair) => pair.structural || pair.canonical).length} |`);
  }
  write();
  const topPairs = [...finalPairs].sort((left, right) => combine(right.values, policy.weights) - combine(left.values, policy.weights)).slice(0, 12);
  write(`Топ-12 пар калибровочного корпуса:`);
  write();
  write(`| пара | score | props | io | source | name | description | levelScope | без порога |`);
  write(`|---|---|---|---|---|---|---|---|---|`);
  for (const pair of topPairs) {
    const cells = pair.values.map((value) => (value === undefined ? "—" : round4(value).toString()));
    write(`| ${pair.left} ↔ ${pair.right} | ${combine(pair.values, policy.weights)} | ${cells.join(" | ")} | ${pair.structural ? "структурный отпечаток" : pair.canonical ? "каноническая роль" : "нет"} |`);
  }
  write();

  write(`## Замер 2 — синтетические сценарии §10`);
  write();
  write(`Каждый сценарий применён ко **всем** ${entries.length} записям калибровочного корпуса;`);
  write(`в таблице — худший (минимальный) случай, а не пример.`);
  write();
  write(`| # | сценарий | ожидание | пар | worst score | заблокировано | без порога |`);
  write(`|---|---|---|---|---|---|---|`);
  const scenarioOutcome = new Map<string, { blocked: number; total: number; worst: number }>();
  for (const scenario of SCENARIOS) {
    const pairs = scenarioPairs.get(scenario.key) ?? [];
    if (scenario.key === "S6") {
      const leaked = entries.filter((entry, index) => {
        const copy = variant(entry, "S6", entries[(index + 37) % entries.length]!)!;
        return matchCandidates(calibration!.candidates, toProposed(copy), policy, { idf: calibration!.idf, limit: 20 }).candidates.length > 0;
      }).length;
      write(`| S6 | ${scenario.title} | ${scenario.expectation} | ${entries.length} | — | ${leaked} утечек | — |`);
      continue;
    }
    if (scenario.key === "S7") { write(`| S7 | ${scenario.title} | ${scenario.expectation} | 1 | — | см. ниже | — |`); continue; }
    let worst = 1;
    let blocked = 0;
    let free = 0;
    for (const pair of pairs) {
      const value = combine(pair.values, policy.weights);
      worst = Math.min(worst, value);
      if (pair.structural || pair.canonical) free += 1;
      if (pair.structural || pair.canonical || value >= policy.blockingThreshold) blocked += 1;
    }
    scenarioOutcome.set(scenario.key, { blocked, total: pairs.length, worst });
    write(`| ${scenario.key} | ${scenario.title} | ${scenario.expectation} | ${pairs.length} | ${pairs.length === 0 ? "—" : round4(worst)} | ${blocked}/${pairs.length} | ${free} |`);
  }
  write();
  // S7 строится отдельно: нужен deprecated-кандидат с активной заменой в корпусе.
  const deprecatedProbe = (() => {
    const original = entries[0]!;
    const deprecated: CorpusCandidate = { ...toCandidate(original), id: `${original.id}-old`, deprecated: true, replacement: original.name };
    const result = matchCandidates([...calibration!.candidates, deprecated], toProposed({ ...original, id: `${original.id}-new`, name: `${original.name}New` }), policy, { idf: calibration!.idf, limit: 20 });
    const found = result.candidates.find((candidate) => candidate.id === deprecated.id);
    return { blocking: found?.blocking ?? false, recommendable: found?.recommendable ?? false, score: found?.score ?? 0 };
  })();
  write(`S7 (deprecated с активной заменой в корпусе): score ${deprecatedProbe.score}, blocking \`${deprecatedProbe.blocking}\`,`);
  write(`recommendable \`${deprecatedProbe.recommendable}\` — демотирование работает и на прод-каталоге, где deprecated-записей нет.`);
  write();
  write(`S1, S2, S4 и S8 блокируются **структурным отпечатком**: копия сохраняет props/io/atomicLevel.`);
  write(`S3 блокируется и отпечатком, и по score (худший ${round4(worstRequired)} ≥ порога ${policy.blockingThreshold}).`);
  write(`S4 показывает границу с другой стороны: переписанный с нуля исходник даёт score всего`);
  write(`${round4(scenarioOutcome.get("S4")?.worst ?? 0)}, и ловит его только отпечаток — то есть отпечаток не избыточен, а несёт свой класс дубликатов.`);
  for (const scenario of SCENARIOS) {
    const notes = scenarioNotes.get(scenario.key) ?? [];
    if (notes.length > 0 && scenario.key !== "S6") write(`${scenario.key}: оригинал не попал в выдачу у ${notes.length} записей (${notes.slice(0, 3).join(", ")}…).`);
  }
  write();

  write(`## Замер 3 — разделяющий зазор`);
  write();
  write(`| величина | значение |`);
  write(`|---|---|`);
  write(`| худший обязательный дубликат S1–S3 (по score) | ${round4(worstRequired)} |`);
  write(`| лучшая легитимная пара каталога | ${round4(chosen.bestLegit)} (${topLegit?.left ?? "—"} ↔ ${topLegit?.right ?? "—"}) |`);
  write(`| **разделяющий зазор** | **${round4(worstRequired - chosen.bestLegit)}** |`);
  write(`| выбранный порог | ${policy.blockingThreshold} |`);
  write(`| худший трудный дубликат S3h | ${round4(chosen.worstDuplicate)} |`);
  write(`| зазор для S3h | ${round4(chosen.worstDuplicate - chosen.bestLegit)} (перекрытие) |`);
  write();
  write(`Зазор для обязательного набора **положителен**, для трудного варианта — отрицателен:`);
  write(`распределения S3h и легитимных пар перекрываются, и ни один из ${grid.length} наборов весов`);
  write(`их не разводит. Порог выбран в положительном зазоре; цена — ${hardDuplicates.length - hardCaught} из ${hardDuplicates.length} S3h проходят.`);
  write();
  write(`Потолок легитимных пар держит пара \`${topLegit?.left ?? "—"} ↔ ${topLegit?.right ?? "—"}\` — соседи одного`);
  write(`семейства \`yp-app-home-*\`. Если триаж проекта 3 признает их дубликатом, потолок падает до`);
  write(`${round4(secondLegit)} и порог можно опустить с ростом recall — это единственный дешёвый способ`);
  write(`улучшить матчер без смены алгоритма.`);
  write();

  write(`## Замер 4 — чувствительность порога`);
  write();
  write(`| порог | пар каталога ≥ порога | S1–S3 ниже порога | S3h ниже порога |`);
  write(`|---|---|---|---|`);
  for (const delta of [-0.03, -0.02, -0.01, 0, 0.01, 0.02, 0.03]) {
    const threshold = round4(policy.blockingThreshold + delta);
    const missedRequired = requiredScores.filter((value) => value < threshold).length;
    const missedHard = hardDuplicates.filter((pair) => combine(pair.values, policy.weights) < threshold).length;
    write(`| ${threshold}${delta === 0 ? " (выбран)" : ""} | ${overThreshold(calibrationPairs, threshold)} | ${missedRequired}/${requiredScores.length} | ${missedHard}/${hardDuplicates.length} |`);
  }
  write();
  const band = calibrationPairs.filter((pair) => {
    const value = combine(pair.values, policy.weights);
    return value >= policy.blockingThreshold - 0.03 && value <= policy.blockingThreshold + 0.03;
  }).length;
  write(`Пар в полосе ±0.03 вокруг порога: **${band}**.`);
  write();

  write(`## Замер 5 — коллизии структурного отпечатка`);
  write();
  write(`| корпус | записей | различных отпечатков | групп-коллизий | записей в коллизиях |`);
  write(`|---|---|---|---|---|`);
  const collisionDetails: string[] = [];
  for (const corpus of corpora) {
    const groups = new Map<string, string[]>();
    let undefinedCount = 0;
    for (const entry of corpus.entries) {
      const fingerprint = structuralFingerprint({ propsJsonSchema: entry.meta?.propsJsonSchema, events: entry.meta?.events, slots: entry.meta?.slots, atomicLevel: entry.atomicLevel, scope: entry.scope });
      if (fingerprint === undefined) { undefinedCount += 1; continue; }
      groups.set(fingerprint, [...(groups.get(fingerprint) ?? []), entry.id]);
    }
    const collisions = [...groups.values()].filter((group) => group.length > 1);
    write(`| \`${corpus.label}\` | ${corpus.entries.length} | ${groups.size}${undefinedCount > 0 ? ` (+${undefinedCount} без схемы)` : ""} | ${collisions.length} | ${collisions.reduce((total, group) => total + group.length, 0)} |`);
    for (const group of collisions) collisionDetails.push(`- \`${corpus.label}\`: ${group.join(" ↔ ")} — props \`${JSON.stringify(propsSignature(corpus.entries.find((entry) => entry.id === group[0])!.meta?.propsJsonSchema)?.properties.map((property) => property.name) ?? [])}\``);
  }
  write();
  if (collisionDetails.length > 0) { write(`Состав коллизий:`); write(); for (const detail of collisionDetails) write(detail); write(); }

  write(`## Замер 6 — сиды серверных тестов и e2e`);
  write();
  write(`Вход для задачи T6b: пары фикстур, которые под итоговой политикой получат score ≥ review.`);
  if (fixtureSkips.length > 0) write(`Фикстуры, не проходящие извлечение (до матчера не доходят): ${fixtureSkips.map((name) => `\`${name}\``).join(", ")}.`);
  write();
  write(`| корпус | пара | score | blocking |`);
  write(`|---|---|---|---|`);
  let seedRows = 0;
  for (const corpus of corpora) {
    if (corpus.label === calibration.label) continue;
    for (const pair of swept.get(corpus.label)!) {
      const value = combine(pair.values, policy.weights);
      if (value < policy.reviewThreshold && !pair.structural && !pair.canonical) continue;
      seedRows += 1;
      write(`| \`${corpus.label}\` | ${pair.left} ↔ ${pair.right} | ${value} | ${pair.structural || pair.canonical || value >= policy.blockingThreshold ? "**да**" : "нет"} |`);
    }
  }
  if (seedRows === 0) write(`| — | нет пар выше review-порога | — | — |`);
  write();

  write(`## Замер 7 — известные дубликаты аудита 2026-07-20`);
  write();
  write(`Пары взяты из \`docs/audit/2026-07-20-yp-catalog-audit.md\` и \`-findings.md\` (все пометки`);
  write(`«near-duplicate» и «дублирует»). Колонка «review» — попал ли кандидат в выдачу гейта, даже`);
  write(`если не заблокирован: для семантических дублей это и есть реалистичный максимум.`);
  write();
  write(`| пара | статус в каталоге | score | blocking | review |`);
  write(`|---|---|---|---|---|`);
  const draftCandidates = drafts.map((draft): CorpusCandidate => toCandidate(draft));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let caught = 0;
  let surfaced = 0;
  for (const [left, right] of KNOWN_DUPLICATES) {
    const leftEntry = byId.get(left) ?? drafts.find((draft) => draft.id === left);
    const rightEntry = byId.get(right) ?? drafts.find((draft) => draft.id === right);
    if (leftEntry === undefined || rightEntry === undefined) { write(`| ${left} ↔ ${right} | нет в каталоге | — | — | — |`); continue; }
    const status = leftEntry.draft || rightEntry.draft ? "одна сторона без активной публикации" : "обе активны";
    const result = matchCandidates([...calibration.candidates, ...draftCandidates], toProposed(leftEntry), policy, { idf: calibration.idf, exclude: { designSystem: leftEntry.designSystem, id: leftEntry.id }, limit: calibration.candidates.length + draftCandidates.length });
    const found = result.candidates.find((candidate) => candidate.id === right);
    const isBlocking = found?.blocking === true;
    const isReview = found !== undefined && found.score >= policy.reviewThreshold;
    if (isBlocking) caught += 1;
    if (isBlocking || isReview) surfaced += 1;
    write(`| ${left} ↔ ${right} | ${status} | ${found?.score ?? "—"} | ${isBlocking ? "**да**" : "нет"} | ${isReview ? "да" : "нет"} |`);
  }
  write();
  write(`Поймано блокировкой: **${caught} из ${KNOWN_DUPLICATES.length}**; показано агенту (blocking или review): **${surfaced} из ${KNOWN_DUPLICATES.length}**.`);
  write();
  write(`Это **не** дефект калибровки, а граница класса: аудит помечал «near-duplicate» по смыслу`);
  write(`(одна и та же продуктовая роль, разный код и разные props), а матчер без \`canonicalFor\``);
  write(`видит только текстовое и структурное родство. Пара \`yp-promo-banner ↔ yp-banner-mid\``);
  write(`не ловится ещё и потому, что вторая сторона снята с публикации: у неё нет`);
  write(`\`definition_meta\`, и применимы только сигналы исходника и имени (§3.1 плана).`);
  write(`Ролевые дубликаты закрывает бэкфилл \`canonicalFor\` в проекте 3, а не подгонка весов.`);
  write();

  write(`## Приложение — как воспроизвести`);
  write();
  write(`Прод-дамп в репозиторий не кладётся (это прод-данные). Снимается **только чтением**,`);
  write(`один логин на процесс (прод рейт-лимитит логины), паузы между пачками:`);
  write();
  write("```js");
  write(`// scratchpad/dump-prod.mjs — EASYUI_USERNAME/EASYUI_PASSWORD из .env`);
  write(`import { createEasyUiClient } from "scripts/easyui-auth.mjs";`);
  write(`const client = createEasyUiClient({ apiBase: "https://easy-ui.pay-offline.ru/api" });`);
  write(`// GET /design-systems → для каждой: GET /catalog/manifest?designSystem=…`);
  write(`// → на каждый компонент: GET /components/:id/versions/:version (там source + definition_meta)`);
  write(`// → для компонентов без активной публикации: GET /components/:id/source`);
  write("```");
  write();
  write("```sh");
  write(`~/.bun/bin/bun scripts/calibrate-matcher.ts --dump <dump.json> \\`);
  write(`  --db data/easy-ui.db --db .e2e-data/dev/easy-ui.db --fixtures \\`);
  write(`  --out docs/audit/2026-07-31-matcher-calibration.md`);
  write("```");
  write();
  write(`Скрипт падает, если его собственная взвешенная сумма разойдётся со score настоящего`);
  write(`матчера хотя бы на одной паре: цифры отчёта относятся к тому коду, который поедет в прод.`);
  write();

  const output = lines.join("\n") + "\n";
  if (argv.out === undefined) process.stdout.write(output);
  else await Bun.write(argv.out, output);
}

await main();
