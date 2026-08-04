#!/usr/bin/env node
/* global process, URL, fetch, setTimeout, clearInterval, setInterval */
/**
 * Замер стоимости капчура: **cold/warm p95 и RSS** (план `docs/plans/2026-08-03-renderer-contract-2.md`
 * §5 **R9a**, метрика K7).
 *
 * Что меряется. N последовательных капчуров одного компонента через публичный API. Первый —
 * **cold** (в per-job режиме это спавн node + запуск chromium; в режиме пула — то же самое, но
 * ровно один раз на весь прогон), остальные — **warm**. По warm-выборке считаются p50/p95/max.
 * Параллельно семплится RSS **всего дерева процессов сервера** (bun + node-воркеры + chromium и
 * его рендереры): именно оно, а не RSS сервера, упирается в `mem_limit` контейнера.
 *
 * Канон устройства — `scripts/measure-acceptance.mjs` (тот же способ поднимать изолированный Bun
 * preview; `DATA_DIR` обязан лежать внутри корня проекта, см. CLAUDE.md).
 *
 * Запуск:
 *   node scripts/measure-capture.mjs --pool 1 --cases 30
 *   node scripts/measure-capture.mjs --pool 0 --cases 30      # базовая линия: процесс на джобу
 * Флаги: `--port N`, `--mem-limit-mb N` (дефолт 4096 — фактический прод-лимит §4), `--keep`,
 * `--flags 0|1` (`EASYUI_RENDERER_FLAGS`, дефолт 1 — прод-цель пакета), `--server-log`.
 *
 * Вывод — одна JSON-строка. Решение по прод-включению пула печатается полем `verdict`:
 * **прод ON, если warm p95 ≤ 1,0 с/case и устойчивый RSS ≤ 75% `mem_limit`; иначе пул остаётся
 * dev/CI-only — это валидный результат волны**, а не провал.
 */
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { statSync } from "node:fs";
import { treeRssMb } from "./screenshot-pool-worker.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const CASES = Number(flag("cases", "30"));
const PORT = Number(flag("port", "4197"));
const POOL = flag("pool", "1") === "1";
const RENDERER_FLAGS = flag("flags", "1") === "1";
const MEM_LIMIT_MB = Number(flag("mem-limit-mb", "4096"));
const KEEP = args.includes("--keep");
const SERVER_LOG = args.includes("--server-log");

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DATA_DIR = ".measure-data/capture";
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_NAME = "Measure Capture Admin";
const ADMIN_PASSWORD = "measure-capture-password";
const DS_ID = "measure-capture";
const COMPONENT_ID = "measure-capture-probe";

const SOURCE = `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ label: z.string() }),
  description: "Capture measurement probe: renders a single static label",
  atomicLevel: "atom" as const,
  examples: { alpha: { label: "Alpha" } },
};

export default function CaptureProbe({ props }: EasyUIComponentProps<{ label: string }>) {
  return <div style={{ padding: 12, background: "#fff", color: "#111", fontSize: 18 }}>{props.label}</div>;
}
`;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let cookie = "";
async function call(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      origin: BASE,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
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
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("server did not become healthy in 120s");
}

async function pollJob(jobId) {
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const { body } = await json(`/api/screenshot-jobs/${jobId}`);
    if (body && (body.status === "done" || body.status === "error")) return body;
    await sleep(50);
  }
  throw new Error(`screenshot job ${jobId} did not settle within 45s`);
}

/** Один капчур: постановка → терминальный статус. Меряется полный путь клиента. */
async function captureOnce(index) {
  const startedAt = Date.now();
  const enqueued = expectStatus(`enqueue #${index}`, await json(
    `/api/components/${COMPONENT_ID}/versions/1/screenshot`,
    { method: "POST", body: JSON.stringify({ props: { label: `Case ${index}` }, viewport: { width: 320, height: 200 }, deviceScaleFactor: 2, theme: "light" }) },
  ), [202]);
  const job = await pollJob(enqueued.body.jobId);
  if (job.status !== "done") throw new Error(`capture #${index} failed: ${JSON.stringify(job.error ?? null)}`);
  return Date.now() - startedAt;
}

/** p-квантиль по методу «ближайший ранг» — на выборке 20–50 замеров он честнее интерполяции. */
function quantile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1];
}

async function main() {
  try { statSync(resolve(ROOT, "dist/index.html")); }
  catch { throw new Error("dist/ is missing — run `npm run build` first (capture needs SERVE_DIST)"); }

  await rm(resolve(ROOT, DATA_DIR), { recursive: true, force: true });
  await mkdir(resolve(ROOT, DATA_DIR), { recursive: true });

  const child = spawn(`${process.env.HOME}/.bun/bin/bun`, ["server/main.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      ADMIN_NAME, ADMIN_PASSWORD,
      DATA_DIR, SERVE_DIST: "dist",
      PORT: String(PORT),
      PUBLIC_ORIGIN: BASE,
      EASYUI_SURFACES: "1",
      EASYUI_RENDERER_POOL: POOL ? "1" : "0",
      EASYUI_RENDERER_FLAGS: RENDERER_FLAGS ? "1" : "0",
      REUSE_GATE: "shadow",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (chunk) => { if (SERVER_LOG) process.stderr.write(chunk); });

  // Семплер RSS дерева: сервер + воркеры + chromium. Пик берётся по максимуму семплов, а не по
  // VmHWM одного процесса — «устойчивый RSS» волны про весь контейнер, а не про bun.
  const samples = [];
  const sampler = setInterval(() => { void treeRssMb(child.pid).then((mb) => { if (mb !== null) samples.push(mb); }); }, 500);

  try {
    await waitForHealth(child);
    expectStatus("login", await json("/api/auth/login", { method: "POST", body: JSON.stringify({ name: ADMIN_NAME, password: ADMIN_PASSWORD }) }), [200]);
    expectStatus("design system", await json("/api/design-systems", {
      method: "POST",
      body: JSON.stringify({ id: DS_ID, name: "Measure Capture", description: "Design system for capture measurement" }),
    }), [201, 409]);
    expectStatus("component", await json("/api/components", {
      method: "POST",
      body: JSON.stringify({ id: COMPONENT_ID, name: "CaptureProbe", source: SOURCE, designSystem: DS_ID, intent: "Показывает статичную подпись для замера стоимости капчура" }),
    }), [201, 409]);
    expectStatus("publish", await json(`/api/components/${COMPONENT_ID}/publish`, { method: "POST", body: JSON.stringify({ baseRev: 1 }) }), [201, 409]);

    const durations = [];
    for (let index = 1; index <= CASES; index += 1) {
      durations.push(await captureOnce(index));
      if (process.stderr.isTTY) process.stderr.write(`\r[measure-capture] ${index}/${CASES} last=${durations.at(-1)}ms   `);
    }
    if (process.stderr.isTTY) process.stderr.write("\n");

    const coldMs = durations[0];
    const warm = durations.slice(1).sort((a, b) => a - b);
    const warmP95 = quantile(warm, 0.95);
    const rssPeakMb = samples.length > 0 ? Math.max(...samples) : null;
    // «Устойчивый» RSS — медиана семплов: одиночный пик запуска chromium не должен решать судьбу
    // прод-включения, а плато под нагрузкой — должен.
    const sortedSamples = [...samples].sort((a, b) => a - b);
    const rssSustainedMb = quantile(sortedSamples, 0.5);
    const rssBudgetMb = Math.round(MEM_LIMIT_MB * 0.75);
    const p95Ok = warmP95 !== null && warmP95 <= 1000;
    const rssOk = rssSustainedMb !== null && rssSustainedMb <= rssBudgetMb;

    const report = {
      pool: POOL,
      rendererFlags: RENDERER_FLAGS,
      cases: CASES,
      coldMs,
      warmP50Ms: quantile(warm, 0.5),
      warmP95Ms: warmP95,
      warmMaxMs: warm.at(-1) ?? null,
      warmMeanMs: warm.length > 0 ? Math.round(warm.reduce((sum, value) => sum + value, 0) / warm.length) : null,
      rssPeakMb, rssSustainedMb, rssSamples: samples.length,
      memLimitMb: MEM_LIMIT_MB, rssBudgetMb,
      cpus: availableParallelism(),
      verdict: p95Ok && rssOk ? "prod-on" : "dev-ci-only",
      verdictReason: [
        `warm p95 ${warmP95 ?? "n/a"}ms ${p95Ok ? "<=" : ">"} 1000ms`,
        `sustained RSS ${rssSustainedMb ?? "n/a"}MB ${rssOk ? "<=" : ">"} ${rssBudgetMb}MB (75% of ${MEM_LIMIT_MB}MB)`,
      ].join("; "),
      verdictRule: "прод ON если warm p95 ≤1.0с/case и RSS ≤75% mem_limit; иначе пул dev/CI-only — валидный результат",
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    clearInterval(sampler);
    child.kill("SIGTERM");
    await sleep(700);
    if (child.exitCode === null) child.kill("SIGKILL");
    if (!KEEP) await rm(resolve(ROOT, DATA_DIR), { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
