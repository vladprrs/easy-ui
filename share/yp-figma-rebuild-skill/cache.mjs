/* global process, Buffer, URLSearchParams */
/**
 * Клиентский кэш ответов easy-ui (план `docs/plans/2026-08-03-family-acceptance-and-composition-v3.md`
 * §5 W7, P1.3). Только клиент: сервер про этот кэш ничего не знает.
 *
 * **Кэш — ускоритель, а не свидетельство.** Приёмочное свидетельство живёт на сервере
 * (`GET /api/acceptance-runs/:id/evidence`, CAS + SHA256SUMS); локальные файлы годятся ровно на
 * то, чтобы не перезапрашивать уже полученный ответ. Любой отчёт агента обязан нести
 * `cache.status` — читатель должен видеть, что цифра пришла из кэша, а не с сервера.
 *
 * Раскладка каталога (`--cache-dir` / `EASYUI_CACHE_DIR`), права `0700`:
 *
 *   <cache>/requests/<sha256(key)>.json   запись ответа: request (без секретов), status,
 *                                          headers.etag, body | bodyRef, fetchedAt,
 *                                          fingerprints, refreshReason?
 *   <cache>/blobs/<sha256>                 бинарь (evidence-zip, PNG) по content-address
 *   <cache>/receipts/<verb>/<key>.json     что делала команда: id'шники + статус кэша
 *   <cache>/links.json                     candidate → run → cases → artifacts → report
 *   <cache>/SHA256SUMS                     контроль целостности всех файлов кэша
 *   <cache>/meta.json                      выученный `apiVersion` на идентичность (не секрет)
 *
 * Ключ записи:
 *
 *   key = sha256(canonicalJson({
 *     identity: sha256(baseUrl + "\n" + (userId|username)),
 *     method, path, query (отсортированный), bodyHash (canonical), apiVersion
 *   }))
 *
 * Токены, куки и `authorization` **не входят в ключ и не пишутся на диск** ни в одном виде:
 * в записи сохраняются только метод, путь, отсортированный query, хэш тела и белый список
 * заголовков ответа (`etag`). Идентичность входит в ключ, поэтому общий `--cache-dir` двух
 * учёток не отдаёт ответы чужой учётки (R3).
 *
 * Целостность: при чтении и запись, и blob сверяются с `SHA256SUMS`; расхождение — miss
 * (подменённый blob не может доехать до отчёта). Кэш выключен при legacy-Basic (общий барьер
 * не даёт различить учётку) и при отсутствии `--cache-dir`.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const CACHE_SCHEMA = "eui-cache-v1";
/** Терминальные статусы рана: только их ответы попадают в кэш (нетерминальный ран меняется). */
export const TERMINAL_RUN_STATUSES = Object.freeze(new Set(["pass", "pass_with_exceptions", "fail", "error", "cancelled"]));
/** Свежесть изменяемых ответов (каталог, capabilities): дольше — и агент увидит устаревший каталог. */
export const FRESH_TTL_MS = 5 * 60 * 1000;
const LINKS_LIMIT = 500;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** Каноническая JSON-сериализация: ключи объектов отсортированы, массивы — как есть. */
export function canonicalJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

/** Идентичность учётки: база API + имя пользователя. Пароль/куки сюда не попадают by design. */
export const identityHash = (baseUrl, user) => sha256(`${baseUrl}\n${user ?? ""}`);

/** Query в ключе не зависит от порядка параметров: `?a=1&b=2` и `?b=2&a=1` — один ключ. */
export function sortedQuery(search) {
  if (!search) return [];
  return [...new URLSearchParams(search).entries()].sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
}

export function requestKey({ identity, method, path, query, bodyHash = null, apiVersion }) {
  return sha256(canonicalJson({ schema: CACHE_SCHEMA, identity, method, path, query, bodyHash, apiVersion }));
}

/** Имя сегмента пути внутри кэша: `..`, слэши и абсолютные формы отвергаются (zip-slip, R3). */
export function safeSegment(value, label = "segment") {
  const text = String(value ?? "");
  if (!text || text === "." || text === ".." || text.includes("/") || text.includes("\\") || text.includes("\0")) {
    throw new Error(`unsafe cache ${label}: ${JSON.stringify(text)}`);
  }
  return text.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

/**
 * Что кэшируется. `immutable` — ответ, адрес которого уже содержит содержимое (версия
 * компонента, case-set, терминальный ран); `fresh` — изменяемый ответ с окном свежести и
 * фингерпринтом (`catalogRevision`) — сюда же относится и кандидат приёмки: его id
 * content-addressed, но строка живёт (`status`/`acceptanceRunId`/`runs[]`). Мутации, auth и нетерминальные раны
 * не кэшируются никогда: `classify` возвращает для них `null`, а `terminalOnly` дополнительно
 * запрещает **запись** нетерминального ответа.
 *
 * **Отрицательных ответов в кэше не бывает** (план 2026-08-04 §W4, расследование P1-5): `write()`
 * пишет только `status === 200`, а `GET /components/:id` не кэшируется вовсе — «компонента нет»
 * никогда не приезжает с диска. Единственный кэшируемый источник, из которого можно ошибочно
 * вывести отсутствие, — агрегированный **список** (`/catalog/manifest`, `fresh` 5 минут; в нём и
 * так только опубликованные версии, драфта там нет никогда). Поэтому вывод «нет» из списка в
 * `driver.mjs` не терминален: см. existence-provenance (`lookupMeta`, `loadCatalog`).
 */
export function classify(method, path) {
  if (method !== "GET") return null;
  const [rawPath] = String(path).split("?");
  const segments = rawPath.split("/").filter(Boolean);
  const [first, second, third] = segments;
  const json = (extra) => ({ kind: "json", ...extra });
  if (first === "capabilities" && segments.length === 1) return json({ mode: "fresh", ttlMs: FRESH_TTL_MS, learns: "capabilities" });
  if (first === "catalog" && (second === "manifest" || second === "candidates") && segments.length === 2) return json({ mode: "fresh", ttlMs: FRESH_TTL_MS });
  if (first === "design-systems" && segments.length === 2) return json({ mode: "fresh", ttlMs: FRESH_TTL_MS });
  if (first === "components" && third === "versions" && segments.length === 4) return json({ mode: "immutable" });
  // Кандидат адресуется content-addressed id, но **строка** мутабельна: `status`
  // (`validated → promoted`), `acceptanceRunId` и `runs[]` меняются в течение его жизни
  // (план 2026-08-04 W3, C22). Поэтому `fresh`, а не `immutable`: иначе тёплый кэш вечно
  // показывал бы кандидата без ранов. Автовыбор связки promote ходит мимо кэша — сетевым запросом.
  if (first === "component-candidates" && segments.length === 2) return json({ mode: "fresh", ttlMs: FRESH_TTL_MS });
  if (first === "case-sets" && (segments.length === 2 || (segments.length === 3 && third === "coverage"))) return json({ mode: "immutable" });
  if (first === "acceptance-runs" && segments.length === 2) return json({ mode: "immutable", terminalOnly: true });
  if (first === "acceptance-runs" && segments.length === 3 && third === "cases") return json({ mode: "immutable", terminalOnly: true });
  if (first === "acceptance-runs" && segments.length === 3 && third === "evidence") return { kind: "blob", mode: "immutable", terminalOnly: false };
  return null;
}

/** Фингерпринты ответа — то, чем hit доказуемо соответствует серверу (ETag сервер не отдаёт). */
export function extractFingerprints(body) {
  if (!body || typeof body !== "object") return {};
  const fingerprints = {};
  for (const key of ["catalogRevision", "buildFingerprint", "candidateId", "runId", "caseSetId", "status", "apiVersion", "rev"]) {
    const value = body[key];
    if (typeof value === "string" || typeof value === "number") fingerprints[key] = value;
  }
  const cases = Array.isArray(body.cases) ? body.cases : null;
  if (cases) {
    const list = cases.map((item) => item?.caseFingerprint).filter((item) => typeof item === "string");
    if (list.length) fingerprints.caseFingerprints = list;
  }
  return fingerprints;
}

const isTerminalRun = (body) => typeof body?.status === "string" && TERMINAL_RUN_STATUSES.has(body.status);

/** Выключенный кэш: тот же интерфейс, ноль операций с диском. */
function disabledCache(reason) {
  return {
    enabled: false,
    dir: null,
    reason,
    async read() { return null; },
    async write() { },
    async receipt() { },
    async link() { },
    async links() { return []; },
    learn() { },
    summary() { return { status: "off", reason }; },
    line() { return `cache: off (${reason})`; },
  };
}

/** No-op-кэш для вызывающего, который ещё (или уже) не сконфигурировал каталог. */
export const nullCache = (reason = "disabled") => disabledCache(reason);

/**
 * Открывает кэш. `disabled`/отсутствие `dir` дают no-op-объект: вызовы драйвера не ветвятся.
 * `refresh` — форс-мисс: запись всё равно обновляется, но с `refreshReason`.
 */
export async function openCache({ dir, baseUrl, user, refresh = false, refreshReason = "flag:--cache-refresh", disabled = false, disabledReason = "no --cache-dir", now = () => Date.now() }) {
  if (disabled) return disabledCache(disabledReason);
  if (!dir) return disabledCache("no --cache-dir");
  const root = resolve(dir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700).catch(() => { });
  for (const sub of ["requests", "blobs", "receipts"]) await mkdir(join(root, sub), { recursive: true, mode: 0o700 });

  const identity = identityHash(baseUrl, user);
  const sumsPath = join(root, "SHA256SUMS");
  const metaPath = join(root, "meta.json");
  const linksPath = join(root, "links.json");
  const sums = new Map();
  try {
    for (const line of (await readFile(sumsPath, "utf8")).split("\n")) {
      const match = /^([0-9a-f]{64})\s{2}(.+)$/.exec(line);
      if (match) sums.set(match[2], match[1]);
    }
  } catch { /* первого прогона ещё не было */ }

  let meta = {};
  try { meta = JSON.parse(await readFile(metaPath, "utf8")); } catch { meta = {}; }
  if (!meta || typeof meta !== "object") meta = {};
  /**
   * `apiVersion` входит в ключ, чтобы смена контракта обнулила кэш. Значение выучивается из
   * `/api/capabilities` и живёт в `meta.json` на идентичность: иначе первая команда, не
   * зовущая capabilities, ключевалась бы иначе, чем вторая — и hit'ы бы не встречались.
   */
  const versions = meta.apiVersions && typeof meta.apiVersions === "object" ? meta.apiVersions : {};
  let apiVersion = typeof versions[identity] === "string" ? versions[identity] : "unknown";

  const counters = { hit: 0, miss: 0, refresh: 0, write: 0 };
  let lastKey = null;
  let lastReason = null;

  const writeAtomic = async (path, data) => {
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, path);
  };

  const relative = (path) => path.slice(root.length + 1);

  const persistSums = async () => {
    const lines = [...sums.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([file, hash]) => `${hash}  ${file}`);
    await writeAtomic(sumsPath, `${lines.join("\n")}\n`);
  };

  /**
   * Записи сериализуются: параллельные запросы драйвера (`Promise.all` в `loadCatalog`) иначе
   * переписывали бы общий `SHA256SUMS` друг под другом и теряли контрольные суммы.
   */
  let queue = Promise.resolve();
  const serialize = (task) => {
    queue = queue.then(task, task);
    return queue;
  };

  const store = (path, data) => serialize(async () => {
    await writeAtomic(path, data);
    sums.set(relative(path), sha256(data));
    await persistSums();
  });

  /** Чтение файла с обязательной сверкой SHA256SUMS: расхождение = miss, а не тихая отдача. */
  const readVerified = async (path) => {
    const name = relative(path);
    const expected = sums.get(name);
    if (!expected) return null;
    let data;
    try { data = await readFile(path); } catch { return null; }
    if (sha256(data) !== expected) return null;
    return data;
  };

  const persistMeta = async () => {
    await writeAtomic(metaPath, `${JSON.stringify({ schema: CACHE_SCHEMA, apiVersions: { ...versions, [identity]: apiVersion } }, null, 2)}\n`);
  };

  const keyFor = (method, path, body) => {
    const [rawPath, search] = String(path).split("?");
    return {
      key: requestKey({
        identity, method, path: rawPath, query: sortedQuery(search),
        bodyHash: body === undefined ? null : sha256(canonicalJson(body)),
        apiVersion,
      }),
      rawPath,
      query: sortedQuery(search),
    };
  };

  const entryPath = (key) => join(root, "requests", `${key}.json`);
  const blobPath = (hash) => join(root, "blobs", hash);

  const fresh = (entry, policy) => {
    if (policy.mode === "immutable") return true;
    const at = Date.parse(entry.fetchedAt ?? "");
    return Number.isFinite(at) && now() - at < (policy.ttlMs ?? FRESH_TTL_MS);
  };

  return {
    enabled: true,
    dir: root,
    identity,
    get apiVersion() { return apiVersion; },
    /** Выучить apiVersion из ответа `/api/capabilities` (в ключе — уже со следующего запуска). */
    async learn(body) {
      const value = body?.apiVersion;
      if (value === undefined || String(value) === apiVersion) return;
      apiVersion = String(value);
      await persistMeta();
    },
    /**
     * Ответ из кэша либо `null`. Возвращает `{status, json|bytes, key, entry}`; `--refresh`
     * всегда даёт `null` (форс-мисс) и помечает будущую запись причиной.
     */
    async read(method, path, body) {
      const policy = classify(method, path);
      if (!policy) return null;
      const { key } = keyFor(method, path, body);
      lastKey = key;
      if (refresh) { counters.refresh += 1; lastReason = refreshReason; return null; }
      const raw = await readVerified(entryPath(key));
      if (!raw) { counters.miss += 1; lastReason = "no entry"; return null; }
      let entry;
      try { entry = JSON.parse(raw.toString("utf8")); } catch { counters.miss += 1; lastReason = "corrupt entry"; return null; }
      if (entry?.schema !== CACHE_SCHEMA || entry.key !== key) { counters.miss += 1; lastReason = "schema mismatch"; return null; }
      if (!fresh(entry, policy)) { counters.miss += 1; lastReason = "stale"; return null; }
      if (entry.bodyRef) {
        const bytes = await readVerified(blobPath(entry.bodyRef.sha256));
        if (!bytes || sha256(bytes) !== entry.bodyRef.sha256) { counters.miss += 1; lastReason = "blob checksum mismatch"; return null; }
        counters.hit += 1;
        lastReason = policy.mode;
        return { status: entry.status, bytes, key, entry };
      }
      counters.hit += 1;
      lastReason = policy.mode;
      return { status: entry.status, json: entry.body ?? null, key, entry };
    },
    /**
     * Записывает ответ. Не пишется: некэшируемый путь, не-200, нетерминальный ран
     * (`terminalOnly`). Из заголовков сохраняется только `etag` — секретов на диске нет.
     */
    async write(method, path, body, response) {
      const policy = classify(method, path);
      if (!policy) return;
      if (response.status !== 200) return;
      const payload = policy.kind === "blob" ? null : response.json;
      if (policy.terminalOnly && !isTerminalRun(payload?.run ?? payload)) return;
      const { key, rawPath, query } = keyFor(method, path, body);
      const entry = {
        schema: CACHE_SCHEMA,
        key,
        request: { identity, method, path: rawPath, query, bodyHash: body === undefined ? null : sha256(canonicalJson(body)), apiVersion },
        status: response.status,
        headers: response.etag ? { etag: response.etag } : {},
        fetchedAt: new Date(now()).toISOString(),
        fingerprints: policy.kind === "blob" ? {} : extractFingerprints(payload),
        ...(refresh ? { refreshReason } : {}),
      };
      if (policy.kind === "blob") {
        const bytes = Buffer.from(response.bytes);
        const hash = sha256(bytes);
        await store(blobPath(hash), bytes);
        entry.bodyRef = { sha256: hash, bytes: bytes.length, contentType: response.contentType ?? "application/octet-stream" };
      } else {
        entry.body = payload;
      }
      await store(entryPath(key), `${JSON.stringify(entry, null, 2)}\n`);
      counters.write += 1;
    },
    /** Квитанция команды: id'шники и статус кэша, без тел ответов и без секретов. */
    async receipt(verb, key, payload) {
      const file = join(root, "receipts", safeSegment(verb, "verb"), `${safeSegment(key, "key")}.json`);
      await store(file, `${JSON.stringify({ schema: CACHE_SCHEMA, verb, key, at: new Date(now()).toISOString(), cache: this.summary(), ...payload }, null, 2)}\n`);
    },
    /**
     * Накопленные связи в порядке записи. Это **подсказка** («по какому кандидату уже шла
     * приёмка»), а не источник истины: состояние ранов живёт на сервере и читается сетевым
     * запросом (план 2026-08-04 §W2b, C13). Битый/отсутствующий файл — пустой список.
     */
    async links() {
      const raw = await readVerified(linksPath);
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw.toString("utf8"));
        return Array.isArray(parsed?.links) ? parsed.links : [];
      } catch { return []; }
    },
    /** Связи candidate → run → cases → artifacts → report: навигация агента по накопленному. */
    async link(record) {
      const links = await this.links();
      links.push({ at: new Date(now()).toISOString(), ...record });
      await store(linksPath, `${JSON.stringify({ schema: CACHE_SCHEMA, links: links.slice(-LINKS_LIMIT) }, null, 2)}\n`);
    },
    /** Статус кэша для `--json`-отчёта: он обязан быть в каждом отчёте (кэш ≠ свидетельство). */
    summary() {
      const status = refresh ? "refresh" : counters.hit > 0 ? "hit" : "miss";
      return {
        status, ...(lastKey ? { key: lastKey } : {}), ...(lastReason ? { reason: lastReason } : {}),
        hits: counters.hit, misses: counters.miss, refreshes: counters.refresh, writes: counters.write, dir: root,
      };
    },
    line() {
      const summary = this.summary();
      return `cache: ${summary.status} hits=${summary.hits} misses=${summary.misses}${summary.refreshes ? ` refresh=${summary.refreshes}` : ""} dir=${root}`;
    },
    /** Только для тестов и ручной уборки. */
    async clear() { await rm(root, { recursive: true, force: true }); },
  };
}
