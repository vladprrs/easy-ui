/* global performance, process, requestAnimationFrame, setTimeout, document, window, MutationObserver, PerformanceObserver, URL */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";
import { createEasyUiClient, easyUiCredentials } from "./easyui-auth.mjs";

/**
 * Perf-гейт библиотеки (план 2026-07-31 §5).
 *
 * Два арма, как у галерейного харнесса: `?libraryPreviews=off` — baseline с одними метаданными,
 * и полный. Абсолютные времена спеки §8 (2500 / 4000 мс) идут в отчёт справочно: в контейнере они
 * зависят от машины, поэтому блокирует только относительная деградация baseline→full и
 * детерминированные счётчики (запросы, байты, iframe, одновременность, смонтированные, heap).
 *
 * Датасет сидится **отдельным процессом bun** (`scripts/perf-library-dataset.ts`): он пишет в БД
 * напрямую через `bun:sqlite`, а сам харнесс живёт под node вместе с playwright. Отсюда
 * `--data-dir`: скрипт local-only и должен работать на одном хосте с сервером.
 */

const VIEWPORT = { width: 1440, height: 900 };
const NETWORK = { latencyMs: 40, downloadBytesPerSecond: 5 * 1024 * 1024 / 8, uploadBytesPerSecond: 1 * 1024 * 1024 / 8 };
const MIB = 1024 * 1024;

const GATES = {
  exactComponentRequests: 0,
  previewIframes: 0,
  peakSchedulerTasks: 4,
  requestsThroughFirstPreview: 30,
  bytesThroughFirstPreview: 3 * MIB,
  mountedAfterSettle: 12,
  heapGrowthBytes: 80 * MIB,
  degradationPercent: 20,
};
/** Потолки спеки §8 — справочные: абсолютное время в контейнере машинозависимо. */
const ADVISORY = { searchableReadyMs: 2500, firstPreviewReadyMs: 4000 };

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const maximum = (values) => values.reduce((best, value) => Math.max(best, value), 0);
const degradation = (baseline, value) => (value - baseline) / baseline * 100;
const mib = (bytes) => (bytes / MIB).toFixed(2);

// --- Датасет (отдельный процесс bun) --------------------------------------

function bunBinary() {
  if (process.env.BUN_BIN) return process.env.BUN_BIN;
  const local = resolve(homedir(), ".bun/bin/bun");
  return existsSync(local) ? local : "bun";
}

function runDataset(action, dataDir) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(bunBinary(), ["scripts/perf-library-dataset.ts", action, "--data-dir", dataDir], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", rejectRun);
    child.on("close", (code) => code === 0
      ? resolveRun(JSON.parse(out.trim().split("\n").at(-1)))
      : rejectRun(new Error(`perf-library-dataset ${action} exited with ${code}`)));
  });
}

// --- Инструментация страницы ----------------------------------------------

/**
 * Одновременность считается по **задачам планировщика**, а не по HTTP-запросам: одна задача
 * выпускает три запроса (preview-мета + тема + бандл), поэтому сетевой счётчик показал бы до 12.
 * Наблюдаемый со страницы срез задачи — `data-component-preview-state="loading"`: превью ставит
 * его первым действием внутри `previewScheduler.run(...)` и снимает, когда задача осела.
 * `previewScheduler.inFlight` со страницы недоступен (модуль внутри бандла), поэтому меряем DOM.
 */
function instrument() {
  const state = { libraryReady: null, firstPreviewReady: null, peakSchedulerTasks: 0, peakActive: 0, longTasks: [] };
  window.__perfLibrary = state;
  const ACTIVE = '[data-component-preview-state="queued"],[data-component-preview-state="loading"],[data-component-preview-state="ready"],[data-component-preview-state="error"]';
  const sample = () => {
    const loading = document.querySelectorAll('[data-component-preview-state="loading"]').length;
    if (loading > state.peakSchedulerTasks) state.peakSchedulerTasks = loading;
    const active = document.querySelectorAll(ACTIVE).length;
    if (active > state.peakActive) state.peakActive = active;
    if (state.libraryReady === null && document.querySelector('[data-library-ready="true"]')) state.libraryReady = performance.now();
    if (state.firstPreviewReady === null && document.querySelector('[data-component-preview-state="ready"]')) state.firstPreviewReady = performance.now();
  };
  new MutationObserver(sample).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-component-preview-state", "data-library-ready"] });
  const tick = () => { sample(); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) state.longTasks.push(Math.round(entry.duration)); }).observe({ entryTypes: ["longtask"] });
  } catch { /* longtask не поддержан — метрика уедет пустой */ }
}

// --- Сеть -----------------------------------------------------------------

const CATEGORIES = [
  ["exactComponent", /^\/api\/components\/[^/?]+$/],
  ["preview", /^\/api\/components\/[^/]+\/versions\/\d+\/preview$/],
  ["bundle", /^\/api\/components\/[^/]+\/versions\/\d+\/bundle\.js$/],
  ["catalog", /^\/api\/catalog\//],
  ["designSystem", /^\/api\/design-systems/],
  ["shim", /^\/api\/shims\//],
  ["assetApi", /^\/api\/assets\//],
  ["api", /^\/api\//],
  ["appAsset", /^\/(assets|fonts|design)\//],
];

function categorize(pathname) {
  for (const [name, pattern] of CATEGORIES) if (pattern.test(pathname)) return name;
  return "document";
}

function trackNetwork(page) {
  const entries = [];
  const pending = [];
  const failed = [];
  page.on("requestfinished", (request) => {
    pending.push((async () => {
      let bytes = 0;
      try {
        const sizes = await request.sizes();
        bytes = Math.max(0, sizes.responseBodySize) + Math.max(0, sizes.responseHeadersSize);
      } catch { /* запрос уже утилизирован — считаем нулём */ }
      // Стенка времени берётся из тайминга самого запроса: событие `requestfinished` доезжает до
      // node с задержкой, и Date.now() смещал бы отсечку «до первого превью».
      let finishedAt = Date.now();
      try {
        const timing = request.timing();
        if (timing && timing.startTime > 0 && timing.responseEnd >= 0) finishedAt = timing.startTime + timing.responseEnd;
      } catch { /* нет тайминга — остаётся Date.now() */ }
      entries.push({ category: categorize(new URL(request.url()).pathname), bytes, finishedAt });
    })());
  });
  page.on("requestfailed", (request) => { failed.push(request.url()); });
  return {
    async collect() { await Promise.all(pending); return { entries, failed }; },
  };
}

function summarize(entries, until) {
  const scoped = until === null ? entries : entries.filter((entry) => entry.finishedAt <= until);
  const byCategory = {};
  let bytes = 0;
  for (const entry of scoped) {
    byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1;
    bytes += entry.bytes;
  }
  return { requests: scoped.length, bytes, byCategory };
}

// --- Прогон ---------------------------------------------------------------

async function configureNetwork(context, page) {
  const session = await context.newCDPSession(page);
  await session.send("Network.enable");
  await session.send("Network.setCacheDisabled", { cacheDisabled: true });
  await session.send("Network.emulateNetworkConditions", {
    offline: false, latency: NETWORK.latencyMs,
    downloadThroughput: NETWORK.downloadBytesPerSecond,
    uploadThroughput: NETWORK.uploadBytesPerSecond,
    connectionType: "wifi",
  });
  await session.send("Runtime.enable");
  await session.send("HeapProfiler.enable");
  return session;
}

async function heapUsage(session) {
  await session.send("HeapProfiler.collectGarbage");
  const { usedSize } = await session.send("Runtime.getHeapUsage");
  return usedSize;
}

/** Планировщик считается успокоившимся, когда трижды подряд нет ни одной задачи в состоянии loading. */
async function settle(page, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let quiet = 0;
  while (Date.now() < deadline) {
    const loading = await page.evaluate(() => document.querySelectorAll('[data-component-preview-state="loading"]').length);
    quiet = loading === 0 ? quiet + 1 : 0;
    if (quiet >= 3) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

async function scrollCatalog(page) {
  await page.evaluate(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    const step = Math.round(window.innerHeight * 0.9);
    for (let y = 0; y <= document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await wait(140);
    }
    window.scrollTo(0, 0);
    await wait(400);
  });
}

async function sample(browser, baseUrl, auth, previews) {
  const context = await browser.newContext({ viewport: VIEWPORT, ...(auth.legacyAuthorization ? { extraHTTPHeaders: { authorization: auth.legacyAuthorization } } : {}) });
  const [cookieName, cookieValue] = auth.cookieHeader.split("=", 2);
  await context.addCookies([{ name: cookieName, value: cookieValue, url: auth.origin }]);
  const page = await context.newPage();
  const session = await configureNetwork(context, page);
  await page.addInitScript(instrument);
  const network = trackNetwork(page);

  const url = new URL("library", baseUrl);
  if (!previews) url.searchParams.set("libraryPreviews", "off");
  try {
    await page.goto(url.href, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-library-ready="true"]');
    if (previews) await page.waitForSelector('[data-component-preview-state="ready"]', { timeout: 60_000 });
    const settled = await settle(page);

    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    const marks = await page.evaluate(() => ({ ...window.__perfLibrary }));
    const dom = await page.evaluate(() => ({
      iframes: document.querySelectorAll("iframe").length,
      mounted: document.querySelectorAll('[data-component-preview-mounted="true"]').length,
      active: document.querySelectorAll('[data-component-preview-state="queued"],[data-component-preview-state="loading"],[data-component-preview-state="ready"],[data-component-preview-state="error"]').length,
      failedPreviews: document.querySelectorAll('[data-component-preview-state="error"]').length,
      cards: document.querySelectorAll("[data-component-preview]").length,
    }));

    const heapBefore = await heapUsage(session);
    await scrollCatalog(page);
    await settle(page);
    const heapAfter = await heapUsage(session);

    // Поиск проверяется последним: ввод в тулбар пересобирает выдачу и сместил бы всё измеренное выше.
    await page.getByLabel("Поиск по задаче").fill("PerfLibrary037");
    await page.getByRole("heading", { name: "PerfLibrary037" }).waitFor({ timeout: 15_000 });

    const { entries, failed } = await network.collect();
    const initialUntil = timeOrigin + (marks.firstPreviewReady ?? marks.libraryReady ?? 0);
    const throughFirstPreview = summarize(entries, marks.firstPreviewReady === null ? null : timeOrigin + marks.firstPreviewReady);
    const initial = summarize(entries, initialUntil);
    const total = summarize(entries, null);
    return {
      settled,
      libraryReady: marks.libraryReady,
      firstPreviewReady: marks.firstPreviewReady,
      peakSchedulerTasks: marks.peakSchedulerTasks,
      peakActive: marks.peakActive,
      longTasks: marks.longTasks.length,
      longTaskMs: marks.longTasks.reduce((sum, value) => sum + value, 0),
      iframes: dom.iframes,
      mounted: dom.mounted,
      active: dom.active,
      failedPreviews: dom.failedPreviews,
      cards: dom.cards,
      heapBefore, heapAfter, heapGrowth: Math.max(0, heapAfter - heapBefore),
      requestsThroughFirstPreview: throughFirstPreview.requests,
      bytesThroughFirstPreview: throughFirstPreview.bytes,
      exactComponentInitial: initial.byCategory.exactComponent ?? 0,
      exactComponentTotal: total.byCategory.exactComponent ?? 0,
      categories: throughFirstPreview.byCategory,
      totalRequests: total.requests,
      totalBytes: total.bytes,
      failedRequests: failed.length,
    };
  } finally {
    await context.close();
  }
}

async function coldSamples(browser, baseUrl, auth, previews, runs) {
  const samples = [];
  // Армы гоняются последовательно: параллельные загрузки сделали бы узким местом сам сервер.
  for (let run = 0; run < runs; run += 1) samples.push(await sample(browser, baseUrl, auth, previews));
  return samples;
}

// --- Отчёт ----------------------------------------------------------------

const gateRow = (metric, value, gate, ok, note = "") => `| ${metric} | ${value} | ${gate} | ${ok ? "PASS" : "FAIL"} |${note ? ` ${note}` : ""}`;

function report({ baseUrl, runs, dataDir, dataset, baseline, preview, reportPath }) {
  const pick = (samples, key) => samples.map((item) => item[key]);
  const baselineReady = median(pick(baseline, "libraryReady"));
  const previewReady = median(pick(preview, "libraryReady"));
  const readyDelta = degradation(baselineReady, previewReady);
  const firstPreview = median(pick(preview, "firstPreviewReady"));
  const firstPreviewDelta = degradation(baselineReady, firstPreview);

  const medians = {
    requests: median(pick(preview, "requestsThroughFirstPreview")),
    bytes: median(pick(preview, "bytesThroughFirstPreview")),
    heapGrowth: median(pick(preview, "heapGrowth")),
  };
  const peaks = {
    exactComponent: maximum(pick(preview, "exactComponentInitial")) + maximum(pick(baseline, "exactComponentInitial")),
    iframes: maximum(pick(preview, "iframes")) + maximum(pick(baseline, "iframes")),
    schedulerTasks: maximum(pick(preview, "peakSchedulerTasks")),
    mounted: maximum(pick(preview, "peakActive")),
  };

  // Булевы инварианты (ноль iframe, ноль точных `GET /api/components/:id`, потолок одновременности,
  // бюджет смонтированных) проверяются по **худшему** прогону: единственное нарушение — это баг,
  // а не шум. Бюджеты сети и памяти — по медиане, как и времена.
  const gates = [
    ["Точных `GET /api/components/:id` при первичной навигации", String(peaks.exactComponent), "= 0", peaks.exactComponent === GATES.exactComponentRequests],
    ["iframe превью", String(peaks.iframes), "= 0", peaks.iframes === GATES.previewIframes],
    ["Пиковая одновременность задач планировщика", String(peaks.schedulerTasks), `≤ ${GATES.peakSchedulerTasks}`, peaks.schedulerTasks <= GATES.peakSchedulerTasks],
    ["Запросов до первого превью (медиана)", String(medians.requests), `≤ ${GATES.requestsThroughFirstPreview}`, medians.requests <= GATES.requestsThroughFirstPreview],
    ["Трафик до первого превью (медиана)", `${mib(medians.bytes)} MiB`, `≤ ${mib(GATES.bytesThroughFirstPreview)} MiB`, medians.bytes <= GATES.bytesThroughFirstPreview],
    ["Смонтированных превью после успокоения (пик)", String(peaks.mounted), `≤ ${GATES.mountedAfterSettle}`, peaks.mounted <= GATES.mountedAfterSettle],
    ["Прирост JS heap после полного скролла (медиана)", `${mib(medians.heapGrowth)} MiB`, `≤ ${mib(GATES.heapGrowthBytes)} MiB`, medians.heapGrowth <= GATES.heapGrowthBytes],
    ["Деградация searchable-ready (full vs baseline)", `${readyDelta.toFixed(2)}%`, `< ${GATES.degradationPercent}%`, readyDelta < GATES.degradationPercent],
  ];
  const passed = gates.every(([, , , ok]) => ok);

  const categoryRows = Object.entries(preview[0].categories).sort().map(([name, count]) => `| ${name} | ${count} |`).join("\n");
  const text = `# Library inline-preview performance gate

Generated: ${new Date().toISOString()}

Command: \`npm run perf:library -- --url ${baseUrl} --data-dir ${dataDir} --runs ${runs}\`

Dataset: ${dataset.components} компонентов (${dataset.systems} дизайн-системы, ${dataset.prototypes} прототипов для usage, ${dataset.references} визуальных эталонов), префикс \`perf-library-\`, сидинг напрямую в БД, cleanup в \`finally\`. Бандлы: ${dataset.bundles.map((bundle) => `${bundle.name} ${bundle.bytes} B (ABI ${bundle.hostAbiVersion})`).join(", ")}.

Viewport: ${VIEWPORT.width}×${VIEWPORT.height}. Network: ${NETWORK.latencyMs} ms RTT, ${(NETWORK.downloadBytesPerSecond * 8 / MIB).toFixed(0)} Mbit/s down, ${(NETWORK.uploadBytesPerSecond * 8 / MIB).toFixed(0)} Mbit/s up. Каждый прогон — холодный контекст с \`Network.setCacheDisabled\`. Медианы по ${runs} прогонам на арм.

Армы: baseline — \`?libraryPreviews=off\` (только метаданные), full — превью включены.

## Блокирующие гейты

| Метрика | Значение | Гейт | Результат |
|---|---:|---:|---|
${gates.map(([metric, value, gate, ok]) => gateRow(metric, value, gate, ok)).join("\n")}

Итог: **${passed ? "PASS" : "FAIL"}**.

## Справочно (потолки спеки §8 — не блокируют)

| Метрика | Baseline, ms | Full, ms | Деградация | Потолок спеки |
|---|---:|---:|---:|---:|
| Searchable ready (\`[data-library-ready="true"]\`) | ${baselineReady.toFixed(1)} | ${previewReady.toFixed(1)} | ${readyDelta.toFixed(2)}% | ${ADVISORY.searchableReadyMs} |
| First preview ready | — | ${firstPreview.toFixed(1)} | ${firstPreviewDelta.toFixed(2)}% vs baseline searchable | ${ADVISORY.firstPreviewReadyMs} |

Абсолютные времена машинозависимы (эмулированная сеть + контейнер), поэтому блокирует только
относительная деградация searchable-ready. У first-preview-ready нет аналога в baseline-арме
(в нём превью не монтируются вовсе), поэтому его деградация считается от searchable-ready
baseline и остаётся справочной.

## Состав трафика до первого превью (первый прогон full-арма)

| Категория | Запросов |
|---|---:|
${categoryRows}

## Прочее (медианы full-арма)

- карточек с превью-зоной: ${median(pick(preview, "cards"))}, смонтированных после успокоения: ${median(pick(preview, "mounted"))}, в состоянии error: ${median(pick(preview, "failedPreviews"))}
- long tasks: ${median(pick(preview, "longTasks"))} шт., суммарно ${median(pick(preview, "longTaskMs")).toFixed(0)} ms (baseline: ${median(pick(baseline, "longTasks"))} шт. / ${median(pick(baseline, "longTaskMs")).toFixed(0)} ms)
- JS heap: ${mib(median(pick(preview, "heapBefore")))} MiB → ${mib(median(pick(preview, "heapAfter")))} MiB
- всего за прогон: ${median(pick(preview, "totalRequests"))} запросов / ${mib(median(pick(preview, "totalBytes")))} MiB (baseline: ${median(pick(baseline, "totalRequests"))} / ${mib(median(pick(baseline, "totalBytes")))} MiB)
- неудавшихся запросов (aborted при размонтировании превью — скролл и финальный поиск снимают задачи на лету): full ${maximum(pick(preview, "failedRequests"))}, baseline ${maximum(pick(baseline, "failedRequests"))}
- точных \`GET /api/components/:id\` за весь прогон: full ${maximum(pick(preview, "exactComponentTotal"))}, baseline ${maximum(pick(baseline, "exactComponentTotal"))}

<details><summary>Raw samples</summary>

\`\`\`json
${JSON.stringify({ baseline, preview }, null, 2)}
\`\`\`
</details>
`;
  return { text, passed, reportPath };
}

// --- Точка входа ----------------------------------------------------------

const baseUrl = argument("--url", process.env.PERF_LIBRARY_URL ?? "http://127.0.0.1:4173/");
const dataDir = argument("--data-dir", process.env.DATA_DIR ?? "data");
const runs = Number(argument("--runs", "5"));
const reportPath = argument("--report", "docs/perf-library-report.md");
if (!Number.isInteger(runs) || runs < 5) throw new Error("--runs must be an integer >= 5");

const root = new URL(baseUrl);
const auth = createEasyUiClient({ apiBase: new URL("/api", root).href.replace(/\/$/, ""), credentials: easyUiCredentials() });
await auth.login();
const browser = await chromium.launch({ headless: true });

try {
  const dataset = await runDataset("seed", dataDir);
  console.log(`Seeded ${dataset.components} components in ${dataset.systems} design systems.`);
  const baseline = await coldSamples(browser, baseUrl, auth, false, runs);
  const preview = await coldSamples(browser, baseUrl, auth, true, runs);
  const result = report({ baseUrl, runs, dataDir, dataset, baseline, preview, reportPath });
  await mkdir(dirname(result.reportPath), { recursive: true });
  await writeFile(result.reportPath, result.text);
  console.log(result.text);
  if (!result.passed) process.exitCode = 2;
} finally {
  await browser.close();
  const cleaned = await runDataset("cleanup", dataDir);
  console.log(`Cleaned ${cleaned.cleaned} performance components.`);
}
