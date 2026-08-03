/**
 * Гейт `determinism` (RFC §4.2, план §4.2): повторный капчур случая и побайтовое сравнение.
 *
 * Считается **на выборке** `determinismSampleSize` (плюс все fail-случаи — их отбирает раннер и
 * ставит `determinismSampled`): полный повтор удвоил бы холодный ран, а недетерминизм —
 * свойство компонента, а не отдельного случая. Вне выборки — `skipped`; `skipped` допустим
 * только у необязательного гейта, поэтому свёртка D10 обязана трактовать «вне выборки» именно
 * как отсутствие вердикта, а не как pass (см. `foldRunVerdict`).
 *
 * Сравнение побайтовое: первый кадр уже лежит в CAS (гейт `render` положил его sha в мемо), так
 * что сравнение адресов и есть сравнение байтов.
 */
import { putArtifact } from "../evidence";
import { captureCase } from "./capture";
import { renderShaKey } from "./render";
import type { Gate, GateContext, GateResult } from "./types";

export const determinismGate: Gate = {
  name: "determinism",
  async run(ctx: GateContext): Promise<GateResult> {
    if (!ctx.determinismSampled) {
      return { gate: "determinism", status: "skipped", metrics: { sampled: false, sampleSize: ctx.policy.determinismSampleSize } };
    }
    const first = ctx.shared.get(renderShaKey(ctx.case.caseId));
    if (typeof first !== "string") {
      // Кадра нет — сравнивать не с чем. Это диагностика, а не дефект компонента.
      return { gate: "determinism", status: "indeterminate", metrics: { sampled: true }, detail: "No baseline frame was captured for this case" };
    }
    const repeat = await captureCase(ctx);
    if (!repeat.image) {
      return { gate: "determinism", status: "indeterminate", metrics: { sampled: true, retries: repeat.retries }, detail: "Repeat capture returned no image bytes" };
    }
    const second = await putArtifact(ctx.dataDir, repeat.image.bytes);
    const identical = second.sha256 === first;
    return {
      gate: "determinism",
      status: identical ? "pass" : "fail",
      artifacts: [{ name: "determinism.png", sha256: second.sha256, bytes: second.bytes }],
      metrics: { sampled: true, byteIdentical: identical, first, second: second.sha256, retries: repeat.retries },
      ...(identical ? {} : { detail: `Repeat capture differs: ${first} vs ${second.sha256}` }),
    };
  },
};
