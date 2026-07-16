#!/usr/bin/env node
/* global URL, process, setTimeout */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEasyUiClient } from "./easyui-auth.mjs";

const API = (process.env.EASYUI_API ?? "http://127.0.0.1:8791/api").replace(/\/$/, "");
const apiUrl = new URL(API);
if (apiUrl.hostname === "easy-ui.pay-offline.ru") throw new Error("W6 harness refuses to mutate the production easy-ui host");

const client = createEasyUiClient({ apiBase: API });
const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = resolve(HERE, "../.claude/skills/author/examples");
const SPACE = Object.freeze({ none: "0px", xs: "4px", sm: "8px", md: "12px", lg: "16px", xl: "24px", "2xl": "32px", "3xl": "48px", "4xl": "64px" });

let currentStep = "startup";
const pass = (name, detail = "") => console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
const fail = (message) => { throw new Error(message); };
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

async function call(method, path, body) {
  const response = await client.request(path, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
}

function requireStatus(label, response, statuses = [200]) {
  if (!statuses.includes(response.status)) fail(`${label} returned ${response.status}: ${JSON.stringify(response.json)}`);
  return response.json;
}

async function readExample(name) {
  return readFile(resolve(EXAMPLES, name), "utf8");
}

async function ensureDesignSystem() {
  let response = await call("GET", "/design-systems/yandex-pay");
  if (response.status === 404) {
    response = await call("POST", "/design-systems", { id: "yandex-pay", name: "Yandex Pay", description: "W6 layout conformance design system" });
    requireStatus("create design system", response, [201]);
  } else requireStatus("read design system", response);
  pass("design-system", "yandex-pay is registered");

  let system = requireStatus("read design system", await call("GET", "/design-systems/yandex-pay"));
  const matches = Object.entries(SPACE).every(([token, value]) => system.tokens?.[`space.${token}`] === value);
  if (!matches) {
    const tokens = Object.fromEntries(Object.entries(SPACE).map(([token, value]) => [`space.${token}`, value]));
    system = requireStatus("patch spacing theme", await call("PATCH", "/design-systems/yandex-pay", { baseVersion: system.latestMetaVersion ?? 0, tokens }));
  }
  if (!equal(system.resolvedSpaceScale, SPACE)) fail(`resolved spacing scale mismatch: ${JSON.stringify(system.resolvedSpaceScale)}`);
  pass("theme-space-scale", `v${system.latestMetaVersion}: ${Object.values(SPACE).join("/")}`);
}

async function ensureComponent({ id, name, file }) {
  const source = await readExample(file);
  let metaResponse = await call("GET", `/components/${id}`);
  let rev;
  if (metaResponse.status === 404) {
    const created = requireStatus(`create ${id}`, await call("POST", "/components", { id, name, source, designSystem: "yandex-pay", message: "W6 fixture" }), [201]);
    rev = created.rev;
  } else {
    const meta = requireStatus(`read ${id}`, metaResponse);
    const draft = requireStatus(`read ${id} source`, await call("GET", `/components/${id}/source`));
    if (draft.source !== source || meta.designSystem !== "yandex-pay") {
      const saved = requireStatus(`update ${id}`, await call("PUT", `/components/${id}`, { baseRev: meta.headRev, source, designSystem: "yandex-pay", message: "W6 fixture" }));
      rev = saved.rev;
    } else rev = draft.rev;
  }

  const versions = requireStatus(`list ${id} versions`, await call("GET", `/components/${id}/versions`));
  let active = versions.find((version) => version.rev === rev && version.status === "active");
  if (!active) {
    const published = requireStatus(`publish ${id}`, await call("POST", `/components/${id}/publish`, { baseRev: rev, message: "W6 fixture" }), [201]);
    active = { version: published.version, hostAbiVersion: published.hostAbiVersion };
  }
  const version = requireStatus(`read ${id} version`, await call("GET", `/components/${id}/versions/${active.version}`));
  pass(`component-${id}`, `v${active.version}, ABI ${version.hostAbiVersion}`);
}

async function saveFixture(file) {
  const doc = JSON.parse(await readExample(file));
  let meta = await call("GET", `/prototypes/${doc.id}`);
  let warnings;
  if (meta.status === 404) {
    warnings = requireStatus(`create ${doc.id}`, await call("POST", "/prototypes", { doc, message: "W6 fixture" }), [201]).warnings;
  } else {
    meta = requireStatus(`read ${doc.id}`, meta);
    // Re-save deliberately: the save response is the public API surface that carries
    // current semantic/layout warnings. Re-running remains create-or-update safe.
    warnings = requireStatus(`update ${doc.id}`, await call("PUT", `/prototypes/${doc.id}`, { baseRev: meta.headRev, doc, message: "W6 fixture" })).warnings;
  }
  pass(`fixture-${doc.id}`, `saved; ${warnings.length} warning(s)`);
  return { doc, warnings };
}

const layoutCodes = (warnings) => [...new Set(warnings.map((warning) => warning.code).filter((code) => typeof code === "string" && code.startsWith("layout/")))].sort();

async function pollJob(jobId) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const job = requireStatus("poll screenshot", await call("GET", `/screenshot-jobs/${jobId}`));
    if (job.status === "done") return job.result;
    if (job.status === "error") fail(`screenshot failed: ${JSON.stringify(job.error)}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  fail("screenshot timed out");
}

async function screenshot(prototypeId, screenId, extra = {}) {
  const queued = requireStatus("queue screenshot", await call("POST", `/prototypes/${prototypeId}/screens/${screenId}/screenshot`, {
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, theme: "light", waitForFonts: true, ...extra,
  }), [202]);
  return pollJob(queued.jobId);
}

function rect(result, key) {
  const found = result.rects.find((item) => item.key === key && item.instance === 0);
  if (!found) fail(`geometry is missing ${key}#0`);
  return found;
}

function clearance(parent, first, second, direction) {
  if (direction === "vertical") return second.y - (first.y + first.height);
  return second.x - (first.x + first.width);
}

async function run() {
  currentStep = "health";
  requireStatus("health", await call("GET", "/health"));
  pass("health", API);

  currentStep = "design-system";
  await ensureDesignSystem();

  currentStep = "components";
  await ensureComponent({ id: "yp-box", name: "YpBox", file: "yp-box.tsx" });
  await ensureComponent({ id: "yp-block", name: "YpBlock", file: "yp-block.tsx" });
  await ensureComponent({ id: "yp-spacer", name: "YpSpacer", file: "yp-spacer.tsx" });

  currentStep = "composed-fixtures";
  const before = await saveFixture("yp-spacing-before.json");
  const after = await saveFixture("yp-spacing-after.json");
  const expectedBefore = ["layout/default-props-noise", "layout/legacy-numeric-spacing", "layout/spacer-chain", "layout/spacer-heavy", "layout/spacer-vs-gap"];
  const beforeCodes = layoutCodes(before.warnings);
  if (!equal(beforeCodes, expectedBefore)) fail(`before layout warnings ${JSON.stringify(beforeCodes)} != ${JSON.stringify(expectedBefore)}`);
  pass("before-layout-warnings", beforeCodes.join(", "));
  const afterCodes = layoutCodes(after.warnings);
  if (afterCodes.length) fail(`after fixture has layout warnings: ${JSON.stringify(afterCodes)}`);
  pass("after-layout-warnings", "none");

  currentStep = "default-pixel-equivalence";
  const defaults = await saveFixture("yp-box-defaults-conformance.json");
  const omitted = await screenshot(defaults.doc.id, "omitted");
  const explicit = await screenshot(defaults.doc.id, "explicit");
  if (omitted.kind !== "image" || explicit.kind !== "image") fail("default conformance did not return image results");
  const browserErrors = [...(omitted.consoleErrors ?? []), ...(omitted.pageErrors ?? []), ...(explicit.consoleErrors ?? []), ...(explicit.pageErrors ?? [])];
  if (browserErrors.length) fail(`default screenshots emitted browser errors: ${JSON.stringify(browserErrors)}`);
  if (omitted.assetId !== explicit.assetId) fail(`default screenshots differ: ${omitted.assetId} != ${explicit.assetId}`);
  pass("yp-box-default-pixels", `${omitted.assetId} ({} == explicit defaults)`);

  currentStep = "geometry";
  const geometry = await screenshot(after.doc.id, "main", { probe: "geometry" });
  if (geometry.kind !== "geometry") fail(`expected geometry result, got ${geometry.kind}`);
  if (!equal(geometry.resolvedSpaceScale, SPACE)) fail(`geometry resolved scale mismatch: ${JSON.stringify(geometry.resolvedSpaceScale)}`);
  const root = rect(geometry, "root");
  const panelA = rect(geometry, "panel-a");
  const nested = rect(geometry, "nested");
  const panelB = rect(geometry, "panel-b");
  const panelC = rect(geometry, "panel-c");
  const rootGap = clearance(root, panelA, nested, "vertical");
  const nestedGap = clearance(nested, panelB, panelC, "horizontal");
  const padding = { inlineStart: panelA.x - root.x, blockStart: panelA.y - root.y, inlineEnd: root.x + root.width - (nested.x + nested.width), blockEnd: root.y + root.height - (nested.y + nested.height) };
  if (rootGap !== 12 || nestedGap !== 8) fail(`unexpected observed gaps: root=${rootGap}, nested=${nestedGap}`);
  if (!equal(padding, { inlineStart: 16, blockStart: 8, inlineEnd: 16, blockEnd: 8 })) fail(`padding override geometry mismatch: ${JSON.stringify(padding)}`);
  if (panelA.height !== 16 || panelB.height !== 16 || panelC.height !== 16) fail(`YpBlock padding geometry mismatch: ${panelA.height}/${panelB.height}/${panelC.height}`);
  if (root.layoutContext?.rowGap !== "12px" || nested.layoutContext?.columnGap !== "8px") fail(`computed CSS gaps mismatch: root=${JSON.stringify(root.layoutContext)}, nested=${JSON.stringify(nested.layoutContext)}`);
  pass("geometry-resolved-scale", JSON.stringify(geometry.resolvedSpaceScale));
  pass("geometry-gap", `root md=${rootGap}px; nested sm=${nestedGap}px`);
  pass("geometry-padding", `paddingX lg=16px overrides xl; paddingY sm=8px overrides xl; YpBlock sm=8px/side`);
}

run().catch((error) => {
  console.error(`FAIL ${currentStep} — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
