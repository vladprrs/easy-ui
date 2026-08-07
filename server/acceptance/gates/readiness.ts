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
import { readinessRequiresBarrier } from "../../capture/resourceBarrier";
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
      codes: observed.readinessCodes ?? [],
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
      // `reason` — доволновая строка, `codes` — типизированный словарь рядом (R3, E3): маппинг не
      // биективен, поэтому в метриках живут оба, а не одно вместо другого.
      reason: observed.readinessReason,
      codes: observed.readinessCodes ?? [],
      policyHash: observed.readinessPolicyHash,
      expectedPolicyHash,
      observedCaptureEnvFingerprint: observed.observedCaptureEnvFingerprint,
      pendingRequests: (evidence as { pendingRequests?: string[] }).pendingRequests ?? [],
      fontFaces: (evidence as { fontFaces?: unknown[] }).fontFaces ?? [],
      images: (evidence as { images?: unknown }).images ?? null,
      framesWaited: (evidence as { framesWaited?: number }).framesWaited ?? null,
      animationsDisabled: (evidence as { animationsDisabled?: boolean }).animationsDisabled ?? null,
      // R4: доказательство строгой политики. `null` — политика профиля её не требовала (v1),
      // а не «проверили и всё хорошо»: гейт обязан различать эти случаи глазами читателя evidence.
      imageDetails: (evidence as { imageDetails?: unknown[] }).imageDetails ?? null,
      layout: (evidence as { layout?: unknown }).layout ?? null,
      fontManifestHash: (evidence as { fontManifestHash?: string | null }).fontManifestHash ?? null,
      // W2: эхо фазы барьера. `null` — политика барьера не требовала; при v3-политике `null`
      // означает, что барьер не исполнялся, и это отдельный исход ниже, а не «всё хорошо».
      resourceBarrier: (evidence as { resourceBarrier?: unknown }).resourceBarrier ?? null,
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
    // W2 (§1.5): факт исполнения барьера едет **эхом**, и при v3-политике он обязателен. Кадр,
    // объявивший `met:true` без блока `resourceBarrier`, снят поверхностью, до которой политика
    // не доехала (старый бандл шелла, сброшенный bootstrap) — а это неотличимо от «барьер
    // исполнен и всё чисто». Вердикта такому кадру не выдаётся: `indeterminate`, не `pass`.
    if (readinessRequiresBarrier(ctx.policy.readiness) && observed.readinessMet && metrics.resourceBarrier === null) {
      return {
        gate: "readiness", status: "indeterminate", artifacts, metrics,
        detail: "Policy declares a resource barrier (readiness v3) but the capture published no resourceBarrier evidence",
      };
    }
    if (!observed.readinessMet) {
      const pending = metrics.pendingRequests.slice(0, 5).join("; ");
      // Типизированные коды с указателем на виновника (R4) — в `detail`: читателю отчёта нужен
      // не только класс причины, но и **что именно** не доехало (семейство, URL, ключ элемента).
      const typed = (observed.readinessCodes ?? [])
        .filter((code) => code.severity === "error")
        .map((code) => (code.ref === undefined ? code.code : `${code.code}(${code.ref})`))
        .slice(0, 5).join(", ");
      return {
        gate: "readiness", status: "fail", artifacts, metrics,
        detail: `Capture readiness not met (${observed.readinessReason ?? "unknown"})${typed ? ` [${typed}]` : ""}${pending ? `: ${pending}` : ""}`,
      };
    }
    return { gate: "readiness", status: "pass", artifacts, metrics };
  },
};
