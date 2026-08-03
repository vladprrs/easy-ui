/**
 * Гейт `contract` (RFC §4.2): receipt-поля и definition extraction кандидата.
 *
 * Ничего не пересчитывает — вся тяжёлая работа сделана validate-префлайтом P8 и лежит в
 * candidate-кэше. Гейт поднимает её факты до вердикта: отрицательная запись кэша (`ok:false`),
 * отсутствие извлечённого определения или несобранный бандл означают, что снимать нечего.
 */
import type { Gate, GateContext, GateResult } from "./types";

export const contractGate: Gate = {
  name: "contract",
  run(ctx: GateContext): Promise<GateResult> {
    const { entry, bundleHash, hostAbiVersion, themeVersion, rev, sourceHash } = ctx.candidate;
    const meta = entry.extracted?.meta;
    const base = {
      gate: "contract" as const,
      metrics: {
        rev, sourceHash, bundleHash, hostAbiVersion, themeVersion,
        hasPropsSchema: meta?.propsJsonSchema !== undefined,
        exampleCount: Object.keys(meta?.examples ?? {}).length,
        atomicLevel: meta?.atomicLevel ?? null,
        headDiverged: ctx.candidate.headDiverged === true,
      },
      warnings: [...(entry.extracted?.warnings ?? [])],
    };
    if (!entry.ok || !meta) {
      return Promise.resolve({
        ...base,
        status: "fail",
        detail: entry.failure?.message ?? "Candidate has no extracted component definition",
      });
    }
    if (!bundleHash || typeof hostAbiVersion !== "number") {
      return Promise.resolve({ ...base, status: "fail", detail: "Candidate build is incomplete: bundleHash/hostAbiVersion are missing" });
    }
    return Promise.resolve({ ...base, status: "pass" });
  },
};
