/**
 * Гейт `render` (RFC §4.2): случай снимается на кандидатском билде, кадр уезжает в CAS.
 *
 * Вердикт — по качеству капчура (D11): `productErrors` непусты ⇒ `fail` (компонент бросил в
 * консоль/на странице), инфраструктурный шум и предупреждения идут в evidence и не роняют.
 * PNG кладётся в CAS **всегда** — даже у провалившегося случая: кадр и есть доказательство.
 */
import { putArtifact } from "../evidence";
import { captureCase } from "./capture";
import type { Gate, GateContext, GateResult } from "./types";

/** Ключ мемо: sha свежего кадра случая, который переиспользует гейт `determinism`. */
export const renderShaKey = (caseId: string): string => `render.sha:${caseId}`;
/** Ключ мемо: качество капчура случая — его пишет в строку случая раннер (D11). */
export const renderQualityKey = (caseId: string): string => `render.quality:${caseId}`;

export const renderGate: Gate = {
  name: "render",
  async run(ctx: GateContext): Promise<GateResult> {
    const capture = await captureCase(ctx);
    ctx.shared.set(renderQualityKey(ctx.case.caseId), capture.quality);
    const image = capture.image;
    if (!image) {
      return {
        gate: "render",
        status: "indeterminate",
        detail: "Capture returned no image bytes",
        metrics: { retries: capture.retries },
      };
    }
    const artifact = await putArtifact(ctx.dataDir, image.bytes);
    ctx.shared.set(renderShaKey(ctx.case.caseId), artifact.sha256);
    const clean = capture.quality.captureClean;
    return {
      gate: "render",
      status: clean ? "pass" : "fail",
      artifacts: [{ name: "render.png", sha256: artifact.sha256, bytes: artifact.bytes }],
      metrics: {
        width: image.width, height: image.height, bytes: artifact.bytes, sha256: artifact.sha256,
        retries: capture.retries, captureClean: clean,
        browserVersion: capture.browserVersion ?? null,
      },
      warnings: [...capture.quality.runtimeWarnings, ...capture.quality.infraWarnings],
      ...(clean ? {} : { detail: capture.quality.productErrors.slice(0, 5).join("; ") }),
    };
  },
};
