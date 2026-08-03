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
  type GeometryPolicyRect, type GeometryTolerancesInput,
} from "../../../src/capture/geometryPolicy";
import type { GeometryDetail } from "../../../src/capture/geometry.mjs";
import { putArtifact } from "../evidence";
import { spawnInkBboxWorker, type RunInkBbox } from "../inkBbox";
import { captureCase } from "./capture";
import type { Gate, GateContext, GateResult } from "./types";

/** Ключ мемо: sha paint-кадра случая — на него ссылаются и evidence, и будущий гейт `visual`. */
export const paintShaKey = (caseId: string): string => `geometry.paint.sha:${caseId}`;

/** Допуски случая: профиль даёт пороги в px, манифест (W2) — намерения `allowPaintOverflow`/`expectedClip`. */
export function geometryTolerancesOf(ctx: GateContext): GeometryTolerancesInput {
  const perCase = ctx.case.casePolicy ?? {};
  return {
    tolerancePx: ctx.policy.geometry.overflowPx,
    sizeTolerancePx: ctx.policy.geometry.sizeDeltaPx,
    expectedGeometry: ctx.case.expectedGeometry ?? null,
    ...(perCase.allowPaintOverflow === undefined ? {} : { allowPaintOverflow: perCase.allowPaintOverflow }),
    ...(perCase.expectedClip === undefined ? {} : { expectedClip: perCase.expectedClip }),
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
      const artifact = await putArtifact(ctx.dataDir, record as unknown as Record<string, unknown>);
      artifacts.push({ name: "geometry.json", sha256: artifact.sha256, bytes: artifact.bytes });

      const named = policy.overflow.sources.length > 0 || policy.expectedGeometryDelta !== null;
      const blocks = geometryVerdictBlocks(policy.policyVerdict, tolerances);
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
          layoutBounds: record.layoutBounds,
          paintBounds: record.paintBounds,
          paintBoundsSource: record.paintBoundsSource,
          paintClamped: record.paintClamped,
          paintMargin: record.paintMargin,
          deviceScaleFactor: ctx.surface.dsf,
          overflow: policy.overflow,
          expectedGeometryDelta: policy.expectedGeometryDelta,
          clippedBy: policy.clippedBy,
          allowPaintOverflow: tolerances.allowPaintOverflow ?? false,
          expectedClip: tolerances.expectedClip ?? false,
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
