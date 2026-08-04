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
import type { ReferenceSurface } from "../../../src/acceptance/caseSetSchema";
import { cropIsApplied } from "../caseSets";
import { putArtifact, readArtifact } from "../evidence";
import { COMPARISON_PAINT_MARGIN_PX } from "../ids";
import { geometryFactsKey, paintShaKey, type GeometryFacts } from "./geometry2";
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

/**
 * Вырезка, которую **надо применить** к байтам ассета.
 *
 * До W5 crop применялся всегда, когда объявлен `cropLineage` — и это порождало ловушку фидбэка
 * P1: агент, уже вырезавший эталон вручную, сохранял rect как provenance, а сервер резал второй
 * раз (`136×32 → 116×12`). Теперь решает `sourceSurface`: «ассет = экспорт узла» (или legacy-
 * отсутствие поля) ⇒ режем, «ассет уже content-hug/paint» ⇒ rect остаётся историей.
 */
const cropRectOf = (ctx: GateContext): number[] | null => {
  const lineage = ctx.case.cropLineage;
  if (!cropIsApplied(lineage)) return null;
  const rect = lineage?.rect;
  return Array.isArray(rect) && rect.length === 4 ? [...rect] : null;
};

/** Поверхность эталона: дефолт применяет **потребитель**, а не схема (C6/C25). */
export const referenceSurfaceOf = (ctx: GateContext): ReferenceSurface => ctx.case.referenceSurface ?? "paint";

export interface ReferenceCanvas {
  padTo: { width: number; height: number };
  placement: { x: number; y: number };
  marginPx: number;
  deviceScaleFactor: number;
  layoutRoot: { width: number; height: number };
  layoutRootSource: "expectedGeometry" | "layoutBounds";
}

/**
 * Каноническая канва сравнения для content-hug эталона (§W5).
 *
 * `canvas = (layoutRoot + 2 × margin) × dsf`, содержимое в `(margin × dsf, margin × dsf)` — ровно
 * то, что делает paint-съёмка (`CaptureComponent` кладёт `padding: margin` вокруг inline-block'а,
 * а скриншот берётся в device px). Источник корня — `expectedGeometry` случая, иначе измеренный в
 * этом же ране `layoutBounds`; margin — фактический margin съёмки, а не константа, если кадр
 * снимался здесь.
 *
 * `null` — корень неизвестен (re-diff без свежих фактов и без `expectedGeometry`): строить канву
 * наугад значило бы сравнить компонент с пустотой и назвать это вердиктом.
 */
export function referenceCanvasOf(ctx: GateContext): ReferenceCanvas | null {
  const facts = ctx.shared.get(geometryFactsKey(ctx.case.caseId)) as GeometryFacts | undefined;
  const dsf = ctx.surface.dsf;
  const marginPx = facts?.paintMargin ?? COMPARISON_PAINT_MARGIN_PX;
  const expected = ctx.case.expectedGeometry ?? null;
  const layoutRoot = expected ?? facts?.layoutBounds ?? null;
  if (!layoutRoot) return null;
  return {
    padTo: {
      width: Math.round((layoutRoot.width + 2 * marginPx) * dsf),
      height: Math.round((layoutRoot.height + 2 * marginPx) * dsf),
    },
    placement: ctx.case.referencePlacement ?? { x: Math.round(marginPx * dsf), y: Math.round(marginPx * dsf) },
    marginPx,
    deviceScaleFactor: dsf,
    layoutRoot: { width: layoutRoot.width, height: layoutRoot.height },
    layoutRootSource: expected ? "expectedGeometry" : "layoutBounds",
  };
}

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
      const surface = referenceSurfaceOf(ctx);
      // Канва строится **только** для content-hug эталона: paint-манифест (в том числе всякий
      // манифест без нового поля) сравнивается ровно как до W5 — инвариант неизменности D13.
      const canvas = surface === "content-hug" ? referenceCanvasOf(ctx) : null;
      if (surface === "content-hug" && canvas === null) {
        return {
          ...base, status: "indeterminate",
          detail: "Case declares a content-hug reference but neither expectedGeometry nor a measured layoutBounds is"
            + " available, so the canonical comparison canvas cannot be derived; declare expectedGeometry on the case",
          metrics: { ...base.metrics, reason: "reference_canvas_unresolved", referenceAssetId: assetId, referenceSurface: surface },
        };
      }
      const lineage = {
        referenceSurface: surface,
        sourceSurface: ctx.case.cropLineage?.sourceSurface ?? (ctx.case.cropLineage ? "figma-node" : null),
        cropApplied: cropRect !== null,
        cropRect,
        padTo: canvas?.padTo ?? null,
        placement: canvas?.placement ?? null,
        marginPx: canvas?.marginPx ?? null,
        deviceScaleFactor: ctx.surface.dsf,
        layoutRoot: canvas?.layoutRoot ?? null,
        layoutRootSource: canvas?.layoutRootSource ?? null,
      };

      const runDiff = ctx.runDiff ?? fallbackRunDiff;
      const diff: NormalizedDiffResult = await runDiff({
        mode: "normalize",
        referencePngBase64: Buffer.from(reference.bytes).toString("base64"),
        candidatePngBase64: Buffer.from(candidate).toString("base64"),
        options: {
          maxDimensionDeltaPx: ctx.policy.visual.maxDimensionDeltaPx,
          ...(cropRect === null ? {} : { cropRect }),
          ...(canvas === null ? {} : { padReferenceTo: canvas.padTo, referencePlacement: canvas.placement }),
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
        /**
         * Что и как сервер сделал с эталоном, прежде чем сравнивать (§W5). Кладётся всегда, в том
         * числе для paint-манифестов: «ничего не паддили, ничего не резали» — тоже факт, и его
         * отсутствие раньше и делало нормализацию невидимой для автора.
         */
        referenceNormalization: {
          // Сначала факты воркера (что он получил и во что превратил), поверх — намерение сервера.
          // Значения совпадают по построению; расхождение читалось бы как «сравнили не то».
          ...(diff.referenceNormalization ?? {}),
          ...lineage,
          sourceDims: diff.sourceDims,
          refDims: diff.refDims,
        },
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
      /**
       * Дериват эталона (§W5, AC фидбэка «evidence сохраняет immutable source reference и
       * server-normalized derivative с lineage»). Сам ассет в CAS по-прежнему **не** копируется —
       * он иммутабелен в реестре и адресуется парой `referenceAssetId`/`referenceSha256`; в CAS
       * едет только то, чего в реестре нет: построенная сервером канва.
       */
      const normalizedReference = diff.normalizedReferencePngBase64 === undefined
        ? null
        : await putArtifact(ctx.dataDir, new Uint8Array(Buffer.from(diff.normalizedReferencePngBase64, "base64")));
      const record = await putArtifact(ctx.dataDir, {
        semantics: "visual-v1",
        verdict: failed ? "fail" : "pass",
        maxRawDiffPct,
        severityClass,
        canvas: diff.canvas,
        padded: diff.padded,
        referenceSource: { assetId, sha256: reference.sha256 },
        ...(normalizedReference === null ? {} : { normalizedReferenceSha256: normalizedReference.sha256 }),
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
          ...(normalizedReference === null
            ? []
            : [{ name: "normalized-reference.png", sha256: normalizedReference.sha256, bytes: normalizedReference.bytes }]),
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
