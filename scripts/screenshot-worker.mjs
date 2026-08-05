// Screenshot worker: one job per process, JSON over stdin -> single JSON line on
// stdout. Runs under node (not bun) with playwright chromium. Egress is closed by
// a controlled deny-proxy socket, port-scoped proxy-bypass, host-resolver rules,
// disabled QUIC/WebRTC, blocked service workers, closed websockets, and a
// context.route allowlist keyed on the exact capture origin + allowed paths.
/* global process, Buffer, URL, window, setTimeout, clearTimeout */
import net from "node:net";
import { createHash } from "node:crypto";
import { analyzeGeometry, collectGeometry } from "../src/capture/geometry.mjs";

/** Deterministic JSON for canonical readiness comparison (mirrors src/capture/canonicalJson.ts). */
export function canonicalStringify(value) {
  const canon = (v) => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(canon);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canon(v[k]);
    return out;
  };
  return JSON.stringify(canon(value));
}

/** Path allowlist match (mirrors server/screenshot/sessions.ts matchAllowed). */
export function matchAllowed(path, allowedUrls) {
  for (const entry of allowedUrls) {
    if (entry === path) return true;
    if (entry.length > 1 && entry.endsWith("/") && path.startsWith(entry)) return true;
  }
  return false;
}

/**
 * Детерминизм-флаги растеризации (план 2026-08-03-renderer-contract-2 §2.1 P1, §5 R2a).
 *
 * Базовый набор — явные дубли того, что playwright и так передаёт сам (`chromiumSwitches()`):
 * смысл дубля в том, что флаг попадает в **наш** `launchDeterminismArgsHash` и перестаёт
 * зависеть от внутренностей конкретной версии playwright.
 *
 * Полный набор (`enabled === true`, флаг `EASYUI_RENDERER_FLAGS=1` на стороне сервера) добавляет
 * то, что бьёт по реальным причинам cross-host расхождения растра: SIMD-пути Skia, хинтинг
 * FreeType, субпиксельное позиционирование глифов, LCD-текст и историю инвалидации тайлов.
 *
 * `--font-render-hinting=none` существует **только** в `chrome-headless-shell` (полный
 * `chrome` этого switch'а не знает) — отсюда тест «фактически запускаемый бинарь принимает все
 * детерминизм-флаги» в `server/screenshot-worker.test.ts` (C-m11).
 *
 * Список отсортирован и возвращается копией: он хешируется дословно. Решение о том, включены ли
 * флаги, принимает **сервер** — воркер окружение не читает вовсе, args приезжают в payload
 * джобы (T-m17: хеш и фактические args не могут разъехаться).
 */
export const BASE_DETERMINISM_ARGS = Object.freeze([
  "--force-color-profile=srgb",
  "--hide-scrollbars",
]);

/** Дополнение полного набора: флаги, реально меняющие растр (см. `BASE_DETERMINISM_ARGS`). */
export const STRICT_DETERMINISM_ARGS = Object.freeze([
  "--disable-font-subpixel-positioning",
  "--disable-lcd-text",
  "--disable-partial-raster",
  "--disable-skia-runtime-opts",
  "--font-render-hinting=none",
]);

/** Детерминизм-args для запуска: база, а при `enabled` — база + строгий набор, отсортированно. */
export function buildDeterminismArgs(enabled) {
  const args = enabled === true ? [...BASE_DETERMINISM_ARGS, ...STRICT_DETERMINISM_ARGS] : [...BASE_DETERMINISM_ARGS];
  return args.sort();
}

/**
 * Опции browser-контекста, одинаковые для всех джоб (E1, C-m18). Хешируются сервером в
 * `contextOptionsHash` — контекст влияет на кадр не меньше флагов запуска, и его дрейф обязан
 * менять отпечаток рендерера. Пер-джобные опции (viewport/dsf/colorScheme) сюда не входят: они
 * и так параметры кадра. `serviceWorkers:"block"` — граница egress, а не растр, поэтому он
 * остаётся при вызове `newContext` и в хеш не входит.
 */
export const CAPTURE_CONTEXT_OPTIONS = Object.freeze({
  locale: "ru-RU",
  timezoneId: "Europe/Moscow",
  reducedMotion: "reduce",
});

/** Exact chromium launch args enforcing the egress boundary (asserted verbatim by tests). */
export function buildLaunchArgs(denyPort, capturePort) {
  return [
    `--proxy-server=http://127.0.0.1:${denyPort}`,
    `--proxy-bypass-list=<-loopback>;127.0.0.1:${capturePort}`,
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    "--disable-quic",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--force-webrtc-ip-handling-policy",
  ];
}

/**
 * Коды воркера из словаря `src/capture/failureCodes.ts` (§3 E3, §5 R3). Дублируются строками
 * потому, что воркер — `.mjs` под node и TS-модуль импортировать не может; тест
 * `server/screenshot-worker.test.ts` сверяет этот объект с `CAPTURE_FAILURE_CODES`, поэтому
 * разъехаться молча они не могут.
 */
export const WORKER_FAILURE_CODES = Object.freeze({
  navigation: "navigation_failed",
  runtime: "runtime_error",
  surfaceMissing: "surface_missing",
});

export function readyToExpected(ready) {
  // `designSystem` — резолвнутая ДС снимаемого экрана (multi-surface D14): пара
  // `(designSystem, dsMetaVersion)` сверяется целиком, иначе дрейф темы второй ДС невидим.
  // `candidateOverlay` (план 2026-08-05 §B2.3) добавляется **условно** по той же причине, что и
  // `slotsHash` ниже: whitelist сравнения — часть контракта, и у джобы без подмен пре-образ
  // обязан остаться байт-в-байт прежним.
  if (ready.kind === "prototype") return { kind: "prototype", prototypeInstanceId: ready.prototypeInstanceId, rev: ready.revision, componentManifestHash: ready.componentManifestHash, builtinCatalogHash: ready.builtinCatalogHash, designSystem: ready.designSystem ?? null, dsMetaVersion: ready.dsMetaVersion, rendererBuild: ready.rendererBuild, ...(ready.candidateOverlay !== undefined ? { candidateOverlay: ready.candidateOverlay } : {}) };
  // Draft-вариант handshake (P1b): rev + sourceHash вместо published version.
  // `slotsHash` (план 2026-08-05 §A6) добавляется **условно**: whitelist сравнения — часть
  // контракта, и у бесслотового случая пре-образ обязан остаться байт-в-байт прежним.
  if (ready.kind === "component-draft") return { kind: "component-draft", componentId: ready.componentId, rev: ready.rev, sourceHash: ready.sourceHash, bundleHash: ready.bundleHash, propsHash: ready.propsHash, dsMetaVersion: ready.dsMetaVersion, rendererBuild: ready.rendererBuild, ...(ready.slotsHash !== undefined ? { slotsHash: ready.slotsHash } : {}) };
  return { kind: "component", componentId: ready.componentId, version: ready.version, bundleHash: ready.bundleHash, propsHash: ready.propsHash, dsMetaVersion: ready.dsMetaVersion, rendererBuild: ready.rendererBuild };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Тайминги капчура для receipt'а (§5 R5). Меряет их воркер, потому что только он знает границы
 * фаз процесса: навигация, ожидание готовности шелла, сам снимок. Пофазовый раскол ожидания
 * (шрифты/картинки/сеть/кадры) живёт внутри страницы (`collectReadiness`) и в receipt приезжает
 * суммарным `readinessMs` — правка readiness вне объёма волны (см. `src/capture/receipt.ts`).
 */
const elapsedSince = (startedAt) => Math.max(0, Math.round(Date.now() - startedAt));

async function run(job) {
  const startedAt = Date.now();
  const timings = { navigateMs: null, readyMs: null, screenshotMs: null, totalMs: null };
  const { chromium } = await import("playwright");
  const consoleErrors = [];
  const consoleWarnings = [];
  const pageErrors = [];

  const denyProxy = net.createServer((socket) => socket.destroy());
  await new Promise((res) => denyProxy.listen(0, "127.0.0.1", res));
  const denyPort = denyProxy.address().port;
  const capturePort = new URL(job.captureOrigin).port;

  let browser;
  let context;
  try {
    // Детерминизм-args приходят в payload джобы: решение принимает сервер, который тем же
    // списком считает `launchDeterminismArgsHash` (R2a). Воркер env не читает — иначе
    // объявленный отпечаток и фактический запуск разъехались бы молча.
    const determinismArgs = Array.isArray(job.determinismArgs) ? job.determinismArgs : [];
    browser = await chromium.launch({ headless: true, args: [...buildLaunchArgs(denyPort, capturePort), ...determinismArgs] });
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
      // Browser chrome noise, not page content: answering empty keeps consoleErrors
      // an honest signal about the captured document itself.
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

    // Навигация — отдельный типизированный исход (§5 R3): «страница не открылась» и «страница
    // открылась, но шелл не сошёлся с ожиданием» — разные диагнозы, и клиент обязан различать их
    // без чтения текста ошибки.
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
    // Шелл не опубликовал handshake либо опубликовал ошибку — это исполнение страницы, а не
    // навигация и не поверхность: `runtime_error`.
    if (!ready || ready.status === "error") return { ok: false, code: WORKER_FAILURE_CODES.runtime, error: ready?.error ?? "capture reported error", consoleErrors, consoleWarnings, pageErrors };
    if (canonicalStringify(readyToExpected(ready)) !== canonicalStringify(job.expected)) {
      return { ok: false, code: WORKER_FAILURE_CODES.runtime, error: `readiness mismatch: got ${canonicalStringify(readyToExpected(ready))} expected ${canonicalStringify(job.expected)}`, consoleErrors, consoleWarnings, pageErrors };
    }
    // W4: доказательство readiness и отпечаток окружения — рядом с handshake, вне сравнения с
    // `expected` (политика в `expected` не дублируется, триаж R1-m2). Старый шелл их не шлёт —
    // тогда поля просто отсутствуют, и результат остаётся прежним по форме.
    const readinessFields = {
      ...(ready.readiness ? { readiness: ready.readiness } : {}),
      ...(ready.env ? { captureEnv: ready.env } : {}),
    };

    if (job.probe === "geometry") {
      const measurements = await page.evaluate(collectGeometry, { limit: job.geometryLimit, roleKeys: job.geometryRoleKeys ?? {} });
      // Structural analysis runs outside the page: it is pure and unit-tested without a DOM.
      const geometry = { ...measurements, ...analyzeGeometry(measurements) };
      timings.totalMs = elapsedSince(startedAt);
      return { ok: true, geometry, consoleErrors, consoleWarnings, pageErrors, browserVersion: browser.version(), timings, ...readinessFields };
    }

    // Paint-режим (план 2026-08-03 §3 D4, W3): **одна сессия** отдаёт и geometry-факты, и PNG.
    // Две джобы давали бы два несопоставимых кадра (триаж R1-M3): между ними успевают
    // перерисоваться шрифты, темы и анимации, и `layoutBounds` относился бы к другому кадру,
    // чем `paintBounds`. Порядок — измерение до снимка: `page.evaluate` ничего не мутирует.
    if (job.probe === "paint") {
      const measurements = await page.evaluate(collectGeometry, {
        limit: job.geometryLimit,
        roleKeys: job.geometryRoleKeys ?? {},
        detailKeys: job.geometryDetailKeys ?? [],
      });
      const paintGeometry = { ...measurements, ...analyzeGeometry(measurements) };
      const surface = await page.$("#eui-capture-surface");
      // Отсутствие поверхности — отказ, а не деградация в кадр всей страницы (§5 R3). Раньше
      // здесь молча снимался viewport: получался кадр «чего-то», который затем сравнивался с
      // эталоном компонента и давал необъяснимый визуальный провал вместо честной причины.
      if (!surface) return { ok: false, code: WORKER_FAILURE_CODES.surfaceMissing, error: "#eui-capture-surface is missing in the captured document", consoleErrors, consoleWarnings, pageErrors };
      // Бокс поверхности снимается **до** кадра и в тех же CSS px, что и geometry: receipt R5
      // обязан говорить, какой прямоугольник стал кадром, а не только его размер в device px.
      const surfaceRect = await surface.boundingBox().catch(() => null);
      // `omitBackground` снимает белую подложку браузера: без неё альфа за пределами компонента
      // была бы непрозрачной и ink-bbox совпал бы с кадром целиком.
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
    try { await context?.close(); } catch { /* best effort */ }
    try { await browser?.close(); } catch { /* best effort */ }
    denyProxy.close();
  }
}

/**
 * Единственный выход воркера. `process.exit()` **обрывает** незаписанные байты stdout-пайпа
 * (на Linux в буфер помещается 64 КиБ, остальное libuv дописывает асинхронно), а результат
 * капчура — это base64 PNG, который на DPR 3 давно больше 64 КиБ. Отсюда наблюдавшийся
 * гоночный `capture_failed: worker result was not JSON: {"ok":true,"pngBase64":"…` на крупных
 * кадрах (найдено корпусом рендерера, план 2026-08-03-renderer-contract-2 §5 R2b). Выходим
 * только после подтверждённой записи; таймер держит event loop и страхует от зависшего дренажа.
 */
function emitResult(result, code) {
  const exit = () => process.exit(code);
  const guard = setTimeout(exit, 10_000);
  process.stdout.write(`${JSON.stringify(result)}\n`, () => { clearTimeout(guard); exit(); });
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  readStdin()
    .then(run)
    .then((result) => emitResult(result, 0))
    .catch((error) => emitResult({ ok: false, error: error?.message ?? String(error) }, 1));
}
