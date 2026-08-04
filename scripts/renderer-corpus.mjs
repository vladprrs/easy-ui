#!/usr/bin/env node
/* global process, URL, fetch, setTimeout */
/**
 * Корпус рендерера (план `docs/plans/2026-08-03-renderer-contract-2.md` §5 **R2b**, гейт K1).
 *
 * Что доказывает. Capture обязан быть **функцией объявленных входов**: один и тот же
 * компонент, тема, вьюпорт и DPR обязаны давать байт-идентичный PNG. Скрипт поднимает
 * изолированный Bun preview, публикует фикстурную ДС из `e2e/fixtures/renderer-corpus/`,
 * снимает матрицу `12 фикстур × 20 вариантов = 240 капчуров` и сверяет результат с
 * `expected.json`: для подмножества `pixel/` — sha256 PNG, для `outcome/` — исход джобы
 * (типизированные коды приедут в R3/R4, до тех пор фиксируется текущее untyped-поведение).
 *
 * Канон устройства — `scripts/measure-acceptance.mjs` (тот же способ поднимать сервер и
 * изолировать `DATA_DIR` внутри корня проекта, см. CLAUDE.md).
 *
 * Запуск:
 *   node scripts/renderer-corpus.mjs --record          # записать expected.json
 *   node scripts/renderer-corpus.mjs --verify          # сверить (дефолт; ненулевой код при расхождении)
 *   node scripts/renderer-corpus.mjs --verify --truncated   # усечённая матрица PR-CI (12×3)
 *   node scripts/renderer-corpus.mjs --verify --report      # + подробный отчёт по фикстурам
 * Дополнительно: `--port N`, `--keep` (не удалять DATA_DIR), `--fixture <id>` (фильтр, повторяемый),
 * `--repeat N` (снять матрицу N раз подряд в одном процессе — прямая проверка K1),
 * `--force` (перезаписать расходящиеся sha при `--record` без bump'а `RENDERER_VERSION`),
 * `--server-log` (не глушить stderr сервера).
 *
 * Режимы волны R2c (CI-гейт, N13):
 *   `--server-url http://127.0.0.1:8787` — не поднимать свой Bun, а работать с уже запущенным
 *      сервером (в CI это `docker run` SHA-образа: гейт обязан мерить **образ**, а не dev-хост);
 *   `--out <file>` — записать host record прогона (renderer + полная матрица) для CI-артефакта;
 *   `--bootstrap` — если для отпечатка текущего хоста ожиданий в `expected.json` **нет**, прогон
 *      снимает матрицу, публикует отчёт и НЕ красится (первый пуш не должен блокироваться о
 *      кросс-хост дельту K2); при наличии ожиданий гейт жёсткий независимо от флага;
 *   `--adopt <file>` — вмерджить host record (артефакт CI) в `expected.json` без сервера: после
 *      этого гейт для того отпечатка становится жёстким.
 *
 * Per-fingerprint ожидания. Корень `expected.json` — запись dev-хоста (историческая, R2b).
 * Ожидания любого другого отпечатка живут в `hosts["<source>:<fingerprint>"]` (аддитивно,
 * та же форма: `pixel`/`outcome`/`sizes` + метаданные). Сверка выбирает запись по отпечатку
 * текущего сервера: корень, если совпал, иначе `hosts[key]`, иначе — «ожиданий нет».
 *
 * Инварианты волны (§6): sha-часть `expected.json` меняется **только** вместе с bump'ом
 * `RENDERER_VERSION` — иначе `--record` отказывается перезаписывать расхождение; ожидания
 * подмножества `outcome/` переходят во владение R4. `--record --truncated` запрещён: усечённая
 * матрица не имеет права переставлять метку `truncated` полной записи.
 *
 * Вывод — одна JSON-строка отчёта в stdout; ненулевой exit code при расхождениях.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const flagAll = (name) => args.flatMap((value, index) => value === `--${name}` ? [args[index + 1]] : []);

const RECORD = args.includes("--record");
const TRUNCATED = args.includes("--truncated");
const REPORT = args.includes("--report");
const FORCE = args.includes("--force");
const KEEP = args.includes("--keep");
const SERVER_LOG = args.includes("--server-log");
const BOOTSTRAP = args.includes("--bootstrap");
const REPEAT = Math.max(1, Number(flag("repeat", "1")));
const ONLY = new Set(flagAll("fixture"));
const PORT = Number(flag("port", "4198"));
const SERVER_URL = flag("server-url", null);
const OUT = flag("out", null);
const ADOPT = flag("adopt", null);

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const CORPUS_DIR = resolve(ROOT, "e2e/fixtures/renderer-corpus");
const EXPECTED_PATH = resolve(CORPUS_DIR, "expected.json");
// Изолированные данные прогона живут внутри корня проекта (CLAUDE.md: `DATA_DIR` обязан быть
// внутри корня — материализованные TSX резолвят зависимости из корневого `node_modules`).
// Каталог — под уже игнорируемым `.measure-data/` (канон `measure-acceptance.mjs`), поэтому
// прогон с `--keep` не оставляет мусор в `git status`.
const DATA_DIR = ".measure-data/renderer-corpus";
const BASE = SERVER_URL ?? `http://127.0.0.1:${PORT}`;
const ADMIN_NAME = process.env.CORPUS_ADMIN_NAME ?? "Corpus Admin";
const ADMIN_PASSWORD = process.env.CORPUS_ADMIN_PASSWORD ?? "corpus-admin-password";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

let cookie = "";
async function call(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      origin: BASE,
      ...(init.body === undefined || init.rawBody ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0) cookie = setCookie.map((item) => item.split(";")[0]).join("; ");
  return response;
}

async function json(path, init) {
  const response = await call(path, init);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, body, text };
}

function expectStatus(step, result, allowed) {
  if (allowed.includes(result.status)) return result;
  throw new Error(`${step}: HTTP ${result.status} ${result.text}`);
}

async function waitForHealth(child) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child !== null && child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("server did not become healthy in 120s");
}

// --- фикстуры -----------------------------------------------------------------------

async function loadManifest() {
  const manifest = JSON.parse(await readFile(resolve(CORPUS_DIR, "corpus.json"), "utf8"));
  const fixtures = manifest.fixtures.filter((fixture) => ONLY.size === 0 || ONLY.has(fixture.id));
  const variants = manifest.variants.filter((variant) => !TRUNCATED || variant.truncated === true);
  if (fixtures.length === 0) throw new Error("fixture filter matched nothing");
  if (variants.length === 0) throw new Error("variant selection is empty");
  return { manifest, fixtures, variants };
}

/** Заливает ассеты корпуса (raster/vector/шрифты) и возвращает карту `key → assetId`. */
async function uploadAssets(manifest) {
  const ids = {};
  for (const [key, spec] of Object.entries(manifest.assets)) {
    const path = spec.repoRoot ? resolve(ROOT, spec.file) : resolve(CORPUS_DIR, spec.file);
    const bytes = await readFile(path);
    const response = await call("/api/assets", { method: "POST", body: bytes, rawBody: true, headers: { "content-type": spec.mime } });
    const text = await response.text();
    if (![200, 201].includes(response.status)) throw new Error(`upload asset ${key}: HTTP ${response.status} ${text}`);
    ids[key] = JSON.parse(text).id;
  }
  return ids;
}

/**
 * Публикует ДС, её тему (шрифты семейства `Corpus Text`) и все фикстурные компоненты.
 * Плейсхолдеры `__ASSET_PNG__`/`__ASSET_SVG__` подставляются здесь: литерал `asset_<sha256>`
 * в исходнике пинуется на publish и обязан существовать (`ComponentRepo.pinAssets`).
 */
async function provision(manifest, fixtures) {
  const assets = await uploadAssets(manifest);
  const ds = manifest.designSystem;
  expectStatus("create design system", await json("/api/design-systems", {
    method: "POST",
    body: JSON.stringify({ id: ds.id, name: ds.name, description: ds.description }),
  }), [201, 409]);

  const fonts = manifest.theme.fonts.map((font) => ({ family: font.family, src: assets[font.asset], weight: font.weight, style: font.style }));
  expectStatus("publish theme", await json(`/api/design-systems/${ds.id}`, {
    method: "PATCH",
    body: JSON.stringify({ fonts, baseVersion: 0 }),
  }), [200]);

  const published = [];
  for (const fixture of fixtures) {
    const raw = await readFile(resolve(CORPUS_DIR, fixture.source), "utf8");
    const source = Object.entries(manifest.assets)
      .filter(([, spec]) => typeof spec.placeholder === "string")
      .reduce((text, [key, spec]) => text.replaceAll(spec.placeholder, assets[key]), raw);
    expectStatus(`create component ${fixture.id}`, await json("/api/components", {
      method: "POST",
      body: JSON.stringify({ id: fixture.id, name: fixture.name, source, designSystem: ds.id, intent: fixture.intent }),
    }), [201]);
    const publish = expectStatus(`publish component ${fixture.id}`, await json(`/api/components/${fixture.id}/publish`, {
      method: "POST",
      body: JSON.stringify({ baseRev: 1 }),
    }), [201]);
    published.push({ ...fixture, version: publish.body.version ?? 1 });
  }
  return { assets, published };
}

// --- капчур -------------------------------------------------------------------------

async function pollJob(jobId) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const { body } = await json(`/api/screenshot-jobs/${jobId}`);
    if (body && (body.status === "done" || body.status === "error")) return body;
    await sleep(200);
  }
  throw new Error(`screenshot job ${jobId} did not settle within 120s`);
}

/** Один капчур: sha256 PNG (`pixel/`) либо исход джобы (`outcome/`). */
async function captureOne(fixture, variant) {
  const started = Date.now();
  const enqueued = expectStatus(`enqueue ${fixture.id}/${variant.id}`, await json(
    `/api/components/${fixture.id}/versions/${fixture.version}/screenshot`,
    { method: "POST", body: JSON.stringify({ props: fixture.props, viewport: variant.viewport, deviceScaleFactor: variant.dsf, theme: variant.theme }) },
  ), [202]);
  const job = await pollJob(enqueued.body.jobId);
  const ms = Date.now() - started;
  if (job.status === "error") {
    return {
      ms, sha: null,
      outcome: { status: "error", failureCode: job.error?.code ?? null, imageProduced: false, consoleErrors: 0, pageErrors: 0 },
      error: { code: job.error?.code ?? null, message: job.error?.message ?? "" },
    };
  }
  const result = job.result ?? {};
  const outcome = {
    status: "done",
    failureCode: null,
    imageProduced: result.imageProduced === true,
    consoleErrors: (result.consoleErrors ?? []).length,
    pageErrors: (result.pageErrors ?? []).length,
  };
  if (fixture.subset === "outcome") return { ms, outcome, sha: null, size: null };
  const response = await call(`/api/assets/${result.assetId}`);
  if (!response.ok) throw new Error(`fetch asset ${result.assetId}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { ms, outcome, sha: sha256(bytes), size: `${result.width}x${result.height}` };
}

/** Снимает всю матрицу один раз: `{pixel, outcome, sizes, msTotal, msByFixture}`. */
async function captureMatrix(fixtures, variants, pass) {
  const pixel = {}; const outcome = {}; const sizes = {}; const msByFixture = {}; const failures = [];
  let captured = 0;
  const total = fixtures.length * variants.length;
  const startedAt = Date.now();
  for (const fixture of fixtures) {
    let fixtureMs = 0;
    for (const variant of variants) {
      const shot = await captureOne(fixture, variant);
      fixtureMs += shot.ms;
      captured += 1;
      if (fixture.subset === "pixel") {
        (pixel[fixture.id] ??= {})[variant.id] = shot.sha;
        (sizes[fixture.id] ??= {})[variant.id] = shot.size ?? null;
        // Упавший капчур `pixel/`-фикстуры — не «отсутствующий sha», а провал гейта: кадра нет,
        // и записывать такое в эталоны нельзя (иначе `expected.json` узаконит поломку).
        if (shot.sha === null) failures.push({ key: `${fixture.id}/${variant.id}`, ...(shot.error ?? { code: null, message: "capture produced no PNG" }) });
      } else {
        (outcome[fixture.id] ??= {})[variant.id] = shot.outcome;
      }
      if (process.stderr.isTTY) process.stderr.write(`\r[corpus] pass ${pass} ${captured}/${total} ${fixture.id}/${variant.id}   `);
    }
    msByFixture[fixture.id] = fixtureMs;
  }
  if (process.stderr.isTTY) process.stderr.write("\n");
  return { pixel, outcome, sizes, msTotal: Date.now() - startedAt, msByFixture, captured, failures };
}

// --- сверка -------------------------------------------------------------------------

function diffMatrix(expected, actual, fixtures, variants) {
  const mismatches = [];
  const quarantined = new Set(expected.quarantined ?? []);
  for (const fixture of fixtures) {
    for (const variant of variants) {
      const key = `${fixture.id}/${variant.id}`;
      if (quarantined.has(fixture.id) || quarantined.has(key)) continue;
      if (fixture.subset === "pixel") {
        const want = expected.pixel?.[fixture.id]?.[variant.id] ?? null;
        const got = actual.pixel[fixture.id]?.[variant.id] ?? null;
        if (want === null) mismatches.push({ key, kind: "missing_expectation", got });
        else if (want !== got) mismatches.push({ key, kind: "sha_mismatch", want, got });
      } else {
        const want = expected.outcome?.[fixture.id]?.[variant.id] ?? null;
        const got = actual.outcome[fixture.id]?.[variant.id] ?? null;
        if (want === null) mismatches.push({ key, kind: "missing_expectation", got });
        else {
          const differing = Object.keys(want).filter((field) => want[field] !== got?.[field]);
          if (differing.length > 0) mismatches.push({ key, kind: "outcome_mismatch", differing, want, got });
        }
      }
    }
  }
  return mismatches;
}

/**
 * Расхождения между проходами одной матрицы — прямая метрика K1.
 *
 * Сверяются **все пары** проходов, а не только (1,2): при `--repeat 3+` дрейф может проявиться
 * на третьем проходе (прогрев кэшей раствора, эпизодический GC) и обязан быть виден.
 */
function diffPasses(passes, fixtures, variants, quarantined = new Set()) {
  const drift = [];
  for (let i = 0; i < passes.length; i += 1) {
    for (let j = i + 1; j < passes.length; j += 1) {
      for (const fixture of fixtures) {
        if (fixture.subset !== "pixel") continue;
        if (quarantined.has(fixture.id)) continue;
        for (const variant of variants) {
          if (quarantined.has(`${fixture.id}/${variant.id}`)) continue;
          const a = passes[i].pixel[fixture.id]?.[variant.id] ?? null;
          const b = passes[j].pixel[fixture.id]?.[variant.id] ?? null;
          if (a !== b) drift.push({ key: `${fixture.id}/${variant.id}`, passA: i + 1, passB: j + 1, first: a, second: b });
        }
      }
    }
  }
  return drift;
}

async function readExpected() {
  try { return JSON.parse(await readFile(EXPECTED_PATH, "utf8")); }
  catch { return null; }
}

// --- per-fingerprint ожидания -------------------------------------------------------

/** Ключ хоста рендерера в `expected.json.hosts`. */
const hostKeyOf = (declaration) => `${declaration.source ?? "unknown"}:${declaration.fingerprint ?? "unknown"}`;

/**
 * Выбирает запись ожиданий под отпечаток текущего сервера.
 *
 * Корень документа — историческая dev-запись (R2b) и остаётся авторитетной для своего отпечатка;
 * все остальные хосты (в первую очередь — образ, `source: "manifest"`) живут в `hosts[key]`.
 * `null` означает «для этого хоста ожиданий ещё нет» — bootstrap-режим гейта.
 */
function resolveExpectations(document, declaration) {
  if (document === null) return null;
  const key = hostKeyOf(declaration);
  if (document.rendererFingerprint === declaration.fingerprint && document.rendererSource === declaration.source) {
    return { scope: "root", key, record: document };
  }
  const host = document.hosts?.[key];
  if (host === undefined) return null;
  // `quarantined` наследуется от корня, если у записи хоста нет собственного списка: карантин —
  // свойство фикстуры, а не хоста (§4).
  return { scope: "host", key, record: { quarantined: document.quarantined ?? [], ...host } };
}

/** Человекочитаемое сравнение отпечатков — печатается ПЕРЕД перечнем расхождений (§5 R2c). */
function fingerprintDrift(record, declaration) {
  const fields = [
    ["rendererFingerprint", record?.rendererFingerprint ?? null, declaration.fingerprint],
    ["rendererSource", record?.rendererSource ?? null, declaration.source],
    ["rendererVersion", record?.rendererVersion ?? null, declaration.rendererVersion],
    ["determinismFlags", record?.determinismFlags ?? null, declaration.determinismFlags],
  ];
  const differing = fields.filter(([, want, got]) => want !== got).map(([name]) => name);
  return { differs: differing.length > 0, differing, fields: Object.fromEntries(fields.map(([name, want, got]) => [name, { expected: want, actual: got }])) };
}

function printDrift(drift, mismatches) {
  const lines = [`[corpus] fingerprint drift: ${drift.differs ? `DIFFERENT (${drift.differing.join(", ")})` : "none — same renderer host"}`];
  for (const [name, pair] of Object.entries(drift.fields)) {
    lines.push(`[corpus]   ${name.padEnd(20)} expected=${pair.expected} actual=${pair.actual}${pair.expected === pair.actual ? "" : "   <-- differs"}`);
  }
  lines.push(drift.differs
    ? "[corpus]   verdict: расхождения sha ниже — кандидат на кросс-хост дельту (K2), а не регрессию рендерера"
    : "[corpus]   verdict: отпечаток тот же — расхождения sha ниже суть регрессия детерминизма (K1)");
  lines.push(`[corpus] mismatches: ${mismatches.length}`);
  for (const item of mismatches.slice(0, 20)) lines.push(`[corpus]   ${item.key} ${item.kind}${item.want && item.got ? ` want=${String(item.want).slice(0, 16)} got=${String(item.got).slice(0, 16)}` : ""}`);
  process.stderr.write(`${lines.join("\n")}\n`);
}

/** Инвариант §6: sha-часть меняется только вместе с bump'ом `RENDERER_VERSION`. */
function assertRecordAllowed(previousRecord, actual, renderer, fixtures, variants) {
  if (previousRecord === null || FORCE || previousRecord.rendererVersion !== renderer.rendererVersion) return;
  const conflicts = [];
  for (const fixture of fixtures) {
    if (fixture.subset !== "pixel") continue;
    for (const variant of variants) {
      const want = previousRecord.pixel?.[fixture.id]?.[variant.id];
      const got = actual.pixel[fixture.id]?.[variant.id];
      if (want !== undefined && got !== undefined && want !== got) conflicts.push(`${fixture.id}/${variant.id}`);
    }
  }
  if (conflicts.length > 0) {
    throw new Error(
      `--record refuses to rewrite ${conflicts.length} sha expectation(s) while RENDERER_VERSION is unchanged `
      + `(${renderer.rendererVersion}): ${conflicts.slice(0, 5).join(", ")}${conflicts.length > 5 ? ", …" : ""}. `
      + "Bump RENDERER_VERSION (plan §6) or pass --force deliberately.",
    );
  }
}

/** Мерджит снятую матрицу в запись ожиданий (корневую либо хостовую). */
function mergeRecord(previousRecord, actual, renderer, truncated) {
  const record = {
    rendererVersion: renderer.rendererVersion,
    rendererSchema: renderer.rendererSchema,
    rendererFingerprint: renderer.fingerprint,
    rendererSource: renderer.source,
    determinismFlags: renderer.determinismFlags,
    recordedAt: new Date().toISOString(),
    truncated,
    pixel: { ...(previousRecord?.pixel ?? {}) },
    outcome: { ...(previousRecord?.outcome ?? {}) },
    sizes: { ...(previousRecord?.sizes ?? {}) },
  };
  for (const [id, byVariant] of Object.entries(actual.pixel)) record.pixel[id] = { ...(record.pixel[id] ?? {}), ...byVariant };
  for (const [id, byVariant] of Object.entries(actual.outcome)) record.outcome[id] = { ...(record.outcome[id] ?? {}), ...byVariant };
  for (const [id, byVariant] of Object.entries(actual.sizes)) record.sizes[id] = { ...(record.sizes[id] ?? {}), ...byVariant };
  return record;
}

/**
 * Запись `expected.json`. Если отпечаток текущего сервера совпал с корневым (или файла ещё нет) —
 * пишется корень; иначе запись едет в `hosts["<source>:<fingerprint>"]` **аддитивно**, не трогая
 * ни корневые dev-ожидания, ни ожидания других хостов.
 */
async function writeExpected(previous, resolved, actual, renderer, fixtures, variants, truncated = TRUNCATED) {
  const previousRecord = resolved?.record ?? null;
  assertRecordAllowed(previousRecord, actual, renderer, fixtures, variants);
  const record = mergeRecord(previousRecord, actual, renderer, truncated);
  const rootScope = previous === null || resolved?.scope === "root";
  const document = rootScope
    ? { corpusVersion: 1, ...record, quarantined: previous?.quarantined ?? [], ...(previous?.hosts ? { hosts: previous.hosts } : {}) }
    : { ...previous, hosts: { ...(previous.hosts ?? {}), [hostKeyOf(renderer)]: record } };
  // Порядок ключей документа держим стабильным: метаданные → карантин → матрицы → hosts.
  const ordered = rootScope
    ? {
      corpusVersion: 1,
      rendererVersion: record.rendererVersion, rendererSchema: record.rendererSchema,
      rendererFingerprint: record.rendererFingerprint, rendererSource: record.rendererSource,
      determinismFlags: record.determinismFlags, recordedAt: record.recordedAt, truncated: record.truncated,
      quarantined: document.quarantined,
      pixel: record.pixel, outcome: record.outcome, sizes: record.sizes,
      ...(document.hosts ? { hosts: document.hosts } : {}),
    }
    : document;
  await writeFile(EXPECTED_PATH, `${JSON.stringify(ordered, null, 2)}\n`);
  return ordered;
}

/**
 * `--adopt <file>`: вмерджить host record (артефакт CI-прогона корпуса в образе) в `expected.json`
 * без поднятия сервера. После adopt'а гейт для этого отпечатка становится жёстким.
 */
async function adopt(file) {
  const payload = JSON.parse(await readFile(resolve(process.cwd(), file), "utf8"));
  const renderer = payload.renderer ?? {};
  if (!renderer.fingerprint) throw new Error(`${file}: no renderer.fingerprint — not a corpus host record`);
  if (payload.truncated === true && !FORCE) throw new Error(`${file}: record is truncated — adopt only full 12×20 matrices (or pass --force)`);
  if ((payload.captureFailures ?? 0) > 0) throw new Error(`${file}: record has ${payload.captureFailures} capture failure(s) — refusing to adopt`);
  const previous = await readExpected();
  if (previous === null) throw new Error(`${EXPECTED_PATH} is missing — record the dev baseline first`);
  const resolved = resolveExpectations(previous, renderer);
  if (resolved?.scope === "root") throw new Error("adopt target equals the root record — re-record with --record instead");
  const key = hostKeyOf(renderer);
  const pseudoFixtures = Object.keys(payload.pixel ?? {}).map((id) => ({ id, subset: "pixel" }));
  const pseudoVariants = [...new Set(Object.values(payload.pixel ?? {}).flatMap((byVariant) => Object.keys(byVariant)))].map((id) => ({ id }));
  assertRecordAllowed(resolved?.record ?? null, payload, renderer, pseudoFixtures, pseudoVariants);
  const record = mergeRecord(resolved?.record ?? null, payload, renderer, payload.truncated === true);
  const document = { ...previous, hosts: { ...(previous.hosts ?? {}), [key]: record } };
  await writeFile(EXPECTED_PATH, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ mode: "adopt", hostKey: key, pixelFixtures: Object.keys(record.pixel).length, outcomeFixtures: Object.keys(record.outcome).length })}\n`);
}

// --- main ---------------------------------------------------------------------------

async function main() {
  if (ADOPT !== null && ADOPT !== undefined) { await adopt(ADOPT); return; }
  if (RECORD && TRUNCATED) {
    throw new Error("--record --truncated is refused: a 12×3 matrix must not relabel the full record as truncated (plan §5 R2c)");
  }
  // Внешний сервер (`--server-url`, в CI — контейнер образа) держит собственные dist/DATA_DIR.
  if (SERVER_URL === null || SERVER_URL === undefined) {
    try { statSync(resolve(ROOT, "dist/index.html")); }
    catch { throw new Error("dist/ is missing — run `npm run build` first (capture needs SERVE_DIST)"); }
  }

  const { manifest, fixtures, variants } = await loadManifest();
  if (SERVER_URL === null || SERVER_URL === undefined) {
    await rm(resolve(ROOT, DATA_DIR), { recursive: true, force: true });
    await mkdir(resolve(ROOT, DATA_DIR), { recursive: true });
  }

  const child = (SERVER_URL !== null && SERVER_URL !== undefined) ? null : spawn(`${process.env.HOME}/.bun/bin/bun`, ["server/main.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      ADMIN_NAME, ADMIN_PASSWORD,
      DATA_DIR, SERVE_DIST: "dist",
      PORT: String(PORT),
      PUBLIC_ORIGIN: BASE,
      // Корпус меряет **прод-целевую** конфигурацию рендерера: детерминизм-флаги включены явно
      // (§5 R2c, V-N2 — дефолт образа OFF, без явного включения гейт мерил бы не ту сборку).
      EASYUI_RENDERER_FLAGS: process.env.EASYUI_RENDERER_FLAGS ?? "1",
      // Фикстуры корпуса — 12 намеренно похожих «пробников» одной ДС; гейт переиспользования
      // к детерминизму растра отношения не имеет и в shadow-режиме не мешает провижену.
      REUSE_GATE: "shadow",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child?.stdout.on("data", () => {});
  child?.stderr.on("data", (chunk) => { if (SERVER_LOG) process.stderr.write(chunk); });

  try {
    await waitForHealth(child);
    expectStatus("login", await json("/api/auth/login", { method: "POST", body: JSON.stringify({ name: ADMIN_NAME, password: ADMIN_PASSWORD }) }), [200]);
    const capabilities = expectStatus("capabilities", await json("/api/capabilities"), [200]);
    const renderer = capabilities.body.renderer ?? {};
    const declaration = {
      rendererVersion: renderer.rendererVersion ?? null,
      rendererSchema: renderer.rendererSchema ?? null,
      fingerprint: renderer.fingerprint ?? null,
      source: renderer.source ?? null,
      determinismFlags: process.env.EASYUI_RENDERER_FLAGS ?? "1",
    };

    const { published } = await provision(manifest, fixtures);
    const passes = [];
    for (let pass = 1; pass <= REPEAT; pass += 1) passes.push(await captureMatrix(published, variants, pass));
    const actual = passes[0];

    const previous = await readExpected();
    const resolved = resolveExpectations(previous, declaration);
    const hostKey = hostKeyOf(declaration);
    const failures = passes.flatMap((pass) => pass.failures);
    let mismatches = [];
    let expectedDocument = previous;
    let bootstrapped = false;
    if (RECORD && failures.length > 0) {
      throw new Error(`${failures.length} pixel capture(s) produced no PNG — refusing to record: ${JSON.stringify(failures.slice(0, 5))}`);
    }
    if (RECORD) {
      expectedDocument = await writeExpected(previous, resolved, actual, declaration, published, variants);
    } else if (resolved === null) {
      // Ожиданий для этого отпечатка ещё нет. Это ровно первый прогон корпуса внутри образа:
      // fingerprint образа (`source: "manifest"`) не совпадает с dev-фолбэком, по которому
      // записан корень. Bootstrap-режим публикует матрицу отчётом и НЕ красит гейт; жёстким
      // гейт становится после `--adopt` снятой записи (плана §5 R2c).
      if (!BOOTSTRAP) {
        throw new Error(
          `no expectations for renderer host ${hostKey} in ${EXPECTED_PATH} `
          + `(root record is ${previous?.rendererSource ?? "none"}:${previous?.rendererFingerprint ?? "none"}). `
          + "Run with --bootstrap to publish the matrix instead of failing, then adopt it via --adopt.",
        );
      }
      bootstrapped = true;
      process.stderr.write(`[corpus] bootstrap: no expectations for host ${hostKey} — publishing the matrix without gating\n`);
    } else {
      if (resolved.record.rendererVersion !== declaration.rendererVersion) {
        throw new Error(`expectations for host ${hostKey} were recorded for RENDERER_VERSION ${resolved.record.rendererVersion}, server declares ${declaration.rendererVersion} — re-record (plan §6)`);
      }
      mismatches = diffMatrix(resolved.record, actual, published, variants);
    }
    const drift = diffPasses(passes, published, variants, new Set((resolved?.record.quarantined ?? expectedDocument?.quarantined) ?? []));
    const driftReport = resolved === null ? null : fingerprintDrift(resolved.record, declaration);
    // «fingerprint drift» печатается ПЕРЕД перечнем расхождений: читателю лога сначала нужен
    // ответ «тот ли это хост», и только потом — список разошедшихся sha (§5 R2c, миноры R2b).
    if (mismatches.some((item) => item.kind === "sha_mismatch")) printDrift(driftReport, mismatches);

    const report = {
      mode: RECORD ? "record" : "verify",
      truncated: TRUNCATED,
      bootstrap: bootstrapped,
      expectationScope: RECORD ? (resolved?.scope ?? "root") : (resolved?.scope ?? "none"),
      hostKey,
      fixtures: published.length,
      variants: variants.length,
      captures: passes.reduce((sum, pass) => sum + pass.captured, 0),
      passes: passes.length,
      mismatches: mismatches.length,
      intraRunDrift: drift.length,
      captureFailures: failures.length,
      msTotal: passes.reduce((sum, pass) => sum + pass.msTotal, 0),
      msPerCapture: Math.round(passes.reduce((sum, pass) => sum + pass.msTotal, 0) / Math.max(1, passes.reduce((sum, pass) => sum + pass.captured, 0))),
      renderer: declaration,
      quarantined: expectedDocument?.quarantined ?? [],
      ...(driftReport !== null ? { fingerprintDrift: driftReport } : {}),
      ...(mismatches.length > 0 ? { mismatchDetail: mismatches.slice(0, 20) } : {}),
      ...(drift.length > 0 ? { driftDetail: drift.slice(0, 20) } : {}),
      ...(failures.length > 0 ? { failureDetail: failures.slice(0, 20) } : {}),
      ...(REPORT ? { msByFixture: actual.msByFixture, sizes: actual.sizes } : {}),
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
    // Host record прогона для CI-артефакта и soft cross-host гейта: та же форма, что запись
    // `expected.json`, поэтому файл принимается `--adopt` как есть.
    if (OUT !== null && OUT !== undefined) {
      await writeFile(resolve(process.cwd(), OUT), `${JSON.stringify({ ...report, pixel: actual.pixel, outcome: actual.outcome, sizes: actual.sizes }, null, 2)}\n`);
    }
    if (mismatches.length > 0 || drift.length > 0 || failures.length > 0) process.exitCode = 1;
  } finally {
    if (child !== null) {
      child.kill("SIGTERM");
      await sleep(500);
      if (child.exitCode === null) child.kill("SIGKILL");
      if (!KEEP) await rm(resolve(ROOT, DATA_DIR), { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
