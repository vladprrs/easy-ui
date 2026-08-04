/**
 * Гейт `visual` — минимальный per-case визуальный вердикт (план 2026-08-03 §2 A5, §5 W5a).
 *
 * Что он **не** делает (вне объёма A5): lifecycle эталонов, promotion baseline'ов, автоприёмка,
 * миграция подсистемы `visual_references`/`visual_runs`. Эталон здесь приходит из case-set'а
 * (`referenceAssetId` случая) и привязан к манифесту, а не к опубликованной версии — ровно
 * поэтому блокер RFC про fingerprint-модель references этой волной не задевается.
 *
 * Что он делает:
 *
 * 1. **Берёт тот самый кадр, который уже измерила геометрия** — `paint.png` случая (прозрачная
 *    поверхность + маргин-поле). Второй съёмки нет: `layoutBounds`, `paintBounds` и пиксельный
 *    вердикт обязаны относиться к одной сессии (R1-M3), а лишний капчур — это лишние 4–8 с на
 *    случай в матрице на 49 состояний.
 * 2. **Нормализует размеры** (обязательная часть A5): crop эталона по `cropLineage.rect`, pad обеих
 *    картинок до общего холста. Несводимое расхождение — `indeterminate` с названной причиной, а
 *    не `fail`: «эталон снят в другом масштабе» — не дефект компонента (триаж R1-M4).
 * 3. **Считает метрики в подпроцессе** (канон `spawnDiffWorker`): `rawDiffPct`/`aaDiffPct`,
 *    `maxChannelDelta`, связные области diff-маски (≤12) и `bestOffset`. Подпроцесс запускается
 *    **после** завершения capture-джобы, поэтому системный слот тяжёлой работы по-прежнему один
 *    (§4.6) — тот же порядок, что у ink-bbox в гейте `geometry`.
 *
 * Обязательность (D10): `required` — только когда визуальная приёмка объявлена (`requireVisual`
 * профиля `pixel-strict-v1` или case-set-манифеста). Иначе гейт считается, кладёт метрики в
 * evidence, но ран не роняет. Случай без эталона: `skipped` у необязательного гейта и
 * `indeterminate` у обязательного — D10 разрешает `skipped` только необязательным.
 *
 * Инвариант D5 держит раннер: кадр, не прошедший readiness, до этого гейта не доходит вовсе.
 */
import { AssetRepo } from "../../repos/assets";
import {
  spawnNormalizedDiffWorker,
  type NormalizedDiffMetrics, type NormalizedDiffResult, type RunNormalizedDiff,
} from "../../visual/diff-runner";
import { putArtifact, readArtifact } from "../evidence";
import { paintShaKey } from "./geometry2";
import type { Gate, GateContext, GateResult } from "./types";

/** Порог случая: per-case допуск манифеста (W2) перекрывает профильный (RFC §3.4). */
export function maxRawDiffPctOf(ctx: GateContext): number {
  const perCase = ctx.case.casePolicy?.maxRawDiffPct;
  return typeof perCase === "number" ? perCase : ctx.policy.visual.maxRawDiffPct;
}

/** Обязателен ли визуальный вердикт в этом ране (профиль либо `requireVisual` набора). */
export const visualIsRequired = (ctx: GateContext): boolean => ctx.policy.gates.visual === "required";

/**
 * Класс severity визуального провала (D10): `aa`, когда AA-терпимая метрика укладывается в тот же
 * бюджет (расхождение объясняется сглаживанием), иначе `raw` — структурное расхождение пикселей.
 * `raw` тяжелее `aa` по рангу, поэтому сортировка репорта показывает настоящие дефекты первыми.
 */
export function visualSeverityClass(metrics: { rawDiffPct: number; aaDiffPct: number }, maxRawDiffPct: number): "raw" | "aa" {
  return metrics.aaDiffPct <= maxRawDiffPct ? "aa" : "raw";
}

/** Байты эталона из asset-store. Эталон **не** копируется в CAS: в манифест кейса едет его id. */
async function referenceBytes(ctx: GateContext, assetId: string): Promise<{ bytes: Uint8Array; sha256: string } | null> {
  const repo = new AssetRepo(ctx.db, ctx.dataDir);
  const row = repo.get(assetId);
  if (!row) return null;
  try {
    const file = Bun.file(repo.bytesPath(row.sha256));
    return { bytes: new Uint8Array(await file.arrayBuffer()), sha256: row.sha256 };
  } catch { return null; }
}

const cropRectOf = (ctx: GateContext): number[] | null => {
  const rect = ctx.case.cropLineage?.rect;
  return Array.isArray(rect) && rect.length === 4 ? [...rect] : null;
};

export function createVisualGate(fallbackRunDiff: RunNormalizedDiff = spawnNormalizedDiffWorker): Gate {
  return {
    name: "visual",
    async run(ctx: GateContext): Promise<GateResult> {
      const required = visualIsRequired(ctx);
      const maxRawDiffPct = maxRawDiffPctOf(ctx);
      const base = { gate: "visual" as const, metrics: { required, maxRawDiffPct } };

      const assetId = ctx.case.referenceAssetId ?? null;
      if (assetId === null) {
        return required
          ? {
            ...base, status: "indeterminate",
            detail: "Case has no referenceAssetId while the run requires a visual verdict; add one to the case-set manifest",
            metrics: { ...base.metrics, reason: "no_reference" },
          }
          : { ...base, status: "skipped", detail: "Case declares no reference asset", metrics: { ...base.metrics, reason: "no_reference" } };
      }

      // Кандидат — кадр, снятый гейтом `geometry` в этом же случае (мемо рана). Своей съёмки у
      // визуала нет: два кадра одной поверхности разошлись бы между собой раньше, чем с эталоном.
      const paintSha = ctx.shared.get(paintShaKey(ctx.case.caseId));
      const candidate = typeof paintSha === "string" ? await readArtifact(ctx.dataDir, paintSha) : null;
      if (!candidate) {
        return {
          ...base, status: "indeterminate",
          detail: "No paint frame was produced for this case, so there is nothing to compare against the reference",
          metrics: { ...base.metrics, reason: "no_candidate_frame", referenceAssetId: assetId },
        };
      }

      const reference = await referenceBytes(ctx, assetId);
      if (!reference) {
        return {
          ...base, status: "indeterminate",
          detail: `Reference asset ${assetId} is registered but its bytes are unreadable`,
          metrics: { ...base.metrics, reason: "reference_unreadable", referenceAssetId: assetId },
        };
      }

      const cropRect = cropRectOf(ctx);
      const runDiff = ctx.runDiff ?? fallbackRunDiff;
      const diff: NormalizedDiffResult = await runDiff({
        mode: "normalize",
        referencePngBase64: Buffer.from(reference.bytes).toString("base64"),
        candidatePngBase64: Buffer.from(candidate).toString("base64"),
        options: {
          maxDimensionDeltaPx: ctx.policy.visual.maxDimensionDeltaPx,
          ...(cropRect === null ? {} : { cropRect }),
        },
      });

      if (diff.ok === false) {
        // Воркер не выдал результат — это не приговор компоненту, а отсутствие измерения.
        return {
          ...base, status: "indeterminate",
          detail: `Visual diff worker failed: ${diff.error}`,
          metrics: { ...base.metrics, reason: "diff_worker_error", referenceAssetId: assetId },
        };
      }

      const common = {
        referenceAssetId: assetId,
        referenceSha256: reference.sha256,
        candidateSha256: paintSha as string,
        cropApplied: diff.cropApplied,
        ...(cropRect === null ? {} : { cropRect }),
        sourceDims: diff.sourceDims,
        refDims: diff.refDims,
        candDims: diff.candDims,
      };

      if (diff.indeterminate) {
        // Несводимые размеры: метрик нет вовсе (выдуманный процент хуже отсутствующего), но
        // диагностика названа — её и читает автор («увеличить маргин», «эталон в другом масштабе»).
        const record = await putArtifact(ctx.dataDir, {
          semantics: "visual-v1", verdict: "indeterminate", reason: diff.reason, ...common,
          ...(diff.dimensionDelta ? { dimensionDelta: diff.dimensionDelta } : {}),
        });
        return {
          ...base, status: "indeterminate",
          detail: `Reference and candidate could not be reconciled: ${diff.reason}`,
          artifacts: [{ name: "visual.json", sha256: record.sha256, bytes: record.bytes }],
          metrics: { ...base.metrics, reason: "dimensions_irreconcilable", ...common, ...(diff.dimensionDelta ? { dimensionDelta: diff.dimensionDelta } : {}) },
        };
      }

      const metrics: NormalizedDiffMetrics = diff.metrics;
      const failed = metrics.rawDiffPct > maxRawDiffPct;
      const severityClass = visualSeverityClass(metrics, maxRawDiffPct);

      const diffPng = await putArtifact(ctx.dataDir, new Uint8Array(Buffer.from(diff.diffPngBase64, "base64")));
      const normalizedPng = await putArtifact(ctx.dataDir, new Uint8Array(Buffer.from(diff.normalizedCandidatePngBase64, "base64")));
      const record = await putArtifact(ctx.dataDir, {
        semantics: "visual-v1",
        verdict: failed ? "fail" : "pass",
        maxRawDiffPct,
        severityClass,
        canvas: diff.canvas,
        padded: diff.padded,
        ...common,
        metrics: metrics as unknown as Record<string, unknown>,
        diffSha256: diffPng.sha256,
        normalizedCandidateSha256: normalizedPng.sha256,
      });

      return {
        gate: "visual",
        status: failed ? "fail" : "pass",
        artifacts: [
          { name: "diff.png", sha256: diffPng.sha256, bytes: diffPng.bytes },
          { name: "normalized-candidate.png", sha256: normalizedPng.sha256, bytes: normalizedPng.bytes },
          { name: "visual.json", sha256: record.sha256, bytes: record.bytes },
        ],
        metrics: {
          ...base.metrics,
          ...common,
          canvas: diff.canvas,
          padded: diff.padded,
          severityClass,
          rawDiffPct: metrics.rawDiffPct,
          aaDiffPct: metrics.aaDiffPct,
          maxChannelDelta: metrics.maxChannelDelta,
          regions: metrics.regions,
          totalRegions: metrics.totalRegions,
          bestOffset: metrics.bestOffset,
          thresholds: metrics.thresholds,
          rawDiffPixels: metrics.rawDiffPixels,
          aaDiffPixels: metrics.aaDiffPixels,
          totalPixels: metrics.totalPixels,
        },
        ...(failed
          ? {
            detail: `Visual diff ${metrics.rawDiffPct}% exceeds the ${maxRawDiffPct}% budget`
              + ` (aa-tolerant ${metrics.aaDiffPct}%, max channel delta ${metrics.maxChannelDelta},`
              + ` ${metrics.totalRegions} region(s), best offset ${metrics.bestOffset.dx}/${metrics.bestOffset.dy}px`
              + ` with ${metrics.bestOffset.residualPct}% residual)`,
          }
          : {}),
      };
    },
  };
}

export const visualGate: Gate = createVisualGate();

/**
 * Вход **re-diff** (план 2026-08-04, D-B): пересравнение уже снятого кадра с новым эталоном.
 *
 * Кадр не снимается: `paintSha` — адрес `paint.png` строки кэша, чей `frameFingerprint` совпал с
 * отпечатком кадра нового случая. Физическое существование артефакта проверяет вызывающий
 * (`artifactPresent`) — отсутствующий кадр означает пересъёмку с причиной
 * `recapture:frame_missing`, а не «сравним с чем-нибудь» (D10/D15).
 *
 * Гейт при этом исполняется **обычным путём**: тот же код, тот же воркер, те же артефакты и
 * метрики. Разница ровно одна — источник кандидатского кадра. Именно поэтому re-diff даёт честный
 * новый `rawDiffPct`, а не пересчитанный старый (анти-репро C0: смена эталона обязана мерить
 * заново, а не арифметически переоценивать прошлое измерение).
 */
export async function rediffCase(ctx: GateContext, paintSha: string, gate: Gate = visualGate): Promise<GateResult> {
  ctx.shared.set(paintShaKey(ctx.case.caseId), paintSha);
  return gate.run(ctx);
}
