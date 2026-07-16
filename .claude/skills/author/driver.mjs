#!/usr/bin/env node
// easy-ui authoring driver. Zero dependencies (Node 18+); `shoot` needs playwright.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = (process.env.EASYUI_API ?? "https://easy-ui.pay-offline.ru/api").replace(/\/$/, "");
const AUTH = process.env.EASYUI_AUTH
  ? `Basic ${Buffer.from(process.env.EASYUI_AUTH).toString("base64")}`
  : null;

export const DESKTOP_VIEWPORT = Object.freeze({ width: 1280, height: 800 });
export const DEVICE_VIEWPORTS = Object.freeze({
  mobile: Object.freeze({ width: 390, height: 844 }),
  tablet: Object.freeze({ width: 834, height: 1112 }),
  desktop: DESKTOP_VIEWPORT,
});
export const MAX_SCREENSHOT_PIXELS = 20_000_000;

const usageLine = "usage: driver.mjs component <id> <Name> <src.tsx> [--design-system <id>] | component-move <id> --design-system <id> | design-system <id> <name> <description> | prototype <doc.json> | catalog <system> [out.json] | diff <protoId> [revA] [revB] [--json] | baseline <protoId> [outDir] [--viewport WxH] [--theme light|dark] [--dsf 1|2|3] | check <protoId> [--threshold N] [--json] | geometry <protoId> <screenId> | get <kind> [id] | delete <kind> <id> | shoot <prototypeId> [outDir] | snap <prototypeId> [outDir] | status <prototypeId> <screenId>";

class CliError extends Error {
  constructor(message, { usage = false } = {}) {
    super(message);
    this.usage = usage;
  }
}

function invalid(message) {
  throw new CliError(message, { usage: true });
}

const viewportFlag = {
  value: true,
  parse(value) {
    const match = /^(\d+)x(\d+)$/i.exec(value);
    if (!match) invalid("--viewport must be WxH");
    return { width: Number(match[1]), height: Number(match[2]) };
  },
};

export const flagSpecs = Object.freeze({
  component: { "--design-system": { value: true, key: "designSystem" } },
  "component-move": { "--design-system": { value: true, key: "designSystem" } },
  diff: { "--json": { value: false, key: "json" } },
  baseline: {
    "--viewport": { ...viewportFlag, key: "viewport" },
    "--theme": { value: true, key: "theme", enum: ["light", "dark"] },
    "--dsf": { value: true, key: "dsf", enum: ["1", "2", "3"], parse: Number },
  },
  check: {
    "--threshold": {
      value: true,
      key: "threshold",
      parse(value) {
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0 || number > 100) invalid("--threshold must be a number from 0 to 100");
        return number;
      },
    },
    "--json": { value: false, key: "json" },
  },
});

const ranges = Object.freeze({
  component: [3, 3],
  "component-move": [1, 1],
  "design-system": [3, 3],
  prototype: [1, 1],
  catalog: [1, 2],
  diff: [1, 3],
  baseline: [1, 2],
  check: [1, 1],
  geometry: [2, 2],
  get: [1, 2],
  delete: [2, 2],
  shoot: [1, 2],
  snap: [1, 2],
  status: [2, 2],
});

export function parseArgs(argv) {
  const [command, ...tokens] = argv;
  const range = ranges[command];
  if (!range) invalid(command ? `unknown command: ${command}` : "command is required");
  const specs = flagSpecs[command] ?? {};
  const positionals = [];
  const flags = {};
  const seen = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const spec = specs[token];
    if (!spec) invalid(`unknown flag for ${command}: ${token}`);
    if (seen.has(token)) invalid(`duplicate flag: ${token}`);
    seen.add(token);
    if (!spec.value) {
      flags[spec.key] = true;
      continue;
    }
    const value = tokens[++i];
    if (value === undefined || value.startsWith("--")) invalid(`flag ${token} requires a value`);
    if (spec.enum && !spec.enum.includes(value)) invalid(`${token} must be one of: ${spec.enum.join(", ")}`);
    flags[spec.key] = spec.parse ? spec.parse(value) : value;
  }
  if (positionals.length < range[0] || positionals.length > range[1]) invalid(`invalid arguments for ${command}`);
  if (command === "component-move" && flags.designSystem === undefined) invalid("component-move requires --design-system <id>");
  return { cmd: command, args: positionals, flags };
}

async function call(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(AUTH ? { authorization: AUTH } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
}

function errorCode(response) {
  return response.json?.error?.code;
}

function requestFailed(step, response) {
  const authHint = response.status === 401 ? "\nhint: set EASYUI_AUTH=user:pass" : "";
  throw new CliError(`${step} failed (${response.status}): ${JSON.stringify(response.json, null, 2)}${authHint}`);
}

async function requireOk(step, response, statuses = [200]) {
  if (!statuses.includes(response.status)) requestFailed(step, response);
  return response.json;
}

async function getMeta(kind, id) {
  const response = await call("GET", `/${kind}/${encodeURIComponent(id)}`);
  if (response.status === 404) return null;
  return requireOk(`GET /${kind}/${id}`, response);
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function pollJob(path, { deadlineMs }) {
  const deadline = Date.now() + deadlineMs;
  while (true) {
    const response = await call("GET", path);
    const state = await requireOk(`poll ${path}`, response);
    if (state.status !== "queued" && state.status !== "running") return state;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { status: "timeout" };
    await delay(Math.min(2000, remaining));
  }
}

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function resolveViewport(screen, override, device = "desktop") {
  if (override) return { width: override.width, height: override.height };
  if (screen?.canvas && Number.isFinite(screen.canvas.width) && Number.isFinite(screen.canvas.height)) {
    return {
      width: clamp(Math.round(screen.canvas.width), 64, 2000),
      height: clamp(Math.round(screen.canvas.height), 64, 4000),
    };
  }
  const canonical = DEVICE_VIEWPORTS[device] ?? DESKTOP_VIEWPORT;
  return { width: canonical.width, height: canonical.height };
}

export function assertViewportPixelBudget(viewport, deviceScaleFactor = 1) {
  const { width, height } = viewport;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || width > 2000 || height < 64 || height > 4000) {
    throw new Error(`invalid viewport ${width}x${height}; expected 64-2000 x 64-4000`);
  }
  if (width * height * deviceScaleFactor ** 2 > MAX_SCREENSHOT_PIXELS) {
    throw new Error(`viewport ${width}x${height} at dsf ${deviceScaleFactor} exceeds 20 Mpx`);
  }
  return viewport;
}

export function buildBaselinePlan(draft, options = {}) {
  const deviceScaleFactor = options.dsf ?? 1;
  const theme = options.theme ?? "light";
  const surfaces = draft.doc.screens.map((screen) => {
    const viewport = resolveViewport(screen, options.viewport, draft.doc.device);
    assertViewportPixelBudget(viewport, deviceScaleFactor);
    return { screenId: screen.id, viewport, deviceScaleFactor, theme };
  });
  return { rev: draft.rev, prototypeInstanceId: draft.prototypeInstanceId, surfaces };
}

export function buildBaselineMembers(surfaces, captures) {
  const byScreen = new Map(captures.map((capture) => [capture.screenId, capture.assetId]));
  return surfaces.map((surface) => {
    const assetId = byScreen.get(surface.screenId);
    if (!assetId) throw new Error(`missing capture for screen ${surface.screenId}`);
    return { ...surface, assetId };
  });
}

function positiveRevision(value, label) {
  if (!/^[1-9]\d*$/.test(String(value))) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}

export function parseDiffArguments(revisionArgs, headRev) {
  const revisions = revisionArgs.map((value, index) => positiveRevision(value, `revision argument ${index + 1}`));
  if (revisions.length > 2) throw new Error("diff accepts at most two revision arguments");
  const toRev = revisions.length === 2 ? revisions[1] : headRev;
  const againstRev = revisions.length ? revisions[0] : headRev - 1;
  if (toRev < 1 || againstRev < 1) throw new Error("revision 1 has no previous revision; pass explicit revisions after creating another revision");
  if (toRev === againstRev) throw new Error("diff revisions must be different");
  return { toRev, againstRev };
}

export const planDiffRevisions = parseDiffArguments;

function compactCatalog(system, manifest) {
  const customKeys = ["id", "name", "version", "atomicLevel", "layoutNeutral", "layout", "description", "events", "eventPayloads", "slots", "example", "examples", "propsJsonSchema"];
  const builtinKeys = ["name", "atomicLevel", "layoutNeutral", "layout", "description", "events", "slots", "propsJsonSchema"];
  const hostKeys = ["name", "atomicLevel", "layoutNeutral", "layout", "description", "events", "slots", "propsJsonSchema"];
  const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
  return {
    designSystem: { id: system.id, name: system.name, description: system.description, resolvedSpaceScale: system.resolvedSpaceScale },
    custom: manifest.components.map((component) => pick(component, customKeys)),
    builtins: system.components.map((component) => pick(component, builtinKeys)),
    hostPrimitives: system.hostPrimitives.map((component) => pick(component, hostKeys)),
  };
}

function diffSummary(diff) {
  const summary = diff.summary;
  return [
    `${diff.prototypeId}: rev ${diff.from.rev} -> ${diff.to.rev}`,
    `screens +${summary.screensAdded} -${summary.screensRemoved} ~${summary.screensChanged}; elements +${summary.staticElementsAdded} -${summary.staticElementsRemoved} ~${summary.staticElementsChanged}`,
    `identical: ${summary.identical ? "yes" : "no"}; document identical: ${summary.docIdentical ? "yes" : "no"}; truncated: ${summary.truncated ? "yes" : "no"}`,
    ...(summary.omittedSections.length ? [`omitted: ${summary.omittedSections.join(", ")}`] : []),
  ].join("\n");
}

function staticFlowDirection(flow, props) {
  if (!flow) return { reason: "flow is not declared" };
  if (typeof flow.direction === "string") return { direction: flow.direction };
  const value = props?.[flow.direction.prop];
  if (value === undefined || (value && typeof value === "object")) return { reason: "flow direction is dynamic or absent" };
  if (flow.direction.vertical?.some((item) => Object.is(item, value))) return { direction: "vertical" };
  if (flow.direction.horizontal?.some((item) => Object.is(item, value))) return { direction: "horizontal" };
  return { reason: "flow direction is unmapped" };
}

/** Pure formatter input used by CLI tests and the geometry command. */
export function analyzeGeometryGaps(screen, definitions, geometry) {
  const elements = screen.spec.elements;
  const rowsByParent = new Map();
  for (const rect of geometry.rects) {
    if (rect.parentKey === undefined) continue;
    const id = `${rect.parentKey}\u0000${rect.parentInstance ?? 0}`;
    const list = rowsByParent.get(id) ?? [];
    list.push(rect);
    rowsByParent.set(id, list);
  }
  return geometry.rects.map((rect) => {
    const element = elements[rect.key];
    const definition = element ? definitions[element.type] : undefined;
    const flow = definition?.layout?.flow;
    const resolved = staticFlowDirection(flow, element?.props);
    let reason = resolved.reason;
    if (!reason && flow.wrap) {
      const wrapValue = element?.props?.[flow.wrap.prop];
      if (wrapValue === undefined || (wrapValue && typeof wrapValue === "object")) reason = "flow wrap is dynamic or absent";
      else if (flow.wrap.enabled.some((item) => Object.is(item, wrapValue))) reason = "flow wrap is enabled";
    }
    const context = rect.layoutContext;
    if (!reason && !context) reason = "layout owner is ambiguous";
    if (!reason && !String(context.display).includes("flex")) reason = `layout owner display is ${context.display || "unknown"}`;
    if (!reason && context.flexWrap !== "nowrap") reason = `layout owner wraps (${context.flexWrap})`;
    const expectedAxis = resolved.direction === "vertical" ? "column" : "row";
    if (!reason && !String(context.flexDirection).startsWith(expectedAxis)) reason = `layout owner direction is ${context.flexDirection}`;
    const childKeys = element?.children ?? [];
    if (!reason && childKeys.some((key) => elements[key]?.repeat)) reason = "repeat in flow group";
    if (!reason && childKeys.some((key) => elements[key]?.slot !== undefined)) reason = "named slots in flow group";
    if (!reason && flow.slot && flow.slot !== "default") reason = "named flow slot";
    const children = (rowsByParent.get(`${rect.key}\u0000${rect.instance}`) ?? []).filter((child) => childKeys.includes(child.key));
    if (!reason && children.length < 2) reason = "fewer than two measured children";
    if (reason) return { key: rect.key, instance: rect.instance, reason, cssGap: null, observed: null };
    const vertical = resolved.direction === "vertical";
    const sorted = [...children].sort((a, b) => vertical ? a.y - b.y : a.x - b.x);
    const observed = sorted.slice(1).map((item, index) => {
      const previous = sorted[index];
      const value = vertical ? item.y - (previous.y + previous.height) : item.x - (previous.x + previous.width);
      return Math.round((value + Number.EPSILON) * 100) / 100;
    });
    return {
      key: rect.key,
      instance: rect.instance,
      reason: null,
      cssGap: { rowGap: context.rowGap, columnGap: context.columnGap },
      observed,
    };
  });
}

async function runGeometry(args) {
  const [id, screenId] = args;
  const encoded = encodeURIComponent(id);
  const draft = await requireOk("draft", await call("GET", `/prototypes/${encoded}/draft`));
  const screen = draft.doc.screens.find((item) => item.id === screenId);
  if (!screen) throw new CliError(`screen ${screenId} not found in ${id}`);
  const viewport = assertViewportPixelBudget(resolveViewport(screen, undefined, draft.doc.device), 1);
  const [system, manifest] = await Promise.all([
    requireOk("design system", await call("GET", `/design-systems/${encodeURIComponent(draft.doc.designSystem)}`)),
    requireOk("catalog manifest", await call("GET", `/catalog/manifest?designSystem=${encodeURIComponent(draft.doc.designSystem)}`)),
  ]);
  const queued = await requireOk("geometry", await call("POST", `/prototypes/${encoded}/screens/${encodeURIComponent(screenId)}/screenshot`, {
    rev: draft.rev, viewport, deviceScaleFactor: 1, theme: "light", waitForFonts: true, probe: "geometry",
  }), [202]);
  const state = await pollJob(`/screenshot-jobs/${encodeURIComponent(queued.jobId)}`, { deadlineMs: 120_000 });
  if (state.status !== "done" || state.result?.kind !== "geometry") throw new CliError(`geometry ${state.status}: ${JSON.stringify(state)}`);
  const definitions = Object.fromEntries([...system.components, ...system.hostPrimitives, ...manifest.components].map((item) => [item.name, item]));
  const gaps = new Map(analyzeGeometryGaps(screen, definitions, state.result).map((item) => [`${item.key}\u0000${item.instance}`, item]));
  console.log(`geometry ${id}/${screenId} rev=${state.result.resolvedRev} viewport=${state.result.viewport.width}x${state.result.viewport.height} dpr=${state.result.dpr} rects=${state.result.rects.length}/${state.result.total}${state.result.truncated ? " truncated" : ""}`);
  for (const rect of state.result.rects) {
    console.log(`${rect.key}#${rect.instance} parent=${rect.parentKey === undefined ? "-" : `${rect.parentKey}#${rect.parentInstance}`} dom=${rect.domIndex} rect=${rect.x},${rect.y} ${rect.width}x${rect.height}${rect.hidden ? " hidden" : ""}`);
    console.log(`  layoutContext: ${rect.layoutContext ? JSON.stringify(rect.layoutContext) : "null"}`);
    const gap = gaps.get(`${rect.key}\u0000${rect.instance}`);
    if (gap?.reason) console.log(`  gaps: n/a (${gap.reason})`);
    else if (gap) console.log(`  CSS gap: row=${gap.cssGap.rowGap} column=${gap.cssGap.columnGap}; observed clearance: ${gap.observed.join(", ")}`);
  }
}

async function downloadImage(imageUrl, outputPath) {
  const url = imageUrl.startsWith("/api/") ? `${API}${imageUrl.slice(4)}` : new URL(imageUrl, `${API}/`).toString();
  const response = await fetch(url, { headers: AUTH ? { authorization: AUTH } : {} });
  if (!response.ok) throw new CliError(`download ${imageUrl} failed (${response.status})`);
  await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
}

async function publishComponent(id, rev) {
  const published = await call("POST", `/components/${encodeURIComponent(id)}/publish`, { baseRev: rev });
  if (published.status !== 201) await failRevisionConflict("publish", published, "components", id);
  const meta = await getMeta("components", id);
  console.log(`published ${id} version ${published.json.version} in ${meta.designSystem}`, published.json.warnings?.length ? published.json.warnings : "");
}

async function failRevisionConflict(step, response, kind, id) {
  if (response.status !== 409 || errorCode(response) !== "revision_conflict") requestFailed(step, response);
  const current = await getMeta(kind, id);
  throw new CliError(`${step} failed (409 revision_conflict); current metadata:\n${JSON.stringify(current, null, 2)}\nnot retrying automatically; inspect the current revision and run the command again`);
}

async function runCatalog(args) {
  const [id, output] = args;
  const encoded = encodeURIComponent(id);
  const [manifest, system] = await Promise.all([
    call("GET", `/catalog/manifest?designSystem=${encoded}`),
    call("GET", `/design-systems/${encoded}`),
  ]);
  if (manifest.status === 404 || system.status === 404) {
    throw new CliError(`design system ${id} not found; hint: run 'driver.mjs get design-systems'`);
  }
  const result = compactCatalog(
    await requireOk(`GET /design-systems/${id}`, system),
    await requireOk(`GET /catalog/manifest?designSystem=${id}`, manifest),
  );
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (output) await writeFile(output, text);
  else process.stdout.write(text);
}

async function runDiff(args, flags) {
  const [id, ...revisionArgs] = args;
  const meta = await getMeta("prototypes", id);
  if (!meta) throw new CliError(`prototypes/${id} not found`);
  let revisions;
  try { revisions = parseDiffArguments(revisionArgs, meta.headRev); }
  catch (error) { throw new CliError(error.message); }
  const response = await call("GET", `/prototypes/${encodeURIComponent(id)}/revisions/${revisions.toRev}/diff?against=${revisions.againstRev}`);
  const result = await requireOk("diff", response);
  console.log(flags.json ? JSON.stringify(result, null, 2) : diffSummary(result));
}

async function runBaseline(args, flags) {
  const [id, outputDir] = args;
  const encoded = encodeURIComponent(id);
  const draftResponse = await call("GET", `/prototypes/${encoded}/draft`);
  const draft = await requireOk("draft", draftResponse);
  let plan;
  try { plan = buildBaselinePlan(draft, flags); }
  catch (error) { throw new CliError(error.message); }
  const baselineResponse = await call("GET", `/visual-baselines/prototypes/${encoded}`);
  let baseGeneration;
  if (baselineResponse.status === 404 && errorCode(baselineResponse) === "baseline_not_found") baseGeneration = null;
  else baseGeneration = (await requireOk("baseline read", baselineResponse)).generation;

  const captures = [];
  for (const surface of plan.surfaces) {
    const queued = await call("POST", `/prototypes/${encoded}/screens/${encodeURIComponent(surface.screenId)}/screenshot`, {
      rev: plan.rev,
      viewport: surface.viewport,
      deviceScaleFactor: surface.deviceScaleFactor,
      theme: surface.theme,
    });
    const job = await requireOk(`screenshot ${surface.screenId}`, queued, [202]);
    const state = await pollJob(`/screenshot-jobs/${encodeURIComponent(job.jobId)}`, { deadlineMs: 120_000 });
    if (state.status !== "done") throw new CliError(`${surface.screenId}: screenshot ${state.status}: ${JSON.stringify(state)}`);
    const browserErrors = [...(state.result.consoleErrors ?? []), ...(state.result.pageErrors ?? [])];
    if (browserErrors.length) throw new CliError(`${surface.screenId}: browser errors abort baseline:\n${browserErrors.join("\n")}`);
    captures.push({ screenId: surface.screenId, assetId: state.result.assetId, imageUrl: state.result.imageUrl });
  }
  const members = buildBaselineMembers(plan.surfaces, captures);
  const committed = await call("PUT", `/visual-baselines/prototypes/${encoded}`, {
    rev: plan.rev,
    prototypeInstanceId: plan.prototypeInstanceId,
    baseGeneration,
    members,
  });
  if (committed.status === 409) {
    const current = await call("GET", `/visual-baselines/prototypes/${encoded}`);
    const snapshot = current.status === 200 ? current.json : current.json?.error;
    throw new CliError(`baseline lost a generation/instance race (${errorCode(committed)}); current state:\n${JSON.stringify(snapshot, null, 2)}\nnot retrying automatically`);
  }
  const result = await requireOk("baseline commit", committed);
  if (outputDir) {
    await mkdir(outputDir, { recursive: true });
    for (const capture of captures) await downloadImage(capture.imageUrl, `${outputDir}/${capture.screenId}.png`);
  }
  for (const member of result.members) console.log(`${member.screenId} -> ${member.referenceId}`);
}

function checkRow(member, baselineRev, run) {
  const candidateRev = run.candidateMeta?.resolvedTarget?.rev ?? run.candidateMeta?.rev ?? "?";
  return {
    screenId: member.screenId,
    status: run.status,
    diffPercent: run.diffPercent,
    revisions: `${baselineRev}->${candidateRev}`,
    diffUrl: run.diff?.url ?? null,
  };
}

async function runCheck(args, flags) {
  const [id] = args;
  const encoded = encodeURIComponent(id);
  const baselineResponse = await call("GET", `/visual-baselines/prototypes/${encoded}`);
  if (baselineResponse.status === 404) {
    throw new CliError(`no visual baseline for ${id}; run baseline first`);
  }
  const baseline = await requireOk("baseline read", baselineResponse);
  const draft = await requireOk("draft", await call("GET", `/prototypes/${encoded}/draft`));
  const rows = [];
  for (const member of baseline.members) {
    const body = { rev: draft.rev, ...(flags.threshold !== undefined ? { threshold: flags.threshold } : {}) };
    const queued = await call("POST", `/visual-references/${encodeURIComponent(member.referenceId)}/check`, body);
    const accepted = await requireOk(`check ${member.screenId}`, queued, [202]);
    const run = await pollJob(`/visual-runs/${encodeURIComponent(accepted.runId)}`, { deadlineMs: 120_000 });
    rows.push(checkRow(member, baseline.rev, run));
  }
  if (flags.json) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log("screenId\tstatus\tdiffPercent\trefRev->candRev\tdiffUrl");
    for (const row of rows) console.log(`${row.screenId}\t${row.status}\t${row.diffPercent ?? "-"}\t${row.revisions}\t${row.diffUrl ?? "-"}`);
  }
  if (rows.some((row) => !["pass"].includes(row.status))) throw new CliError("visual check failed");
}

export async function main(argv = process.argv.slice(2)) {
  const { cmd, args, flags } = parseArgs(argv);
  if (cmd === "component") {
    const [id, name, sourcePath] = args;
    const selectedSystem = flags.designSystem ?? process.env.EASYUI_DESIGN_SYSTEM;
    const source = await readFile(sourcePath, "utf8");
    const meta = await getMeta("components", id);
    const systemBody = selectedSystem !== undefined && selectedSystem !== meta?.designSystem ? { designSystem: selectedSystem } : {};
    const saved = meta === null
      ? await call("POST", "/components", { id, name, source, ...systemBody, message: "driver save" })
      : await call("PUT", `/components/${encodeURIComponent(id)}`, { source, ...systemBody, message: "driver save", baseRev: meta.headRev });
    if (![200, 201].includes(saved.status)) await failRevisionConflict("save", saved, "components", id);
    const savedMeta = await getMeta("components", id);
    console.log(`saved ${id} rev ${saved.json.rev} in ${savedMeta.designSystem}`);
    await publishComponent(id, saved.json.rev);
  } else if (cmd === "component-move") {
    const [id] = args;
    const meta = await getMeta("components", id);
    if (!meta) throw new CliError(`components/${id} not found`);
    const saved = await call("PUT", `/components/${encodeURIComponent(id)}`, { designSystem: flags.designSystem, message: "driver move", baseRev: meta.headRev });
    if (saved.status !== 200) await failRevisionConflict("move", saved, "components", id);
    const savedMeta = await getMeta("components", id);
    console.log(`saved ${id} rev ${saved.json.rev} in ${savedMeta.designSystem}`);
    await publishComponent(id, saved.json.rev);
  } else if (cmd === "design-system") {
    const [id, name, description] = args;
    const created = await call("POST", "/design-systems", { id, name, description });
    if (created.status === 201) console.log(JSON.stringify(created.json, null, 2));
    else if (created.status === 409) console.log(JSON.stringify(await requireOk("design-system", await call("GET", `/design-systems/${encodeURIComponent(id)}`)), null, 2));
    else requestFailed("design-system", created);
  } else if (cmd === "prototype") {
    const doc = JSON.parse(await readFile(args[0], "utf8"));
    const meta = await getMeta("prototypes", doc.id);
    const saved = meta === null
      ? await call("POST", "/prototypes", { doc, message: "driver save" })
      : await call("PUT", `/prototypes/${encodeURIComponent(doc.id)}`, { doc, message: "driver save", baseRev: meta.headRev });
    const result = await requireOk("save", saved, [200, 201]);
    console.log(`saved ${doc.id} rev ${result.rev}`, result.warnings?.length ? result.warnings : "");
    const draft = await requireOk("draft", await call("GET", `/prototypes/${encodeURIComponent(doc.id)}/draft`));
    console.log("component pins:", JSON.stringify(draft.components));
    const base = API.replace(/\/api$/, "");
    console.log(`player: ${base}/p/${doc.id}`);
    for (const screen of result.screens ?? []) console.log(`screen:  ${base}${screen.url}`);
  } else if (cmd === "catalog") await runCatalog(args);
  else if (cmd === "diff") await runDiff(args, flags);
  else if (cmd === "baseline") await runBaseline(args, flags);
  else if (cmd === "check") await runCheck(args, flags);
  else if (cmd === "geometry") await runGeometry(args);
  else if (cmd === "get") {
    const [kind, id] = args;
    const path = kind === "assets" && id ? `/assets/${encodeURIComponent(id)}/usage` : id ? `/${kind}/${encodeURIComponent(id)}` : `/${kind}`;
    console.log(JSON.stringify(await requireOk("get", await call("GET", path)), null, 2));
  } else if (cmd === "delete") {
    const [kind, id] = args;
    const meta = await getMeta(kind, id);
    if (!meta) throw new CliError(`${kind}/${id} not found`);
    await requireOk("delete", await call("DELETE", `/${kind}/${encodeURIComponent(id)}`, { baseRev: meta.headRev }), [204]);
    console.log(`deleted ${kind}/${id}`);
  } else if (cmd === "shoot") {
    const [id, outputDir = `author-shots/${id}`] = args;
    const draft = await requireOk("draft", await call("GET", `/prototypes/${encodeURIComponent(id)}/draft`));
    await mkdir(outputDir, { recursive: true });
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    const [user, ...password] = (process.env.EASYUI_AUTH ?? "").split(":");
    const page = await browser.newPage({ viewport: { width: 480, height: 800 }, ...(AUTH ? { httpCredentials: { username: user, password: password.join(":") } } : {}) });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    const base = API.replace(/\/api$/, "");
    for (const screen of draft.doc.screens) {
      await page.goto(`${base}/p/${id}/s/${screen.id}`, { waitUntil: "networkidle" });
      await page.screenshot({ path: `${outputDir}/${screen.id}.png` });
      console.log(`${outputDir}/${screen.id}.png`);
    }
    await browser.close();
    if (errors.length) throw new CliError(`browser errors:\n${errors.join("\n")}`);
  } else if (cmd === "snap") {
    const [id, outputDir = `author-shots/${id}`] = args;
    const draft = await requireOk("draft", await call("GET", `/prototypes/${encodeURIComponent(id)}/draft`));
    await mkdir(outputDir, { recursive: true });
    let hadErrors = false;
    for (const screen of draft.doc.screens) {
      const queued = await requireOk(`screenshot ${screen.id}`, await call("POST", `/prototypes/${encodeURIComponent(id)}/screens/${encodeURIComponent(screen.id)}/screenshot`, { viewport: { width: 480, height: 800 } }), [202]);
      const state = await pollJob(`/screenshot-jobs/${encodeURIComponent(queued.jobId)}`, { deadlineMs: 60_000 });
      if (state.status !== "done") { console.error(`${screen.id}: ${JSON.stringify(state)}`); hadErrors = true; continue; }
      await downloadImage(state.result.imageUrl, `${outputDir}/${screen.id}.png`);
      console.log(`${outputDir}/${screen.id}.png`);
      const errors = [...(state.result.consoleErrors ?? []), ...(state.result.pageErrors ?? [])];
      if (errors.length) { console.error(`${screen.id} browser errors:`, JSON.stringify(errors)); hadErrors = true; }
    }
    if (hadErrors) throw new CliError("one or more screenshots failed");
  } else if (cmd === "status") {
    const [id, screenId] = args;
    const result = await requireOk("render-status", await call("GET", `/prototypes/${encodeURIComponent(id)}/screens/${encodeURIComponent(screenId)}/render-status`));
    console.log(JSON.stringify(result, null, 2));
    if (!result.renderable) throw new CliError("prototype screen is not renderable");
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    if (error?.usage) console.error(usageLine);
    process.exitCode = 1;
  });
}
