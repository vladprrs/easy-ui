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
 * Сигнатура источника артефакта в Figma (§W8): ключи компонентов и семантические роли его узлов.
 *
 * Тип объявлен **здесь**, а не импортируется из `server/figma/sourcePackage.ts`, ровно по той же
 * причине, по которой ядро матчера не ходит в БД: его файл держит закрытый список импортов
 * (гейт-тест в `matcher.test.ts`), и вход сигнала обязан быть его собственным типом, а не ссылкой
 * на подсистему хранения. Проекцию пакета в эту форму делает `sourceSignatureOf`.
 */
export interface SourceSignature {
  componentKeys: readonly string[];
  roles: readonly string[];
}

/** Тип артефакта каталога. Композиции въехали в корпус в W9 (план 2026-08-03, R1-M9). */
export type ArtifactKind = "component" | "composition";

/**
 * Структурная сигнатура тела композиции (`server/catalog/compositionSignature.ts`).
 * У компонента её нет: его тело описывают шинглы TSX.
 */
export interface CandidateStructure {
  shingles: ReadonlySet<string>;
  fingerprint: string;
}

/**
 * Запись корпуса. Собирается T4 из авторитетных таблиц (активные публикации + head-драфты);
 * `shingles` приходят из content-addressed кэша `component_fingerprints` либо считаются на лету
 * — матчеру безразлично, откуда, лишь бы это была `sourceShingles(source)` того же исходника.
 */
export interface CorpusCandidate {
  kind: ArtifactKind;
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
  /** Только у `kind: "composition"`: структура тела вместо шинглов TSX. */
  structure?: CandidateStructure;
  /**
   * Источник артефакта в Figma (§W8): ключи компонентов и семантические роли узлов из пакета
   * исходников, на который ссылается его provenance. Отсутствует — сигнал неприменим.
   */
  sourceSignature?: SourceSignature;
}

/** Предложение: то, что вызывающий собирается создать. */
export interface ProposedArtifact {
  kind: ArtifactKind;
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
  /** Только у `kind: "composition"`: структура тела предложенного документа. */
  structure?: CandidateStructure;
  /** Источник предложения (§W8): что пакет знает про узлы, из которых его собираются собрать. */
  sourceSignature?: SourceSignature;
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
  /** Общий источник Figma (§W8): ранжирующий сигнал, в `gateScore` не входит. */
  sourcePackage?: number;
  /** Сумма весов применимых сигналов (знаменатель перенормировки). */
  appliedWeight: number;
}

export interface ScoreBreakdown {
  score: number;
  /**
   * Score **без** ранжирующих сигналов (сегодня это один `sourcePackage`, §W8). Именно он решает
   * `blocking`: сигнал источника показывает кандидата выше, но не имеет права запрещать создание.
   * Без источника у обеих сторон `gateScore === score` байт-в-байт, поэтому доволновые вердикты
   * не двигаются.
   */
  gateScore: number;
  signals: SignalBreakdown;
  /** Пересекающиеся канонические роли — blocking независимо от score. */
  canonicalOverlap: string[];
  /** Равенство структурных отпечатков — blocking независимо от score. */
  structuralMatch: boolean;
  propsDelta: PropsDelta;
}

export interface MatchCandidate {
  kind: ArtifactKind;
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
  /**
   * Пороги по типу артефакта (W9). Веса общие — различаются только `blockingThreshold`/
   * `reviewThreshold`: калибровка T0 мерила пары компонентов, и переносить её пороги на
   * композиции нечестно. Не передан — для всех типов действует `policy`.
   */
  policyByKind?: Partial<Record<ArtifactKind, MatchPolicy>>;
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

/**
 * Сходство источников (§W8). Совпавший `componentKey` — **тождество мастера** Figma, сильнейшее из
 * возможных утверждений о родстве, поэтому 1 без дальнейшей арифметики. Иначе остаётся Jaccard
 * семантических ролей: «оба — платёжная кнопка» стоит ровно столько, сколько стоит роль.
 */
export function sourcePackageSimilarity(left: SourceSignature, right: SourceSignature): number {
  const leftKeys = new Set(left.componentKeys);
  if (right.componentKeys.some((key) => leftKeys.has(key))) return 1;
  const leftRoles = new Set(left.roles), rightRoles = new Set(right.roles);
  if (leftRoles.size === 0 || rightRoles.size === 0) return 0;
  return jaccard(leftRoles, rightRoles);
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
  sourceSignature?: SourceSignature;
  fingerprint?: string;
  canonicalFor: Set<string>;
  structure?: CandidateStructure;
}

export function prepareProposed(proposed: ProposedArtifact): ProposedView {
  const meta = proposed.meta;
  return {
    artifact: proposed,
    props: propsSignature(meta?.propsJsonSchema),
    io: meta === undefined ? undefined : ioTokens(ioSignature(meta.events, meta.slots)),
    // Слот сигнала «тело» один: у компонента это шинглы TSX, у композиции — шинглы структуры.
    shingles: proposed.structure !== undefined ? new Set(proposed.structure.shingles)
      : proposed.source === undefined ? new Set<string>() : sourceShingles(proposed.source),
    name: nameTokens(proposed.name ?? proposed.id ?? ""),
    text: [proposed.description ?? "", proposed.intent ?? ""].join(" ").trim(),
    fingerprint: meta === undefined ? undefined : structuralFingerprint({ propsJsonSchema: meta.propsJsonSchema, events: meta.events, slots: meta.slots, atomicLevel: proposed.atomicLevel, scope: proposed.scope }),
    canonicalFor: new Set(proposed.canonicalFor ?? []),
    ...(proposed.structure === undefined ? {} : { structure: proposed.structure }),
    ...(proposed.sourceSignature === undefined ? {} : { sourceSignature: proposed.sourceSignature }),
  };
}

/**
 * Перенормировка: сумма только по применимым сигналам, делённая на сумму их весов.
 * Ни одного применимого сигнала — score 0 (а не деление на ноль и не «единица по умолчанию»).
 */
const SCORE_KEYS = ["props", "io", "source", "name", "description", "levelScope", "sourcePackage"] as const;
/** Сигналы гейта: ранжирующий `sourcePackage` в решение `blocking` не входит (§W8, триаж S-M6). */
const GATE_KEYS = ["props", "io", "source", "name", "description", "levelScope"] as const;

function weighted(
  signals: Omit<SignalBreakdown, "appliedWeight">,
  weights: MatchWeights,
  keys: readonly (keyof MatchWeights)[] = SCORE_KEYS,
): { score: number; appliedWeight: number } {
  let sum = 0, appliedWeight = 0;
  for (const key of keys) {
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

  // Сигнал тела применим **только внутри одного типа артефакта**: шинглы TSX и шинглы
  // структуры композиции живут в разных словарях, их Jaccard тождественно ноль, и с весом 0.75
  // он бы утопил любой кросс-типовой мэтч (композиция ↔ компонент) вместо того, чтобы молчать.
  const sameKind = candidate.kind === view.artifact.kind;
  const candidateBody = candidate.structure?.shingles ?? candidate.shingles;
  const source = !sameKind || candidateBody.size === 0 || view.shingles.size === 0 ? undefined : jaccard(candidateBody, view.shingles);

  const candidateName = nameTokens(candidate.name);
  const name = candidateName.size === 0 || view.name.size === 0 ? undefined : jaccard(candidateName, view.name);

  const candidateText = candidate.description.trim().length > 0 ? candidate.description : candidate.intent ?? "";
  const description = tokenize(candidateText).length === 0 || tokenize(view.text).length === 0 ? undefined : idfOverlap(candidateText, view.text, idf);

  // levelScope: сравниваются только измерения, объявленные **обеими** сторонами.
  const dimensions: number[] = [];
  if (candidate.atomicLevel !== undefined && view.artifact.atomicLevel !== undefined) dimensions.push(candidate.atomicLevel === view.artifact.atomicLevel ? 1 : 0);
  if (candidate.scope !== undefined && view.artifact.scope !== undefined) dimensions.push(candidate.scope === view.artifact.scope ? 1 : 0);
  const levelScope = dimensions.length === 0 ? undefined : dimensions.reduce((total, value) => total + value, 0) / dimensions.length;

  // §W8: общий источник Figma. Совпавший `componentKey` — тождество мастера, поэтому 1; иначе
  // сигнал вырождается в пересечение семантических ролей. Неприменим, когда источника нет хотя бы
  // у одной стороны: молчание пакета не должно штрафовать кандидата, у которого пакета не бывает.
  const sourcePackage = candidate.sourceSignature === undefined || view.sourceSignature === undefined
    ? undefined
    : sourcePackageSimilarity(candidate.sourceSignature, view.sourceSignature);

  const parts = { props, io, source, name, description, levelScope, sourcePackage };
  const { score, appliedWeight } = weighted(parts, policy.weights);
  const gateScore = sourcePackage === undefined ? score : weighted(parts, policy.weights, GATE_KEYS).score;

  const candidateFingerprint = meta === undefined ? undefined : structuralFingerprint({ propsJsonSchema: meta.propsJsonSchema, events: meta.events, slots: meta.slots, atomicLevel: candidate.atomicLevel, scope: candidate.scope });

  // Отпечаток блокирует без порога, поэтому кросс-типовое равенство контрактов им **не**
  // считается: у композиции с параметром `title` и компонента с пропом `title` совпадёт
  // сигнатура, но это подсказка «расширь компонент», а не тождество. Внутри одного типа
  // работает сильнейший из доступных отпечатков: у композиции — структура тела.
  const structuralMatch = !sameKind ? false
    : candidate.structure !== undefined && view.structure !== undefined
      ? candidate.structure.fingerprint === view.structure.fingerprint
      : candidateFingerprint !== undefined && candidateFingerprint === view.fingerprint;

  return {
    score,
    gateScore,
    signals: { ...parts, appliedWeight },
    canonicalOverlap: [...new Set(candidate.canonicalFor ?? [])].filter((role) => view.canonicalFor.has(role)).sort(),
    structuralMatch,
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
  const composition = candidate.kind === "composition";
  for (const role of breakdown.canonicalOverlap) reasons.push(`same canonical role: ${role}`);
  if (breakdown.structuralMatch) reasons.push(composition ? "identical composition body signature" : "same props/events/slots signature");
  const { source, name, props, description, levelScope } = breakdown.signals;
  if (source !== undefined && source >= REASON_FLOOR) reasons.push(`${percent(source)}% ${composition ? "composition body structure" : "normalized source structure"}`);
  if (props !== undefined && props >= REASON_FLOOR && !breakdown.structuralMatch) reasons.push(`${percent(props)}% props signature similarity`);
  if (name !== undefined && name >= REASON_FLOOR) reasons.push(`${percent(name)}% name-token similarity`);
  const sourcePackage = breakdown.signals.sourcePackage;
  if (sourcePackage !== undefined && sourcePackage >= REASON_FLOOR) {
    reasons.push(sourcePackage === 1 ? "same Figma component key in the source package" : `${percent(sourcePackage)}% semantic role overlap in the source package`);
  }
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
  const policyOf = (kind: CorpusCandidate["kind"]): MatchPolicy => options.policyByKind?.[kind] ?? policy;
  const relevance = new Map<MatchCandidate, boolean>();
  const scored: MatchCandidate[] = scoped.map((candidate) => {
    const effective = policyOf(candidate.kind);
    const breakdown = scoreWith(candidate, view, policy, idf);
    const rounded = round4(breakdown.score);
    const replacementActive = candidate.replacement !== undefined && active.has(candidate.replacement);
    // Порог применим только там, где есть структурное основание. При поиске по одному `intent`
    // (без исходника и меты) перенормировка схлопывает знаменатель до единственного сигнала, и
    // дословное попадание в описание даёт score 0.8 — выше порога 0.70 при весе описания 0.05
    // из 1.00. Без этой проверки discovery-поиск объявлял бы «blocking» вообще без структурных
    // улик. У гейта исходник и мета есть всегда, поэтому на его вердикт правило не влияет — и
    // калибровку оно не сдвигает: там во всех парах применён `source`.
    const structuralEvidence = breakdown.signals.props !== undefined || breakdown.signals.io !== undefined || breakdown.signals.source !== undefined;
    // Deprecated/replaced возвращается ради объяснения, но не как цель: blocking снимается
    // только когда активная замена реально есть в корпусе — иначе агенту некуда идти.
    // Порог применяется к **гейтовому** score (§W8): ранжирующий сигнал источника поднимает
    // кандидата в выдаче, но запрещать создание он права не имеет.
    const blocking = (breakdown.canonicalOverlap.length > 0 || breakdown.structuralMatch || (round4(breakdown.gateScore) >= effective.blockingThreshold && structuralEvidence)) && !(candidate.deprecated && replacementActive);
    const row: MatchCandidate = {
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
    relevance.set(row, blocking || rounded >= effective.reviewThreshold);
    return row;
  });

  // Округление выполнено до сортировки: иначе пары, различающиеся на 1e-12, меняли бы порядок
  // между прогонами и ломали воспроизводимость аудита.
  scored.sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const limit = options.limit ?? 8;
  // Порог релевантности — тоже по типу артефакта (`policyByKind`), поэтому он снят на месте
  // подсчёта, а не пересчитывается здесь по одной политике.
  const isRelevant = (candidate: MatchCandidate): boolean => relevance.get(candidate) === true;
  const relevant = scored.filter(isRelevant);
  // Спека §3: более низкие score возвращаются только чтобы добить выдачу до запрошенного размера.
  const filler = scored.filter((candidate) => !isRelevant(candidate));
  return {
    policyVersion: policy.policyVersion,
    blocking: scored.filter((candidate) => candidate.blocking),
    candidates: [...relevant, ...filler].slice(0, Math.max(0, limit)),
  };
}
