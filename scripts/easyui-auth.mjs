/* global Buffer, Headers, URL, fetch, process */

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

export function createEasyUiClient({ apiBase, credentials = easyUiCredentials(), fetchImpl = fetch }) {
  const base = apiBase.replace(/\/$/, "");
  const origin = new URL(base).origin;
  const authorization = basic(credentials.legacyBasicAuth);
  let cookie;
  let loginPromise;

  async function login() {
    if (cookie) return cookie;
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
      return cookie;
    })();
    return loginPromise;
  }

  async function request(path, init = {}) {
    if (!path.endsWith("/auth/login")) await login();
    const headers = new Headers(init.headers);
    headers.set("origin", origin);
    if (authorization) headers.set("authorization", authorization);
    if (cookie) headers.set("cookie", cookie);
    return fetchImpl(`${base}${path}`, { ...init, headers });
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
