/**
 * Отпечаток блокера и retry-disposition рана (EUI-BR-10a, план
 * `docs/plans/2026-08-08-blocker-removal-eui-br.md` §10; фидбэк §13).
 *
 * Задача, которую решает модуль, ровно одна: агент, получивший терминальный `fail`/`error`, обязан
 * узнать **не пересняв ни одного пикселя**, изменилось ли на сервере хоть что-нибудь из того, от
 * чего этот вердикт зависел, — и если изменилось, то насколько глубоко придётся переигрывать
 * (пересчёт вердикта / re-diff / пересъёмка / пересборка кандидата). До волны единственным ответом
 * был новый ран: полная матрица ради вопроса «а вдруг само починилось».
 *
 * Три границы, которые здесь держатся жёстко:
 *
 * 1. **`blockerFingerprint` считается только из СОХРАНЁННЫХ данных** (строка рана, строки случаев,
 *    строка кандидата) и никогда — из «текущего» состояния сервера. Это обязательное условие
 *    инварианта «run view и disposition дают одно значение»: run view не реконструирует набор
 *    случаев и не имеет права этого делать (это чтение, а не постановка). Ни `runId`, ни время в
 *    пре-образ не входят — неизменившийся блокер обязан давать один и тот же отпечаток в двух
 *    разных ранах, иначе дедуп блокеров невозможен.
 * 2. **Disposition сравнивает сохранённые отпечатки случаев с «would-be» отпечатками тех же
 *    случаев под текущим состоянием сервера**, и считает их **той же** функцией, что постановка и
 *    раннер (`caseFingerprintsOf`, D7). Второй реализации быть не должно: расхождение означало бы,
 *    что мы обещаем reuse, которого каскад не даст (или наоборот).
 * 3. **Ничего не создаётся и не мутируется.** Ни рана, ни строки кэша, ни артефакта: ручка
 *    `GET /retry-disposition` — чистое чтение (`no-store`), и всё, что модуль умеет делать с БД, —
 *    это `SELECT` через уже существующие read-хелперы репозитория.
 *
 * Чего модуль **не** делает (BR-10b, волна V5): не добавляет в basis `schemaResolverVersion`,
 * `resourceBarrierPolicyVersion` и `capturePolicyVersion` — эти величины появятся вместе со своими
 * фичами, и объявлять их сейчас значило бы хэшировать константу ради вида.
 */
import type { Database } from "bun:sqlite";
import { canonicalStringify } from "../../src/capture/canonicalJson";
import { GEOMETRY_CONTRACT_VERSION } from "../../src/capture/geometry.mjs";
import { ApiError } from "../http";
import { sha256 as sha256Hex } from "../components/pipeline";
import { ComponentRepo } from "../repos/components";
import { rendererFingerprint } from "../capture/renderer";
import { DEFAULT_CASE_SURFACE, type AcceptanceCase } from "./cases";
import { casesOfRun, CaseSetRepo, manifestOfRow, surfaceOfManifest } from "./caseSets";
import {
  CASE_FINGERPRINT_ALGO_VERSION, caseFingerprintsOf, readinessPolicyHashOf,
  type CaseSurface, type FieldLayer,
} from "./ids";
import { effectivePolicy } from "./orchestrator";
import { acceptancePolicy, policyProfileHash, type AcceptancePolicy } from "./policies";
import { isTerminalRunStatus, type AcceptanceCaseRow, type AcceptanceRepo, type AcceptanceRunRow, type CandidateRow } from "./repo";

/**
 * Kill-switch волны (`EASYUI_BLOCKER_FINGERPRINT_DISABLED=1`): гасит **обе** поверхности сразу —
 * ручку `GET /api/acceptance-runs/:runId/retry-disposition` (404) и поле `blockerFingerprint` в
 * представлении рана. Половинчатый откат тут был бы хуже полного: агент, увидевший отпечаток в
 * ране, обязан иметь возможность спросить по нему disposition.
 *
 * Читается **по месту вызова**, а не один раз на процесс: тумблер обязан флипаться без рестарта,
 * и discovery (`features.blockerFingerprintV1`) обязан отвечать то же, что ручка.
 */
export const blockerFingerprintEnabled = (): boolean => process.env.EASYUI_BLOCKER_FINGERPRINT_DISABLED !== "1";

const sha256 = (value: string): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");

/**
 * Глубина переигровки. Порядок — это и есть семантика: `unchanged` < `recompute` < `rediff` <
 * `recapture` < `rebuild`, и run-level disposition — **максимум** по случаям (один случай,
 * требующий пересъёмки, делает ран пересъёмочным).
 */
export type RetryDispositionKind = "unchanged" | "recompute" | "rediff" | "recapture" | "rebuild";

export type RetrySuggestedAction = "do-not-retry" | "resume-run" | "new-run" | "update-source";

const DEPTH: Record<RetryDispositionKind, number> = {
  unchanged: 0, recompute: 1, rediff: 2, recapture: 3, rebuild: 4,
};

/**
 * Слой отпечатка → что придётся переиграть. Ключи — тот же тип `FieldLayer`, которым размечен
 * `FIELD_LAYERS` (`ids.ts`), поэтому появление нового слоя у поля не сможет молча разъехаться с
 * этой таблицей. `report-only` в disposition не участвует по определению: поле, не входящее ни в
 * один отпечаток, не может изменить вердикт.
 */
export const DISPOSITION_BY_LAYER: Record<Exclude<FieldLayer, "report-only">, RetryDispositionKind> = {
  frame: "recapture",
  comparison: "rediff",
  verdict: "recompute",
};

/** Поля basis в каноническом порядке: он же порядок `changed`/`unchanged` в ответе. */
export const BASIS_FIELDS = [
  "rendererFingerprint",
  "geometryContractVersion",
  "candidateSourceHash",
  "comparisonFingerprint",
  "verdictPolicyFingerprint",
  "readinessPolicyHash",
  "policyProfileHash",
  "caseFingerprintAlgoVersion",
] as const;

export type BasisField = (typeof BASIS_FIELDS)[number];

/**
 * Basis блокера — **сохранённое** состояние входов вердикта (форма §13 фидбэка).
 *
 * Два поля агрегированы канонизированно, а не скаляром (ревью раунда 2): `comparisonFingerprint` и
 * `verdictPolicyFingerprint` живут на случаях, и у семьи из 20 состояний их значения законно
 * расходятся. Сортированный набор различных значений — единственная форма, которая и стабильна
 * (порядок случаев на неё не влияет), и не врёт (не выдаёт одно из двадцати за общее).
 */
export interface BlockerBasis {
  /** Объявленный рендерер рана (колонка v30). `null` — ран до миграции: «неизвестно», не «другой». */
  rendererFingerprint: string | null;
  /** Версия контракта геометрии. В строке рана не хранится — это константа кода (см. `basisNote`). */
  geometryContractVersion: number;
  /** `source_hash` кандидата рана; `null` — кандидат вытеснен TTL/GC. */
  candidateSourceHash: string | null;
  comparisonFingerprint: string[];
  verdictPolicyFingerprint: string[];
  /**
   * Хэш readiness-политики профиля рана; `null` — профиль этому серверу неизвестен. Величина
   * **отчётная**: собственной колонки у неё нет, поэтому она выводится из профиля (то есть из
   * текущего кода) и в `changed` не попадает — смену readiness называют `rendererFingerprint` и
   * `policyProfileHash`, оба честно.
   */
  readinessPolicyHash: string | null;
  policyProfileHash: string;
  caseFingerprintAlgoVersion: number;
}

/**
 * Почему basis неполон и disposition поэтому не вычисляется (фидбэк §13: типизированный ответ, а
 * не 500). Каждое значение — **факт о данных**, а не сообщение: агент обязан различать «кандидата
 * вытеснил GC» и «набор случаев больше не восстановим».
 */
export type BasisIncompleteReason =
  | "candidate_evicted"
  | "case_set_evicted"
  | "case_set_unreconstructible"
  | "case_set_changed"
  | "policy_profile_unknown"
  | "case_fingerprint_layers_missing"
  | "no_cases";

export interface CaseDisposition {
  caseId: string;
  disposition: RetryDispositionKind;
  /** Слои, разошедшиеся у этого случая, в порядке глубины. */
  layers: Exclude<FieldLayer, "report-only">[];
}

export interface RetryDispositionView {
  runId: string;
  /** `blk_<sha256>`; `null` — блокера нет (ран прошёл/отменён) либо kill-switch поднят. */
  blockerFingerprint: string | null;
  disposition: RetryDispositionKind;
  changed: BasisField[];
  unchanged: BasisField[];
  suggestedAction: RetrySuggestedAction;
  basis: BlockerBasis;
  /** Присутствует только когда basis неполон; тогда disposition — `unchanged`/`do-not-retry`. */
  basisIncomplete?: BasisIncompleteReason;
  cases: CaseDisposition[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseJson(raw: string | null): unknown {
  if (raw === null || raw === "") return null;
  try { return JSON.parse(raw); } catch { return null; }
}

const sortedDistinct = (values: readonly (string | null)[]): string[] =>
  [...new Set(values.filter((value): value is string => typeof value === "string" && value !== ""))].sort();

// ------------------------------------------------------------------ basis и отпечаток блокера

/**
 * Сохранённый basis рана. Считается из трёх источников, ни один из которых не зависит от текущего
 * состояния каталога: строка рана, строки её случаев и строка кандидата.
 *
 * Два поля выведены, а не прочитаны, и это названо честно:
 * - `readinessPolicyHash` — из **профиля** рана (`policy_profile_id` персистирован), потому что
 *   сам хэш нигде не колонка; если профиль этому серверу неизвестен — `null`, а не выдумка;
 * - `geometryContractVersion` — константа кода. Её изменение видно disposition'у как расхождение
 *   кадрового слоя (`frameFingerprint` версией версионируется), но в basis она попадает текущим
 *   значением: другого источника у неё нет.
 */
export function storedBasisOf(
  run: AcceptanceRunRow,
  cases: readonly AcceptanceCaseRow[],
  candidate: CandidateRow | undefined,
): BlockerBasis {
  const profile = acceptancePolicy(run.policy_profile_id);
  return {
    rendererFingerprint: run.renderer_fingerprint,
    geometryContractVersion: GEOMETRY_CONTRACT_VERSION,
    candidateSourceHash: candidate?.source_hash ?? null,
    comparisonFingerprint: sortedDistinct(cases.map((row) => row.comparison_fingerprint)),
    verdictPolicyFingerprint: sortedDistinct(cases.map((row) => row.verdict_policy_hash)),
    readinessPolicyHash: profile ? readinessPolicyHashOf(profile.readiness) : null,
    policyProfileHash: run.policy_profile_hash,
    caseFingerprintAlgoVersion: CASE_FINGERPRINT_ALGO_VERSION,
  };
}

/**
 * Терминальные коды блокера — **сортированное** множество (ревью E5): порядок случаев и порядок
 * гейтов внутри случая на отпечаток влиять не имеют права.
 *
 * Что считается кодом: провалившийся или неопределённый гейт (`<gate>:<status>`), классифицированные
 * коды его метрик (`<gate>:<code>` — их эмитят гейты геометрии/readiness) и исход инфраструктурного
 * падения случая (`case_error:<outcome>`, колонка `error_json` v37). Последнее — не украшение: ран,
 * целиком упавший на аллокации рендерера, обязан иметь другой отпечаток, чем ран, упавший по
 * пикселям, иначе «тот же блокер» соврало бы на первом же рестарте.
 */
export function blockerCodesOf(cases: readonly AcceptanceCaseRow[]): string[] {
  const codes = new Set<string>();
  for (const row of cases) {
    const parsed = parseJson(row.gates_json);
    if (Array.isArray(parsed)) {
      for (const gate of parsed) {
        if (!isObject(gate)) continue;
        const name = String(gate.gate ?? "");
        const status = String(gate.status ?? "");
        if (status !== "fail" && status !== "indeterminate") continue;
        codes.add(`${name}:${status}`);
        const metrics = isObject(gate.metrics) ? gate.metrics : null;
        const metricCodes = metrics !== null && Array.isArray(metrics.codes) ? metrics.codes : [];
        for (const code of metricCodes) {
          const value = isObject(code) ? code.code : code;
          if (typeof value === "string" && value !== "") codes.add(`${name}:${value}`);
        }
      }
    }
    const error = parseJson(row.error_json);
    if (isObject(error) && typeof error.outcome === "string" && error.outcome !== "") {
      codes.add(`case_error:${error.outcome}`);
    }
  }
  return [...codes].sort();
}

/**
 * Есть ли у рана блокер вообще. Терминальные `fail`/`error` — да; терминальный `pass`* с
 * `indeterminate`-случаями — тоже да (фидбэк §13: неопределённость мешает не меньше провала, и
 * агенту нужен тот же дедуп). `cancelled` и нетерминальные раны блокера не имеют: их никто не
 * судил.
 */
export function runHasBlocker(run: AcceptanceRunRow, cases: readonly AcceptanceCaseRow[]): boolean {
  if (!isTerminalRunStatus(run.status)) return false;
  if (run.status === "fail" || run.status === "error") return true;
  if (run.status === "cancelled") return false;
  return cases.some((row) => row.verdict === "indeterminate");
}

/**
 * `blk_<sha256>` от канонизованного `{basis, codes}`. `null` — блокера нет либо kill-switch поднят.
 *
 * Единственная точка расчёта: её зовут и представление рана, и disposition-ручка, и evidence —
 * три ответа с разными значениями были бы хуже, чем отсутствие отпечатка вовсе.
 */
export function blockerFingerprintOf(
  run: AcceptanceRunRow,
  cases: readonly AcceptanceCaseRow[],
  candidate: CandidateRow | undefined,
): string | null {
  if (!blockerFingerprintEnabled()) return null;
  if (!runHasBlocker(run, cases)) return null;
  return `blk_${sha256(canonicalStringify({
    basis: storedBasisOf(run, cases, candidate),
    codes: blockerCodesOf(cases),
  }))}`;
}

// ------------------------------------------------------------------ would-be отпечатки

interface Reconstruction {
  cases: AcceptanceCase[];
  surface: CaseSurface;
  /** **Эффективная** политика рана (`requireVisual` набора применён), как в постановке и раннере. */
  policy: AcceptancePolicy;
}

/**
 * Набор случаев рана «как если бы его ставили сейчас».
 *
 * Case-set-путь идёт **тем же** кодом, что resume и оркестратор (`casesOfRun`, режим
 * `"reconstruction"`), с overlay из строки рана: durable-граф рана не имеет права разъехаться с
 * персистированными кадрами. Голова кандидата при этом не читается (`candidateEntry: null`) — в
 * режиме реконструкции она не влияет ни на один отпечаток (проверки фактов слотов сняты), а её
 * чтение требовало бы материализации бандла, которого у вытесненного кандидата уже нет.
 *
 * Examples-путь манифеста не имеет вовсе, и восстанавливать его нечем — но и нечего: у именованного
 * example нет ни эталона, ни ожидаемых габаритов, ни per-case политики, поэтому все входы
 * отпечатков лежат в колонках самой строки случая (`case_key`, `props_hash`, `reference_asset_id`,
 * `expected_geometry_json`). Именно они и подставляются — без единого обращения к бандлу.
 */
function reconstructCases(
  db: Database,
  repo: AcceptanceRepo,
  run: AcceptanceRunRow,
  candidate: CandidateRow,
  rows: readonly AcceptanceCaseRow[],
): Reconstruction | BasisIncompleteReason {
  const profile = acceptancePolicy(run.policy_profile_id);
  if (!profile) return "policy_profile_unknown";
  if (run.case_set_id === null) {
    const cases: AcceptanceCase[] = rows.map((row) => ({
      caseId: row.case_id,
      caseKey: row.case_key,
      props: {},
      propsHash: row.props_hash,
      aliasOfCaseId: row.alias_of_case_id,
      ...(row.reference_asset_id === null ? {} : { referenceAssetId: row.reference_asset_id }),
      ...(row.expected_geometry_json === null
        ? {}
        : { expectedGeometry: parseJson(row.expected_geometry_json) as { width: number; height: number } | null }),
    }));
    return { cases, surface: DEFAULT_CASE_SURFACE, policy: effectivePolicy(profile, null) };
  }
  const setRow = new CaseSetRepo(db).get(run.case_set_id);
  if (!setRow) return "case_set_evicted";
  const overlay = repo.runOverlay(run);
  try {
    // `manifestOfRow` тоже внутри try: манифест, записанный более новой сборкой, — это
    // `422 case_set_manifest_unreadable`, и он ровно та же «набор не восстановим», а не 500.
    const manifest = manifestOfRow(setRow);
    return {
      cases: casesOfRun({
        db,
        componentId: run.component_id,
        designSystem: candidate.design_system,
        candidateEntry: null,
        manifest,
        mode: "reconstruction",
        ...(overlay.length === 0 ? {} : { overlay }),
      }),
      surface: surfaceOfManifest(manifest),
      policy: effectivePolicy(profile, manifest),
    };
  } catch (error) {
    // Набор больше не восстановим (пин ребёнка исчез, overlay развалился) — это факт о данных, а
    // не 500: агенту он говорит ровно то же, что и вытесненный кандидат — ретраить нечего.
    if (error instanceof ApiError) return "case_set_unreconstructible";
    throw error;
  }
}

/** Голова компонента сейчас: её `sourceHash` — то, из чего собрался бы **новый** кандидат. */
function headSourceHash(db: Database, componentId: string): string | null {
  try { return sha256Hex(new ComponentRepo(db).source(componentId).source); }
  catch { return null; }
}

// ------------------------------------------------------------------ disposition

export interface RetryDispositionInput {
  db: Database;
  repo: AcceptanceRepo;
  run: AcceptanceRunRow;
  cases: readonly AcceptanceCaseRow[];
}

/**
 * Retry-disposition рана (BR-10a).
 *
 * Алгоритм по шагам:
 *
 * 1. Кандидат вытеснен / набор не восстановим / профиль неизвестен ⇒ типизированный ответ
 *    `unchanged` + `do-not-retry` + `basisIncomplete` (фидбэк §13).
 * 2. Иначе — для каждого случая считаются would-be отпечатки **той же** `caseFingerprintsOf` на
 *    текущих `rendererFingerprint`/`readinessPolicyHash`/политике, и сравниваются со слоями,
 *    персистированными в `acceptance_cases`.
 * 3. Слои → `DISPOSITION_BY_LAYER`; отдельный случай — совпали все три слоя, но разошёлся
 *    `case_fingerprint`: это ровно и только bump `CASE_FINGERPRINT_ALGO_VERSION`, и он даёт
 *    re-diff без пересъёмки (ALGO в `frameFingerprint` не входит).
 * 4. Смена `sourceHash` головы компонента ⇒ `rebuild` для всего рана: кандидат, которым его
 *    ставили, больше не описывает то, что автор собирается публиковать.
 *
 * `changed[]` называет **поля basis**, а не слои: агенту нужен ответ «что именно поменялось», а
 * слой — уже вывод из него. Кадровое расхождение, не объяснимое ни рендерером, ни readiness,
 * атрибутируется `geometryContractVersion` — единственному кадровому входу basis, который сервер
 * не персистит (см. `storedBasisOf`).
 */
export function retryDispositionOf(input: RetryDispositionInput): RetryDispositionView {
  const { db, repo, run } = input;
  const rows = [...input.cases];
  const candidate = repo.candidate(run.candidate_id);
  const basis = storedBasisOf(run, rows, candidate);
  const blockerFingerprint = blockerFingerprintOf(run, rows, candidate);
  // Продолжаемость — факт строки рана (BR-06, `resume_json`), а не вывод из статуса.
  const resumable = repo.runResume(run)?.resumable === true;

  const incomplete = (reason: BasisIncompleteReason): RetryDispositionView => ({
    runId: run.run_id,
    blockerFingerprint,
    disposition: "unchanged",
    changed: [],
    unchanged: [...BASIS_FIELDS],
    // Неполный basis — это «сравнивать не с чем», а не «всё в порядке»: единственный честный
    // совет здесь — не ретраить вслепую (фидбэк §13).
    suggestedAction: "do-not-retry",
    basis,
    basisIncomplete: reason,
    cases: [],
  });

  if (!candidate) return incomplete("candidate_evicted");
  if (rows.length === 0) return incomplete("no_cases");
  const reconstruction = reconstructCases(db, repo, run, candidate, rows);
  if (typeof reconstruction === "string") return incomplete(reconstruction);
  const policy = reconstruction.policy;

  const byCaseId = new Map(reconstruction.cases.map((item) => [item.caseId, item] as const));
  const changed = new Set<BasisField>();
  const cases: CaseDisposition[] = [];
  let deepest: RetryDispositionKind = "unchanged";

  const headHash = headSourceHash(db, run.component_id);
  const rebuild = headHash !== null && headHash !== candidate.source_hash;
  if (rebuild) changed.add("candidateSourceHash");

  const currentRenderer = rendererFingerprint(readinessPolicyHashOf(policy.readiness));
  if (run.renderer_fingerprint !== null && run.renderer_fingerprint !== currentRenderer) {
    changed.add("rendererFingerprint");
  }
  const currentPolicyHash = policyProfileHash(acceptancePolicy(run.policy_profile_id)!);
  if (run.policy_profile_hash !== currentPolicyHash) changed.add("policyProfileHash");

  const wouldBeComparison: (string | null)[] = [];
  const wouldBeVerdict: (string | null)[] = [];

  for (const row of rows) {
    const item = byCaseId.get(row.case_id);
    if (item === undefined) return incomplete("case_set_changed");
    // Строка до миграции v29 слоёв не несёт: сравнивать не с чем, и притворяться, что «ничего не
    // изменилось», нельзя (тот же принцип, что у `caseResultForFrameComparison` — D17).
    if (row.frame_fingerprint === null || row.comparison_fingerprint === null || row.verdict_policy_hash === null) {
      return incomplete("case_fingerprint_layers_missing");
    }
    const fps = caseFingerprintsOf({
      candidateId: candidate.candidate_id,
      surface: reconstruction.surface,
      policy,
      case: item,
    });
    wouldBeComparison.push(fps.comparison);
    wouldBeVerdict.push(fps.verdictPolicy);

    const layers: Exclude<FieldLayer, "report-only">[] = [];
    if (row.verdict_policy_hash !== fps.verdictPolicy) layers.push("verdict");
    if (row.comparison_fingerprint !== fps.comparison) layers.push("comparison");
    if (row.frame_fingerprint !== fps.frame) layers.push("frame");
    // Все три слоя совпали, а итоговый отпечаток — нет: это и только это означает подъём
    // `CASE_FINGERPRINT_ALGO_VERSION`. Он не входит в кадр, поэтому платой является re-diff.
    if (layers.length === 0 && row.case_fingerprint !== fps.case) {
      layers.push("comparison");
      changed.add("caseFingerprintAlgoVersion");
    }
    if (layers.includes("frame")) {
      // Кадр разошёлся, а объявленные кадровые входы basis — нет: единственный оставшийся
      // кадровый вход, который сервер не хранит, — версия контракта геометрии.
      if (!changed.has("rendererFingerprint")) changed.add("geometryContractVersion");
    }
    let disposition: RetryDispositionKind = rebuild ? "rebuild" : "unchanged";
    for (const layer of layers) {
      const candidateDisposition = DISPOSITION_BY_LAYER[layer];
      if (DEPTH[candidateDisposition] > DEPTH[disposition]) disposition = candidateDisposition;
    }
    if (DEPTH[disposition] > DEPTH[deepest]) deepest = disposition;
    cases.push({ caseId: row.case_id, disposition, layers });
  }

  if (sortedDistinct(wouldBeComparison).join(" ") !== basis.comparisonFingerprint.join(" ")) {
    changed.add("comparisonFingerprint");
  }
  if (sortedDistinct(wouldBeVerdict).join(" ") !== basis.verdictPolicyFingerprint.join(" ")) {
    changed.add("verdictPolicyFingerprint");
  }
  // `readinessPolicyHash` в `changed` не появляется **никогда**, и это не пропуск: собственного
  // хэша readiness строка рана не хранит, а выводится он из профиля — то есть из текущего кода, и
  // сравнивать его было бы сравнением значения с самим собой. Смена readiness видна двумя другими
  // именами, и обоими честно: `rendererFingerprint` (политика входит в него по построению) и
  // `policyProfileHash` (readiness — поле профиля). Поле остаётся в basis как **отчёт** — по нему
  // читатель evidence понимает, каким ожиданием готовности мерили.
  const changedFields = BASIS_FIELDS.filter((field) => changed.has(field));
  return {
    runId: run.run_id,
    blockerFingerprint,
    disposition: deepest,
    changed: changedFields,
    unchanged: BASIS_FIELDS.filter((field) => !changed.has(field)),
    suggestedAction: suggestedActionOf(deepest, resumable),
    basis,
    cases,
  };
}

/**
 * Совет действия.
 *
 * Порядок ветвлений — не косметика: `rebuild` сильнее всего (продолжать ран, снятый с другого
 * исходника, бессмысленно), затем продолжаемость (BR-06: у остановленного рана есть дешёвый путь
 * доиграть его, и он дешевле нового рана даже когда basis не двигался), и только потом обычная
 * пара «ничего не изменилось ⇒ не ретраить / изменилось ⇒ новый ран».
 *
 * `resume-run` формально принадлежит BR-10b (V5), но отдаётся уже сейчас: `resume_json` появился в
 * BR-06, ручка `/resume` работает, и молчать о ней ради номера волны значило бы советовать агенту
 * более дорогой путь при существующем дешёвом.
 */
export function suggestedActionOf(disposition: RetryDispositionKind, resumable: boolean): RetrySuggestedAction {
  if (disposition === "rebuild") return "update-source";
  if (resumable) return "resume-run";
  return disposition === "unchanged" ? "do-not-retry" : "new-run";
}
