/**
 * **Suggested policy** — предложение минимальной правки бюджета по типизированной причине провала
 * (план `docs/plans/2026-08-07-migration-feedback-wave.md` §W7, P1.3; AC §9).
 *
 * Модуль живёт **здесь**, а не в `server/visual/causes.ts` (триаж C-M7): предложение обязано знать
 * серверные пресеты (`TEXT_AA_PRESETS` в `gates/visual.ts`) и профили приёмки (`policies.ts`), а
 * `gates/visual.ts` уже импортирует `CAUSE_THRESHOLDS` из таксономии — положив продюсер в
 * `causes.ts`, мы получили бы цикл. Таксономия остаётся листом.
 *
 * Четыре границы, за которые модуль не выходит:
 *
 * 1. **Report-only.** Предложение никогда не применяется само и ни во что не входит: ни в один
 *    отпечаток, ни в свёртку вердикта, ни в гейты. Оно едет в отчёт рана и в `?case=<id>` рядом с
 *    причинами и всегда несёт `requiresHumanJudgement: true`.
 * 2. **Отказ при структурной причине обязателен** (AC §9.2). Сдвиг геометрии, выход за маску,
 *    переполнение эффектом, недогруженный ассет — это дефекты, а не допуски; никакой бюджет их не
 *    «прощает», и предложение в этих случаях — `null`, а не «поднимите порог».
 * 3. **Предложение не изобретает ручек.** Разрешены ровно две правки, обе уже существующие в
 *    контракте манифеста: именованный пресет `textAaBudget` (числа принадлежат серверу) и per-case
 *    `policy.perCase.<caseId>.maxRawDiffPct`. Пресет предпочитается всегда, когда он накрывает
 *    факт: он документирован и не даёт свободной ручки.
 * 4. **Бюджет минимален и ограничен сверху.** Предлагается наименьшее значение, накрывающее
 *    измеренный факт, а потолок — самый мягкий `visual.maxRawDiffPct` среди профилей реестра:
 *    выше него «исключение для случая» превращается в просьбу выключить визуальный гейт, и модуль
 *    молчит.
 *
 * Вторая половина модуля — **advisory-expiry** принятых исключений (AC §9.3, триаж S-M8).
 * Durable-хранилища принятых исключений не существует (per-case бюджеты живут в контентно-
 * адресованных манифестах), поэтому механизм — предупреждение `policy_exception_stale` в
 * `accept-status`: рендерер сменился с тех пор, как случай с бюджетом впервые прошёл, и исключение
 * стоит перепроверить. Baseline берётся **только по пост-W2 ранам** (раунд 2, N8) — см.
 * `isPostBarrierRun`.
 */
import type { TextAaBudget } from "../../src/acceptance/caseSetSchema";
import type { VisualCause, VisualCauseCode } from "../visual/causes";
import { TEXT_AA_PRESETS, type TextAaPreset } from "./gates/visual";
import { ACCEPTANCE_POLICIES, acceptancePolicy, policyProfileHash, type AcceptancePolicy } from "./policies";

/**
 * Kill-switch волны (`EASYUI_SUGGESTED_POLICY_DISABLED=1`, регистрация — `server/main.ts`,
 * compose-строка — W11). Гасит **обе** производные: и предложение в отчёте, и advisory-expiry.
 * Env читается по месту (прецедент `impactedSnapEnabled`), параметр — ради тестов.
 */
export const suggestedPolicyEnabled = (raw: string | undefined = process.env.EASYUI_SUGGESTED_POLICY_DISABLED): boolean =>
  raw !== "1";

/**
 * Причины, при которых предложение не выдаётся никогда (AC §9.2): расхождение структурное —
 * содержимое нарисовано не там, вылезло за маску, переполнило контейнер эффектом либо кадр снят
 * до готовности ресурсов. Ни один из этих случаев не чинится бюджетом.
 */
export const STRUCTURAL_CAUSE_CODES: ReadonlySet<VisualCauseCode> = new Set<VisualCauseCode>([
  "geometry-shift", "descendant-outside-mask", "effect-overflow", "missing-late-asset",
]);

/**
 * Единственная причина, под которую бюджет вообще осмыслен: остаток лежит на собственных контурах
 * эталона, то есть расхождение — растеризация живого текста против PNG-экспорта. `surface-tint`,
 * `edge-radius-stroke` и `alpha-compositing` сюда не входят намеренно: другой цвет, другая рамка и
 * другая альфа — это разница, а не шум, и «поднять порог» означало бы спрятать её.
 */
export const BUDGETABLE_CAUSE_CODE: VisualCauseCode = "text-raster-residual";

/**
 * Потолок предлагаемого `maxRawDiffPct` — самый мягкий визуальный бюджет реестра профилей.
 * Величина выведена, а не назначена: предложение, которое мягче любого профиля, перестаёт быть
 * исключением для одного случая.
 */
export const SUGGEST_MAX_RAW_DIFF_PCT = Math.max(
  ...Object.values(ACCEPTANCE_POLICIES).map((profile) => profile.visual.maxRawDiffPct),
);

/** Пресеты по возрастанию потолка: «минимальный накрывающий» ищется именно в этом порядке. */
const PRESETS_BY_BUDGET: TextAaPreset[] = Object.values(TEXT_AA_PRESETS)
  .sort((left, right) => left.maxRawDiffPct - right.maxRawDiffPct);

export interface SuggestedPolicyEvidence {
  topCause: VisualCauseCode;
  confidence: number;
  rawDiffPct: number;
  currentMaxRawDiffPct: number | null;
  edgeResidualInsidePct: number | null;
  bestOffset: { dx: number; dy: number; residualPct: number } | null;
  geometryClean: boolean;
  affectedElementKeys: string[];
  rendererFingerprint: string | null;
}

export interface SuggestedPolicy {
  kind: "textAaBudget" | "maxRawDiffPct";
  /** Имя серверного пресета (`kind: "textAaBudget"`). */
  textAaBudget?: TextAaBudget;
  /** Минимальное значение per-case бюджета, накрывающее факт (`kind: "maxRawDiffPct"`). */
  maxRawDiffPct?: number;
  /** Куда именно в манифесте вносится правка — путь, а не пересказ. */
  target: string;
  /** Почему предложено именно это значение (одна фраза для читателя отчёта). */
  basis: string;
  scope: "case-id" | "remediation-group";
  caseIds: string[];
  /** Ключ группы ремедиаций (`scope: "remediation-group"`): одна правка на все случаи группы. */
  remediationKey?: string;
  evidence: SuggestedPolicyEvidence;
  expiry: {
    trigger: "renderer-or-source-fingerprint-change";
    rendererFingerprint: string | null;
    referenceAssetId: string | null;
  };
  /** Всегда `true`: предложение — вход для решения человека, а не автоприменяемая правка. */
  requiresHumanJudgement: true;
}

/** Минимальная форма результата гейта, которой достаточно модулю (`GateResult` ей соответствует). */
export interface SuggestGate {
  gate: string;
  status: string;
  metrics?: Record<string, unknown>;
  causes?: VisualCause[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const numberOr = (value: unknown, fallback: number | null): number | null =>
  (typeof value === "number" && Number.isFinite(value) ? value : fallback);

const gateOf = (gates: readonly SuggestGate[], name: string): SuggestGate | undefined =>
  gates.find((gate) => gate.gate === name);

/** Округление вверх до сотых: бюджет обязан накрывать факт, а не «примерно совпадать» с ним. */
const ceil2 = (value: number): number => Math.ceil(value * 100) / 100;

/**
 * Предложение по одному случаю. `null` — предложения нет, и это **штатный** ответ: структурная
 * причина, небюджетируемая причина, недоказанный остаток, отсутствующие метрики или факт выше
 * потолка. Отсутствие предложения никогда не означает «случай в порядке».
 */
export function suggestPolicy(
  gates: readonly SuggestGate[],
  context: { caseId: string; rendererFingerprint?: string | null },
): SuggestedPolicy | null {
  const visual = gateOf(gates, "visual");
  // Объяснять и предлагать есть что только у провального визуального исхода; `indeterminate`
  // (несводимые размеры, нет эталона) бюджетом не лечится — там нечего измерять.
  if (!visual || visual.status !== "fail") return null;
  const causes = visual.causes ?? [];
  const top = causes[0];
  if (!top) return null;
  if (STRUCTURAL_CAUSE_CODES.has(top.code)) return null;
  if (top.code !== BUDGETABLE_CAUSE_CODE) return null;

  // Провал по геометрии — тоже структурный отказ, даже когда визуальная причина растровая: случай,
  // у которого не сошлись поверхности, нельзя «дотерпеть» пиксельным бюджетом (AC §9.2).
  const geometry = gateOf(gates, "geometry");
  const geometryClean = geometry === undefined || geometry.status === "pass" || geometry.status === "skipped";
  if (!geometryClean) return null;

  const metrics = visual.metrics ?? {};
  const rawDiffPct = numberOr(metrics.rawDiffPct, null);
  if (rawDiffPct === null) return null;
  const current = numberOr(metrics.maxRawDiffPct, null);
  const edgeResidual = isObject(metrics.edgeResidual) ? metrics.edgeResidual : null;
  const insidePct = numberOr(edgeResidual?.insidePct, null);
  const declared = isObject(metrics.textAaBudget) && typeof metrics.textAaBudget.preset === "string"
    ? metrics.textAaBudget.preset
    : null;

  // Пресет применяется только к **доказанно** растровому остатку; без измерения `edgeResidual`
  // («не измерено» ≠ «в допуске») предложения нет вовсе — это тот же инвариант, что у гейта.
  if (insidePct === null) return null;

  const evidence: SuggestedPolicyEvidence = {
    topCause: top.code,
    confidence: top.confidence,
    rawDiffPct,
    currentMaxRawDiffPct: current,
    edgeResidualInsidePct: insidePct,
    bestOffset: isObject(metrics.bestOffset)
      ? {
        dx: numberOr(metrics.bestOffset.dx, 0) ?? 0,
        dy: numberOr(metrics.bestOffset.dy, 0) ?? 0,
        residualPct: numberOr(metrics.bestOffset.residualPct, 0) ?? 0,
      }
      : null,
    geometryClean: true,
    affectedElementKeys: [...new Set(causes.flatMap((cause) => (cause.elementKey === undefined ? [] : [cause.elementKey])))].sort(),
    rendererFingerprint: context.rendererFingerprint ?? null,
  };
  const expiry = {
    trigger: "renderer-or-source-fingerprint-change" as const,
    rendererFingerprint: context.rendererFingerprint ?? null,
    referenceAssetId: typeof metrics.referenceAssetId === "string" ? metrics.referenceAssetId : null,
  };

  // 1. Минимальный накрывающий **пресет**: имя, а не число. Уже объявленный случаем пресет
  //    кандидатом не является — он этот факт не накрыл, иначе случай бы прошёл.
  const preset = PRESETS_BY_BUDGET.find((item) =>
    item.id !== declared && rawDiffPct <= item.maxRawDiffPct && insidePct >= item.minEdgeResidualPct);
  if (preset) {
    return {
      kind: "textAaBudget",
      textAaBudget: preset.id,
      target: `cases[${context.caseId}].textAaBudget`,
      basis: `raw diff ${rawDiffPct}% with ${insidePct}% of the residual on the reference's own edges`
        + ` fits the ${preset.id} preset (≤${preset.maxRawDiffPct}%, ≥${preset.minEdgeResidualPct}% required)`,
      scope: "case-id",
      caseIds: [context.caseId],
      evidence, expiry,
      requiresHumanJudgement: true,
    };
  }

  // 2. Пресета, накрывающего факт, нет — остаётся per-case бюджет. Тюнинг пресета запрещён по
  //    построению (`live-text-v2` — это новый пресет, а не другие числа под тем же именем).
  if (rawDiffPct > SUGGEST_MAX_RAW_DIFF_PCT) return null;
  const proposed = Math.max(ceil2(rawDiffPct), current === null ? 0 : ceil2(current + 0.01));
  if (proposed > SUGGEST_MAX_RAW_DIFF_PCT) return null;
  if (current !== null && proposed <= current) return null;
  return {
    kind: "maxRawDiffPct",
    maxRawDiffPct: proposed,
    target: `policy.perCase.${context.caseId}.maxRawDiffPct`,
    basis: `raw diff ${rawDiffPct}% is entirely on the reference's own edges (${insidePct}% inside)`
      + ` but exceeds every named text preset; ${proposed}% is the smallest per-case budget covering it`,
    scope: "case-id",
    caseIds: [context.caseId],
    evidence, expiry,
    requiresHumanJudgement: true,
  };
}

/**
 * Предложение на **группу ремедиаций** (§19.6 + AC §9.1): одна причина в одном месте ⇒ одна
 * правка, а не N одинаковых правок в N случаях.
 *
 * Группа получает предложение, только если оно есть у **каждого** участника и все они одного вида:
 * группа, где половина случаев чинится пресетом, а половина — числом, требует решения человека по
 * каждому, и склеенное предложение соврало бы про её однородность. Значение берётся самое широкое
 * из участников — оно накрывает всю группу по построению.
 */
export function groupSuggestion(remediationKey: string, members: readonly SuggestedPolicy[]): SuggestedPolicy | null {
  if (members.length === 0) return null;
  const kind = members[0]!.kind;
  if (members.some((item) => item.kind !== kind)) return null;
  const widest = members.reduce((left, right) => {
    if (kind === "maxRawDiffPct") return (right.maxRawDiffPct ?? 0) > (left.maxRawDiffPct ?? 0) ? right : left;
    const budgetOf = (item: SuggestedPolicy): number =>
      PRESETS_BY_BUDGET.find((preset) => preset.id === item.textAaBudget)?.maxRawDiffPct ?? 0;
    return budgetOf(right) > budgetOf(left) ? right : left;
  });
  const caseIds = [...new Set(members.flatMap((item) => item.caseIds))].sort();
  return {
    ...widest,
    target: kind === "maxRawDiffPct"
      ? `policy.perCase.<each of ${caseIds.length} case(s)>.maxRawDiffPct`
      : `cases[<each of ${caseIds.length} case(s)>].textAaBudget`,
    scope: "remediation-group",
    caseIds,
    remediationKey,
  };
}

// ------------------------------------------------------------------ advisory expiry (AC §9.3)

/** Объявленное исключение случая — то, что предложение когда-то и создало. */
export type PolicyExceptionKind = "textAaBudget" | "maxRawDiffPct" | "sizeDeltaPx" | "overflowBudgetPx";

/**
 * Какие бюджеты действовали в случае, судя по его сохранённым метрикам.
 *
 * Источник — метрики гейтов, а не манифест: манифест контентно-адресован и может быть недоступен,
 * а метрики персистятся строкой случая и переживают всё. `textAaBudget`/`overflowBudgetPx` —
 * абсолютные маркеры (их не бывает без декларации), `maxRawDiffPct`/`sizeDeltaPx` — сравнением с
 * профилем рана: per-case значение побеждает профильное, и именно расхождение делает его
 * объявленным исключением.
 */
export function declaredExceptionsOf(
  gates: readonly SuggestGate[],
  profile: AcceptancePolicy | undefined,
): PolicyExceptionKind[] {
  const out: PolicyExceptionKind[] = [];
  const visual = gateOf(gates, "visual")?.metrics ?? {};
  const geometry = gateOf(gates, "geometry")?.metrics ?? {};
  if (isObject(visual.textAaBudget)) out.push("textAaBudget");
  if (profile !== undefined) {
    const max = numberOr(visual.maxRawDiffPct, null);
    if (max !== null && max !== profile.visual.maxRawDiffPct) out.push("maxRawDiffPct");
    const size = numberOr(geometry.sizeTolerancePx, null);
    if (size !== null && size !== profile.geometry.sizeDeltaPx) out.push("sizeDeltaPx");
  }
  if (isObject(geometry.overflowBudgetPx)) out.push("overflowBudgetPx");
  return out;
}

/**
 * **Дискриминатор пост-W2 рана** (раунд 2, N8).
 *
 * W2 включила барьер ресурсов внутрь readiness-политики профилей, а `policy_profile_hash` — sha256
 * профиля **целиком**, включая `readiness`. Значит, у любого доволнового рана этот хэш заведомо не
 * равен сегодняшнему хэшу того же профиля, а у пост-волнового — равен. Сравнение с
 * `renderer_fingerprint` напрямую невозможно (он необратим), а хранить отдельный «маркер волны»
 * значило бы завести второй источник истины о том же факте.
 *
 * Следствие, принятое сознательно: **любая** будущая правка профиля так же обнуляет baseline. Это
 * честно — исключение, принятое под другой политикой, и должно быть перепроверено.
 *
 * Следствие второе: при `EASYUI_RESOURCE_BARRIER_DISABLED=1` реестр профилей возвращается к
 * доволновым политикам, и «пост-W2» снова означает доволновые раны — ровно то, что нужно, потому
 * что вместе с политикой откатывается и рендерер.
 */
export const isPostBarrierRun = (run: { policyProfileId: string; policyProfileHash: string }): boolean => {
  const profile = acceptancePolicy(run.policyProfileId);
  return profile !== undefined && policyProfileHash(profile) === run.policyProfileHash;
};

/** Строка истории: случай, прошедший в более раннем ране того же компонента и того же набора. */
export interface PolicyExceptionHistoryRow {
  runId: string;
  createdAt: string;
  rendererFingerprint: string | null;
  policyProfileId: string;
  policyProfileHash: string;
  caseId: string;
  gates: SuggestGate[];
}

export interface PolicyExceptionWarning {
  code: "policy_exception_stale";
  caseId: string;
  exceptions: PolicyExceptionKind[];
  /** Ран, в котором случай с этим исключением впервые прошёл (только пост-W2 раны). */
  baselineRunId: string;
  baselineRendererFingerprint: string;
  rendererFingerprint: string;
  detail: string;
}

/**
 * Предупреждения `policy_exception_stale` для `accept-status` (AC §9.3, advisory-форма).
 *
 * Условие ровно одно: случай **прошёл** под объявленным бюджетом, а рендерер этого рана отличается
 * от рендерера самого раннего пост-W2 рана, где тот же случай с тем же бюджетом проходил. Это не
 * вердикт и не отказ — исключение, принятое под другим рендерером, могло стать ненужным (или
 * недостаточным), и его стоит перепроверить.
 *
 * Раны без `renderer_fingerprint` (до миграции v30) и доволновые раны в baseline не участвуют:
 * «неизвестно» — не «другой», а сравнение с доволновым рендерером дало бы ложный stale на всех
 * бюджетных случаях на весь период пересъёмки.
 */
export function policyExceptionWarnings(input: {
  run: { runId: string; rendererFingerprint: string | null; policyProfileId: string; policyProfileHash: string };
  cases: { caseId: string; verdict: string | null; gates: SuggestGate[] }[];
  history: readonly PolicyExceptionHistoryRow[];
}): PolicyExceptionWarning[] {
  const { run } = input;
  if (run.rendererFingerprint === null || !isPostBarrierRun(run)) return [];
  const profile = acceptancePolicy(run.policyProfileId);

  // История: только пост-W2 раны с известным рендерером, в порядке появления (SQL уже отсортировал).
  const baselineByCase = new Map<string, PolicyExceptionHistoryRow>();
  for (const row of input.history) {
    if (baselineByCase.has(row.caseId)) continue;
    if (row.rendererFingerprint === null) continue;
    if (!isPostBarrierRun(row)) continue;
    if (declaredExceptionsOf(row.gates, acceptancePolicy(row.policyProfileId)).length === 0) continue;
    baselineByCase.set(row.caseId, row);
  }

  const warnings: PolicyExceptionWarning[] = [];
  for (const item of input.cases) {
    if (item.verdict !== "pass") continue;
    const exceptions = declaredExceptionsOf(item.gates, profile);
    if (exceptions.length === 0) continue;
    const baseline = baselineByCase.get(item.caseId);
    if (!baseline || baseline.rendererFingerprint === run.rendererFingerprint) continue;
    warnings.push({
      code: "policy_exception_stale",
      caseId: item.caseId,
      exceptions,
      baselineRunId: baseline.runId,
      baselineRendererFingerprint: baseline.rendererFingerprint!,
      rendererFingerprint: run.rendererFingerprint,
      detail: `Case ${item.caseId} passes under a declared budget (${exceptions.join(", ")}) that was first accepted`
        + ` by run ${baseline.runId} under a different renderer; re-check the exception against the current renderer`,
    });
  }
  return warnings.sort((left, right) => (left.caseId < right.caseId ? -1 : left.caseId > right.caseId ? 1 : 0));
}
