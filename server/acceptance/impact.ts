/**
 * Импакт-анализ кандидата относительно baseline-рана (план §3 D6, §5 W6).
 *
 * Отвечает ровно на один вопрос: **какие случаи baseline-набора обязаны быть сняты заново**,
 * если приёмку прогоняют на новом кандидате. Ответ доказательный, а не эвристический, и потому
 * умещается в три базиса:
 *
 * - `asset-only` — форма исходника не изменилась (`sourceShapeHash` совпал), версия темы та же,
 *   изменились только литералы `asset_<sha256>`. Пересъёмке подлежат случаи, чьи **наблюдённые**
 *   ассеты (readiness-evidence, W4) пересекаются с симметрической разностью ссылок.
 * - `theme-only` — исходник побайтово тот же (`sourceHash` совпал), сменилась версия темы ДС.
 *   Пересъёмке подлежат случаи, чьи наблюдённые токены/иконки пересекаются с диффом темы.
 * - `conservative` — всё остальное, включая «изменилось и то и другое», отсутствие доказательств
 *   формы у любого из кандидатов, нетерминальный/чужой baseline и смену шрифта темы. Затронуты
 *   все случаи; `reason` называет причину буквально.
 *
 * **Асимметрия сознательная.** Совпадение хэшей доказывает эквивалентность формы; расхождение не
 * доказывает ничего, поэтому любое сомнение уводит в `conservative`. Молчаливого reuse не бывает:
 * случай без evidence (динамический URL, вычищенный артефакт, кадр от старого шелла) всегда
 * затронут, даже внутри «узкого» базиса.
 *
 * Импакт **не входит** в `case_fingerprint` и не меняет капчур — поэтому W6 не поднимает
 * `CASE_FINGERPRINT_ALGO_VERSION` (накопленный reuse остаётся годным).
 */
import type { Database } from "bun:sqlite";
import { ApiError } from "../http";
import { getDesignSystemVersion } from "../designSystems";
import { themeDiff, type ThemeContent, type ThemeIcon } from "../designSystemsMeta";
import { readCandidate, type CandidateEntry } from "../components/candidates";
import { observedResourcesOfRun, intersects, themeTokenCssVar, type ObservedResources } from "./resources";
import { isTerminalRunStatus, type AcceptanceCaseRow, type AcceptanceRepo, type AcceptanceRunRow, type CandidateRow } from "./repo";

export type ImpactBasis = "asset-only" | "theme-only" | "conservative";

export interface ImpactReport {
  basis: ImpactBasis;
  candidateId: string;
  baselineRunId: string;
  baselineCandidateId: string;
  /** asset-id, появившиеся или исчезнувшие (исходник — в `asset-only`, иконки темы — в `theme-only`). */
  changedAssets: string[];
  /** Имена CSS-кастом-проперти изменившихся токенов темы (`--eui-…`); только в `theme-only`. */
  changedTokens: string[];
  /** `caseId` случаев baseline-набора, подлежащих пересъёмке. */
  affectedCases: string[];
  /** `caseId` случаев, чей baseline-вердикт можно перенести без съёмки. */
  unaffectedCases: string[];
  /** Сколько **целевых** (не-алиасных) случаев придётся снять: у алиаса своей съёмки нет (D10). */
  recaptureCount: number;
  /** Человекочитаемое обоснование базиса — попадает в `impact_json` рана и в CLI-отчёт. */
  reason: string;
}

export interface ComputeImpactInput {
  db: Database;
  dataDir: string;
  repo: AcceptanceRepo;
  /** Кандидат, для которого планируется новый ран. */
  candidate: CandidateRow;
  /** Терминальный ран того же компонента, чьи вердикты предполагается переиспользовать. */
  baselineRun: AcceptanceRunRow;
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

/** Симметрическая разность двух множеств строк. */
function symmetricDifference(left: Iterable<string>, right: Iterable<string>): string[] {
  const a = new Set(left);
  const b = new Set(right);
  const out: string[] = [];
  for (const item of a) if (!b.has(item)) out.push(item);
  for (const item of b) if (!a.has(item)) out.push(item);
  return sorted(out);
}

/** Все asset-id иконки: базовый плюс тематические варианты (`themes.light|dark`). */
const iconAssetIds = (icon: ThemeIcon): string[] =>
  [icon.assetId, icon.themes?.light, icon.themes?.dark].filter((id): id is string => typeof id === "string");

/** Запись candidate-кэша по `sourceHash` строки кандидата; `null` — кэш вытеснен/протух. */
async function entryOf(dataDir: string, row: CandidateRow): Promise<CandidateEntry | null> {
  return readCandidate(dataDir, row.source_hash);
}

/** Есть ли у обеих записей доказательства формы (W6-поля); без них узкий базис недоказуем. */
function hasShapeEvidence(entry: CandidateEntry | null): entry is CandidateEntry & { sourceShapeHash: string; assetRefs: string[] } {
  return entry !== null && typeof entry.sourceShapeHash === "string" && Array.isArray(entry.assetRefs);
}

interface Verdict {
  basis: ImpactBasis;
  changedAssets: string[];
  changedTokens: string[];
  reason: string;
  /** Базис доказан, но затрагивает вообще всё (сменился шрифт темы) — затронуты все случаи. */
  affectsEverything?: boolean;
}

/**
 * Дифф двух версий темы одной ДС → изменившиеся токены (в пространстве CSS-переменных) и
 * asset-id иконок. Смена шрифта возвращается отдельным признаком: `@font-face` действует на
 * весь документ, и «наблюдённых токенов» у него нет — сузить пересъёмку нечем.
 */
function themeImpact(db: Database, designSystem: string, from: number | null, to: number | null): Verdict {
  if (from === null || to === null) {
    return {
      basis: "conservative", changedAssets: [], changedTokens: [],
      reason: `Design system ${designSystem} has no pinned theme version on one side of the comparison (${from} → ${to})`,
    };
  }
  const before = getDesignSystemVersion(db, designSystem, from);
  const after = getDesignSystemVersion(db, designSystem, to);
  if (!before || !after) {
    return {
      basis: "conservative", changedAssets: [], changedTokens: [],
      reason: `Theme version ${before ? to : from} of ${designSystem} is no longer readable; the diff cannot be proven`,
    };
  }
  const content = (value: ThemeContent): ThemeContent => ({ tokens: value.tokens, fonts: value.fonts, icons: value.icons });
  const diff = themeDiff(content(before), content(after));
  const changedTokens = sorted([
    ...Object.keys(diff.tokens.added),
    ...Object.keys(diff.tokens.changed),
    ...diff.tokens.removed,
  ].map(themeTokenCssVar));
  const changedAssets = sorted([...diff.icons.added, ...diff.icons.removed].flatMap(iconAssetIds));
  const fontsChanged = diff.fonts.added.length > 0 || diff.fonts.removed.length > 0;
  return {
    basis: "theme-only",
    changedAssets,
    changedTokens,
    ...(fontsChanged ? { affectsEverything: true } : {}),
    reason: fontsChanged
      ? `Theme ${designSystem} v${from} → v${to} changes font faces, which apply document-wide; every case is recaptured`
      : `Theme ${designSystem} v${from} → v${to}: ${changedTokens.length} token(s), ${changedAssets.length} icon asset(s) changed`,
  };
}

/** Классификация изменения кандидата: узкий доказанный базис либо честный `conservative`. */
function classify(
  db: Database,
  candidate: CandidateRow,
  baselineCandidate: CandidateRow,
  entry: CandidateEntry | null,
  baselineEntry: CandidateEntry | null,
): Verdict {
  const sourceChanged = candidate.source_hash !== baselineCandidate.source_hash;
  const themeChanged = candidate.theme_version !== baselineCandidate.theme_version;

  if (!sourceChanged && !themeChanged) {
    return {
      basis: "asset-only", changedAssets: [], changedTokens: [],
      reason: "Candidate build is identical to the baseline: nothing changed",
    };
  }
  if (sourceChanged && themeChanged) {
    return {
      basis: "conservative", changedAssets: [], changedTokens: [],
      reason: "Both the component source and the design-system theme version changed; no narrow basis is provable",
    };
  }
  if (themeChanged) {
    if (candidate.design_system !== baselineCandidate.design_system) {
      return {
        basis: "conservative", changedAssets: [], changedTokens: [],
        reason: `Candidate moved between design systems (${baselineCandidate.design_system} → ${candidate.design_system})`,
      };
    }
    return themeImpact(db, candidate.design_system, baselineCandidate.theme_version, candidate.theme_version);
  }
  // Остался только изменившийся исходник при неизменной теме.
  if (!hasShapeEvidence(entry) || !hasShapeEvidence(baselineEntry)) {
    return {
      basis: "conservative", changedAssets: [], changedTokens: [],
      reason: "Candidate cache holds no source-shape evidence for one of the builds (entry evicted or predates W6)",
    };
  }
  if (entry.sourceShapeHash !== baselineEntry.sourceShapeHash) {
    return {
      basis: "conservative", changedAssets: [], changedTokens: [],
      reason: "Source shape hash differs: the edit touched more than asset literals",
    };
  }
  const changedAssets = symmetricDifference(entry.assetRefs, baselineEntry.assetRefs);
  return {
    basis: "asset-only",
    changedAssets,
    changedTokens: [],
    reason: `Only asset literals changed (${changedAssets.length} asset id(s)); the source shape is byte-identical`,
  };
}

/** Затронут ли случай при доказанном узком базисе. Неизвестные ресурсы всегда затронуты. */
function caseAffected(resources: ObservedResources, caseId: string, verdict: Verdict): boolean {
  if (verdict.affectsEverything === true) return true;
  const observed = resources.get(caseId);
  if (!observed) return true;
  return intersects(observed.assets, verdict.changedAssets) || intersects(observed.tokens, verdict.changedTokens);
}

/**
 * Импакт кандидата относительно baseline-рана. Чистая функция над уже записанным состоянием:
 * ни одного капчура, ни одной записи — её вызывают и dry-run-ручка, и постановка частичного рана.
 */
export async function computeImpact(input: ComputeImpactInput): Promise<ImpactReport> {
  const { db, dataDir, repo, candidate, baselineRun } = input;
  if (baselineRun.component_id !== candidate.component_id) {
    throw new ApiError(422, "baseline_run_mismatch",
      `Baseline run belongs to component ${baselineRun.component_id}, not the candidate's ${candidate.component_id}`);
  }
  const baselineCases = repo.cases(baselineRun.run_id);
  const all = baselineCases.map((row) => row.case_id);
  const targets = new Set(baselineCases.filter((row) => row.alias_of_case_id === null).map((row) => row.case_id));
  const baselineCandidate = repo.requireCandidate(baselineRun.candidate_id);

  const conservative = (reason: string): ImpactReport => ({
    basis: "conservative",
    candidateId: candidate.candidate_id,
    baselineRunId: baselineRun.run_id,
    baselineCandidateId: baselineRun.candidate_id,
    changedAssets: [], changedTokens: [],
    affectedCases: [...all].sort(),
    unaffectedCases: [],
    recaptureCount: targets.size,
    reason,
  });

  if (!isTerminalRunStatus(baselineRun.status)) {
    return conservative(`Baseline run is ${baselineRun.status}; only a terminal run carries reusable verdicts`);
  }
  if (baselineCases.length === 0) return conservative("Baseline run has no recorded cases");

  const verdict = classify(db, candidate, baselineCandidate, await entryOf(dataDir, candidate), await entryOf(dataDir, baselineCandidate));
  if (verdict.basis === "conservative") return conservative(verdict.reason);

  const resources = await observedResourcesOfRun(dataDir, repo, baselineRun.run_id);
  const affected = new Set(baselineCases.filter((row) => caseAffected(resources, row.case_id, verdict)).map((row) => row.case_id));
  // Алиас не снимается сам, но и не может разойтись с целью (D10): затронутая цель тянет алиасы.
  for (const row of baselineCases) {
    if (row.alias_of_case_id !== null && affected.has(row.alias_of_case_id)) affected.add(row.case_id);
  }
  return {
    basis: verdict.basis,
    candidateId: candidate.candidate_id,
    baselineRunId: baselineRun.run_id,
    baselineCandidateId: baselineRun.candidate_id,
    changedAssets: verdict.changedAssets,
    changedTokens: verdict.changedTokens,
    affectedCases: [...affected].sort(),
    unaffectedCases: all.filter((caseId) => !affected.has(caseId)).sort(),
    recaptureCount: [...affected].filter((caseId) => targets.has(caseId)).length,
    reason: verdict.reason,
  };
}

/** Строка baseline-случая по `caseId` — вход переноса вердикта в частичном ране. */
export function baselineCaseIndex(rows: AcceptanceCaseRow[]): Map<string, AcceptanceCaseRow> {
  return new Map(rows.map((row) => [row.case_id, row]));
}
