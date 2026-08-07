import { ApiError, json, noStore, readJson } from "../http";
import type { JobStatus, ResolvedCandidateOverride, ScreenshotResult, ScreenshotService } from "../screenshot/service";
import type { Database } from "bun:sqlite";
import type { Principal } from "../auth";
import { requirePrototypeOwner, requirePrototypeRead, requireResourceOwner, requireUser, resourceOwner } from "../authorization";
import { registerOverlayLease, releaseOverlayLease } from "../components/candidates";
import { barrierAwareReadinessPolicy } from "../capture/resourceBarrier";
import type { ReadinessPolicy } from "../../src/capture/readinessPolicy";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Потолок подмен на один кадр (план 2026-08-05 §B1/B3). Флаг возможностей — объём W4. */
export const prototypeCandidateOverlayMax = 2;

/** Строка кандидата, нужная overlay-постановке; читается напрямую, без acceptance-репозитория. */
interface OverlayCandidateRow { candidate_id: string; component_id: string; rev: number; source_hash: string; bundle_hash: string }

/**
 * Единый отказ «такого кандидата для вас нет» (план §B1, авторизация v3).
 *
 * Он **один и тот же** для несуществующего и для чужого кандидата — байт в байт, включая
 * сообщение. `requireResourceOwner` здесь не годится принципиально: он отвечает 403 на чужой
 * ресурс и 404 на отсутствующий, то есть сам является оракулом существования кандидатов
 * (и, через `candidate_id`, факта чужой сборки). Поэтому проверка встроена сюда, а не переиспользована.
 */
const overlayCandidateNotFound = (): ApiError => new ApiError(404, "not_found", "Candidate not found");

/**
 * Резолв кандидата подмены с владельческой проверкой (§B1). Админ проходит по тому же
 * short-circuit'у, что и в `requireResourceOwner`: администратор видит чужие компоненты по
 * определению роли, и прятать от него кандидата было бы неконсистентно с остальным API.
 */
function overlayCandidate(db: Database, candidateId: string, principal: Principal): OverlayCandidateRow {
  const user = requireUser(principal);
  const row = db.query("SELECT candidate_id,component_id,rev,source_hash,bundle_hash FROM component_candidates WHERE candidate_id=?")
    .get(candidateId) as OverlayCandidateRow | null;
  if (!row) throw overlayCandidateNotFound();
  if (!user.isAdmin) {
    // `resourceOwner` бросает свой 404 на отсутствующий компонент — он тоже схлопывается в
    // единый отказ: «кандидат есть, но компонента нет» наружу неотличимо от «кандидата нет».
    let owner: string;
    try { owner = resourceOwner(db, "components", row.component_id); }
    catch { throw overlayCandidateNotFound(); }
    if (owner !== user.userId) throw overlayCandidateNotFound();
  }
  return row;
}

/** Разбор `candidateOverrides` тела запроса: только форма и потолки, без обращений к БД. */
function parseCandidateOverrides(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ApiError(400, "invalid_request", "candidateOverrides must be an array");
  if (value.length > prototypeCandidateOverlayMax) {
    throw new ApiError(400, "invalid_request", `candidateOverrides accepts at most ${prototypeCandidateOverlayMax} entries`);
  }
  const ids: string[] = [];
  for (const entry of value) {
    if (!isObject(entry)) throw new ApiError(400, "invalid_request", "candidateOverrides entries must be objects");
    for (const key of Object.keys(entry)) {
      if (key !== "candidateId") throw new ApiError(400, "invalid_request", `candidateOverrides entries have an unknown field: ${key}`);
    }
    if (typeof entry.candidateId !== "string" || entry.candidateId.length === 0) {
      throw new ApiError(400, "invalid_request", "candidateOverrides[].candidateId must be a non-empty string");
    }
    ids.push(entry.candidateId);
  }
  return ids;
}

/**
 * HTTP-конверт результата джобы (план §B2.1, v3.1 F1).
 *
 * Байтовый исход (`kind:"image-bytes"`) наружу в JSON не едет **никогда** — ни для overlay-джобы,
 * ни для существующих candidate-джоб приёмки (их статус сегодня отдаёт numeric-keyed массив на
 * мегабайты). Санитизация живёт ровно здесь, на HTTP-границе: in-process потребитель
 * (`gates/capture.ts` → `service.get()` → `result.bytes`) обязан продолжать получать байты, а
 * трогать `job.result` значило бы сломать гейт приёмки. Сами байты доступны отдельной ручкой
 * `GET /api/screenshot-jobs/:jobId/bytes`, пока жив результат (RESULT_TTL).
 */
export function sanitizeJobStatus(status: JobStatus): JobStatus {
  const result = status.result;
  if (!result || result.kind !== "image-bytes") return status;
  const { bytes, ...rest } = result;
  return {
    ...status,
    result: { ...rest, byteLength: bytes.byteLength, pngSha256: pngSha256Of(bytes) } as unknown as ScreenshotResult,
  };
}

/** sha256 отданных байтов: тот же адрес кадра, что пишет в receipt воркер (`output.pngSha256`). */
const pngSha256Of = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/**
 * Авторизация чтения overlay-джобы (§B2.6): владение прототипом **и** владение каждым
 * подменённым компонентом. Одного `requirePrototypeRead` мало — на опубликованном прототипе он
 * пропускает любого, включая share-принципала, а кадр показывает неопубликованный код кандидата.
 */
function authorizeOverlayJob(db: Database, service: ScreenshotService, jobId: string, principal: Principal): void {
  const job = service.peek(jobId);
  if (job?.candidateOverlay === undefined) return;
  for (const entry of job.candidateOverlay) overlayCandidate(db, entry.candidateId, principal);
}

/** Общая авторизация обеих read-ручек джобы (`:jobId` и `:jobId/bytes`). */
function authorizeJobRead(db: Database, service: ScreenshotService, jobId: string, principal: Principal): void {
  const job = service.peek(jobId);
  if (job?.kind === "prototype") { const match = /^\/capture\/([^/]+)\//.exec(job.captureUrl); if (match) requirePrototypeRead(db, decodeURIComponent(match[1]!), principal); }
  // Component-джобы (published и draft) перепроверяют владельца компонента, как и постановка.
  if (job?.kind === "component") { const match = /^\/capture\/component\/([^/]+)\//.exec(job.captureUrl); if (match) requireResourceOwner(db, "components", decodeURIComponent(match[1]!), principal); }
  authorizeOverlayJob(db, service, jobId, principal);
}

function body(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new ApiError(400, "invalid_request", "Request body must be an object");
  return value;
}
function optionalPositiveInt(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new ApiError(400, "invalid_request", `${name} must be a positive integer`);
  return value;
}
/**
 * Опт-ин барьера ресурсов для одной джобы (план 2026-08-07 §W2, триаж O-M4).
 *
 * Дефолт интерактивного пути не меняется: редактор и превью человека продолжают снимать по v1 —
 * барьер стоит времени, а их вердикт смотрит человек. Сервисные съёмки (галереи) просят его
 * явно, потому что именно на этом пути воспроизводилась потеря registry-листов. При включённом
 * kill-switch параметр остаётся валидным и становится no-op'ом (v1) — иначе аварийное выключение
 * барьера ломало бы клиентов, а не только барьер.
 */
function parseReadinessOptIn(value: unknown): ReadinessPolicy | undefined {
  if (value === undefined) return undefined;
  if (value !== "barrier") throw new ApiError(400, "invalid_request", "readiness must be \"barrier\"");
  return barrierAwareReadinessPolicy("gallery");
}

function unavailable(): never { throw new ApiError(501, "screenshot_unavailable", "Screenshot capture requires SERVE_DIST and an installed chromium"); }

/**
 * Авторизация receipt'а джобы (§5 R5, N12). Ключ владения записан рядом со ссылкой в сторе,
 * поэтому проверка **не зависит от живой джобы**: результат живёт 10 минут, receipt — 7 суток
 * (V-N4). Проверяется текущее владение целью, а не запомненный пользователь: сменился владелец
 * компонента — сменился и тот, кому receipt доступен.
 *
 * Ручки «по sha» у receipt'ов нет и не будет (инвариант `server/routes/acceptance.ts:26`):
 * у content-addressed документа нет владельца, и такая ручка была бы cross-owner-каналом.
 */
export function authorizeReceiptOwner(db: Database, ownerKey: string, principal: Principal): void {
  const separator = ownerKey.indexOf(":");
  const kind = ownerKey.slice(0, separator);
  const id = ownerKey.slice(separator + 1);
  if (kind === "prototype" && id.length > 0) { requirePrototypeRead(db, id, principal); return; }
  if (kind === "component" && id.length > 0) { requireResourceOwner(db, "components", id, principal); return; }
  // Неразбираемый ключ владения — не повод отдать документ: доступ выводится только из владения.
  throw new ApiError(403, "forbidden", "Capture receipt is not accessible to this principal");
}

/**
 * Screenshot job routes. Returns `null` when the path is not a screenshot route
 * so the caller can fall through to the generic API router. When the path is a
 * screenshot route but the service is unavailable, POST returns 501 directly.
 *
 * `options.validateDisabled` — kill-switch P8 (`EASYUI_VALIDATE_DISABLED=1`): гасит и
 * draft-preview (P1b), потому что постановка draft-джобы собирает candidate-bundle тем же
 * тяжёлым префлайтом. Опубликованная съёмка кандидата не строит и продолжает работать.
 */
export async function routeScreenshots(request: Request, db:Database, service: ScreenshotService | undefined, segments: string[], principal:Principal, options:{validateDisabled?:boolean;acceptanceMatrix?:boolean}={}): Promise<Response | null> {
  // GET /api/screenshot-jobs/:jobId
  if (segments[0] === "screenshot-jobs" && segments.length === 2) {
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    if (!service) throw new ApiError(404, "job_not_found", "Screenshot job not found");
    authorizeJobRead(db, service, segments[1]!, principal);
    return json(sanitizeJobStatus(service.get(segments[1]!)), 200, noStore);
  }
  // GET /api/screenshot-jobs/:jobId/bytes — PNG байтового исхода (§B2.1). Живёт ровно столько,
  // сколько живёт результат джобы (RESULT_TTL 10 мин): байты держит память процесса, а не стор.
  if (segments[0] === "screenshot-jobs" && segments.length === 3 && segments[2] === "bytes") {
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    if (!service) throw new ApiError(404, "job_not_found", "Screenshot job not found");
    authorizeJobRead(db, service, segments[1]!, principal);
    const status = service.get(segments[1]!);
    if (status.result?.kind !== "image-bytes") throw new ApiError(404, "not_found", "Screenshot job has no image bytes");
    const bytes = status.result.bytes;
    return new Response(bytes as unknown as BodyInit, { status: 200, headers: { "content-type": "image/png", "content-length": String(bytes.byteLength), ...noStore } });
  }
  // GET /api/screenshot-jobs/:jobId/receipt — capture receipt кадра (§5 R5). Job-scoped: и живая
  // джоба, и вычищенная резолвятся через индекс стора, авторизация — по записанному ключу владения.
  if (segments[0] === "screenshot-jobs" && segments.length === 3 && segments[2] === "receipt") {
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    if (!service) throw new ApiError(404, "receipt_not_found", "Capture receipt not found");
    const found = await service.receiptFor(segments[1]!);
    if (!found) throw new ApiError(404, "receipt_not_found", "Capture receipt not found");
    authorizeReceiptOwner(db, found.ownerKey, principal);
    return json({ receiptSha256: found.receiptSha256, receipt: found.receipt }, 200, noStore);
  }
  // POST /api/prototypes/:id/screens/:screenId/screenshot
  if (segments[0] === "prototypes" && segments.length === 5 && segments[2] === "screens" && segments[4] === "screenshot") {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    if (!service) unavailable();
    requirePrototypeOwner(db,segments[1]!,principal);
    const b = body(await readJson(request));
    const rev = optionalPositiveInt(b.rev, "rev"), version = optionalPositiveInt(b.version, "version");
    if (rev !== undefined && version !== undefined) throw new ApiError(400, "invalid_request", "rev and version are mutually exclusive");
    if (b.probe !== undefined && b.probe !== "geometry") throw new ApiError(400, "invalid_request", "probe must be geometry");
    const overrideIds = parseCandidateOverrides(b.candidateOverrides);
    if (overrideIds.length > 0 && !(options.acceptanceMatrix === true && options.validateDisabled !== true)) {
      // Фича гасится теми же двумя ключами, что и всё, что живёт на кандидатах: без матричной
      // приёмки кандидатов не существует, а `EASYUI_VALIDATE_DISABLED` гасит candidate-bundle
      // целиком (тот же аргумент, что у draft-preview выше).
      throw new ApiError(404, "not_found", "Prototype candidate overlay is disabled");
    }
    const readinessPolicy = parseReadinessOptIn(b.readiness);
    const enqueue = (overrides: ResolvedCandidateOverride[]) => service.enqueuePrototype(segments[1]!, segments[3]!, { rev, version, viewport: b.viewport, deviceScaleFactor: b.deviceScaleFactor, theme: typeof b.theme === "string" ? b.theme : undefined, waitForFonts: b.waitForFonts !== false, probe: b.probe as "geometry" | undefined, ...(readinessPolicy ? { readinessPolicy } : {}), ...(overrides.length ? { candidateOverrides: overrides } : {}) });
    if (overrideIds.length === 0) return json(enqueue([]), 202, noStore);
    const rows = overrideIds.map((candidateId) => overlayCandidate(db, candidateId, principal));
    // Два кандидата одного компонента — не «последний выигрывает», а отказ: подмена пина
    // определена однозначно либо не определена вовсе.
    if (new Set(rows.map((row) => row.component_id)).size !== rows.length) {
      throw new ApiError(400, "invalid_request", "candidateOverrides must not target the same component twice");
    }
    // §B2.5: аренда пина регистрируется **до** чтения бандла и снимается на любом непоставившем
    // выходе. После успешной постановки пин держит сама джоба (`pinnedCandidateSourceHashes`),
    // поэтому аренда снимается и здесь — она страхует только окно резолва.
    const leases = rows.map((row) => registerOverlayLease(row.source_hash));
    try {
      const resolved: ResolvedCandidateOverride[] = [];
      for (const row of rows) {
        resolved.push(await service.resolveCandidateOverride({ candidateId: row.candidate_id, componentId: row.component_id, rev: row.rev, sourceHash: row.source_hash, bundleHash: row.bundle_hash }));
      }
      return json(enqueue(resolved), 202, noStore);
    } finally {
      for (const lease of leases) releaseOverlayLease(lease);
    }
  }
  // POST /api/components/:id/versions/:version/screenshot
  if (segments[0] === "components" && segments.length === 5 && segments[2] === "versions" && segments[4] === "screenshot") {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    if (!service) unavailable();
    requireResourceOwner(db,"components",segments[1]!,principal);
    const versionNumber = optionalPositiveInt(Number(segments[3]), "version");
    if (versionNumber === undefined) throw new ApiError(400, "invalid_request", "version must be a positive integer");
    const b = body(await readJson(request));
    if (Object.hasOwn(b, "props") && Object.hasOwn(b, "exampleName")) throw new ApiError(400, "invalid_request", "props and exampleName are mutually exclusive");
    if (b.props !== undefined && !isObject(b.props)) throw new ApiError(422, "invalid_props", "props must be a JSON object");
    if (b.exampleName !== undefined && typeof b.exampleName !== "string") throw new ApiError(400, "invalid_request", "exampleName must be a string");
    if (b.probe !== undefined && b.probe !== "geometry") throw new ApiError(400, "invalid_request", "probe must be geometry");
    const result = service.enqueueComponent(segments[1]!, versionNumber, { props: b.props as Record<string, unknown> | undefined, exampleName: b.exampleName as string | undefined, viewport: b.viewport, deviceScaleFactor: b.deviceScaleFactor, theme: typeof b.theme === "string" ? b.theme : undefined, waitForFonts: b.waitForFonts !== false, probe: b.probe as "geometry" | undefined });
    return json(result, 202, noStore);
  }
  // POST /api/components/:id/head/screenshot — draft-вариант (P1b): съёмка сохранённой, но не
  // опубликованной head-ревизии через candidate-bundle префлайта P8. Тело — как у published.
  if (segments[0] === "components" && segments.length === 4 && segments[2] === "head" && segments[3] === "screenshot") {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    if (!service) unavailable();
    if (options.validateDisabled) throw new ApiError(404, "not_found", "Component draft preview is disabled");
    const actor = requireResourceOwner(db,"components",segments[1]!,principal);
    const b = body(await readJson(request));
    if (Object.hasOwn(b, "props") && Object.hasOwn(b, "exampleName")) throw new ApiError(400, "invalid_request", "props and exampleName are mutually exclusive");
    if (b.props !== undefined && !isObject(b.props)) throw new ApiError(422, "invalid_props", "props must be a JSON object");
    if (b.exampleName !== undefined && typeof b.exampleName !== "string") throw new ApiError(400, "invalid_request", "exampleName must be a string");
    if (b.probe !== undefined && b.probe !== "geometry") throw new ApiError(400, "invalid_request", "probe must be geometry");
    const result = await service.enqueueComponentDraft(segments[1]!, actor.userId, { props: b.props as Record<string, unknown> | undefined, exampleName: b.exampleName as string | undefined, viewport: b.viewport, deviceScaleFactor: b.deviceScaleFactor, theme: typeof b.theme === "string" ? b.theme : undefined, waitForFonts: b.waitForFonts !== false, probe: b.probe as "geometry" | undefined });
    return json(result, 202, noStore);
  }
  return null;
}
