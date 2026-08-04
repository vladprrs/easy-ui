/**
 * Стор capture-receipt'ов (план `docs/plans/2026-08-03-renderer-contract-2.md` §2.1 **P7**, §5 **R5**).
 *
 * Раскладка:
 * ```
 * <dataDir>/.receipts/<sha[0:2]>/<sha>            — receipt (канонический JSON)
 * <dataDir>/.receipts/index/jobs/<jobId>.json     — {receiptSha256, ownerKey, createdAt}
 * <dataDir>/.receipts/index/assets/<assetId>.json — {receiptSha256, createdAt}
 * ```
 *
 * Почему отдельный маленький CAS, а не уже существующие хранилища:
 * - **asset-store запрещён**: у него нет GC вовсе, а receipt пишется на каждый капчур (та же
 *   причина, что породила A4);
 * - **acceptance-CAS не переиспользуется**: у него refcount по строкам приёмки, здесь — TTL/LRU;
 *   связывать два контура GC — заводить новый класс инцидентов (триаж S-m7 отклонён).
 *
 * Два индекса и почему их два:
 * - `jobId → {receiptSha256, ownerKey}` — доступ по ручке `GET /api/screenshot-jobs/:id/receipt`
 *   (N12: ручки «по sha» нет). Джоба живёт в памяти 10 минут (`RESULT_TTL_MS`) и вычищается
 *   `reapExpired()`, а receipt — 7 суток, поэтому **авторизация не может зависеть от живой
 *   джобы**: ключ владения записывается рядом с ссылкой (V-N4).
 * - `assetId → receiptSha256` — резолв рендерера эталона в R6 (T-B2). Пишется **после**
 *   `assetRepo.ingest`: до ингеста assetId не существует (V-N7).
 *
 * Свипер: TTL 7 суток, потолок 64 МБ, LRU по mtime, GC на старте процесса и при записи,
 * **пин-провайдер** (receipt'ы живых job-результатов и — с R6 — ссылок `visual_references` не
 * вытесняются; канон `gcCandidates`/`candidatePins`).
 */
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalReceiptJson, type CaptureReceipt } from "../../src/capture/receipt";

export const RECEIPTS_DIR_NAME = ".receipts";
/** TTL стора: переживает и `RESULT_TTL_MS` джобы (10 мин), и рабочую неделю расследования. */
export const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RECEIPT_MAX_BYTES = 64 * 1024 * 1024;
/** Молодой receipt не вытесняется: ссылка на него может быть ещё не записана (канон evidence-GC). */
export const RECEIPT_GC_GRACE_MS = 30 * 60_000;

const SHA_PATTERN = /^[0-9a-f]{64}$/;
const JOB_ID_PATTERN = /^job_[0-9a-fA-F-]{36}$/;
const ASSET_ID_PATTERN = /^asset_[0-9a-f]{64}$/;

export const receiptsRoot = (dataDir: string): string => resolve(dataDir, RECEIPTS_DIR_NAME);
const casRoot = (dataDir: string): string => receiptsRoot(dataDir);
const jobIndexRoot = (dataDir: string): string => resolve(receiptsRoot(dataDir), "index", "jobs");
const assetIndexRoot = (dataDir: string): string => resolve(receiptsRoot(dataDir), "index", "assets");

/** Kill-switch волны (`EASYUI_CAPTURE_RECEIPTS_DISABLED=1`); дефолт — receipt'ы включены. */
export const receiptsDisabled = (): boolean => process.env.EASYUI_CAPTURE_RECEIPTS_DISABLED === "1";

/** Адрес receipt'а. `sha` обязан быть 64-hex — иначе это не адрес, а произвольный путь. */
export function receiptPath(dataDir: string, sha: string): string | null {
  if (!SHA_PATTERN.test(sha)) return null;
  return resolve(casRoot(dataDir), sha.slice(0, 2), sha);
}

const writeAtomic = async (path: string, data: string): Promise<void> => {
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
};

const sha256Of = (value: string): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");

export interface StoredReceipt { sha256: string; bytes: number }

/**
 * Кладёт receipt в стор и запускает GC-on-write. Адрес — sha256 **канонического** JSON, того же
 * текста, который читает `readReceiptBytes`: гейты приёмки кладут в CAS ровно эти байты, поэтому
 * `receipt.json` в evidence адресуется тем же sha, что и запись здесь.
 *
 * Троттлинг GC-on-write: полный проход GC — это O(размер стора) readdir/stat по шардам и обоим
 * индексам плюс пин-провайдер (скан acceptance-таблиц), и внутри `ScreenshotService.execute`
 * он был бы прямой добавкой к латентности каждого капчура (замер приёмки R5: ~700 мс на 5k
 * записей ещё до работы БД). Пишем всегда, GC — не чаще раза в интервал и не реже, чем раз в
 * N записей; корректность вытеснения не страдает — потолок/TTL догоняют на следующем тике.
 */
export const RECEIPT_GC_MIN_INTERVAL_MS = 60_000;
export const RECEIPT_GC_EVERY_WRITES = 50;
let lastGcAtMs = 0;
let writesSinceGc = 0;
/** Только для тестов: сбросить троттлинг, чтобы прогнать GC детерминированно. */
export function __resetReceiptGcThrottleForTest(): void { lastGcAtMs = 0; writesSinceGc = 0; }

export async function putReceipt(dataDir: string, receipt: CaptureReceipt): Promise<StoredReceipt> {
  const json = canonicalReceiptJson(receipt);
  const sha = sha256Of(json);
  const path = receiptPath(dataDir, sha)!;
  await mkdir(resolve(path, ".."), { recursive: true });
  try {
    const existing = await stat(path);
    if (existing.size === Buffer.byteLength(json)) {
      // Хит: обновляем mtime — LRU-семантика «последнее использование», а не «первая запись»,
      // иначе постоянно перевоспроизводимый receipt старился бы до TTL-вытеснения (минор R5).
      const now = new Date();
      await utimes(path, now, now).catch(() => {});
      return { sha256: sha, bytes: existing.size };
    }
  } catch { /* записи нет — пишем */ }
  await writeAtomic(path, json);
  writesSinceGc += 1;
  const now = Date.now();
  if (now - lastGcAtMs >= RECEIPT_GC_MIN_INTERVAL_MS || writesSinceGc >= RECEIPT_GC_EVERY_WRITES) {
    lastGcAtMs = now;
    writesSinceGc = 0;
    await gcReceipts(dataDir);
  }
  return { sha256: sha, bytes: Buffer.byteLength(json) };
}

/** Сырые байты receipt'а (их же кладут в acceptance-CAS, чтобы sha совпадал). */
export async function readReceiptBytes(dataDir: string, sha: string): Promise<string | null> {
  const path = receiptPath(dataDir, sha);
  if (path === null) return null;
  try { return await readFile(path, "utf8"); } catch { return null; }
}

export async function readReceipt(dataDir: string, sha: string): Promise<CaptureReceipt | null> {
  const raw = await readReceiptBytes(dataDir, sha);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? parsed as CaptureReceipt : null;
  } catch { return null; }
}

export interface JobReceiptLink { receiptSha256: string; ownerKey: string; createdAt: string }
export interface AssetReceiptLink { receiptSha256: string; createdAt: string }

const indexPath = (root: string, key: string): string => resolve(root, `${key}.json`);

/**
 * Ссылка джобы на receipt вместе с ключом владения. `ownerKey` — авторизационный ключ цели
 * капчура (`component:<id>` / `prototype:<id>`), а не идентификатор пользователя: владелец
 * ресурса может смениться, и проверять надо текущее владение, а не запомненного человека.
 */
export async function putJobReceipt(dataDir: string, jobId: string, link: { receiptSha256: string; ownerKey: string }): Promise<void> {
  if (!JOB_ID_PATTERN.test(jobId) || !SHA_PATTERN.test(link.receiptSha256)) return;
  await mkdir(jobIndexRoot(dataDir), { recursive: true });
  await writeAtomic(indexPath(jobIndexRoot(dataDir), jobId), JSON.stringify({ ...link, createdAt: new Date().toISOString() }));
}

export async function getJobReceipt(dataDir: string, jobId: string): Promise<JobReceiptLink | null> {
  if (!JOB_ID_PATTERN.test(jobId)) return null;
  try {
    const parsed = JSON.parse(await readFile(indexPath(jobIndexRoot(dataDir), jobId), "utf8")) as JobReceiptLink;
    return SHA_PATTERN.test(parsed?.receiptSha256 ?? "") && typeof parsed.ownerKey === "string" ? parsed : null;
  } catch { return null; }
}

/** Ссылка ассета на receipt (R6 резолвит по ней рендерер эталона). Пишется после `ingest`. */
export async function putAssetReceipt(dataDir: string, assetId: string, receiptSha256: string): Promise<void> {
  if (!ASSET_ID_PATTERN.test(assetId) || !SHA_PATTERN.test(receiptSha256)) return;
  await mkdir(assetIndexRoot(dataDir), { recursive: true });
  await writeAtomic(indexPath(assetIndexRoot(dataDir), assetId), JSON.stringify({ receiptSha256, createdAt: new Date().toISOString() }));
}

export async function getAssetReceipt(dataDir: string, assetId: string): Promise<AssetReceiptLink | null> {
  if (!ASSET_ID_PATTERN.test(assetId)) return null;
  try {
    const parsed = JSON.parse(await readFile(indexPath(assetIndexRoot(dataDir), assetId), "utf8")) as AssetReceiptLink;
    return SHA_PATTERN.test(parsed?.receiptSha256 ?? "") ? parsed : null;
  } catch { return null; }
}

/**
 * Процесс-широкий провайдер пинов (канон `setCandidatePinProvider`): множество sha, которые
 * свипер не вытесняет ни по TTL, ни по LRU. Сегодня его наполняет `ScreenshotService` живыми
 * job-результатами и раннер приёмки — манифестами ранов; R6 добавит `visual_references`.
 */
let processPinProvider: (() => Set<string> | Promise<Set<string>>) | null = null;

export function setReceiptPinProvider(provider: (() => Set<string> | Promise<Set<string>>) | null): void {
  processPinProvider = provider;
}

export interface ReceiptGcOptions {
  ttlMs?: number;
  maxBytes?: number;
  graceMs?: number;
  pinned?: () => Set<string> | Promise<Set<string>>;
  now?: number;
}
export interface ReceiptGcReport { removed: number; freedBytes: number; totalBytes: number; removedLinks: number }

/**
 * Best-effort свипер. Никогда не бросает: отказ GC не должен ронять ни старт сервера, ни капчур.
 *
 * Порядок: 1) индексные ссылки, чей receipt исчез или которые старше TTL; 2) файлы старше TTL,
 * кроме запиненных и молодых; 3) потолок байт — LRU по mtime, снова кроме запиненных.
 * Байты запиненных считаются в потолок: пин не должен молча поднимать фактический размер стора.
 */
export async function gcReceipts(dataDir: string, options: ReceiptGcOptions = {}): Promise<ReceiptGcReport> {
  const report: ReceiptGcReport = { removed: 0, freedBytes: 0, totalBytes: 0, removedLinks: 0 };
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? RECEIPT_TTL_MS;
  const maxBytes = options.maxBytes ?? RECEIPT_MAX_BYTES;
  const graceMs = options.graceMs ?? RECEIPT_GC_GRACE_MS;
  const provider = options.pinned ?? processPinProvider ?? null;
  // Отказ провайдера означает «список пинов неизвестен»; безопасная сторона — не вытеснить
  // ничего, а не вытеснить запиненное.
  let pinned: Set<string>;
  try { pinned = (await provider?.()) ?? new Set<string>(); }
  catch { return report; }

  const files: { sha: string; path: string; bytes: number; mtimeMs: number }[] = [];
  let shards: string[];
  try { shards = await readdir(casRoot(dataDir)); } catch { return report; }
  for (const shard of shards) {
    if (!/^[0-9a-f]{2}$/.test(shard)) continue;
    let names: string[];
    try { names = await readdir(resolve(casRoot(dataDir), shard)); } catch { continue; }
    for (const name of names) {
      if (!SHA_PATTERN.test(name)) continue;
      const path = resolve(casRoot(dataDir), shard, name);
      try {
        const info = await stat(path);
        files.push({ sha: name, path, bytes: info.size, mtimeMs: info.mtimeMs });
      } catch { /* гонка с параллельной записью */ }
    }
  }

  const alive = new Set(files.map((file) => file.sha));
  for (const root of [jobIndexRoot(dataDir), assetIndexRoot(dataDir)]) {
    let names: string[];
    try { names = await readdir(root); } catch { continue; }
    for (const name of names) {
      const path = resolve(root, name);
      try {
        const info = await stat(path);
        const raw = JSON.parse(await readFile(path, "utf8")) as { receiptSha256?: string };
        const dangling = typeof raw.receiptSha256 !== "string" || !alive.has(raw.receiptSha256);
        // Ссылка на молодую запись может опережать её появление на диске лишь на миллисекунды,
        // и всё же grace здесь тот же, что у файлов: гонка записи не должна стирать индекс.
        if ((dangling && now - info.mtimeMs > graceMs) || now - info.mtimeMs > ttlMs) {
          await rm(path, { force: true });
          report.removedLinks += 1;
        }
      } catch { /* битая запись — следующий проход дожмёт */ }
    }
  }

  const kept: typeof files = [];
  for (const file of files) {
    const young = now - file.mtimeMs < graceMs;
    if (!pinned.has(file.sha) && !young && now - file.mtimeMs > ttlMs) {
      try { await rm(file.path, { force: true }); report.removed += 1; report.freedBytes += file.bytes; continue; }
      catch { /* best effort */ }
    }
    kept.push(file);
  }

  let total = kept.reduce((sum, file) => sum + file.bytes, 0);
  if (total > maxBytes) {
    for (const file of [...kept].sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      if (total <= maxBytes) break;
      if (pinned.has(file.sha) || now - file.mtimeMs < graceMs) continue;
      try {
        await rm(file.path, { force: true });
        total -= file.bytes;
        report.removed += 1;
        report.freedBytes += file.bytes;
      } catch { /* best effort */ }
    }
  }
  report.totalBytes = Math.max(total, 0);
  return report;
}
