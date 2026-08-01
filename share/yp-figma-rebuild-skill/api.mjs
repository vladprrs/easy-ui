#!/usr/bin/env node
/* global process, console */
// Generic authenticated easy-ui API helper for operations driver.mjs does not cover:
// theme PATCH (auto-CAS), figma provenance (auto-baseRev), asset upload, arbitrary calls.
//
// usage:
//   api.mjs get <path>                        # GET /api<path>, prints JSON
//   api.mjs send <METHOD> <path> [body.json]  # arbitrary call with optional JSON body
//   api.mjs upload <file> [--mime <mime>]     # POST /assets (binary), prints {id,...}
//   api.mjs theme <dsId> <theme.json>         # PATCH /design-systems/:id, baseVersion = latestMetaVersion
//   api.mjs figma <componentId> <figma.json>  # PUT /components/:id {figma, baseRev = headRev} + publish
//                                             # (figma_json живёт на ревизии — без publish provenance
//                                             #  остался бы на неопубликованном драфте)

import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { createEasyUiClient, easyUiCredentials } from "./easyui-auth.mjs";

const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
};

const apiBase = (process.env.EASYUI_API || "https://easy-ui.pay-offline.ru/api").replace(/\/$/, "");
const client = createEasyUiClient({ apiBase, credentials: easyUiCredentials() });

function fail(message) { console.error(message); process.exit(2); }

async function call(method, path, body, contentType = "application/json") {
  const init = { method };
  if (body !== undefined) {
    init.headers = { "content-type": contentType };
    init.body = contentType === "application/json" ? JSON.stringify(body) : body;
  }
  const response = await client.request(path, init);
  const text = await response.text();
  if (!response.ok) fail(`HTTP ${response.status} ${method} ${path}\n${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { fail(`cannot read JSON ${file}: ${error.message}`); }
}

const [command, ...rest] = process.argv.slice(2);
const out = (value) => console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));

switch (command) {
  case "get": {
    const [path] = rest;
    if (!path?.startsWith("/")) fail("usage: api.mjs get </path>");
    out(await call("GET", path));
    break;
  }
  case "send": {
    const [method, path, bodyFile] = rest;
    if (!method || !path?.startsWith("/")) fail("usage: api.mjs send <METHOD> </path> [body.json]");
    out(await call(method.toUpperCase(), path, bodyFile ? readJson(bodyFile) : undefined));
    break;
  }
  case "upload": {
    const [file, flag, flagValue] = rest;
    if (!file) fail("usage: api.mjs upload <file> [--mime <mime>]");
    const mime = flag === "--mime" ? flagValue : MIME[extname(file).toLowerCase()];
    if (!mime) fail(`unknown extension ${extname(file)}; pass --mime <mime>`);
    out(await call("POST", "/assets", readFileSync(file), mime));
    break;
  }
  case "theme": {
    const [dsId, themeFile] = rest;
    if (!dsId || !themeFile) fail("usage: api.mjs theme <dsId> <theme.json>");
    const summary = await call("GET", `/design-systems/${encodeURIComponent(dsId)}`);
    const baseVersion = summary.latestMetaVersion ?? 0;
    out(await call("PATCH", `/design-systems/${encodeURIComponent(dsId)}`, { ...readJson(themeFile), baseVersion }));
    break;
  }
  case "figma": {
    const [componentId, figmaFile] = rest;
    if (!componentId || !figmaFile) fail("usage: api.mjs figma <componentId> <figma.json>");
    const encoded = encodeURIComponent(componentId);
    const meta = await call("GET", `/components/${encoded}`);
    const saved = await call("PUT", `/components/${encoded}`, {
      figma: readJson(figmaFile),
      baseRev: meta.headRev,
    });
    out(saved);
    out(await call("POST", `/components/${encoded}/publish`, { baseRev: saved.rev }));
    break;
  }
  default:
    fail("usage: api.mjs get|send|upload|theme|figma …  (see header of this file)");
}
