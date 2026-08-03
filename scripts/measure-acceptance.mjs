#!/usr/bin/env node
/**
 * Замер стоимости матричной приёмки (план `docs/plans/2026-08-03-family-acceptance-and-composition-v3.md`
 * §4, гейт O1 волны W1b).
 *
 * Что меряется: холодный ран на N случаях (по умолчанию 20) и повторный «тёплый» ран того же
 * кандидата (полный reuse по `case_fingerprint`), плюс байты CAS и пик RSS серверного процесса.
 *
 * Скрипт **сам поднимает** Bun preview-сервер по канону `playwright.config.ts` (webServer preview):
 * `SERVE_DIST=dist EASYUI_ACCEPTANCE_MATRIX=1 DATA_DIR=<изолированный> bun server/main.ts`.
 * Требуется собранный `dist/` (`npm run build`) и установленный chromium — без них капчур отвечает
 * 501 и мерить нечего. Данные пишутся в свежий `.measure-data/acceptance` (каталог обязан лежать
 * внутри корня проекта — см. CLAUDE.md про `DATA_DIR`).
 *
 * Запуск:
 *   node scripts/measure-acceptance.mjs [--cases 20] [--port 4199] [--keep]
 *
 * Вывод — одна JSON-строка:
 *   {cases, coldMs, warmMs, casBytes, rssPeakMb, cpus, coldVerdict, warmReused}
 * `rssPeakMb` — `VmHWM` из /proc/<pid>/status **серверного** процесса; если /proc недоступен —
 * `null`. Chromium живёт в отдельном воркер-процессе (`spawnWorker`), его пик сюда не входит —
 * это верхняя граница по серверу, а не по всей связке.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { statSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const CASES = Number(flag("cases", "20"));
const PORT = Number(flag("port", "4199"));
const KEEP = args.includes("--keep");

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DATA_DIR = ".measure-data/acceptance";
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_NAME = "Measure Admin";
const ADMIN_PASSWORD = "measure-admin-password";
const DS_ID = "measure-acceptance";
const COMPONENT_ID = "measure-acceptance-probe";

const SOURCE = `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ label: z.string() }),
  description: "Acceptance measurement probe: renders a single static label",
  atomicLevel: "atom" as const,
  examples: { alpha: { label: "Alpha" } },
};

export default function MeasureProbe({ props }: EasyUIComponentProps<{ label: string }>) {
  return <div style={{ padding: 8, background: "#fff", color: "#000" }}>{props.label}</div>;
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

async function waitForHealth(child) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("server did not become healthy in 90s");
}

async function rssPeakMb(pid) {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const match = /VmHWM:\s+(\d+)\s+kB/.exec(status);
    return match ? Math.round((Number(match[1]) / 1024) * 10) / 10 : null;
  } catch { return null; }
}

const du = (path) => new Promise((done) => {
  const child = spawn("du", ["-sb", path]);
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.on("close", () => done(Number(out.split(/\s/)[0]) || null));
  child.on("error", () => done(null));
});

async function pollRun(runId) {
  for (let attempt = 0; attempt < 2400; attempt += 1) {
    const { body } = await json(`/api/acceptance-runs/${runId}`);
    if (body && !["queued", "running"].includes(body.status)) return body;
    await sleep(500);
  }
  throw new Error("acceptance run did not terminalize within 20 minutes");
}

async function runOnce(candidateId, label) {
  const started = await json("/api/acceptance-runs", {
    method: "POST",
    body: JSON.stringify({ candidateId, cases: caseSet(), idempotencyKey: label }),
  });
  if (started.status !== 202) throw new Error(`${label} run refused: HTTP ${started.status} ${started.text}`);
  const at = Date.now();
  const run = await pollRun(started.body.runId);
  return { ms: Date.now() - at, run };
}

const caseSet = () => Array.from({ length: CASES }, (_, index) => ({
  key: `case-${String(index + 1).padStart(2, "0")}`,
  props: { label: `Case ${index + 1}` },
}));

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
      EASYUI_ACCEPTANCE_MATRIX: "1",
      EASYUI_SURFACES: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    await waitForHealth(child);
    const login = await json("/api/auth/login", { method: "POST", body: JSON.stringify({ name: ADMIN_NAME, password: ADMIN_PASSWORD }) });
    if (login.status !== 200) throw new Error(`login failed: HTTP ${login.status} ${login.text}`);

    const ds = await json("/api/design-systems", { method: "POST", body: JSON.stringify({ id: DS_ID, name: "Measure Acceptance", description: "Design system for acceptance measurement" }) });
    if (![201, 409].includes(ds.status)) throw new Error(`design system refused: HTTP ${ds.status} ${ds.text}`);

    const component = await json("/api/components", {
      method: "POST",
      body: JSON.stringify({
        id: COMPONENT_ID, name: "MeasureProbe", source: SOURCE, designSystem: DS_ID,
        intent: "Показывает статичную подпись для замера стоимости матричной приёмки",
      }),
    });
    if (![201, 409].includes(component.status)) throw new Error(`component refused: HTTP ${component.status} ${component.text}`);

    const candidate = await json(`/api/components/${COMPONENT_ID}/candidates`, { method: "POST", body: "{}" });
    if (candidate.status !== 200) throw new Error(`candidate refused: HTTP ${candidate.status} ${candidate.text}`);

    const cold = await runOnce(candidate.body.candidateId, "measure-cold");
    const warm = await runOnce(candidate.body.candidateId, "measure-warm");

    const report = {
      cases: CASES,
      coldMs: cold.ms,
      warmMs: warm.ms,
      casBytes: await du(resolve(ROOT, DATA_DIR, ".acceptance")),
      rssPeakMb: await rssPeakMb(child.pid),
      cpus: availableParallelism(),
      coldVerdict: cold.run.status,
      warmVerdict: warm.run.status,
      warmReused: `${warm.run.progress.reused}/${warm.run.progress.total}`,
      coldFailed: cold.run.failedCases?.length ?? 0,
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    child.kill("SIGTERM");
    await sleep(500);
    if (child.exitCode === null) child.kill("SIGKILL");
    if (!KEEP) await rm(resolve(ROOT, DATA_DIR), { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
