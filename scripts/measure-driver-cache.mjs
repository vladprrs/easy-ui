#!/usr/bin/env node
/* global process, URL, fetch, setTimeout, Buffer */
/**
 * Замер KPI №1 плана `docs/plans/2026-08-03-family-acceptance-and-composition-v3.md` §1
 * («клиентские операции на семью 49 cases»), волна W7.
 *
 * Что меряется: сколько **HTTP-запросов клиента** стоит приёмка семьи из N случаев командой
 * `driver.mjs accept --case-set … --cache-dir …` — холодным кэшем и тёплым. Считает не драйвер,
 * а прозрачный прокси перед сервером: цифра не зависит от честности клиента.
 *
 * Схема: bun-сервер (`SERVE_DIST=dist EASYUI_ACCEPTANCE_MATRIX=1`) ← счётный прокси ← драйвер.
 * Подготовка семьи (DS, компонент, case-set) идёт мимо прокси, чтобы в KPI попадала только
 * приёмка. Требуется собранный `dist/` и установленный chromium (иначе капчур отвечает 501).
 *
 *   node scripts/measure-driver-cache.mjs [--cases 49] [--port 4197] [--keep]
 *
 * Вывод — JSON-строка: {cases, cold: {...}, warm: {...}} с числом запросов по методу и пути.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const CASES = Number(flag("cases", "49"));
const PORT = Number(flag("port", "4197"));
const PROXY_PORT = PORT + 1;
const KEEP = args.includes("--keep");

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DATA_DIR = ".measure-data/driver-cache";
const CACHE_DIR = ".measure-data/driver-cache-client";
const BASE = `http://127.0.0.1:${PORT}`;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
const ADMIN_NAME = "Cache Measure Admin";
const ADMIN_PASSWORD = "cache-measure-password";
const DS_ID = "measure-cache";
const COMPONENT_ID = "measure-cache-probe";

const SOURCE = `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ label: z.string() }),
  description: "Client cache measurement probe: renders a single static label",
  atomicLevel: "atom" as const,
  examples: { alpha: { label: "Alpha" } },
};

export default function CacheProbe({ props }: EasyUIComponentProps<{ label: string }>) {
  return <div style={{ padding: 8, background: "#fff", color: "#000" }}>{props.label}</div>;
}
`;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let cookie = "";
async function json(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      // Origin — прокси: сервер знает публичным origin именно его (PUBLIC_ORIGIN), а замер
      // ходит и напрямую (подготовка), и через прокси (сам замер).
      origin: PROXY,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
    },
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0) cookie = setCookie.map((item) => item.split(";")[0]).join("; ");
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, body, text };
}

async function waitForHealth(child) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("server did not become healthy in 90s");
}

/** Прозрачный счётчик запросов перед сервером: KPI считается снаружи клиента. */
function startProxy() {
  const counts = new Map();
  let recording = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url, PROXY);
    const label = `${request.method} ${url.pathname.replace(/\/(cand_|run_|cset_|asset_)[0-9a-f]+/g, "/$1…")}`;
    if (recording) counts.set(label, (counts.get(label) ?? 0) + 1);
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      const upstream = await fetch(`${BASE}${request.url}`, {
        method: request.method,
        headers: Object.fromEntries(Object.entries(request.headers).filter(([name]) => name !== "host" && name !== "connection" && name !== "content-length")),
        body: ["GET", "HEAD"].includes(request.method) ? undefined : Buffer.concat(chunks),
        redirect: "manual",
      });
      response.writeHead(upstream.status, Object.fromEntries([...upstream.headers.entries()].filter(([name]) => name !== "content-encoding" && name !== "content-length")));
      response.end(Buffer.from(await upstream.arrayBuffer()));
    });
  });
  return {
    listen: () => new Promise((done) => server.listen(PROXY_PORT, "127.0.0.1", done)),
    close: () => new Promise((done) => server.close(done)),
    start() { recording = true; counts.clear(); },
    stop() { recording = false; return { total: [...counts.values()].reduce((sum, value) => sum + value, 0), byPath: Object.fromEntries([...counts.entries()].sort()) }; },
  };
}

/**
 * Семья N случаев в двух измерениях (`row` × `col`): по одному измерению на 49 значений схема
 * не пускает (`CASE_SET_MAX_DIMENSION_VALUES = 32`), и настоящая семья тоже многомерна.
 */
const manifest = () => {
  const side = Math.ceil(Math.sqrt(CASES));
  const axis = (count) => Array.from({ length: count }, (_, i) => `v${String(i + 1).padStart(2, "0")}`);
  return {
    manifestVersion: 1,
    componentId: COMPONENT_ID,
    capture: { viewport: { width: 320, height: 160 }, deviceScaleFactor: 1, theme: "light" },
    dimensions: { row: axis(side), col: axis(side) },
    cases: Array.from({ length: CASES }, (_, i) => ({
      id: `case-${String(i + 1).padStart(2, "0")}`,
      props: { label: `Case ${i + 1}` },
      dims: { row: `v${String(Math.floor(i / side) + 1).padStart(2, "0")}`, col: `v${String((i % side) + 1).padStart(2, "0")}` },
    })),
  };
};

function runDriver(extraArgs) {
  return new Promise((done, fail) => {
    const child = spawn("node", [resolve(ROOT, ".claude/skills/author/driver.mjs"), ...extraArgs], {
      cwd: ROOT,
      env: {
        ...process.env,
        EASYUI_API: `${PROXY}/api`,
        EASYUI_USERNAME: ADMIN_NAME,
        EASYUI_PASSWORD: ADMIN_PASSWORD,
        EASYUI_LEGACY_BASIC_AUTH: "",
        EASYUI_SESSION_FILE: resolve(ROOT, CACHE_DIR, "session.json"),
        EASYUI_SESSION_CACHE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

async function main() {
  try { statSync(resolve(ROOT, "dist/index.html")); }
  catch { throw new Error("dist/ is missing — run `npm run build` first (capture needs SERVE_DIST)"); }

  for (const dir of [DATA_DIR, CACHE_DIR]) {
    await rm(resolve(ROOT, dir), { recursive: true, force: true });
    await mkdir(resolve(ROOT, dir), { recursive: true });
  }

  const child = spawn(`${process.env.HOME}/.bun/bin/bun`, ["server/main.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      ADMIN_NAME, ADMIN_PASSWORD,
      DATA_DIR, SERVE_DIST: "dist",
      PORT: String(PORT),
      PUBLIC_ORIGIN: PROXY,
      EASYUI_ACCEPTANCE_MATRIX: "1",
      EASYUI_SURFACES: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const proxy = startProxy();

  try {
    await waitForHealth(child);
    await proxy.listen();
    const login = await json("/api/auth/login", { method: "POST", body: JSON.stringify({ name: ADMIN_NAME, password: ADMIN_PASSWORD }) });
    if (login.status !== 200) throw new Error(`login failed: HTTP ${login.status} ${login.text}`);

    const ds = await json("/api/design-systems", { method: "POST", body: JSON.stringify({ id: DS_ID, name: "Measure Cache", description: "Design system for the W7 client cache measurement" }) });
    if (![201, 409].includes(ds.status)) throw new Error(`design system refused: HTTP ${ds.status} ${ds.text}`);
    const component = await json("/api/components", {
      method: "POST",
      body: JSON.stringify({ id: COMPONENT_ID, name: "CacheProbe", source: SOURCE, designSystem: DS_ID, intent: "Показывает статичную подпись для замера клиентского кэша приёмки" }),
    });
    if (![201, 409].includes(component.status)) throw new Error(`component refused: HTTP ${component.status} ${component.text}`);
    const caseSet = await json(`/api/components/${COMPONENT_ID}/case-sets`, { method: "PUT", body: JSON.stringify({ manifest: manifest() }) });
    if (caseSet.status !== 200) throw new Error(`case-set refused: HTTP ${caseSet.status} ${caseSet.text}`);
    const caseSetId = caseSet.body.caseSetId;

    const cacheDir = resolve(ROOT, CACHE_DIR, "cache");
    const measure = async (label) => {
      proxy.start();
      const at = Date.now();
      const result = await runDriver(["accept", COMPONENT_ID, "--case-set", caseSetId, "--json", "--cache-dir", cacheDir, "--timeout-sec", "3600"]);
      const counts = proxy.stop();
      if (result.code !== 0 && result.code !== 2) throw new Error(`${label} accept failed (${result.code}):\n${result.stderr}`);
      const payload = JSON.parse(result.stdout);
      return {
        label, wallMs: Date.now() - at, exitCode: result.code, verdict: payload.status,
        progress: payload.progress, cache: payload.cache, requests: counts.total, byPath: counts.byPath,
      };
    };

    const cold = await measure("cold");
    const warm = await measure("warm");
    process.stdout.write(`${JSON.stringify({ cases: CASES, caseSetId, cold, warm }, null, 2)}\n`);
  } finally {
    await proxy.close().catch(() => {});
    child.kill("SIGTERM");
    await sleep(500);
    if (child.exitCode === null) child.kill("SIGKILL");
    if (!KEEP) for (const dir of [DATA_DIR, CACHE_DIR]) await rm(resolve(ROOT, dir), { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
