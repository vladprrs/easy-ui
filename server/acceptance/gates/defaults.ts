/**
 * Гейт `defaults` (RFC §4.2): parity-warnings P8 (`server/components/validate.ts`, «schema
 * `.default()` ↔ render `??`-fallback»), поднятые до gate-результата.
 *
 * **Фаза W1a warn-only.** Ни один профиль реестра политик (`policies.ts`) не объявляет parity
 * блокирующим, а изобретать здесь собственный критерий блокировки нельзя: гейт обязан отражать
 * политику, а не заводить её. Когда профиль получит соответствующее поле, единственная правка —
 * {@link parityBlocking}; тест свёртки D10 на этот гейт не опирается.
 */
import type { AcceptancePolicy } from "../policies";
import type { Gate, GateContext, GateResult } from "./types";

/** Требует ли профиль падать на parity-warnings. В обоих профилях фазы 1 — нет. */
export function parityBlocking(policy: AcceptancePolicy): boolean {
  return "requireParity" in policy && policy.requireParity === true;
}

export const defaultsGate: Gate = {
  name: "defaults",
  run(ctx: GateContext): Promise<GateResult> {
    const warnings = [...(ctx.candidate.entry.parityWarnings ?? [])];
    const blocking = parityBlocking(ctx.policy) && warnings.length > 0;
    return Promise.resolve({
      gate: "defaults",
      status: blocking ? "fail" : "pass",
      metrics: { parityWarnings: warnings.length },
      warnings,
      ...(blocking ? { detail: `${warnings.length} parity warning(s) blocked by policy ${ctx.policy.id}` } : {}),
    });
  },
};
