// Тёплый пул капчура (план `docs/plans/2026-08-03-renderer-contract-2.md` §5 **R9a**).
//
// Долгоживущий процесс: **один** browser на много джоб, NDJSON-протокол по stdin/stdout.
// Канон поведения капчура — `scripts/screenshot-worker.mjs` (strict-воркер, один процесс на
// джобу): готовность, handshake, коды R3, поля receipt'а R5. Пул обязан давать **байт-идентичные**
// кадры, поэтому всё, что влияет на растр и на границу egress, импортируется из strict-воркера
// (`buildLaunchArgs`, `CAPTURE_CONTEXT_OPTIONS`, `matchAllowed`, `canonicalStringify`,
// `readyToExpected`, `WORKER_FAILURE_CODES`), а не переписывается здесь.
//
// Изоляция джоб. Браузер общий, **контекст — свой на каждую джобу** и закрывается в `finally`:
// cookie, localStorage, service workers, initScript-бутстрап живут внутри контекста и между
// джобами не переживают (тест «контекст не течёт»).
//
// Deny-proxy долгоживущий: его порт зафиксирован в launch-аргументах браузера, поэтому смена
// `captureOrigin` (или набора детерминизм-args) — это **ресайкл**, а не переиспользование.
//
// Ресайкл: бюджет джоб (20), TTL, порог RSS дерева процессов и **всегда** после не-`ok` исхода —
// упавшая джоба могла оставить браузер в непонятном состоянии, и следующий кадр обязан быть
// снят с чистого листа.
/* global process, URL, window, setTimeout, clearTimeout */
import net from "node:net";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { readFile, readdir } from "node:fs/promises";
import { analyzeGeometry, collectGeometry } from "../src/capture/geometry.mjs";
import {
  buildLaunchArgs,
  canonicalStringify,
  CAPTURE_CONTEXT_OPTIONS,
  matchAllowed,
  readyToExpected,
  WORKER_FAILURE_CODES,
} from "./screenshot-worker.mjs";

/**
 * Дефолты ресайкла. Пороги — от фактических ресурсов прода (§4: хост 8 vCPU/8 ГБ, сервис
 * `mem_limit: 4g`, `cpus: "4"`): 1500 МБ на дерево пула — это ~37% лимита сервиса, то есть
 * ресайкл случается заметно раньше, чем контейнер приблизится к 75% (критерий включения §5 R9a).
 */
export const POOL_DEFAULTS = Object.freeze({ maxJobs: 20, ttlMs: 10 * 60_000, rssLimitMb: 1500 });

/** Тюнинг пула из окружения. Детерминизм-args сюда НЕ входят — они приезжают в payload джобы. */
export function poolLimits(env = process.env) {
  const num = (name, fallback) => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    maxJobs: num("EASYUI_POOL_MAX_JOBS", POOL_DEFAULTS.maxJobs),
    ttlMs: num("EASYUI_POOL_TTL_MS", POOL_DEFAULTS.ttlMs),
    rssLimitMb: num("EASYUI_POOL_RSS_MB", POOL_DEFAULTS.rssLimitMb),
  };
}

/**
 * Ключ запуска браузера: всё, что зашито в launch-аргументы и потому не может меняться на живом
 * браузере. Порт capture-origin входит в `--proxy-bypass-list`, детерминизм-args — в растр.
 */
export function launchKeyOf(job) {
  const port = (() => { try { return new URL(job.captureOrigin).port; } catch { return "?"; } })();
  const args = Array.isArray(job.determinismArgs) ? job.determinismArgs : [];
  return canonicalStringify({ captureOrigin: job.captureOrigin, port, determinismArgs: args });
}

/**
 * Единственное правило ресайкла (чистая функция — тестируется без браузера).
 * Порядок причин — от самой специфичной к самой общей: он попадает в лог и в отчёт замера.
 */
export function recycleReason(state, limits, now) {
  if (state.browserAlive !== true) return null;
  if (state.requestedKey !== undefined && state.requestedKey !== state.launchKey) return "origin_changed";
  if (state.lastJobOk === false) return "job_failed";
  if (state.jobs >= limits.maxJobs) return "job_budget";
  if (now - state.startedAt >= limits.ttlMs) return "ttl";
  if (typeof state.rssMb === "number" && state.rssMb >= limits.rssLimitMb) return "rss";
  return null;
}

/**
 * RSS всего дерева процессов (node пула + chromium + его рендереры), МБ.
 *
 * Мерить только себя бессмысленно: память пула — это память браузера. `/proc` недоступен
 * (не-Linux) ⇒ `null`, и порог RSS просто не участвует в решении.
 */
export async function treeRssMb(rootPid = process.pid) {
  let entries;
  try { entries = await readdir("/proc"); } catch { return null; }
  const pids = entries.filter((name) => /^\d+$/.test(name)).map(Number);
  const parents = new Map();
  const rss = new Map();
  await Promise.all(pids.map(async (pid) => {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      // comm может содержать пробелы и скобки — берём хвост после последней ')'.
      const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      parents.set(pid, Number(tail[1]));
      // 21-е поле хвоста — rss в страницах (поле 24 по man proc, минус pid и comm).
      rss.set(pid, Number(tail[21]) * 4096);
    } catch { /* процесс ушёл между readdir и чтением */ }
  }));
  const tree = new Set([rootPid]);
  // Дерево неглубокое (пул → chromium → рендереры), поэтому достаточно нескольких проходов.
  for (let pass = 0; pass < 6; pass += 1) {
    for (const [pid, parent] of parents) if (tree.has(parent)) tree.add(pid);
  }
  let total = 0;
  for (const pid of tree) total += rss.get(pid) ?? 0;
  return Math.round((total / 1024 / 1024) * 10) / 10;
}

const elapsedSince = (startedAt) => Math.max(0, Math.round(Date.now() - startedAt));

/**
 * Тело капчура: строчная калька `run()` strict-воркера **без** запуска браузера и deny-proxy —
 * их держит пул. Всё остальное (навигация, handshake, ветки probe, поля результата) обязано
 * совпадать дословно: корпус рендерера под пулом сверяется по тем же sha256.
 */
async function captureWithContext(browser, job) {
  const startedAt = Date.now();
  const timings = { navigateMs: null, readyMs: null, screenshotMs: null, totalMs: null };
  const consoleErrors = [];
  const consoleWarnings = [];
  const pageErrors = [];
  let context;
  try {
    context = await browser.newContext({
      viewport: job.viewport,
      deviceScaleFactor: job.deviceScaleFactor,
      colorScheme: job.colorScheme,
      ...CAPTURE_CONTEXT_OPTIONS,
      serviceWorkers: "block",
    });

    await context.routeWebSocket("**", (ws) => ws.close());
    await context.route("**/*", (route) => {
      const req = route.request();
      let u;
      try { u = new URL(req.url()); } catch { return route.abort(); }
      const origin = `${u.protocol}//${u.host}`;
      let path;
      try { path = decodeURIComponent(u.pathname); } catch { path = u.pathname; }
      if (origin === job.captureOrigin && matchAllowed(path, job.allowedUrls)) {
        return route.continue({ headers: { ...req.headers(), "x-easyui-capture": job.token } });
      }
      if (origin === job.captureOrigin && path === "/favicon.ico") return route.fulfill({ status: 204, body: "" });
      console.error(`[egress-abort] ${req.method()} ${req.url()}`);
      return route.abort();
    });

    await context.addInitScript(({ bootstrap, key }) => {
      const freeze = (v) => {
        if (v && typeof v === "object") { for (const k of Object.keys(v)) freeze(v[k]); Object.freeze(v); }
        return v;
      };
      Object.defineProperty(window, key, { value: freeze(bootstrap), writable: false, configurable: false });
    }, { bootstrap: job.bootstrap, key: "__EUI_CAPTURE_BOOTSTRAP__" });

    const page = await context.newPage();
    page.on("console", (msg) => {
      const type = msg.type();
      if (type !== "error" && type !== "warning") return;
      const sink = type === "error" ? consoleErrors : consoleWarnings;
      if (sink.length >= 100) return;
      const url = msg.location()?.url;
      sink.push(url ? `${msg.text()} (${url})` : msg.text());
    });
    page.on("pageerror", (err) => { if (pageErrors.length < 100) pageErrors.push(err.message); });

    const navigateAt = Date.now();
    try {
      await page.goto(job.captureOrigin + job.captureUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    } catch (error) {
      return {
        ok: false, code: WORKER_FAILURE_CODES.navigation,
        error: `navigation failed: ${error?.message ?? String(error)}`,
        consoleErrors, consoleWarnings, pageErrors,
      };
    }
    timings.navigateMs = elapsedSince(navigateAt);

    const readyAt = Date.now();
    const ready = await (async () => {
      const handle = await page.waitForFunction(() => window.__EUI_CAPTURE_READY__ ?? null, null, { timeout: 20000, polling: 100 });
      return handle.jsonValue();
    })().catch((error) => ({ status: "error", error: `capture handshake timed out: ${error?.message ?? String(error)}` }));
    timings.readyMs = elapsedSince(readyAt);
    if (!ready || ready.status === "error") return { ok: false, code: WORKER_FAILURE_CODES.runtime, error: ready?.error ?? "capture reported error", consoleErrors, consoleWarnings, pageErrors };
    if (canonicalStringify(readyToExpected(ready)) !== canonicalStringify(job.expected)) {
      return { ok: false, code: WORKER_FAILURE_CODES.runtime, error: `readiness mismatch: got ${canonicalStringify(readyToExpected(ready))} expected ${canonicalStringify(job.expected)}`, consoleErrors, consoleWarnings, pageErrors };
    }
    const readinessFields = {
      ...(ready.readiness ? { readiness: ready.readiness } : {}),
      ...(ready.env ? { captureEnv: ready.env } : {}),
    };

    if (job.probe === "geometry") {
      const measurements = await page.evaluate(collectGeometry, { limit: job.geometryLimit, roleKeys: job.geometryRoleKeys ?? {} });
      const geometry = { ...measurements, ...analyzeGeometry(measurements) };
      timings.totalMs = elapsedSince(startedAt);
      return { ok: true, geometry, consoleErrors, consoleWarnings, pageErrors, browserVersion: browser.version(), timings, ...readinessFields };
    }

    if (job.probe === "paint") {
      const measurements = await page.evaluate(collectGeometry, {
        limit: job.geometryLimit,
        roleKeys: job.geometryRoleKeys ?? {},
        detailKeys: job.geometryDetailKeys ?? [],
        // Эхо поверхности джобы (план 2026-08-06 §W5 T5c.6): на viewport-поверхности layout-корнем
        // становится контентная обёртка оверлея. Отсутствие поля — hug, то есть доволновой сбор.
        overlayAwareRoot: job.bootstrap?.surface?.mode === "viewport",
      });
      const paintGeometry = { ...measurements, ...analyzeGeometry(measurements) };
      const surface = await page.$("#eui-capture-surface");
      if (!surface) return { ok: false, code: WORKER_FAILURE_CODES.surfaceMissing, error: "#eui-capture-surface is missing in the captured document", consoleErrors, consoleWarnings, pageErrors };
      const surfaceRect = await surface.boundingBox().catch(() => null);
      const paintAt = Date.now();
      const png = await surface.screenshot({ type: "png", omitBackground: true });
      timings.screenshotMs = elapsedSince(paintAt);
      timings.totalMs = elapsedSince(startedAt);
      return {
        ok: true, geometry: paintGeometry,
        pngBase64: png.toString("base64"),
        pngSha256: createHash("sha256").update(png).digest("hex"),
        surfaceRect,
        width: png.length >= 24 ? png.readUInt32BE(16) : job.viewport.width,
        height: png.length >= 24 ? png.readUInt32BE(20) : job.viewport.height,
        consoleErrors, consoleWarnings, pageErrors, browserVersion: browser.version(), timings,
        ...readinessFields,
      };
    }

    const el = await page.$("#eui-capture-surface");
    if (!el) return { ok: false, code: WORKER_FAILURE_CODES.surfaceMissing, error: "#eui-capture-surface is missing in the captured document", consoleErrors, consoleWarnings, pageErrors };
    const surfaceRect = await el.boundingBox().catch(() => null);
    const shotAt = Date.now();
    const buf = await el.screenshot({ type: "png" });
    timings.screenshotMs = elapsedSince(shotAt);
    timings.totalMs = elapsedSince(startedAt);
    const width = buf.length >= 24 ? buf.readUInt32BE(16) : job.viewport.width;
    const height = buf.length >= 24 ? buf.readUInt32BE(20) : job.viewport.height;
    return {
      ok: true, pngBase64: buf.toString("base64"), pngSha256: createHash("sha256").update(buf).digest("hex"),
      surfaceRect, width, height, consoleErrors, consoleWarnings, pageErrors,
      browserVersion: browser.version(), timings, ...readinessFields,
    };
  } finally {
    // Обязателен: контекст — единственная граница изоляции джоб в пуле.
    try { await context?.close(); } catch { /* best effort */ }
  }
}

/** Состояние пула: один браузер, один deny-proxy, счётчики ресайкла. */
class Pool {
  constructor(limits) {
    this.limits = limits;
    this.browser = null;
    this.denyProxy = null;
    this.launchKey = null;
    this.startedAt = 0;
    this.jobs = 0;
    this.recycles = 0;
    this.lastJobOk = true;
    this.rssMb = null;
    this.lastRecycleReason = null;
  }

  state(requestedKey) {
    return {
      browserAlive: this.browser !== null,
      launchKey: this.launchKey,
      ...(requestedKey === undefined ? {} : { requestedKey }),
      jobs: this.jobs, startedAt: this.startedAt, rssMb: this.rssMb, lastJobOk: this.lastJobOk,
    };
  }

  async close() {
    const browser = this.browser; const proxy = this.denyProxy;
    this.browser = null; this.denyProxy = null; this.launchKey = null;
    try { await browser?.close(); } catch { /* best effort */ }
    try { proxy?.close(); } catch { /* best effort */ }
  }

  async recycleIfNeeded(requestedKey) {
    const reason = recycleReason(this.state(requestedKey), this.limits, Date.now());
    if (reason === null) return null;
    await this.close();
    this.recycles += 1;
    this.lastRecycleReason = reason;
    return reason;
  }

  async acquire(job) {
    const key = launchKeyOf(job);
    const recycled = await this.recycleIfNeeded(key);
    if (this.browser !== null) return { browser: this.browser, recycled, launched: false };
    const { chromium } = await import("playwright");
    // Deny-proxy живёт вместе с браузером: его порт зашит в launch-аргументы.
    const denyProxy = net.createServer((socket) => socket.destroy());
    await new Promise((res) => denyProxy.listen(0, "127.0.0.1", res));
    const denyPort = denyProxy.address().port;
    const capturePort = new URL(job.captureOrigin).port;
    const determinismArgs = Array.isArray(job.determinismArgs) ? job.determinismArgs : [];
    const browser = await chromium.launch({ headless: true, args: [...buildLaunchArgs(denyPort, capturePort), ...determinismArgs] });
    this.browser = browser; this.denyProxy = denyProxy; this.launchKey = key;
    this.startedAt = Date.now(); this.jobs = 0; this.lastJobOk = true;
    return { browser, recycled, launched: true };
  }

  async run(job) {
    const { browser, recycled, launched } = await this.acquire(job);
    let result;
    try {
      result = await captureWithContext(browser, job);
    } catch (error) {
      result = { ok: false, error: `pool capture failed: ${error?.message ?? String(error)}` };
    }
    this.jobs += 1;
    this.lastJobOk = result.ok === true;
    this.rssMb = await treeRssMb();
    const pool = {
      jobs: this.jobs, recycles: this.recycles, rssMb: this.rssMb,
      browserAgeMs: Date.now() - this.startedAt, launched, recycledBefore: recycled,
      lastRecycleReason: this.lastRecycleReason,
    };
    // Ресайкл «по факту исхода» и по бюджету исполняется сразу после джобы, чтобы следующая
    // не платила за него временем ожидания результата и чтобы упавший браузер не жил лишнего.
    const after = await this.recycleIfNeeded(undefined);
    return { result, pool: { ...pool, recycledAfter: after } };
  }
}

/** Одна строка stdout = один JSON-документ протокола. Промис ждёт подтверждения записи. */
let lastWrite = Promise.resolve();
function emit(message) {
  lastWrite = new Promise((done) => process.stdout.write(`${JSON.stringify(message)}\n`, () => done()));
  return lastWrite;
}

/**
 * Выход только после дренажа stdout (урок R2b/hotfix cd16937: base64-PNG крупнее 64КиБ пайпа,
 * голый exit обрезал последний результат). Страховочный таймер — от мёртвого читателя.
 */
async function drainAndExit(code) {
  const guard = setTimeout(() => process.exit(code), 10_000);
  await lastWrite.catch(() => {});
  clearTimeout(guard);
  process.exit(code);
}

/**
 * NDJSON-петля. Джобы исполняются **строго последовательно** (конкуренция capture в сервисе
 * сегодня 1; поднятие — измеряемая опция, §5 R9a): очередь промисов гарантирует, что два
 * контекста одного браузера не снимают кадр одновременно.
 */
export async function serve(input = process.stdin, limits = poolLimits()) {
  const pool = new Pool(limits);
  let chain = Promise.resolve();
  const lines = createInterface({ input, crlfDelay: Infinity });
  let shuttingDown = false;
  for await (const line of lines) {
    const text = line.trim();
    if (text.length === 0) continue;
    let message;
    try { message = JSON.parse(text); }
    catch { emit({ type: "fatal", error: `pool worker got a non-JSON line: ${text.slice(0, 200)}` }); continue; }
    if (message.type === "shutdown") { shuttingDown = true; break; }
    if (message.type !== "job" || typeof message.id !== "string" || message.job === undefined) {
      emit({ type: "fatal", id: message.id ?? null, error: `unknown pool message: ${String(message.type)}` });
      continue;
    }
    const { id, job } = message;
    chain = chain.then(async () => {
      try {
        const { result, pool: stats } = await pool.run(job);
        emit({ type: "result", id, result, pool: stats });
      } catch (error) {
        emit({ type: "result", id, result: { ok: false, error: `pool worker failed: ${error?.message ?? String(error)}` }, pool: null });
      }
    });
  }
  await chain;
  await pool.close();
  return { shuttingDown };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  emit({ type: "ready", limits: poolLimits() });
  serve()
    .then(() => drainAndExit(0))
    .catch((error) => { emit({ type: "fatal", error: error?.message ?? String(error) }); return drainAndExit(1); });
}
