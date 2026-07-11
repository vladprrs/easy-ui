#!/usr/bin/env node
// easy-ui authoring driver: push custom components and prototypes to the
// easy-ui server over HTTP and (optionally) screenshot the result in the player.
// Zero dependencies (Node 18+); `shoot` additionally needs playwright.
//
//   node driver.mjs component <id> <Name> <source.tsx>   create-or-update + publish
//   node driver.mjs prototype <doc.json>                 create-or-update (id from doc)
//   node driver.mjs get <prototypes|components> [id]     inspect (list without id)
//   node driver.mjs delete <prototypes|components> <id>
//   node driver.mjs shoot <prototypeId> [outDir]         screenshot every screen
//
// Env:
//   EASYUI_API   API base, default https://easy-ui.pay-offline.ru/api
//   EASYUI_AUTH  basic-auth credentials "user:pass" (required for the default prod API)

import { readFile, mkdir } from "node:fs/promises";

const API = (process.env.EASYUI_API ?? "https://easy-ui.pay-offline.ru/api").replace(/\/$/, "");
const AUTH = process.env.EASYUI_AUTH
  ? `Basic ${Buffer.from(process.env.EASYUI_AUTH).toString("base64")}`
  : null;

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(AUTH ? { authorization: AUTH } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

function fail(step, r) {
  console.error(`${step} failed (${r.status}):`, JSON.stringify(r.json, null, 2));
  if (r.status === 401) console.error("hint: set EASYUI_AUTH=user:pass");
  process.exit(1);
}

async function headRev(kind, id) {
  const r = await call("GET", `/${kind}/${id}`);
  if (r.status === 404) return null;
  if (r.status !== 200) fail(`GET /${kind}/${id}`, r);
  return r.json.headRev;
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "component") {
  const [id, name, sourcePath] = args;
  const source = await readFile(sourcePath, "utf8");
  const rev = await headRev("components", id);
  const save = rev === null
    ? await call("POST", "/components", { id, name, source, message: "driver save" })
    : await call("PUT", `/components/${id}`, { source, message: "driver save", baseRev: rev });
  if (save.status !== 200 && save.status !== 201) fail("save", save);
  const newRev = save.json.rev;
  console.log(`saved ${id} rev ${newRev}`);
  const pub = await call("POST", `/components/${id}/publish`, { baseRev: newRev });
  if (pub.status !== 201) fail("publish", pub);
  console.log(`published ${id} version ${pub.json.version}`, pub.json.warnings?.length ? pub.json.warnings : "");
} else if (cmd === "prototype") {
  const [docPath] = args;
  const doc = JSON.parse(await readFile(docPath, "utf8"));
  const rev = await headRev("prototypes", doc.id);
  const save = rev === null
    ? await call("POST", "/prototypes", { doc, message: "driver save" })
    : await call("PUT", `/prototypes/${doc.id}`, { doc, message: "driver save", baseRev: rev });
  if (save.status !== 200 && save.status !== 201) fail("save", save);
  console.log(`saved ${doc.id} rev ${save.json.rev}`, save.json.warnings?.length ? save.json.warnings : "");
  const draft = await call("GET", `/prototypes/${doc.id}/draft`);
  console.log("component pins:", JSON.stringify(draft.json.components));
  console.log(`player: ${API.replace(/\/api$/, "")}/p/${doc.id}`);
} else if (cmd === "get") {
  const [kind, id] = args;
  const r = await call("GET", id ? `/${kind}/${id}` : `/${kind}`);
  if (r.status !== 200) fail("get", r);
  console.log(JSON.stringify(r.json, null, 2));
} else if (cmd === "delete") {
  const [kind, id] = args;
  const rev = await headRev(kind, id);
  if (rev === null) { console.error(`${kind}/${id} not found`); process.exit(1); }
  const r = await call("DELETE", `/${kind}/${id}`, { baseRev: rev });
  if (r.status !== 204) fail("delete", r);
  console.log(`deleted ${kind}/${id}`);
} else if (cmd === "shoot") {
  const [id, outDir = `author-shots/${id}`] = args;
  const draft = await call("GET", `/prototypes/${id}/draft`);
  if (draft.status !== 200) fail("draft", draft);
  const screens = draft.json.doc.screens.map((s) => s.id);
  await mkdir(outDir, { recursive: true });
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const [user, ...pass] = (process.env.EASYUI_AUTH ?? "").split(":");
  const page = await browser.newPage({
    viewport: { width: 480, height: 800 },
    ...(AUTH ? { httpCredentials: { username: user, password: pass.join(":") } } : {}),
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const base = API.replace(/\/api$/, "");
  for (const screen of screens) {
    await page.goto(`${base}/p/${id}/s/${screen}`, { waitUntil: "networkidle" });
    await page.screenshot({ path: `${outDir}/${screen}.png` });
    console.log(`${outDir}/${screen}.png`);
  }
  await browser.close();
  if (errors.length) {
    console.error("browser errors:\n" + errors.join("\n"));
    process.exit(1);
  }
} else {
  console.error("usage: driver.mjs component <id> <Name> <src.tsx> | prototype <doc.json> | get <kind> [id] | delete <kind> <id> | shoot <prototypeId> [outDir]");
  process.exit(1);
}
