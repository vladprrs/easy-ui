/**
 * Гейт `geometry` **v2** — Geometry Contract 2.0 (план 2026-08-03 §3 D3/D4, §5 W3).
 *
 * Заменяет advisory-гейт v1 (`gates/geometry.ts`, union `getClientRects()` — сам по себе дефект
 * §19.2 фидбэка: «измеренная ширина 175 при layout-ширине 140» давала коробка декоративного
 * потомка). Здесь измерения разделены честно:
 *
 * - `layoutBounds` — union border-box'ов **in-flow** потомков (собирает `collectGeometry`);
 * - `paintBounds` — ink-bbox по альфе кадра `probe:"paint"` (прозрачная поверхность + маргин),
 *   нормализованный в CSS px делением на `deviceScaleFactor` (триаж R1-M2);
 * - вердикт — чистая функция `src/capture/geometryPolicy.ts` (D3: факты в capture, вердикт на сервере).
 *
 * **Инвариант гейта (KPI §1, done W3):** `fail` возможен только с непустым `overflow.sources[]`
 * либо с названным `expectedGeometry`-расхождением. Наблюдённый overflow без объяснимого
 * источника — `indeterminate` с диагностикой, а не обвинение компонента: «геометрия упала, но
 * непонятно из-за кого» — ровно то, что этот пакет обязан убрать.
 */
import {
  evaluateGeometryPolicy, geometryVerdictBlocks,
  type GeometryOverflowSides, type GeometryPolicyRect, type GeometryPolicyVerdict, type GeometryTolerancesInput,
} from "../../../src/capture/geometryPolicy";
import type { CaptureCode } from "../../../src/capture/failureCodes";
import type { GeometryDetail } from "../../../src/capture/geometry.mjs";
import { putArtifact } from "../evidence";
import { spawnInkBboxWorker, type RunInkBbox } from "../inkBbox";
import { captureCase } from "./capture";
import type { Gate, GateContext, GateResult } from "./types";

/** Ключ мемо: sha paint-кадра случая — на него ссылаются и evidence, и будущий гейт `visual`. */
export const paintShaKey = (caseId: string): string => `geometry.paint.sha:${caseId}`;

/**
 * Ключ мемо: измеренные факты кадра случая (W5). Их читает гейт `visual`, когда строит
 * каноническую канву из content-hug эталона и `expectedGeometry` у случая не объявлен: канва
 * тогда выводится из **измеренного** `layoutBounds` и того же `paintMargin`, которым снимался
 * кадр. Пересчитывать margin из константы вместо факта съёмки нельзя — они обязаны совпадать.
 */
export const geometryFactsKey = (caseId: string): string => `geometry.facts:${caseId}`;
export interface GeometryFacts {
  /**
   * Бокс layout-корня в CSS px **относительно внешнего `#eui-capture-surface`**, то есть вместе с
   * маргином поля. `x`/`y` добавлены волной W5 (§T5c.5): на viewport-поверхности content-hug эталон
   * кладётся в канву именно туда, где корень оказался в кадре, — у hug-кейса это `margin×dsf`, а у
   * оверлея координата произвольная и вывести её из `expectedGeometry` (там только w/h) нельзя.
   */
  layoutBounds: { x: number; y: number; width: number; height: number } | null;
  paintMargin: number | null;
  deviceScaleFactor: number;
}

/**
 * Допуски случая: профиль даёт пороги в px, манифест (W2) — намерения
 * `allowPaintOverflow`/`expectedClip`, а с W3 (план 2026-08-06) ещё и числа: `sizeDeltaPx`
 * **побеждает** профильный (случай — объявленное исключение из нормы семьи) и `overflowBudgetPx`
 * задаёт per-side допуск краски.
 */
export function geometryTolerancesOf(ctx: GateContext): GeometryTolerancesInput {
  const perCase = ctx.case.casePolicy ?? {};
  return {
    tolerancePx: ctx.policy.geometry.overflowPx,
    sizeTolerancePx: perCase.sizeDeltaPx ?? ctx.policy.geometry.sizeDeltaPx,
    expectedGeometry: ctx.case.expectedGeometry ?? null,
    ...(perCase.allowPaintOverflow === undefined ? {} : { allowPaintOverflow: perCase.allowPaintOverflow }),
    ...(perCase.expectedClip === undefined ? {} : { expectedClip: perCase.expectedClip }),
    ...(perCase.overflowBudgetPx === undefined ? {} : { overflowBudgetPx: perCase.overflowBudgetPx }),
  };
}

const isRect = (value: unknown): value is GeometryPolicyRect =>
  value !== null && typeof value === "object"
  && ["x", "y", "width", "height"].every((key) => typeof (value as Record<string, unknown>)[key] === "number");

/** Корневой детальный замер: по умолчанию `detailKeys` — корневой маркер, он и есть компонент. */
function rootDetail(geometry: Record<string, unknown>): GeometryDetail | null {
  const details = geometry.details;
  if (!Array.isArray(details) || details.length === 0) return null;
  return details[0] as GeometryDetail;
}

/**
 * Вердикт геометрии в типизированный словарь (§3 E3, §5 R3): `surface_overflow` — единственный код
 * этой области, и он эмитится **только** когда вердикт действительно блокирует при текущих
 * допусках. `indeterminate` кодом не сопровождается: «не измерили» — не «вылезло за поверхность».
 * `severity` берётся из того же `geometryVerdictBlocks`, что и статус гейта, — два источника
 * правды о том, провал это или нет, здесь недопустимы.
 */
export function geometryCodes(
  verdict: GeometryPolicyVerdict,
  overflow: GeometryOverflowSides | null,
  tolerances: GeometryTolerancesInput,
  reasons: readonly string[],
): CaptureCode[] {
  if (verdict === "clean" || verdict === "indeterminate") return [];
  const blocks = geometryVerdictBlocks(verdict, overflow, tolerances);
  return [{
    code: "surface_overflow",
    severity: blocks ? "error" : "warning",
    detail: reasons.length > 0 ? reasons.join("; ") : `geometry verdict ${verdict}`,
    ref: verdict,
  }];
}

export function createGeometry2Gate(fallbackInkBbox: RunInkBbox = spawnInkBboxWorker): Gate {
  return {
    name: "geometry",
    async run(ctx: GateContext): Promise<GateResult> {
      // Ink-воркер — шов: продакшн спавнит node-подпроцесс, тесты подсовывают чистую функцию,
      // поэтому вердикт политики проверяется без chromium и без pngjs-подпроцесса.
      const runInkBbox = ctx.inkBbox ?? fallbackInkBbox;
      const capture = await captureCase(ctx, { probe: "paint", geometryDetailKeys: ctx.case.geometryDetailKeys ?? [] });
      const geometry = capture.geometry ?? {};
      const detail = rootDetail(geometry);
      const image = capture.image;
      const tolerances = geometryTolerancesOf(ctx);
      const artifacts: GateResult["artifacts"] = [];

      // Кадр и факты кладутся в evidence **всегда**, даже когда вердикт не выдан: они и есть
      // доказательство того, что мерялось (и вход диагностики «увеличить маргин»).
      if (image) {
        const png = await putArtifact(ctx.dataDir, image.bytes);
        ctx.shared.set(paintShaKey(ctx.case.caseId), png.sha256);
        artifacts.push({ name: "paint.png", sha256: png.sha256, bytes: png.bytes });
      }

      const ink = image
        ? await runInkBbox({
          pngBase64: Buffer.from(image.bytes).toString("base64"),
          options: { deviceScaleFactor: ctx.surface.dsf },
        })
        : { ok: false as const, error: "paint capture returned no image bytes" };

      const paintBounds = ink.ok && isRect(ink.bounds) ? ink.bounds : null;
      const policy = evaluateGeometryPolicy({
        layoutBounds: detail?.layoutBounds ?? null,
        paintBounds,
        paintBoundsSource: paintBounds ? "alpha" : null,
        paintClamped: ink.ok ? ink.clamped : null,
        effectSources: detail?.effectSources ?? [],
        clipChain: detail?.clipChain ?? [],
        tolerances,
      });

      const record = {
        semantics: "v2-paint",
        paintMargin: capture.paintMargin ?? null,
        deviceScaleFactor: ctx.surface.dsf,
        layoutBounds: detail?.layoutBounds ?? null,
        paintBounds,
        paintBoundsSource: paintBounds ? "alpha" : null,
        paintBoundsPixels: ink.ok ? ink.pixelBounds : null,
        paintClamped: ink.ok ? ink.clamped : null,
        ...(ink.ok ? {} : { inkError: ink.error }),
        policyVerdict: policy.policyVerdict,
        overflow: policy.overflow,
        expectedGeometryDelta: policy.expectedGeometryDelta,
        clippedBy: policy.clippedBy,
        effectSources: detail?.effectSources ?? [],
        clipChain: detail?.clipChain ?? [],
        geometry,
      };
      // W5: факты кадра — вход канонической канвы визуального сравнения (см. `geometryFactsKey`).
      ctx.shared.set(geometryFactsKey(ctx.case.caseId), {
        layoutBounds: isRect(record.layoutBounds)
          ? { x: record.layoutBounds.x, y: record.layoutBounds.y, width: record.layoutBounds.width, height: record.layoutBounds.height }
          : null,
        paintMargin: record.paintMargin,
        deviceScaleFactor: ctx.surface.dsf,
      } satisfies GeometryFacts);

      const artifact = await putArtifact(ctx.dataDir, record as unknown as Record<string, unknown>);
      artifacts.push({ name: "geometry.json", sha256: artifact.sha256, bytes: artifact.bytes });

      const named = policy.overflow.sources.length > 0 || policy.expectedGeometryDelta !== null;
      const blocks = geometryVerdictBlocks(policy.policyVerdict, policy.overflow, tolerances);
      // Инвариант: провал обязан назвать виновника. Иначе — `indeterminate` (D10 всё равно не даст
      // такому случаю `pass`, но вердикт не будет ложно обвинять компонент).
      const status = policy.policyVerdict === "indeterminate" ? "indeterminate"
        : !blocks ? "pass"
        : named ? "fail"
        : "indeterminate";
      const detailMessage = status === "pass" ? undefined
        : named || policy.reasons.length > 0
          ? policy.reasons.join("; ")
          : `paint overflow (${policy.policyVerdict}) without an attributable descendant effect`;

      return {
        gate: "geometry",
        status,
        artifacts,
        metrics: {
          semantics: "v2-paint",
          policyVerdict: policy.policyVerdict,
          // R3: тот же вердикт типизированным кодом — `surface_overflow` (плюс коды readiness
          // кадра, если поверхность их принесла: paint-джоба несёт доказательство).
          codes: [...geometryCodes(policy.policyVerdict, policy.overflow, tolerances, policy.reasons), ...(capture.readiness?.readinessCodes ?? [])],
          layoutBounds: record.layoutBounds,
          paintBounds: record.paintBounds,
          paintBoundsSource: record.paintBoundsSource,
          paintClamped: record.paintClamped,
          paintMargin: record.paintMargin,
          deviceScaleFactor: ctx.surface.dsf,
          overflow: policy.overflow,
          expectedGeometryDelta: policy.expectedGeometryDelta,
          clippedBy: policy.clippedBy,
          // W5b: атрибуция причин работает по коробкам источников эффектов, а не только по
          // сводке overflow — поэтому сами `effectSources` едут в метрики, а не только в артефакт.
          effectSources: record.effectSources,
          allowPaintOverflow: tolerances.allowPaintOverflow ?? false,
          expectedClip: tolerances.expectedClip ?? false,
          // W3: объявленные per-case числа едут в метрики рядом с намерениями — иначе по
          // сохранённому рану нельзя сказать, почему overflow не заблокировал вердикт.
          overflowBudgetPx: tolerances.overflowBudgetPx ?? null,
          sizeTolerancePx: tolerances.sizeTolerancePx ?? null,
          retries: capture.retries,
        },
        ...(capture.quality.runtimeWarnings.length + capture.quality.infraWarnings.length > 0
          ? { warnings: [...capture.quality.runtimeWarnings, ...capture.quality.infraWarnings] }
          : {}),
        ...(detailMessage === undefined ? {} : { detail: detailMessage }),
      };
    },
  };
}

export const geometry2Gate: Gate = createGeometry2Gate();
