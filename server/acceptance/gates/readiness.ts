/**
 * Гейт `readiness` (план §3 D5, §5 W4) — **обязательный в обоих профилях**.
 *
 * Судит не компонент, а пригодность кадра: исполнила ли поверхность объявленную политику
 * (шрифты, декод изображений, тишина сети по ресурсам компонента, стабильные кадры) до того, как
 * был снят PNG. Мотивировка §1 плана буквальна: draft-скриншот `pay-action-button` снялся до
 * появления theme-иконки и попал в визуальную оценку — такой кадр обязан отказываться от
 * визуального вердикта, а не занижать его.
 *
 * Три исхода:
 * - `pass` — политика выполнена, хэш политики поверхности совпал с хэшем политики профиля;
 * - `fail` — `met: false`: причина и список незавершённого едут в метрики и в CAS. **Это
 *   продуктовый исход, а не инфраструктурный**: ретраев здесь нет (ретраит только `jobOutcome`,
 *   A3) — компонент, который не успевает подгрузить свою иконку за 15 с, будет не успевать и на
 *   второй попытке;
 * - `indeterminate` — кадр не принёс доказательства вовсе (старый шелл/preview-режим) либо
 *   поверхность ждала по **другой** политике: вердикт не выдаётся, но и обвинения нет.
 *
 * Инвариант D5 («capture с `met:false` не получает визуального вердикта») держит не этот гейт, а
 * раннер: он пропускает последующие визуальные/геометрические сравнения случая (см. `runner.ts`).
 */
import { putArtifact } from "../evidence";
import { readinessPolicyHashOf } from "../ids";
import type { CaptureOutcome } from "./capture";
import { renderReadinessKey } from "./render";
import type { Gate, GateContext, GateResult } from "./types";

/** Исход readiness случая: его кладёт в мемо гейт `render`, снявший кадр. */
export function readinessOfCase(ctx: GateContext): CaptureOutcome["readiness"] | undefined {
  return ctx.shared.get(renderReadinessKey(ctx.case.caseId)) as CaptureOutcome["readiness"] | undefined;
}

/** `met === false` у наблюдённого кадра — единственный признак «визуальный вердикт запрещён» (D5). */
export function readinessBlocksVisual(ctx: GateContext): boolean {
  return readinessOfCase(ctx)?.readinessMet === false;
}

export const readinessGate: Gate = {
  name: "readiness",
  async run(ctx: GateContext): Promise<GateResult> {
    const observed = readinessOfCase(ctx);
    if (!observed || observed.readinessMet === null) {
      return {
        gate: "readiness",
        status: "indeterminate",
        detail: "Capture published no readiness evidence (renderer predates the readiness protocol)",
        metrics: { met: null, expectedPolicyHash: readinessPolicyHashOf(ctx.policy.readiness) },
      };
    }
    const expectedPolicyHash = readinessPolicyHashOf(ctx.policy.readiness);
    const evidence = observed.readinessEvidence ?? {};
    // Доказательство — в CAS всегда: оно вход импакт-анализа W6 (`themeResources`) независимо
    // от того, прошёл гейт или нет.
    const artifact = await putArtifact(ctx.dataDir, {
      met: observed.readinessMet,
      reason: observed.readinessReason,
      policyHash: observed.readinessPolicyHash,
      expectedPolicyHash,
      observedCaptureEnvFingerprint: observed.observedCaptureEnvFingerprint,
      observedCaptureEnv: observed.observedCaptureEnv,
      evidence,
    });
    const artifacts = [{ name: "readiness.json", sha256: artifact.sha256, bytes: artifact.bytes }];
    const themeResources = (evidence as { themeResources?: { tokens?: string[]; icons?: string[]; images?: string[] } }).themeResources ?? {};
    const metrics = {
      met: observed.readinessMet,
      reason: observed.readinessReason,
      policyHash: observed.readinessPolicyHash,
      expectedPolicyHash,
      observedCaptureEnvFingerprint: observed.observedCaptureEnvFingerprint,
      pendingRequests: (evidence as { pendingRequests?: string[] }).pendingRequests ?? [],
      fontFaces: (evidence as { fontFaces?: unknown[] }).fontFaces ?? [],
      images: (evidence as { images?: unknown }).images ?? null,
      framesWaited: (evidence as { framesWaited?: number }).framesWaited ?? null,
      animationsDisabled: (evidence as { animationsDisabled?: boolean }).animationsDisabled ?? null,
      themeResources: {
        tokens: themeResources.tokens ?? [],
        icons: themeResources.icons ?? [],
        images: themeResources.images ?? [],
      },
    };

    if (observed.readinessPolicyHash !== null && observed.readinessPolicyHash !== expectedPolicyHash) {
      return {
        gate: "readiness", status: "indeterminate", artifacts, metrics,
        detail: `Surface honoured a different readiness policy (${observed.readinessPolicyHash} ≠ ${expectedPolicyHash})`,
      };
    }
    if (!observed.readinessMet) {
      const pending = metrics.pendingRequests.slice(0, 5).join("; ");
      return {
        gate: "readiness", status: "fail", artifacts, metrics,
        detail: `Capture readiness not met (${observed.readinessReason ?? "unknown"})${pending ? `: ${pending}` : ""}`,
      };
    }
    return { gate: "readiness", status: "pass", artifacts, metrics };
  },
};
