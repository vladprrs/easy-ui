/**
 * Гейт `render` (RFC §4.2): случай снимается на кандидатском билде, кадр уезжает в CAS.
 *
 * Вердикт — по качеству капчура (D11): `productErrors` непусты ⇒ `fail` (компонент бросил в
 * консоль/на странице), инфраструктурный шум и предупреждения идут в evidence и не роняют.
 * PNG кладётся в CAS **всегда** — даже у провалившегося случая: кадр и есть доказательство.
 */
import { putArtifact } from "../evidence";
import { readReceiptBytes } from "../../capture/receiptStore";
import { captureCase } from "./capture";
import type { Gate, GateContext, GateResult } from "./types";

/** Ключ мемо: sha свежего кадра случая, который переиспользует гейт `determinism`. */
export const renderShaKey = (caseId: string): string => `render.sha:${caseId}`;
/** Ключ мемо: качество капчура случая — его пишет в строку случая раннер (D11). */
export const renderQualityKey = (caseId: string): string => `render.quality:${caseId}`;
/**
 * Ключ мемо: исход readiness кадра (W4). Гейт `readiness` не снимает своего капчура — он судит
 * **тот самый кадр**, который получил `render`; иначе вердикт относился бы к другому кадру.
 */
export const renderReadinessKey = (caseId: string): string => `render.readiness:${caseId}`;

/**
 * Копирует receipt капчура из его стора в CAS приёмки. `null` — receipt'ов нет (kill-switch) или
 * запись вытеснена: отсутствие доказательства не превращает кадр в провал, но и не подделывается.
 */
async function captureReceiptArtifact(dataDir: string, sha: string | undefined): Promise<{ sha256: string; bytes: number } | null> {
  if (sha === undefined) return null;
  const raw = await readReceiptBytes(dataDir, sha);
  if (raw === null) return null;
  const artifact = await putArtifact(dataDir, raw);
  return { sha256: artifact.sha256, bytes: artifact.bytes };
}

export const renderGate: Gate = {
  name: "render",
  async run(ctx: GateContext): Promise<GateResult> {
    const capture = await captureCase(ctx);
    ctx.shared.set(renderQualityKey(ctx.case.caseId), capture.quality);
    if (capture.readiness) ctx.shared.set(renderReadinessKey(ctx.case.caseId), capture.readiness);
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
    // Receipt кадра (R5) уезжает в evidence **копией**: стор receipt'ов живёт по TTL/LRU, а
    // доказательства приёмки — по refcount'у своего CAS, и связывать два контура GC нельзя
    // (P7). Байты кладутся ровно те, что лежат в сторе, поэтому адрес совпадает с `receiptSha256`
    // джобы, и `receipt.json` попадает в per-run манифест и SHA256SUMS как обычный артефакт.
    const receiptArtifact = await captureReceiptArtifact(ctx.dataDir, capture.receiptSha256);
    const clean = capture.quality.captureClean;
    return {
      gate: "render",
      status: clean ? "pass" : "fail",
      artifacts: [
        { name: "render.png", sha256: artifact.sha256, bytes: artifact.bytes },
        ...(receiptArtifact === null ? [] : [{ name: "receipt.json", sha256: receiptArtifact.sha256, bytes: receiptArtifact.bytes }]),
      ],
      metrics: {
        width: image.width, height: image.height, bytes: artifact.bytes, sha256: artifact.sha256,
        retries: capture.retries, captureClean: clean,
        browserVersion: capture.browserVersion ?? null,
        receiptSha256: receiptArtifact?.sha256 ?? null,
        // Типизированные коды кадра (R3): гейт `render` судит качество консоли, но причина
        // «кадр снят с непрогруженным ресурсом» обязана быть машиночитаемой и здесь — иначе
        // K4 держится только на гейте `readiness`, которого у не-байтовых режимов может не быть.
        codes: capture.readiness?.readinessCodes ?? [],
      },
      warnings: [...capture.quality.runtimeWarnings, ...capture.quality.infraWarnings],
      ...(clean ? {} : { detail: capture.quality.productErrors.slice(0, 5).join("; ") }),
    };
  },
};
