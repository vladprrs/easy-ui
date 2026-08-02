import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtractResult } from "./extract-subprocess";

/**
 * Эфемерный candidate-bundle кэш (план 2026-08-02 P8): результат validate-префлайта
 * head-ревизии, адресуемый `sourceHash` исходника. **Файловый, без миграции** — каталог
 * `<dataDir>/.candidates/<sourceHash>/{result.json,bundle.js}`; план допускает файловый
 * кэш именно чтобы не тащить миграцию схемы (записи кандидатов в БД нет).
 *
 * Границы контракта:
 * - публичного URL у кандидата **нет** и не будет: бандл достаётся только внутри процесса
 *   (`getCandidateBundle`) — следующая часть W2 (draft-preview, P1b) читает его отсюда по
 *   паре `(componentId, sourceHash)`;
 * - TTL 24 ч + потолок суммарных байт; GC на старте процесса (`gcCandidates` из
 *   `startServer`) и при каждой записи;
 * - запись источнико-чистая: extraction/compile зависят только от исходника, поэтому
 *   publish может легально переиспользовать `extracted` через шов `PublishExtraction`
 *   (сверка sha256 там уже есть). Receipt-поля `themeVersion`/`catalogRevision` в кэш
 *   **не** пишутся — они снимок каталога на момент ответа, а не свойство исходника.
 */

export const CANDIDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const CANDIDATE_CACHE_MAX_BYTES = 32 * 1024 * 1024;

export const CANDIDATES_DIR_NAME = ".candidates";
export const candidatesRoot = (dataDir: string) => resolve(dataDir, CANDIDATES_DIR_NAME);
const candidateDir = (dataDir: string, sourceHash: string) => resolve(candidatesRoot(dataDir), sourceHash);

/** Провальный исход префлайта, сериализуемый обратно в ApiError на ответе. */
export type CandidateFailure = {
  status: 400 | 413 | 422;
  code: string;
  message: string;
  issues?: { path: (string | number)[]; message: string }[];
};

export type CandidateEntry = {
  version: 1;
  sourceHash: string;
  /** Компоненты, чей head-исходник дал этот хэш (один исходник бывает у нескольких драфтов). */
  componentIds: string[];
  createdAt: string;
  ok: boolean;
  failure?: CandidateFailure;
  /** Результат `checkSource(source, path, true)` — того же вызова, что делает publish. */
  extracted?: ExtractResult;
  parityWarnings?: string[];
  bundleHash?: string;
  hostAbiVersion?: number;
};

export const candidateExpired = (entry: CandidateEntry, now = Date.now(), ttlMs = CANDIDATE_CACHE_TTL_MS): boolean =>
  now - Date.parse(entry.createdAt) > ttlMs;

/** Читает `result.json`; null на отсутствии/битой записи (битая будет вычищена GC). */
export async function readCandidate(dataDir: string, sourceHash: string): Promise<CandidateEntry | null> {
  let raw: string;
  try { raw = await readFile(resolve(candidateDir(dataDir, sourceHash), "result.json"), "utf8"); }
  catch { return null; }
  try {
    const entry = JSON.parse(raw) as CandidateEntry;
    if (entry.version !== 1 || entry.sourceHash !== sourceHash || !Array.isArray(entry.componentIds)) return null;
    return entry;
  } catch { return null; }
}

const writeAtomic = async (path: string, content: string): Promise<void> => {
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
};

/**
 * Записывает кандидата и запускает GC-on-write (план P8: «GC на старте и при записи»).
 * `componentIds` мержится с уже лежащей записью того же хэша: тяжёлые поля источнико-чисты,
 * а список компонентов — advisory-индекс для lookup'а P1b. Гонка двух записей одного хэша
 * в худшем случае теряет один id из advisory-списка — для эфемерного кэша приемлемо.
 */
export async function writeCandidate(dataDir: string, entry: CandidateEntry, bundleJs?: string): Promise<void> {
  const dir = candidateDir(dataDir, entry.sourceHash);
  await mkdir(dir, { recursive: true });
  const existing = await readCandidate(dataDir, entry.sourceHash);
  const componentIds = [...new Set([...(existing?.componentIds ?? []), ...entry.componentIds])].sort();
  if (bundleJs !== undefined) await writeAtomic(resolve(dir, "bundle.js"), bundleJs);
  await writeAtomic(resolve(dir, "result.json"), JSON.stringify({ ...entry, componentIds }));
  await gcCandidates(dataDir);
}

/**
 * Lookup для draft-preview (P1b): кандидат по паре `(componentId, sourceHash)`.
 * Возвращает null, когда записи нет, она протухла или хэш собирался под чужим компонентом.
 */
export async function getCandidateBundle(
  dataDir: string,
  componentId: string,
  sourceHash: string,
): Promise<{ entry: CandidateEntry; bundleJs: string } | null> {
  const entry = await readCandidate(dataDir, sourceHash);
  if (!entry?.ok || candidateExpired(entry) || !entry.componentIds.includes(componentId)) return null;
  try { return { entry, bundleJs: await readFile(resolve(candidateDir(dataDir, sourceHash), "bundle.js"), "utf8") }; }
  catch { return null; }
}

const entryBytes = async (dir: string): Promise<number> => {
  let total = 0;
  for (const file of await readdir(dir)) {
    try { total += (await stat(resolve(dir, file))).size; } catch { /* гонка с GC — best effort */ }
  }
  return total;
};

/**
 * Best-effort GC: сносит протухшие и битые записи, затем вытесняет самые старые, пока
 * суммарный вес кэша над потолком. Никогда не бросает — отказ GC не должен ронять ни
 * старт сервера, ни validate.
 */
export async function gcCandidates(
  dataDir: string,
  limits: { ttlMs?: number; maxBytes?: number } = {},
): Promise<{ removed: number }> {
  const ttlMs = limits.ttlMs ?? CANDIDATE_CACHE_TTL_MS;
  const maxBytes = limits.maxBytes ?? CANDIDATE_CACHE_MAX_BYTES;
  const root = candidatesRoot(dataDir);
  let names: string[];
  try { names = await readdir(root); } catch { return { removed: 0 }; }
  let removed = 0;
  const alive: { dir: string; createdAt: number; bytes: number }[] = [];
  for (const name of names) {
    const dir = resolve(root, name);
    try {
      const entry = await readCandidate(dataDir, name);
      if (entry === null || candidateExpired(entry, Date.now(), ttlMs)) {
        await rm(dir, { recursive: true, force: true });
        removed++;
        continue;
      }
      alive.push({ dir, createdAt: Date.parse(entry.createdAt), bytes: await entryBytes(dir) });
    } catch { /* гонка за одну запись — следующий GC дожмёт */ }
  }
  let total = alive.reduce((sum, item) => sum + item.bytes, 0);
  for (const item of alive.sort((a, b) => a.createdAt - b.createdAt)) {
    if (total <= maxBytes) break;
    try {
      await rm(item.dir, { recursive: true, force: true });
      total -= item.bytes;
      removed++;
    } catch { /* best effort */ }
  }
  return { removed };
}
