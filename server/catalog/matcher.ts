/**
 * Детерминированный матчер семантических дубликатов (план 2026-07-31 §3.3, спека §3).
 *
 * Чистое ядро: ноль обращений к БД, ноль HTTP, ноль чтения env — корпус приходит параметром
 * (его собирает `server/catalog/corpus.ts`, задача T4), политика инъектируется параметром
 * (`server/catalog/policy.ts`, калибруется T0). Всё вычисление синхронно: гейт создания
 * вызывает матчер **внутри** `db.transaction(() => …)`, где ни одного `await` быть не может —
 * bun:sqlite молча коммитит на первом await.
 *
 * Ключевой инвариант — **неприменимый сигнал** (§3.2): сигнал исключается из суммы, а веса
 * перенормируются на присутствующие, если обе стороны пусты ИЛИ одна из сторон сигнал не
 * объявляет. Без перенормировки побайтово идентичный драфт-дубликат набирает ~0.35 вместо
 * ~0.87 (у драфта нет `definition_meta`, то есть 0.65 весового бюджета из 1.00) и обход
 * «создать драфт → опубликовать» переоткрывается молча.
 */

import { buildIdf, idfOverlap, tokenize } from "../../src/library/text";
import { ioSignature, propsSignature, sourceShingles, structuralFingerprint, type PropsSignature } from "./fingerprint";
import type { MatchPolicy, MatchWeights } from "./policy";

// ─────────────────────────────── типы корпуса ───────────────────────────────

/** Мета активной публикации; у head-драфта её нет — соответствующие сигналы неприменимы. */
export interface CandidateMeta {
  propsJsonSchema?: unknown;
  events?: readonly string[];
  slots?: readonly string[];
}

/**
 * Запись корпуса. Собирается T4 из авторитетных таблиц (активные публикации + head-драфты);
 * `shingles` приходят из content-addressed кэша `component_fingerprints` либо считаются на лету
 * — матчеру безразлично, откуда, лишь бы это была `sourceShingles(source)` того же исходника.
 */
export interface CorpusCandidate {
  kind: "component";
  id: string;
  name: string;
  designSystem: string;
  /** Версия активной публикации; `0` у head-драфта. */
  version: number;
  /** У драфта нет активной публикации, а значит и `definition_meta`. */
  draft: boolean;
  /** Описание из `definition_meta`; у драфта — пустая строка. */
  description: string;
  /** Опциональный intent создания (если вызывающий его сохранил): fallback описания драфта. */
  intent?: string;
  atomicLevel?: string;
  scope?: string;
  canonicalFor?: readonly string[];
  /** Имя компонента-замены (для deprecated/replaced). */
  replacement?: string;
  deprecated: boolean;
  headUsageCount: number;
  /** Отсутствует у драфта: props/io/структурный отпечаток по нему не считаются. */
  meta?: CandidateMeta;
  shingles: ReadonlySet<string>;
}

/** Предложение: то, что вызывающий собирается создать. */
export interface ProposedArtifact {
  kind: "component";
  id?: string;
  name?: string;
  designSystem: string;
  /** Обязателен на границе API; здесь — просто текст сигнала описания. */
  intent?: string;
  description?: string;
  atomicLevel?: string;
  scope?: string;
  canonicalFor?: readonly string[];
  meta?: CandidateMeta;
  source?: string;
}

export interface PropsDelta { added: string[]; removed: string[]; typeChanged: string[] }

/** Значения сигналов; `undefined` — сигнал неприменим и исключён из перенормированной суммы. */
export interface SignalBreakdown {
  props?: number;
  io?: number;
  source?: number;
  name?: number;
  description?: number;
  levelScope?: number;
  /** Сумма весов применимых сигналов (знаменатель перенормировки). */
  appliedWeight: number;
}

export interface ScoreBreakdown {
  score: number;
  signals: SignalBreakdown;
  /** Пересекающиеся канонические роли — blocking независимо от score. */
  canonicalOverlap: string[];
  /** Равенство структурных отпечатков — blocking независимо от score. */
  structuralMatch: boolean;
  propsDelta: PropsDelta;
}

export interface MatchCandidate {
  kind: "component";
  id: string;
  name: string;
  designSystem: string;
  version: number;
  draft: boolean;
  description: string;
  atomicLevel?: string;
  scope?: string;
  canonicalFor: string[];
  replacement?: string;
  deprecated: boolean;
  headUsageCount: number;
  /** Округлён до 4 знаков **до** сортировки. */
  score: number;
  blocking: boolean;
  /** Можно ли предлагать как цель переиспользования: deprecated — нельзя. */
  recommendable: boolean;
  reasons: string[];
  /** Только у blocking-кандидатов: имена пропов, без схем и без значений. */
  propsDelta?: PropsDelta;
  signals: SignalBreakdown;
}

export interface MatchResult {
  policyVersion: number;
  /** Все blocking-кандидаты по **полному** корпусу (не усечены `limit`). */
  blocking: MatchCandidate[];
  /** Выдача: blocking+review по убыванию score, добитая до `limit` лучшими из остальных. */
  candidates: MatchCandidate[];
}

export interface MatchOptions {
  /** IDF описаний корпуса. Не передан — строится по описаниям того же корпуса. */
  idf?: ReadonlyMap<string, number>;
  /** Размер выдачи (спека §2: 1..20, default 8). На `blocking` не влияет. */
  limit?: number;
  /** Исключение самого оцениваемого артефакта из корпуса (D4). */
  exclude?: { designSystem: string; id: string };
}

// ───────────────────────────────── сигналы ──────────────────────────────────

/** Порог, с которого сигнал попадает в `reasons`: ниже — шум, объясняющий ничего. */
const REASON_FLOOR = 0.5;

const jaccard = (left: ReadonlySet<string>, right: ReadonlySet<string>): number => {
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

/**
 * Токены имени: `YpPayButton`, `yp-pay-button` и `yp_pay_button` дают одно множество.
 * Без разбиения camelCase имя компонента — один токен, и сигнал вырождается в «равно/не равно».
 */
export const nameTokens = (value: string): Set<string> =>
  new Set(tokenize(value.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2").replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")));

/**
 * Сходство сигнатур props. Совпало имя — половина балла (проп с тем же именем и другим типом
 * всё ещё говорит о родстве), совпала форма — ещё 0.35, совпала обязательность — ещё 0.15.
 * Нормировка на объединение имён: «похожее имя, но несовместимые props» обязано проваливаться.
 */
function propsSimilarity(left: PropsSignature, right: PropsSignature): number {
  const leftByName = new Map(left.properties.map((property) => [property.name, property]));
  const rightByName = new Map(right.properties.map((property) => [property.name, property]));
  const names = new Set([...leftByName.keys(), ...rightByName.keys()]);
  if (names.size === 0) return 0;
  let sum = 0;
  for (const name of names) {
    const a = leftByName.get(name), b = rightByName.get(name);
    if (a === undefined || b === undefined) continue;
    sum += 0.5 + (a.shape === b.shape ? 0.35 : 0) + (a.required === b.required ? 0.15 : 0);
  }
  return sum / names.size;
}

function propsDeltaOf(candidate: PropsSignature | undefined, proposed: PropsSignature | undefined): PropsDelta {
  const left = new Map((candidate?.properties ?? []).map((property) => [property.name, property.shape]));
  const right = new Map((proposed?.properties ?? []).map((property) => [property.name, property.shape]));
  const added: string[] = [], removed: string[] = [], typeChanged: string[] = [];
  for (const [name, shape] of right) {
    if (!left.has(name)) added.push(name);
    else if (left.get(name) !== shape) typeChanged.push(name);
  }
  for (const name of left.keys()) if (!right.has(name)) removed.push(name);
  return { added: added.sort(), removed: removed.sort(), typeChanged: typeChanged.sort() };
}

const ioTokens = (signature: { events: string[]; slots: string[] }): Set<string> =>
  new Set([...signature.events.map((event) => `e:${event}`), ...signature.slots.map((slot) => `s:${slot}`)]);

/** Предвычисленная сторона предложения: TSX парсится один раз на весь корпус, а не на кандидата. */
interface ProposedView {
  artifact: ProposedArtifact;
  props?: PropsSignature;
  io?: Set<string>;
  shingles: Set<string>;
  name: Set<string>;
  text: string;
  fingerprint?: string;
  canonicalFor: Set<string>;
}

export function prepareProposed(proposed: ProposedArtifact): ProposedView {
  const meta = proposed.meta;
  return {
    artifact: proposed,
    props: propsSignature(meta?.propsJsonSchema),
    io: meta === undefined ? undefined : ioTokens(ioSignature(meta.events, meta.slots)),
    shingles: proposed.source === undefined ? new Set<string>() : sourceShingles(proposed.source),
    name: nameTokens(proposed.name ?? proposed.id ?? ""),
    text: [proposed.description ?? "", proposed.intent ?? ""].join(" ").trim(),
    fingerprint: meta === undefined ? undefined : structuralFingerprint({ propsJsonSchema: meta.propsJsonSchema, events: meta.events, slots: meta.slots, atomicLevel: proposed.atomicLevel, scope: proposed.scope }),
    canonicalFor: new Set(proposed.canonicalFor ?? []),
  };
}

/**
 * Перенормировка: сумма только по применимым сигналам, делённая на сумму их весов.
 * Ни одного применимого сигнала — score 0 (а не деление на ноль и не «единица по умолчанию»).
 */
function weighted(signals: Omit<SignalBreakdown, "appliedWeight">, weights: MatchWeights): { score: number; appliedWeight: number } {
  let sum = 0, appliedWeight = 0;
  for (const key of ["props", "io", "source", "name", "description", "levelScope"] as const) {
    const value = signals[key];
    if (value === undefined) continue;
    sum += weights[key] * value;
    appliedWeight += weights[key];
  }
  return { score: appliedWeight === 0 ? 0 : sum / appliedWeight, appliedWeight };
}

function scoreWith(candidate: CorpusCandidate, view: ProposedView, policy: MatchPolicy, idf: ReadonlyMap<string, number>): ScoreBreakdown {
  const meta = candidate.meta;
  const candidateProps = propsSignature(meta?.propsJsonSchema);
  const candidateIo = meta === undefined ? undefined : ioTokens(ioSignature(meta.events, meta.slots));

  // props: неприменим, если одна из сторон схему не объявляет либо обе стороны пусты.
  const propsBothEmpty = (candidateProps?.properties.length ?? 0) === 0 && (view.props?.properties.length ?? 0) === 0;
  const props = candidateProps === undefined || view.props === undefined || propsBothEmpty ? undefined : propsSimilarity(candidateProps, view.props);

  // io: 22 из 37 прод-компонентов не имеют ни событий, ни слотов — «оба пусты» обязано быть
  // неприменимым, иначе они даром получают полный вес сигнала.
  const io = candidateIo === undefined || view.io === undefined || (candidateIo.size === 0 && view.io.size === 0) ? undefined : jaccard(candidateIo, view.io);

  const source = candidate.shingles.size === 0 || view.shingles.size === 0 ? undefined : jaccard(candidate.shingles, view.shingles);

  const candidateName = nameTokens(candidate.name);
  const name = candidateName.size === 0 || view.name.size === 0 ? undefined : jaccard(candidateName, view.name);

  const candidateText = candidate.description.trim().length > 0 ? candidate.description : candidate.intent ?? "";
  const description = tokenize(candidateText).length === 0 || tokenize(view.text).length === 0 ? undefined : idfOverlap(candidateText, view.text, idf);

  // levelScope: сравниваются только измерения, объявленные **обеими** сторонами.
  const dimensions: number[] = [];
  if (candidate.atomicLevel !== undefined && view.artifact.atomicLevel !== undefined) dimensions.push(candidate.atomicLevel === view.artifact.atomicLevel ? 1 : 0);
  if (candidate.scope !== undefined && view.artifact.scope !== undefined) dimensions.push(candidate.scope === view.artifact.scope ? 1 : 0);
  const levelScope = dimensions.length === 0 ? undefined : dimensions.reduce((total, value) => total + value, 0) / dimensions.length;

  const parts = { props, io, source, name, description, levelScope };
  const { score, appliedWeight } = weighted(parts, policy.weights);

  const candidateFingerprint = meta === undefined ? undefined : structuralFingerprint({ propsJsonSchema: meta.propsJsonSchema, events: meta.events, slots: meta.slots, atomicLevel: candidate.atomicLevel, scope: candidate.scope });

  return {
    score,
    signals: { ...parts, appliedWeight },
    canonicalOverlap: [...new Set(candidate.canonicalFor ?? [])].filter((role) => view.canonicalFor.has(role)).sort(),
    structuralMatch: candidateFingerprint !== undefined && candidateFingerprint === view.fingerprint,
    propsDelta: propsDeltaOf(candidateProps, view.props),
  };
}

/**
 * Оценка одной пары. Публичная форма из плана §4 (T2). Внутри `matchCandidates` используется
 * предвычисленная сторона предложения: здесь она собирается на каждый вызов, поэтому для
 * прохода по корпусу вызывать эту функцию в цикле не следует.
 */
export function score(candidate: CorpusCandidate, proposed: ProposedArtifact, policy: MatchPolicy, idf: ReadonlyMap<string, number>): ScoreBreakdown {
  return scoreWith(candidate, prepareProposed(proposed), policy, idf);
}

// ───────────────────────────────── причины ──────────────────────────────────

const percent = (value: number): number => Math.round(value * 100);

function reasonsFor(candidate: CorpusCandidate, breakdown: ScoreBreakdown, replacementActive: boolean): string[] {
  const reasons: string[] = [];
  for (const role of breakdown.canonicalOverlap) reasons.push(`same canonical role: ${role}`);
  if (breakdown.structuralMatch) reasons.push("same props/events/slots signature");
  const { source, name, props, description, levelScope } = breakdown.signals;
  if (source !== undefined && source >= REASON_FLOOR) reasons.push(`${percent(source)}% normalized source structure`);
  if (props !== undefined && props >= REASON_FLOOR && !breakdown.structuralMatch) reasons.push(`${percent(props)}% props signature similarity`);
  if (name !== undefined && name >= REASON_FLOOR) reasons.push(`${percent(name)}% name-token similarity`);
  if (levelScope === 1 && description !== undefined && description >= REASON_FLOOR) {
    reasons.push(`same ${candidate.scope ?? candidate.atomicLevel} scope with matching product-job description`);
  }
  if (candidate.deprecated) {
    reasons.push(candidate.replacement !== undefined && replacementActive ? `deprecated: use ${candidate.replacement} instead` : "deprecated without an active replacement");
  }
  return reasons;
}

// ────────────────────────────────── выдача ──────────────────────────────────

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/**
 * Проход по корпусу. Кандидаты ограничены дизайн-системой предложения (спека §3: «candidates
 * are limited to the requested active design system») — одинаковая структура в другой системе
 * не является дубликатом и в выдачу не попадает вовсе.
 */
export function matchCandidates(corpus: readonly CorpusCandidate[], proposed: ProposedArtifact, policy: MatchPolicy, options: MatchOptions = {}): MatchResult {
  const scoped = corpus.filter((candidate) =>
    candidate.designSystem === proposed.designSystem &&
    !(options.exclude !== undefined && candidate.designSystem === options.exclude.designSystem && candidate.id === options.exclude.id));

  // IDF корпус-относителен: он считается по описаниям **всего** корпуса системы, а не по
  // усечённой выдаче. Вызывающий может запинить свой набор (фикстуры обязаны это делать).
  const idf = options.idf ?? buildIdf(scoped.map((candidate) => (candidate.description.trim().length > 0 ? candidate.description : candidate.intent ?? "")));

  // Активные замены ищутся по **полному** корпусу, а не по срезу до `limit`: иначе
  // «deprecated с заменой» демотировался бы или нет в зависимости от размера выдачи.
  const active = new Set<string>();
  for (const candidate of scoped) if (!candidate.deprecated) { active.add(candidate.id); active.add(candidate.name); }

  const view = prepareProposed(proposed);
  const scored: MatchCandidate[] = scoped.map((candidate) => {
    const breakdown = scoreWith(candidate, view, policy, idf);
    const rounded = round4(breakdown.score);
    const replacementActive = candidate.replacement !== undefined && active.has(candidate.replacement);
    // Deprecated/replaced возвращается ради объяснения, но не как цель: blocking снимается
    // только когда активная замена реально есть в корпусе — иначе агенту некуда идти.
    const blocking = (breakdown.canonicalOverlap.length > 0 || breakdown.structuralMatch || rounded >= policy.blockingThreshold) && !(candidate.deprecated && replacementActive);
    return {
      kind: candidate.kind,
      id: candidate.id,
      name: candidate.name,
      designSystem: candidate.designSystem,
      version: candidate.version,
      draft: candidate.draft,
      description: candidate.description,
      ...(candidate.atomicLevel !== undefined ? { atomicLevel: candidate.atomicLevel } : {}),
      ...(candidate.scope !== undefined ? { scope: candidate.scope } : {}),
      canonicalFor: [...(candidate.canonicalFor ?? [])].sort(),
      ...(candidate.replacement !== undefined ? { replacement: candidate.replacement } : {}),
      deprecated: candidate.deprecated,
      headUsageCount: candidate.headUsageCount,
      score: rounded,
      blocking,
      recommendable: !candidate.deprecated,
      reasons: reasonsFor(candidate, breakdown, replacementActive),
      ...(blocking ? { propsDelta: breakdown.propsDelta } : {}),
      signals: breakdown.signals,
    };
  });

  // Округление выполнено до сортировки: иначе пары, различающиеся на 1e-12, меняли бы порядок
  // между прогонами и ломали воспроизводимость аудита.
  scored.sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const limit = options.limit ?? 8;
  const isRelevant = (candidate: MatchCandidate): boolean => candidate.blocking || candidate.score >= policy.reviewThreshold;
  const relevant = scored.filter(isRelevant);
  // Спека §3: более низкие score возвращаются только чтобы добить выдачу до запрошенного размера.
  const filler = scored.filter((candidate) => !isRelevant(candidate));
  return {
    policyVersion: policy.policyVersion,
    blocking: scored.filter((candidate) => candidate.blocking),
    candidates: [...relevant, ...filler].slice(0, Math.max(0, limit)),
  };
}
