#!/usr/bin/env node
// easy-ui authoring driver: push custom components and prototypes to the
// easy-ui server over HTTP and (optionally) screenshot the result in the player.
// Zero dependencies (Node 18+); `shoot` additionally needs playwright.
//
//   node driver.mjs component <id> <Name> <source.tsx> [--design-system <id>]
//   node driver.mjs component-move <id> --design-system <id>
//   node driver.mjs design-system <id> <name> <description>
//   node driver.mjs prototype <doc.json>                 create-or-update (id from doc)
//   node driver.mjs get <prototypes|components> [id]     inspect (list without id)
//   node driver.mjs delete <prototypes|components> <id>
//   node driver.mjs shoot <prototypeId> [outDir]         screenshot every screen
//
// Env:
//   EASYUI_API   API base, default https://easy-ui.pay-offline.ru/api
//   EASYUI_AUTH  basic-auth credentials "user:pass" (required for the default prod API)
//   EASYUI_DESIGN_SYSTEM  default system for `component`; the CLI flag wins

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

async function getMeta(kind, id) {
  const r = await call("GET", `/${kind}/${id}`);
  if (r.status === 404) return null;
  if (r.status !== 200) fail(`GET /${kind}/${id}`, r);
  return r.json;
}

function usage(message) {
  if (message) console.error(message);
  console.error("usage: driver.mjs component <id> <Name> <src.tsx> [--design-system <id>] | component-move <id> --design-system <id> | design-system <id> <name> <description> | prototype <doc.json> | get <kind> [id] | delete <kind> <id> | shoot <prototypeId> [outDir]");
  process.exit(1);
}

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  const positionals = [];
  const flags = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    if (token !== "--design-system") usage(`unknown flag: ${token}`);
    if (flags.designSystem !== undefined) usage(`duplicate flag: ${token}`);
    const value = tokens[++i];
    if (value === undefined || value.startsWith("--")) usage(`flag ${token} requires a value`);
    flags.designSystem = value;
  }

  const ranges = {
    component: [3, 3],
    "component-move": [1, 1],
    "design-system": [3, 3],
    prototype: [1, 1],
    get: [1, 2],
    delete: [2, 2],
    shoot: [1, 2],
  };
  const range = ranges[command];
  if (!range) usage(command ? `unknown command: ${command}` : undefined);
  if (positionals.length < range[0] || positionals.length > range[1]) usage(`invalid arguments for ${command}`);
  if (flags.designSystem !== undefined && command !== "component" && command !== "component-move") {
    usage(`--design-system is not valid for ${command}`);
  }
  if (command === "component-move" && flags.designSystem === undefined) {
    usage("component-move requires --design-system <id>");
  }
  return { cmd: command, args: positionals, flags };
}

async function failRevisionConflict(step, r, kind, id) {
  if (r.status !== 409 || r.json?.error?.code !== "revision_conflict") fail(step, r);
  const current = await getMeta(kind, id);
  console.error(`${step} failed (409 revision_conflict); current metadata:`);
  console.error(JSON.stringify(current, null, 2));
  console.error("not retrying automatically; inspect the current revision and run the command again");
  process.exit(1);
}

async function publishComponent(id, rev) {
  const pub = await call("POST", `/components/${id}/publish`, { baseRev: rev });
  if (pub.status !== 201) await failRevisionConflict("publish", pub, "components", id);
  const meta = await getMeta("components", id);
  console.log(`published ${id} version ${pub.json.version} in ${meta.designSystem}`, pub.json.warnings?.length ? pub.json.warnings : "");
}

const { cmd, args, flags } = parseArgs(process.argv.slice(2));

if (cmd === "component") {
  const [id, name, sourcePath] = args;
  const selectedSystem = flags.designSystem ?? process.env.EASYUI_DESIGN_SYSTEM;
  const source = await readFile(sourcePath, "utf8");
  const meta = await getMeta("components", id);
  const systemBody = selectedSystem !== undefined && selectedSystem !== meta?.designSystem
    ? { designSystem: selectedSystem }
    : {};
  const save = meta === null
    ? await call("POST", "/components", { id, name, source, ...systemBody, message: "driver save" })
    : await call("PUT", `/components/${id}`, { source, ...systemBody, message: "driver save", baseRev: meta.headRev });
  if (save.status !== 200 && save.status !== 201) await failRevisionConflict("save", save, "components", id);
  const newRev = save.json.rev;
  const savedMeta = await getMeta("components", id);
  console.log(`saved ${id} rev ${newRev} in ${savedMeta.designSystem}`);
  await publishComponent(id, newRev);
} else if (cmd === "component-move") {
  const [id] = args;
  const meta = await getMeta("components", id);
  if (meta === null) { console.error(`components/${id} not found`); process.exit(1); }
  const save = await call("PUT", `/components/${id}`, {
    designSystem: flags.designSystem,
    message: "driver move",
    baseRev: meta.headRev,
  });
  if (save.status !== 200) await failRevisionConflict("move", save, "components", id);
  const savedMeta = await getMeta("components", id);
  console.log(`saved ${id} rev ${save.json.rev} in ${savedMeta.designSystem}`);
  await publishComponent(id, save.json.rev);
} else if (cmd === "design-system") {
  const [id, name, description] = args;
  const created = await call("POST", "/design-systems", { id, name, description });
  if (created.status === 201) {
    console.log(JSON.stringify(created.json, null, 2));
  } else if (created.status === 409) {
    const existing = await call("GET", `/design-systems/${id}`);
    if (existing.status !== 200) fail(`GET /design-systems/${id}`, existing);
    console.log(JSON.stringify(existing.json, null, 2));
  } else {
    fail("design-system", created);
  }
} else if (cmd === "prototype") {
  const [docPath] = args;
  const doc = JSON.parse(await readFile(docPath, "utf8"));
  const meta = await getMeta("prototypes", doc.id);
  const save = meta === null
    ? await call("POST", "/prototypes", { doc, message: "driver save" })
    : await call("PUT", `/prototypes/${doc.id}`, { doc, message: "driver save", baseRev: meta.headRev });
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
  const meta = await getMeta(kind, id);
  if (meta === null) { console.error(`${kind}/${id} not found`); process.exit(1); }
  const r = await call("DELETE", `/${kind}/${id}`, { baseRev: meta.headRev });
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
}
