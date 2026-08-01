/* global Buffer, Headers, URL, fetch, process */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function basic(value) {
  return value ? `Basic ${Buffer.from(value).toString("base64")}` : undefined;
}

function cookiePair(response) {
  const header = response.headers.get("set-cookie");
  return header?.split(";", 1)[0] || undefined;
}

export function easyUiCredentials(env = process.env) {
  return {
    legacyBasicAuth: env.EASYUI_LEGACY_BASIC_AUTH || undefined,
    username: env.EASYUI_USERNAME || undefined,
    password: env.EASYUI_PASSWORD || undefined,
  };
}

/** Кэш живёт в приватном каталоге пользователя, а не в общем tmp: имя предсказуемо. */
function sessionCachePath(apiBase, username, env = process.env) {
  if (env.EASYUI_SESSION_FILE) return env.EASYUI_SESSION_FILE;
  const directory = env.XDG_STATE_HOME ? join(env.XDG_STATE_HOME, "easyui") : join(homedir(), ".cache", "easyui");
  const key = createHash("sha256").update(`${apiBase}|${username ?? ""}`).digest("hex").slice(0, 16);
  return join(directory, `session-${key}.json`);
}

function readSessionCache(path, apiBase, username) {
  let entry;
  try { entry = JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
  if (!entry || typeof entry.cookie !== "string" || entry.apiBase !== apiBase || (entry.username ?? undefined) !== username) return undefined;
  if (!(Date.now() - Date.parse(entry.savedAt) < SESSION_TTL_MS)) { dropSessionCache(path); return undefined; }
  return entry.cookie;
}

function writeSessionCache(path, apiBase, username, cookie) {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify({ cookie, apiBase, username, savedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } catch { rmSync(temporary, { force: true }); }
}

function dropSessionCache(path) {
  try { rmSync(path, { force: true }); } catch { /* кэш — best effort */ }
}

/** Только application-401 (`server/auth.ts`) значит «сессия протухла»; legacy-Basic отвечает текстом. */
async function isSessionExpired(response) {
  if (response.status !== 401 || !response.headers.get("content-type")?.includes("json")) return false;
  try { return (await response.clone().json())?.error?.code === "unauthorized"; } catch { return false; }
}

export function createEasyUiClient({ apiBase, credentials = easyUiCredentials(), fetchImpl = fetch }) {
  const base = apiBase.replace(/\/$/, "");
  const origin = new URL(base).origin;
  const authorization = basic(credentials.legacyBasicAuth);
  const cachePath = sessionCachePath(base, credentials.username);
  const cacheEnabled = process.env.EASYUI_SESSION_CACHE !== "0";
  let cookie;
  let loginPromise;
  let cached = false;
  let generation = 0;

  if (cacheEnabled) {
    cookie = readSessionCache(cachePath, base, credentials.username);
    cached = Boolean(cookie);
  } else dropSessionCache(cachePath);

  async function login() {
    if (cookie && !cached) return cookie;
    if (!credentials.username || !credentials.password) {
      throw new Error("EASYUI_USERNAME and EASYUI_PASSWORD are required for named-account login");
    }
    loginPromise ??= (async () => {
      const response = await fetchImpl(`${base}/auth/login`, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify({ name: credentials.username, password: credentials.password }),
      });
      if (!response.ok) throw new Error(`easy-ui login failed: HTTP ${response.status} ${await response.text()}`);
      cookie = cookiePair(response);
      if (!cookie) throw new Error("easy-ui login did not return a session cookie");
      cached = false;
      if (cacheEnabled) writeSessionCache(cachePath, base, credentials.username, cookie);
      return cookie;
    })();
    return loginPromise;
  }

  /** Пачка параллельных 401 переживает одну протухшую cookie ровно одним логином. */
  async function relogin(staleGeneration) {
    if (staleGeneration === generation) {
      generation += 1;
      cookie = undefined;
      loginPromise = undefined;
      cached = false;
      dropSessionCache(cachePath);
    }
    return login();
  }

  function send(path, init) {
    const headers = new Headers(init.headers);
    headers.set("origin", origin);
    if (authorization) headers.set("authorization", authorization);
    if (cookie) headers.set("cookie", cookie);
    return fetchImpl(`${base}${path}`, { ...init, headers });
  }

  async function request(path, init = {}) {
    const isLogin = path.endsWith("/auth/login");
    if (!isLogin && !cookie) await login();
    const staleCookie = cached;
    const staleGeneration = generation;
    const response = await send(path, init);
    if (isLogin || !staleCookie || !(await isSessionExpired(response))) return response;
    // Повтор тела безопасен: глобальный анонимный гейт (`server/main.ts:140`) отвечает 401
    // до роутинга и до `readJson`, то есть до любого side-effect запроса.
    await relogin(staleGeneration);
    return send(path, init);
  }

  return {
    apiBase: base,
    origin,
    legacyAuthorization: authorization,
    login,
    request,
    get cookieHeader() { return cookie; },
  };
}
