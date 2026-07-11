#!/usr/bin/env node
// Authoring driver for easy-ui: push custom components and prototypes to the
// local Bun API and screenshot the result in the player.
//
//   node .claude/skills/author/driver.mjs component <id> <Name> <source.tsx>
//   node .claude/skills/author/driver.mjs prototype <doc.json>
//   node .claude/skills/author/driver.mjs shoot <prototypeId> [baseUrl]
//
// API base defaults to http://127.0.0.1:8787/api (override with EASYUI_API).
// `component` and `prototype` create the resource or update it (CAS via
// headRev); `component` also publishes the new revision.

import { readFile, mkdir } from "node:fs/promises";

const API = process.env.EASYUI_API ?? "http://127.0.0.1:8787/api";

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

function fail(step, r) {
  console.error(`${step} failed (${r.status}):`, JSON.stringify(r.json, null, 2));
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
} else if (cmd === "shoot") {
  const [id, base = "http://localhost:5173"] = args;
  const draft = await call("GET", `/prototypes/${id}/draft`);
  if (draft.status !== 200) fail("draft", draft);
  const screens = draft.json.doc.screens.map((s) => s.id);
  const dir = `.e2e-data/author-shots/${id}`;
  await mkdir(dir, { recursive: true });
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 480, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  for (const screen of screens) {
    await page.goto(`${base}/p/${id}/s/${screen}`, { waitUntil: "networkidle" });
    await page.screenshot({ path: `${dir}/${screen}.png` });
    console.log(`${dir}/${screen}.png`);
  }
  await browser.close();
  if (errors.length) {
    console.error("browser errors:\n" + errors.join("\n"));
    process.exit(1);
  }
} else {
  console.error("usage: driver.mjs component <id> <Name> <source.tsx> | prototype <doc.json> | shoot <prototypeId> [baseUrl]");
  process.exit(1);
}
