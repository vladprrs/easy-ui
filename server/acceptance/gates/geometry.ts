/**
 * Гейт `geometry` — **advisory-only в W1a** (план §5 W1a, триаж R2-11).
 *
 * v1-семантика (union `getClientRects()`) и есть исходный дефект §19.2 фидбэка: измеренная
 * ширина включает коробки декоративных/out-of-flow потомков. Поэтому факты собираются и едут в
 * evidence, а статус **всегда `skipped`** — вердикт рана он не двигает ни при каких значениях.
 * Боевой гейт (`probe:"paint"`, layout/paint/overflow) приезжает в W3 отдельным файлом
 * `gates/geometry2.ts`; этот остаётся до тех пор источником сравнимых метрик.
 *
 * Отказ измерения тоже не роняет случай: advisory-гейт не имеет права быть причиной `error`.
 */
import { putArtifact } from "../evidence";
import { captureCase } from "./capture";
import type { Gate, GateContext, GateResult } from "./types";

export const geometryGate: Gate = {
  name: "geometry",
  async run(ctx: GateContext): Promise<GateResult> {
    try {
      const capture = await captureCase(ctx, { probe: "geometry" });
      const geometry = capture.geometry ?? {};
      const artifact = await putArtifact(ctx.dataDir, geometry as Record<string, unknown>);
      const rects = (geometry as { rects?: unknown[] }).rects ?? [];
      const frame = (geometry as { frame?: { width?: number; height?: number } }).frame;
      return {
        gate: "geometry",
        status: "skipped",
        artifacts: [{ name: "geometry.json", sha256: artifact.sha256, bytes: artifact.bytes }],
        metrics: {
          advisory: true,
          semantics: "v1-union-rect",
          rects: Array.isArray(rects) ? rects.length : 0,
          frameWidth: frame?.width ?? null,
          frameHeight: frame?.height ?? null,
          truncated: (geometry as { truncated?: boolean }).truncated ?? false,
          retries: capture.retries,
        },
        detail: "Advisory v1 geometry: measured, never blocking (W3 replaces it)",
      };
    } catch (error) {
      return {
        gate: "geometry",
        status: "skipped",
        metrics: { advisory: true, measured: false },
        detail: `Advisory geometry probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
