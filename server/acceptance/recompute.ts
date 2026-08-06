/**
 * Пересчёт вердикта случая по **сохранённым метрикам** (план `docs/plans/2026-08-04-acceptance-pipeline-feedback.md`,
 * решение D-B, волна W1).
 *
 * Зачем модуль существует. До этой волны порог визуального гейта входил в `case_fingerprint`
 * плоским хэшем: смена одного числа в политике обнуляла reuse целиком, и матрица на 49 состояний
 * переснималась ради вопроса, ответ на который уже лежал в `metrics_json` («0.8% расхождения — это
 * больше нового бюджета 0.5% или нет?»). Пересъёмка ради арифметики — не строгость, а налог.
 *
 * Три инварианта, которые здесь держатся жёстко:
 *
 * 1. **Пересчёт — только по дельте политики, и только для гейтов, которые её умеют пересчитать**
 *    (C26). Правило «по имени гейта» было бы дырой: перенести `readiness`-вердикт, потому что
 *    «менялся-то визуальный порог», можно лишь если доказано, что дельта до readiness не достаёт.
 *    Поэтому вход — карта «поле политики → затронутые гейты», а не список «эти гейты переносим».
 * 2. **Старая политика приходит снимком по значениям** (D0/D14). Хэша недостаточно: он отвечает
 *    «отличается ли», а нужно «чем именно». Снимка нет ⇒ дельта неизвестна ⇒ вызывающий обязан
 *    переснять, а не переносить (`reevaluable: false`).
 * 3. **Геометрия считается от сырых `layoutBounds`/`paintBounds`/`effectSources`**, а не от
 *    `overflow`, уже отфильтрованного **старым** допуском (D0). Иначе новый, более строгий допуск
 *    никогда не увидел бы переполнения, отброшенного прошлым порогом, — и ужесточение политики
 *    молча не срабатывало бы.
 *
 * Чего модуль не делает: не ходит в БД, не читает CAS, не решает судьбу случая. `reevaluateGates` —
 * чистая функция; перезапись производных артефактов (`visual.json`/`geometry.json` с
 * `derivedFrom`) вынесена в отдельную async-функцию, потому что это уже запись в CAS.
 */
import {
  evaluateGeometryPolicy, geometryVerdictBlocks,
  type GeometryPolicyClipLink, type GeometryPolicyEffectSource, type GeometryPolicyRect, type GeometryTolerancesInput,
} from "../../src/capture/geometryPolicy";
import type { TextAaBudget } from "../../src/acceptance/caseSetSchema";
import { putArtifact, readArtifact } from "./evidence";
import { geometryCodes } from "./gates/geometry2";
import { textAaBudgetApplies, textAaPresetOf } from "./gates/visual";
import type { GateArtifactRef, GateResult } from "./gates/types";
import type { VerdictPolicySnapshot } from "./ids";
import type { GateName } from "./policies";

/**
 * Kill-switch пересчёта (`EASYUI_ACCEPTANCE_VERDICT_RECOMPUTE`, план §«Волны»): выключенный флаг
 * гасит **и** recompute, **и** re-diff — любой промах `case_fingerprint` уводит в пересъёмку.
 * Полумеры («re-diff оставим») здесь недопустимы: обе ветки опираются на один и тот же аппарат
 * слоёв, и доверять половине аппарата, не доверяя другой, бессмысленно (D8).
 *
 * Откат флага **не ретроактивен**: уже записанные recompute-производные строки остаются годными
 * (их чистка — bump `CASE_FINGERPRINT_ALGO_VERSION`, не флаг).
 */
export const verdictRecomputeEnabled = (): boolean =>
  (process.env.EASYUI_ACCEPTANCE_VERDICT_RECOMPUTE ?? "1") !== "0";

/** Листовое поле вердиктного снимка — единица дельты и ключ карты «поле → гейты». */
export type VerdictPolicyField =
  | "policyProfileId" | "gates" | "requireVisual" | "allowExceptions" | "maxRawDiffPct"
  | "geometry.overflowPx" | "geometry.sizeDeltaPx" | "geometry.offsetPx"
  | "perCase.maxRawDiffPct" | "perCase.allowPaintOverflow" | "perCase.expectedClip"
  | "perCase.sizeDeltaPx" | "perCase.overflowBudgetPx"
  | "textAaBudget"
  | "expectedGeometry" | "declaredPolicyProfile";

/**
 * Карта «поле политики → гейты, чей вердикт оно может изменить» (C26).
 *
 * Пустой список — не «поле неважно», а «поле не меняет ни одного гейтового вердикта, только
 * свёртку случая»: `allowExceptions` и идентичность профиля именно таковы, и их дельта честно
 * закрывается пересчётом свёртки (`caseVerdictOf` по новой политике) без трогания гейтов.
 */
export const GATES_BY_POLICY_FIELD: Record<VerdictPolicyField, readonly GateName[]> = {
  policyProfileId: [],
  // Роли гейтов меняют не их статусы, а участие в свёртке; исключение — переход в/из
  // `not-implemented`, который разбирается отдельно (гейт мог не считаться вовсе).
  gates: [],
  requireVisual: ["visual"],
  allowExceptions: [],
  maxRawDiffPct: ["visual"],
  "geometry.overflowPx": ["geometry"],
  "geometry.sizeDeltaPx": ["geometry"],
  "geometry.offsetPx": ["geometry"],
  "perCase.maxRawDiffPct": ["visual"],
  "perCase.allowPaintOverflow": ["geometry"],
  "perCase.expectedClip": ["geometry"],
  // W3 (план 2026-08-06): оба per-case числа — чистый вердиктный слой. Ни съёмка, ни сравнение от
  // них не зависят, поэтому смена бюджета пересчитывается по сохранённым метрикам.
  "perCase.sizeDeltaPx": ["geometry"],
  "perCase.overflowBudgetPx": ["geometry"],
  // W4: пресет растрового текста — вторая инстанция визуального вердикта. Пересчитывается по
  // сохранённым метрикам, **если** в них есть `edgeResidual`; если нет — `recomputeVisual`
  // честно отказывается (см. ниже), и каскад уходит на re-diff.
  textAaBudget: ["visual"],
  expectedGeometry: ["geometry"],
  declaredPolicyProfile: [],
};

/** Гейты, вердикт которых восстановим из сохранённых метрик без единого нового пикселя. */
export const REEVALUABLE_GATES: readonly GateName[] = ["visual", "geometry"];

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/** Изменившиеся листовые поля вердиктного снимка. Порядок стабилен — он уезжает в квитанцию reuse. */
export function verdictPolicyDelta(oldPolicy: VerdictPolicySnapshot, newPolicy: VerdictPolicySnapshot): VerdictPolicyField[] {
  const delta: VerdictPolicyField[] = [];
  const check = (field: VerdictPolicyField, left: unknown, right: unknown): void => {
    if (!same(left, right)) delta.push(field);
  };
  check("policyProfileId", oldPolicy.policyProfileId, newPolicy.policyProfileId);
  check("gates", oldPolicy.gates, newPolicy.gates);
  check("requireVisual", oldPolicy.requireVisual, newPolicy.requireVisual);
  check("allowExceptions", oldPolicy.allowExceptions, newPolicy.allowExceptions);
  check("maxRawDiffPct", oldPolicy.maxRawDiffPct, newPolicy.maxRawDiffPct);
  check("geometry.overflowPx", oldPolicy.geometry.overflowPx, newPolicy.geometry.overflowPx);
  check("geometry.sizeDeltaPx", oldPolicy.geometry.sizeDeltaPx, newPolicy.geometry.sizeDeltaPx);
  check("geometry.offsetPx", oldPolicy.geometry.offsetPx, newPolicy.geometry.offsetPx);
  check("perCase.maxRawDiffPct", oldPolicy.perCase?.maxRawDiffPct, newPolicy.perCase?.maxRawDiffPct);
  check("perCase.allowPaintOverflow", oldPolicy.perCase?.allowPaintOverflow, newPolicy.perCase?.allowPaintOverflow);
  check("perCase.expectedClip", oldPolicy.perCase?.expectedClip, newPolicy.perCase?.expectedClip);
  check("perCase.sizeDeltaPx", oldPolicy.perCase?.sizeDeltaPx, newPolicy.perCase?.sizeDeltaPx);
  check("perCase.overflowBudgetPx", oldPolicy.perCase?.overflowBudgetPx, newPolicy.perCase?.overflowBudgetPx);
  check("textAaBudget", oldPolicy.textAaBudget, newPolicy.textAaBudget);
  check("expectedGeometry", oldPolicy.expectedGeometry, newPolicy.expectedGeometry);
  check("declaredPolicyProfile", oldPolicy.declaredPolicyProfile, newPolicy.declaredPolicyProfile);
  return delta;
}

/**
 * Переход роли гейта, который делает перенос невозможным: гейт **не считался вовсе**
 * (`not-implemented`) в одном из состояний политики. Метрик, которых не собирали, не бывает, а
 * выкидывать посчитанный вердикт «потому что теперь гейт выключен» — тоже подлог: свёртка обязана
 * работать над тем набором гейтов, который объявлен сейчас.
 */
function gateRolesReevaluable(oldPolicy: VerdictPolicySnapshot, newPolicy: VerdictPolicySnapshot): boolean {
  for (const [name, mode] of Object.entries(oldPolicy.gates) as [GateName, string][]) {
    const next = newPolicy.gates[name];
    if (mode === next) continue;
    if (mode === "not-implemented" || next === "not-implemented") return false;
  }
  return true;
}

export interface ReevaluationResult {
  /** Гейты случая после пересчёта (новые объекты у затронутых, прежние ссылки у остальных). */
  gates: GateResult[];
  /** Дельта пересчитываема целиком: каждый затронутый гейт умеет считаться от своих метрик. */
  reevaluable: boolean;
  /** Хотя бы один гейтовый вердикт изменился (для квитанции и для решения «переписывать ли артефакт»). */
  changed: boolean;
  delta: VerdictPolicyField[];
  /** Имена гейтов, которые действительно пересчитывались. */
  recomputedGates: GateName[];
  /** Почему пересчёт невозможен (только при `reevaluable: false`). */
  reason?: string;
}

const carry = (gates: GateResult[], delta: VerdictPolicyField[]): ReevaluationResult =>
  ({ gates, reevaluable: true, changed: false, delta, recomputedGates: [] });

const refuse = (gates: GateResult[], delta: VerdictPolicyField[], reason: string): ReevaluationResult =>
  ({ gates, reevaluable: false, changed: false, delta, recomputedGates: [], reason });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRect = (value: unknown): value is GeometryPolicyRect =>
  isObject(value) && ["x", "y", "width", "height"].every((key) => typeof value[key] === "number");

/** Эффективный порог визуала: per-case перекрывает профильный (тот же порядок, что в гейте). */
const maxRawDiffPctOf = (policy: VerdictPolicySnapshot): number =>
  typeof policy.perCase?.maxRawDiffPct === "number" ? policy.perCase.maxRawDiffPct : policy.maxRawDiffPct;

/**
 * Пересчёт визуального гейта от сохранённых `rawDiffPct`/`aaDiffPct`.
 *
 * Разобранные исходы «метрик нет»:
 * - `no_reference` — вердикт зависит **только** от обязательности гейта, поэтому он пересчитывается
 *   (D10: `skipped` необязательному, `indeterminate` обязательному);
 * - `skippedByReadiness`, `no_candidate_frame`, `diff_worker_error`, `dimensions_irreconcilable` —
 *   ни один порог их не сдвинет: вердикт не выдан по причинам, к политике не относящимся. Гейт
 *   переносится как есть.
 */
function recomputeVisual(gate: GateResult, newPolicy: VerdictPolicySnapshot): { gate: GateResult; changed: boolean } | null {
  const metrics = gate.metrics ?? {};
  const required = newPolicy.gates.visual === "required";
  const maxRawDiffPct = maxRawDiffPctOf(newPolicy);
  const preset = textAaPresetOf(newPolicy.textAaBudget as TextAaBudget | undefined);

  if (metrics.reason === "no_reference") {
    const status = required ? "indeterminate" as const : "skipped" as const;
    const next: GateResult = {
      ...gate,
      status,
      metrics: { ...metrics, required, maxRawDiffPct },
      detail: required
        ? "Case has no referenceAssetId while the run requires a visual verdict; add one to the case-set manifest"
        : "Case declares no reference asset",
    };
    return { gate: next, changed: next.status !== gate.status };
  }
  if (typeof metrics.rawDiffPct !== "number") {
    return { gate: { ...gate, metrics: { ...metrics, required, maxRawDiffPct } }, changed: false };
  }

  const rawDiffPct = metrics.rawDiffPct;
  const aaDiffPct = typeof metrics.aaDiffPct === "number" ? metrics.aaDiffPct : 0;
  const overBudget = rawDiffPct > maxRawDiffPct;
  const edgeResidual = isObject(metrics.edgeResidual) ? metrics.edgeResidual : null;
  // W4 (§W4-1/W4-2): пресет судит по `edgeResidual`. Его нет в метриках, снятых до волны, — и
  // «пересчитать» пресет по числам, которых не измеряли, невозможно. Отказ (`null`) — это всегда
  // «сравни заново» у вызывающего: каскад пробует re-diff того же кадра, где edge считается
  // честно, и только если и он невозможен — пересъёмку.
  if (preset !== null && edgeResidual === null) return null;
  const presetApplied = overBudget && preset !== null
    && textAaBudgetApplies(preset, {
      rawDiffPct,
      edgeResidual: { insidePct: typeof edgeResidual?.insidePct === "number" ? edgeResidual.insidePct : null },
    });
  const failed = overBudget && !presetApplied;
  const severityClass = aaDiffPct <= maxRawDiffPct ? "aa" : "raw";
  const presetMetrics = preset === null
    ? {}
    : {
      textAaBudget: {
        preset: preset.id,
        maxRawDiffPct: preset.maxRawDiffPct,
        minEdgeResidualPct: preset.minEdgeResidualPct,
        applied: presetApplied,
      },
    };
  const next: GateResult = {
    ...gate,
    status: failed ? "fail" : "pass",
    metrics: { ...metrics, required, maxRawDiffPct, severityClass, ...presetMetrics },
    ...(failed
      ? {
        detail: `Visual diff ${rawDiffPct}% exceeds the ${maxRawDiffPct}% budget`
          + ` (aa-tolerant ${aaDiffPct}%, recomputed from stored metrics without a recapture)`,
      }
      : {}),
  };
  if (!failed) delete next.detail;
  return {
    gate: next,
    changed: next.status !== gate.status || metrics.severityClass !== severityClass
      || !same(metrics.textAaBudget, presetMetrics.textAaBudget),
  };
}

/**
 * Пересчёт геометрии от **сырых** измерений (D0). `clipChain` в метриках редуцирован до
 * `clippedBy` (единственное эффективное звено — только оно и участвует в вердикте), поэтому цепочка
 * восстанавливается из него: результат `evaluateGeometryPolicy` по построению тот же.
 */
function recomputeGeometry(gate: GateResult, newPolicy: VerdictPolicySnapshot): { gate: GateResult; changed: boolean } | null {
  const metrics = gate.metrics ?? {};
  if (metrics.skippedByReadiness === true) return { gate, changed: false };
  const layoutBounds = isRect(metrics.layoutBounds) ? metrics.layoutBounds : null;
  const paintBounds = isRect(metrics.paintBounds) ? metrics.paintBounds : null;
  // Ни layout-контура, ни доказательства его отсутствия — метрик доволновой формы: пересчёт
  // невозможен, и притворяться, что возможен, нельзя.
  if (layoutBounds === null && metrics.policyVerdict === undefined) return null;

  const clippedBy = isObject(metrics.clippedBy) ? metrics.clippedBy : null;
  const clipChain: GeometryPolicyClipLink[] = clippedBy
    ? [{
      ...(typeof clippedBy.key === "string" ? { key: clippedBy.key } : {}),
      property: String(clippedBy.property ?? ""),
      value: String(clippedBy.value ?? ""),
      effective: true,
    }]
    : [];
  const tolerances: GeometryTolerancesInput = {
    tolerancePx: newPolicy.geometry.overflowPx,
    // Per-case `sizeDeltaPx` побеждает профильный — тот же порядок, что в `geometryTolerancesOf`.
    sizeTolerancePx: newPolicy.perCase?.sizeDeltaPx ?? newPolicy.geometry.sizeDeltaPx,
    expectedGeometry: newPolicy.expectedGeometry,
    ...(newPolicy.perCase?.allowPaintOverflow === undefined ? {} : { allowPaintOverflow: newPolicy.perCase.allowPaintOverflow }),
    ...(newPolicy.perCase?.expectedClip === undefined ? {} : { expectedClip: newPolicy.perCase.expectedClip }),
    ...(newPolicy.perCase?.overflowBudgetPx === undefined ? {} : { overflowBudgetPx: newPolicy.perCase.overflowBudgetPx }),
  };
  const policy = evaluateGeometryPolicy({
    layoutBounds,
    paintBounds,
    paintBoundsSource: paintBounds ? "alpha" : null,
    paintClamped: isObject(metrics.paintClamped) ? metrics.paintClamped as never : null,
    effectSources: Array.isArray(metrics.effectSources) ? metrics.effectSources as GeometryPolicyEffectSource[] : [],
    clipChain,
    tolerances,
  });

  const named = policy.overflow.sources.length > 0 || policy.expectedGeometryDelta !== null;
  const blocks = geometryVerdictBlocks(policy.policyVerdict, policy.overflow, tolerances);
  // Тот же порядок решений, что в `gates/geometry2.ts`: провал обязан назвать виновника.
  const status = policy.policyVerdict === "indeterminate" ? "indeterminate" as const
    : !blocks ? "pass" as const
    : named ? "fail" as const
    : "indeterminate" as const;
  const detail = status === "pass" ? undefined
    : named || policy.reasons.length > 0
      ? policy.reasons.join("; ")
      : `paint overflow (${policy.policyVerdict}) without an attributable descendant effect`;
  // Коды readiness кадра приезжали из капчура и к политике не относятся — они сохраняются.
  const carriedCodes = Array.isArray(metrics.codes)
    ? (metrics.codes as { code?: unknown }[]).filter((code) => code?.code !== "surface_overflow")
    : [];
  const next: GateResult = {
    ...gate,
    status,
    metrics: {
      ...metrics,
      policyVerdict: policy.policyVerdict,
      codes: [...geometryCodes(policy.policyVerdict, policy.overflow, tolerances, policy.reasons), ...carriedCodes],
      overflow: policy.overflow,
      expectedGeometryDelta: policy.expectedGeometryDelta,
      clippedBy: policy.clippedBy,
      allowPaintOverflow: tolerances.allowPaintOverflow ?? false,
      expectedClip: tolerances.expectedClip ?? false,
      overflowBudgetPx: tolerances.overflowBudgetPx ?? null,
      sizeTolerancePx: tolerances.sizeTolerancePx ?? null,
    },
    ...(detail === undefined ? {} : { detail }),
  };
  if (detail === undefined) delete next.detail;
  return {
    gate: next,
    changed: next.status !== gate.status || !same(metrics.policyVerdict, policy.policyVerdict)
      || !same(metrics.overflow, policy.overflow) || !same(metrics.expectedGeometryDelta, policy.expectedGeometryDelta),
  };
}

/**
 * Пересчёт гейтов случая при смене вердиктной политики.
 *
 * `reevaluable: false` — это **всегда** «переснять», и никогда «перенести как есть»: у вызывающего
 * не должно быть третьего варианта.
 */
export function reevaluateGates(
  gates: GateResult[],
  oldPolicy: VerdictPolicySnapshot,
  newPolicy: VerdictPolicySnapshot,
): ReevaluationResult {
  const delta = verdictPolicyDelta(oldPolicy, newPolicy);
  if (delta.length === 0) return carry(gates, delta);
  if (delta.includes("gates") && !gateRolesReevaluable(oldPolicy, newPolicy)) {
    return refuse(gates, delta, "a gate moved in or out of not-implemented: its metrics were never collected");
  }

  const affected = new Set<GateName>();
  for (const field of delta) for (const gate of GATES_BY_POLICY_FIELD[field]) affected.add(gate);
  for (const gate of affected) {
    if (!REEVALUABLE_GATES.includes(gate)) {
      return refuse(gates, delta, `gate ${gate} is affected by the policy delta but cannot be recomputed from stored metrics`);
    }
  }

  const recomputedGates: GateName[] = [];
  let changed = false;
  const next: GateResult[] = [];
  for (const gate of gates) {
    // Гейт вне дельты переносится законно — это и есть смысл дельта-карты (C26).
    if (!affected.has(gate.gate)) { next.push(gate); continue; }
    if (gate.gate === "visual") {
      const result = recomputeVisual(gate, newPolicy);
      if (result === null) {
        return refuse(gates, delta,
          "the case declares a textAaBudget preset but the stored visual metrics carry no edgeResidual;"
          + " the verdict cannot be recomputed without re-measuring the residual");
      }
      next.push(result.gate);
      recomputedGates.push("visual");
      changed = changed || result.changed;
      continue;
    }
    const result = recomputeGeometry(gate, newPolicy);
    if (result === null) {
      return refuse(gates, delta, "geometry metrics predate the raw-bounds contract; the verdict cannot be recomputed");
    }
    next.push(result.gate);
    recomputedGates.push("geometry");
    changed = changed || result.changed;
  }
  return { gates: next, reevaluable: true, changed, delta, recomputedGates };
}

// --------------------------------------------- производные артефакты (C2)

/** Имя производного JSON-артефакта гейта: ровно они переписываются пересчётом. */
const DERIVED_ARTIFACT: Partial<Record<GateName, string>> = { visual: "visual.json", geometry: "geometry.json" };

/**
 * Перезапись производных артефактов пересчитанных гейтов (C2).
 *
 * Байтовые артефакты (`paint.png`, `diff.png`, `normalized-candidate.png`) переиспользуются как
 * есть: пиксели пересчёт не трогает. А вот `visual.json`/`geometry.json` — это **вердикт**, и
 * оставить в evidence запись со старым порогом, пока случай отдан с новым, значит выпустить
 * манифест, противоречащий сам себе (тест «согласованность манифеста и пересчитанного visual.json»).
 *
 * `derivedFrom` — адрес предыдущей записи: цепочка происхождения не рвётся, а сам новый адрес
 * получается контентно, поэтому повторный одинаковый пересчёт не плодит записей.
 */
export async function rewriteDerivedArtifacts(
  dataDir: string,
  gates: GateResult[],
  recomputedGates: readonly GateName[],
): Promise<GateResult[]> {
  const targets = new Set(recomputedGates);
  const out: GateResult[] = [];
  for (const gate of gates) {
    const name = DERIVED_ARTIFACT[gate.gate];
    if (!targets.has(gate.gate) || name === undefined || !gate.artifacts?.length) { out.push(gate); continue; }
    const artifacts: GateArtifactRef[] = [];
    for (const artifact of gate.artifacts) {
      if (artifact.name !== name) { artifacts.push(artifact); continue; }
      const bytes = await readArtifact(dataDir, artifact.sha256);
      let record: Record<string, unknown> | null = null;
      if (bytes) {
        try { record = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>; }
        catch { record = null; }
      }
      // Старой записи нет (вычищена GC) — вердикт всё равно обязан быть записан: доказательство
      // собирается из метрик самого гейта, а `derivedFrom` честно указывает на утраченный адрес.
      const updated = {
        ...(record ?? {}),
        ...(gate.gate === "visual"
          ? {
            verdict: gate.status,
            maxRawDiffPct: gate.metrics?.maxRawDiffPct,
            severityClass: gate.metrics?.severityClass,
          }
          : {
            policyVerdict: gate.metrics?.policyVerdict,
            overflow: gate.metrics?.overflow,
            expectedGeometryDelta: gate.metrics?.expectedGeometryDelta,
            clippedBy: gate.metrics?.clippedBy,
          }),
        recomputed: true,
        derivedFrom: artifact.sha256,
      };
      const written = await putArtifact(dataDir, updated);
      artifacts.push({ name, sha256: written.sha256, bytes: written.bytes });
    }
    out.push({ ...gate, artifacts });
  }
  return out;
}
