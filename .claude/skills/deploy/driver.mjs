#!/usr/bin/env node
// Deploy driver for easy-ui on Dokploy (https://dokploy.pay-offline.ru).
// Zero deps; secrets come from env or the project .env (gitignored).
//   node .claude/skills/deploy/driver.mjs status|deploy [title]|watch|verify

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DOKPLOY_URL = "https://dokploy.pay-offline.ru";
const COMPOSE_ID = "CWXPcz6h6L_cyYSwG9V92";
const APP_URL = "https://easy-ui.pay-offline.ru";

function loadDotEnv() {
  try {
    for (const line of readFileSync(resolve(process.cwd(), ".env"), "utf8").split("\n")) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch {}
}
loadDotEnv();

const apiKey = process.env.DOKPLOY_API_KEY;
if (!apiKey) {
  console.error("DOKPLOY_API_KEY is not set (env or .env in project root)");
  process.exit(2);
}
const namedUser = process.env.EASYUI_USERNAME; // named account, optional (verify degrades)
const namedPassword = process.env.EASYUI_PASSWORD;

async function api(path, body) {
  const res = await fetch(`${DOKPLOY_URL}/api/${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-api-key": apiKey, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// API returns deployments unsorted — always order by createdAt explicitly.
const byCreatedAt = (deployments) =>
  (deployments ?? []).slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

async function composeState() {
  const c = await api(`compose.one?composeId=${COMPOSE_ID}`);
  const last = byCreatedAt(c.deployments).at(-1) ?? {};
  return { composeStatus: c.composeStatus, last };
}

async function status() {
  const c = await api(`compose.one?composeId=${COMPOSE_ID}`);
  console.log(`composeStatus: ${c.composeStatus}`);
  for (const d of byCreatedAt(c.deployments).slice(-3))
    console.log(`  ${d.createdAt}  ${d.status.padEnd(7)} ${(d.title ?? "").split("\n")[0].slice(0, 70)}`);
}

async function watch({ timeoutMs = 15 * 60_000 } = {}) {
  const startedAt = Date.now();
  let lastLine = "";
  while (Date.now() - startedAt < timeoutMs) {
    const { composeStatus, last } = await composeState();
    const line = `${composeStatus} / ${last.status} ${(last.title ?? "").split("\n")[0].slice(0, 60)}`;
    if (line !== lastLine) console.log(new Date().toISOString().slice(11, 19), line);
    lastLine = line;
    // composeStatus may lag or hold a stale "error" from a previous run —
    // only the newest deployment's status decides the outcome.
    if (last.status === "error") {
      console.error(`deployment failed: ${last.errorMessage ?? "see Dokploy UI logs"}`);
      process.exit(1);
    }
    if (last.status === "done") return;
    await new Promise(r => setTimeout(r, 15_000));
  }
  console.error("watch timed out");
  process.exit(1);
}

async function deploy(title) {
  const r = await api("compose.deploy", { composeId: COMPOSE_ID, title: title ?? "manual deploy via driver" });
  console.log(r.message ?? JSON.stringify(r));
  await new Promise(r => setTimeout(r, 5_000)); // let the queued deployment register
  await watch();
}

async function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
  return ok;
}

async function verify() {
  let allOk = true;
  const health = await fetch(`${APP_URL}/api/health`);
  const healthBody = await health.json().catch(() => ({}));
  allOk &= await check("health open, ready", health.status === 200 && healthBody.status === "ready", `${health.status} ${healthBody.status}`);

  const unauth = await fetch(`${APP_URL}/api/prototypes`);
  allOk &= await check("API requires auth", unauth.status === 401, `${unauth.status}, www-authenticate=${unauth.headers.get("www-authenticate")}`);

  const spa = await fetch(`${APP_URL}/`, { headers: { accept: "text/html" } });
  const html = await spa.text();
  allOk &= await check("SPA open", spa.status === 200 && html.includes("<title>easy-ui</title>"), `${spa.status}`);

  if (namedUser && namedPassword) {
    const login = await fetch(`${APP_URL}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_URL },
      body: JSON.stringify({ name: namedUser, password: namedPassword }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    allOk &= await check("login sets session cookie", login.status === 200 && cookie.length > 0, `${login.status}`);
    const apiRes = await fetch(`${APP_URL}/api/prototypes`, { headers: { cookie } });
    allOk &= await check("API with session cookie", apiRes.status === 200, `${apiRes.status}`);
  } else {
    console.log("SKIP  session checks (EASYUI_USERNAME/EASYUI_PASSWORD not set)");
  }
  if (!allOk) process.exit(1);
}

const [cmd, arg] = process.argv.slice(2);
const commands = { status, deploy: () => deploy(arg), watch: () => watch(), verify };
if (!commands[cmd]) {
  console.error("usage: driver.mjs status | deploy [title] | watch | verify");
  process.exit(2);
}
await commands[cmd]();
