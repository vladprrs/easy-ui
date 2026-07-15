// Screenshot worker: one job per process, JSON over stdin -> single JSON line on
// stdout. Runs under node (not bun) with playwright chromium. Egress is closed by
// a controlled deny-proxy socket, port-scoped proxy-bypass, host-resolver rules,
// disabled QUIC/WebRTC, blocked service workers, closed websockets, and a
// context.route allowlist keyed on the exact capture origin + allowed paths.
/* global process, Buffer, URL, window */
import net from "node:net";

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

export function readyToExpected(ready) {
  if (ready.kind === "prototype") return { kind: "prototype", prototypeInstanceId: ready.prototypeInstanceId, rev: ready.revision, componentManifestHash: ready.componentManifestHash, builtinCatalogHash: ready.builtinCatalogHash, dsMetaVersion: ready.dsMetaVersion, rendererBuild: ready.rendererBuild };
  return { kind: "component", componentId: ready.componentId, version: ready.version, bundleHash: ready.bundleHash, propsHash: ready.propsHash, dsMetaVersion: ready.dsMetaVersion, rendererBuild: ready.rendererBuild };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function run(job) {
  const { chromium } = await import("playwright");
  const consoleErrors = [];
  const pageErrors = [];

  const denyProxy = net.createServer((socket) => socket.destroy());
  await new Promise((res) => denyProxy.listen(0, "127.0.0.1", res));
  const denyPort = denyProxy.address().port;
  const capturePort = new URL(job.captureOrigin).port;

  let browser;
  let context;
  try {
    browser = await chromium.launch({ headless: true, args: buildLaunchArgs(denyPort, capturePort) });
    context = await browser.newContext({
      viewport: job.viewport,
      deviceScaleFactor: job.deviceScaleFactor,
      colorScheme: job.colorScheme,
      locale: "ru-RU",
      timezoneId: "Europe/Moscow",
      reducedMotion: "reduce",
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
      if (msg.type() !== "error" || consoleErrors.length >= 100) return;
      const url = msg.location()?.url;
      consoleErrors.push(url ? `${msg.text()} (${url})` : msg.text());
    });
    page.on("pageerror", (err) => { if (pageErrors.length < 100) pageErrors.push(err.message); });

    await page.goto(job.captureOrigin + job.captureUrl, { waitUntil: "domcontentloaded", timeout: 20000 });

    const handle = await page.waitForFunction(() => window.__EUI_CAPTURE_READY__ ?? null, null, { timeout: 20000, polling: 100 });
    const ready = await handle.jsonValue();
    if (!ready || ready.status === "error") return { ok: false, error: ready?.error ?? "capture reported error", consoleErrors, pageErrors };
    if (canonicalStringify(readyToExpected(ready)) !== canonicalStringify(job.expected)) {
      return { ok: false, error: `readiness mismatch: got ${canonicalStringify(readyToExpected(ready))} expected ${canonicalStringify(job.expected)}`, consoleErrors, pageErrors };
    }

    const el = await page.$("#eui-capture-surface");
    const buf = el ? await el.screenshot({ type: "png" }) : await page.screenshot({ type: "png" });
    const width = buf.length >= 24 ? buf.readUInt32BE(16) : job.viewport.width;
    const height = buf.length >= 24 ? buf.readUInt32BE(20) : job.viewport.height;
    return { ok: true, pngBase64: buf.toString("base64"), width, height, consoleErrors, pageErrors, browserVersion: browser.version() };
  } finally {
    try { await context?.close(); } catch { /* best effort */ }
    try { await browser?.close(); } catch { /* best effort */ }
    denyProxy.close();
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  readStdin()
    .then(run)
    .then((result) => { process.stdout.write(JSON.stringify(result) + "\n"); process.exit(0); })
    .catch((error) => { process.stdout.write(JSON.stringify({ ok: false, error: error?.message ?? String(error) }) + "\n"); process.exit(1); });
}
