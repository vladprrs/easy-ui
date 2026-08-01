#!/usr/bin/env node
// easy-ui authoring driver. Zero dependencies (Node 18+); `shoot` needs playwright.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEasyUiClient } from "../../../scripts/easyui-auth.mjs";

const API = (process.env.EASYUI_API ?? "https://easy-ui.pay-offline.ru/api").replace(/\/$/, "");
const client = createEasyUiClient({ apiBase: API });

export const DESKTOP_VIEWPORT = Object.freeze({ width: 1280, height: 800 });
export const DEVICE_VIEWPORTS = Object.freeze({
  mobile: Object.freeze({ width: 390, height: 844 }),
  tablet: Object.freeze({ width: 834, height: 1112 }),
  desktop: DESKTOP_VIEWPORT,
});
export const MAX_SCREENSHOT_PIXELS = 20_000_000;

const usageLine = "usage: driver.mjs component <id> <Name> <src.tsx> [--design-system <id>] [--intent <text>] [--figma <figma.json>] [--force-new --reason <text>] | component-move <id> --design-system <id> | composition <id> <doc.json> --design-system <id> | composition publish <id> | design-system <id> <name> <description> | prototype <doc.json> | catalog <system> [out.json] [--full] | catalog list <system> | catalog search <system> --intent <text> [--limit N] | catalog get <system> <artifact...> | diff <protoId> [revA] [revB] | baseline <protoId> [outDir] [--viewport WxH] [--theme light|dark] [--dsf 1|2|3] | check <protoId> [--threshold N] | geometry <protoId> <screenId> | get <kind> [id] | delete <kind> <id> (prototypes/components/compositions/design-systems; design-system → ретайр) | shoot <prototypeId> [outDir] | snap <prototypeId> [outDir] [--all-screens] [--viewport WxH] [--theme light|dark] [--dsf 1|2|3] | status <prototypeId> [screenId] [--all-screens] | readiness <protoId> | publish <protoId> [--verify] [--force] | usages <componentId> [--tree] | audit --design-system <id> | audit reuse [--design-system <id>] [--actor <id>] [--since <iso>] [--limit N] [--min-attempts N]\nevery verb accepts --json; snap exits 0 (PNG, no product errors), 2 (PNG + product errors), 1 (no PNG); readiness/publish/audit and terminal reuse STOPs exit 2 on product-level failure";

/** Exit codes are part of the CLI contract: 0 ok, 2 product errors with an artifact, 1 everything else. */
export const EXIT = Object.freeze({ ok: 0, failed: 1, productErrors: 2 });

class CliError extends Error {
  constructor(message, { usage = false, exitCode = EXIT.failed } = {}) {
    super(message);
    this.usage = usage;
    this.exitCode = exitCode;
  }
}

let jsonMode = false;
/** Human line printed only outside --json; JSON mode owns stdout entirely. */
const out = (line) => { if (!jsonMode) console.log(line); };
/** Terminal output of a verb: a JSON document in --json mode, human lines otherwise. */
function report(lines, payload) {
  if (jsonMode) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else for (const line of [lines].flat()) console.log(line);
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

/** Один разбор поверхности съёмки на все команды, снимающие экраны (baseline и snap). */
const surfaceFlags = {
  "--viewport": { ...viewportFlag, key: "viewport" },
  "--theme": { value: true, key: "theme", enum: ["light", "dark"] },
  "--dsf": { value: true, key: "dsf", enum: ["1", "2", "3"], parse: Number },
};

const jsonFlag = { "--json": { value: false, key: "json" } };
const allScreensFlag = { "--all-screens": { value: false, key: "allScreens" } };
const catalogLimitFlag = {
  value: true,
  key: "limit",
  parse(value) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 20) invalid("--limit must be an integer from 1 to 20");
    return number;
  },
};

/** Секции аудита длиннее каталожных выборок: потолок сервера — 1000 на секцию. */
const auditLimitFlag = {
  value: true,
  key: "limit",
  parse(value) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 1000) invalid("--limit must be an integer from 1 to 1000");
    return number;
  },
};

export const flagSpecs = Object.freeze({
  component: {
    ...jsonFlag,
    "--design-system": { value: true, key: "designSystem" },
    "--intent": { value: true, key: "intent" },
    "--force-new": { value: false, key: "forceNew" },
    "--reason": { value: true, key: "reason" },
    // Provenance не наследуется ревизией: файл передаётся при каждом вызове (план §T2, M8).
    "--figma": { value: true, key: "figma" },
  },
  "component-move": { ...jsonFlag, "--design-system": { value: true, key: "designSystem" } },
  composition: { ...jsonFlag, "--design-system": { value: true, key: "designSystem" } },
  "composition publish": { ...jsonFlag },
  "design-system": { ...jsonFlag },
  prototype: { ...jsonFlag },
  catalog: { ...jsonFlag, "--full": { value: false, key: "full" } },
  "catalog list": { ...jsonFlag },
  "catalog search": { ...jsonFlag, "--intent": { value: true, key: "intent" }, "--limit": catalogLimitFlag },
  "catalog get": { ...jsonFlag },
  diff: { ...jsonFlag },
  baseline: { ...jsonFlag, ...surfaceFlags },
  check: {
    ...jsonFlag,
    "--threshold": {
      value: true,
      key: "threshold",
      parse(value) {
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0 || number > 100) invalid("--threshold must be a number from 0 to 100");
        return number;
      },
    },
  },
  geometry: { ...jsonFlag },
  get: { ...jsonFlag },
  delete: { ...jsonFlag },
  shoot: { ...jsonFlag },
  snap: { ...jsonFlag, ...allScreensFlag, ...surfaceFlags },
  status: { ...jsonFlag, ...allScreensFlag },
  readiness: { ...jsonFlag },
  publish: { ...jsonFlag, "--verify": { value: false, key: "verify" }, "--force": { value: false, key: "force" } },
  usages: { ...jsonFlag, "--tree": { value: false, key: "tree" } },
  audit: { ...jsonFlag, "--design-system": { value: true, key: "designSystem" } },
  "audit reuse": {
    ...jsonFlag,
    "--design-system": { value: true, key: "designSystem" },
    "--actor": { value: true, key: "actor" },
    "--since": { value: true, key: "since" },
    "--limit": auditLimitFlag,
    "--min-attempts": {
      value: true,
      key: "minAttempts",
      parse(value) {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 2 || number > 50) invalid("--min-attempts must be an integer from 2 to 50");
        return number;
      },
    },
  },
});

const ranges = Object.freeze({
  component: [3, 3],
  "component-move": [1, 1],
  composition: [2, 2],
  "design-system": [3, 3],
  prototype: [1, 1],
  catalog: [1, Infinity],
  diff: [1, 3],
  baseline: [1, 2],
  check: [1, 1],
  geometry: [2, 2],
  get: [1, 2],
  delete: [2, 2],
  shoot: [1, 2],
  snap: [1, 2],
  status: [1, 2],
  readiness: [1, 1],
  publish: [1, 1],
  usages: [1, 1],
  // 0 — каталожный sweep `audit --design-system`, 1 — подкоманда `audit reuse`.
  audit: [0, 1],
});

export function parseArgs(argv) {
  const [command, ...tokens] = argv;
  const range = ranges[command];
  if (!range) invalid(command ? `unknown command: ${command}` : "command is required");
  const firstPositional = (valueFlags) => {
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (!token.startsWith("--")) return token;
      if (valueFlags.has(token)) index += 1;
    }
    return null;
  };
  const catalogFirst = command === "catalog" ? firstPositional(new Set(["--intent", "--limit"])) : null;
  const compositionFirst = command === "composition" ? firstPositional(new Set(["--design-system"])) : null;
  // `audit reuse` — чтение аудита гейта; у него собственный набор флагов, поэтому подкоманда
  // распознаётся до разбора флагов, как у `catalog list|search|get`.
  const auditFirst = command === "audit" ? firstPositional(new Set(["--design-system", "--actor", "--since", "--limit", "--min-attempts"])) : null;
  const catalogSubcommand = ["list", "search", "get"].includes(catalogFirst) ? catalogFirst : null;
  const compositionSubcommand = compositionFirst === "publish" ? "publish" : null;
  const auditSubcommand = auditFirst === "reuse" ? "reuse" : null;
  const commandForm = catalogSubcommand ? `catalog ${catalogSubcommand}`
    : compositionSubcommand ? "composition publish"
    : auditSubcommand ? "audit reuse"
    : command;
  const specs = flagSpecs[commandForm] ?? {};
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
    if (!spec) invalid(`unknown flag for ${commandForm}: ${token}`);
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
  if (positionals.length < range[0] || positionals.length > range[1]) invalid(`invalid arguments for ${commandForm}`);
  if (commandForm === "catalog list" && positionals.length !== 2) invalid("invalid arguments for catalog list");
  if (commandForm === "catalog search") {
    if (positionals.length !== 2) invalid("invalid arguments for catalog search");
    if (flags.intent === undefined) invalid("catalog search requires --intent <text>");
  }
  if (commandForm === "catalog get" && positionals.length < 3) invalid("catalog get requires at least one artifact");
  if (commandForm === "catalog" && positionals.length > 2) invalid("invalid arguments for catalog");
  if (command === "component-move" && flags.designSystem === undefined) invalid("component-move requires --design-system <id>");
  if (command === "component" && flags.forceNew && flags.reason === undefined) invalid("component --force-new requires --reason <text>");
  if (commandForm === "composition" && flags.designSystem === undefined) invalid("composition requires --design-system <id>");
  if (commandForm === "audit reuse" && positionals.length !== 1) invalid("invalid arguments for audit reuse");
  // `--design-system` обязателен только у каталожного sweep: аудит гейта по построению
  // сквозной, дизайн-система в нём — необязательный фильтр.
  if (commandForm === "audit" && flags.designSystem === undefined) invalid("audit requires --design-system <id>");
  if (commandForm === "audit" && positionals.length !== 0) invalid("invalid arguments for audit");
  if (command === "status" && positionals.length < 2 && !flags.allScreens) invalid("status requires <screenId> or --all-screens");
  return { cmd: command, args: positionals, flags };
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Retries only transient server-side failures; the auth session is minted once per process. */
export const RETRY_BACKOFF_MS = [500, 1500];
const isTransient = (status) => status >= 500;

async function call(method, path, body, options = {}) {
  // Reads are retried by default; writes only when the caller opts in (snap enqueue).
  const retries = options.retries ?? (method === "GET" ? RETRY_BACKOFF_MS.length : 0);
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await delay(RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)]);
    let response;
    try {
      response = await client.request(path, {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      lastError = error;
      if (attempt === retries) throw error;
      continue;
    }
    const text = await response.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (isTransient(response.status) && attempt < retries) continue;
    return { status: response.status, json };
  }
  throw lastError;
}

function errorCode(response) {
  return response.json?.error?.code;
}

function requestFailed(step, response) {
  const authHint = response.status === 401 ? "\nhint: set EASYUI_USERNAME/EASYUI_PASSWORD and, during the transition, EASYUI_LEGACY_BASIC_AUTH" : "";
  throw new CliError(`${step} failed (${response.status}): ${JSON.stringify(response.json, null, 2)}${authHint}`);
}

async function requireOk(step, response, statuses = [200]) {
  if (!statuses.includes(response.status)) requestFailed(step, response);
  return response.json;
}

/**
 * REST-коллекции всегда во множественном числе, а руки набирают единственное. Раньше `kind`
 * уходил в путь как есть, и `delete component <id>` бился о `/api/component/<id>` → 404 с
 * диагностикой «component/<id> not found», врущей про существование ресурса. Алиасы
 * нормализуют форму; неизвестный kind диагностируется отдельно, а не через ложный 404.
 */
const COLLECTION_ALIASES = Object.freeze({
  prototype: "prototypes",
  component: "components",
  composition: "compositions",
  "design-system": "design-systems",
  asset: "assets",
});
const resolveCollection = (kind) => COLLECTION_ALIASES[kind] ?? kind;

/**
 * Что и как удаляется. `revisioned` — ресурсы с CAS по headRev; дизайн-система версий тела
 * не имеет: DELETE её ретайрит (retired=1) без тела запроса.
 */
const DELETABLE = Object.freeze({
  prototypes: { revisioned: true, verb: "deleted" },
  components: { revisioned: true, verb: "deleted" },
  compositions: { revisioned: true, verb: "deleted" },
  "design-systems": { revisioned: false, verb: "retired" },
});

async function getMeta(kind, id) {
  const response = await call("GET", `/${kind}/${encodeURIComponent(id)}`);
  if (response.status === 404) return null;
  return requireOk(`GET /${kind}/${id}`, response);
}

/**
 * `--figma <path>` — тело provenance для create/update компонента одной ревизией с source.
 * Отсутствующий или не-JSON файл — ошибка аргументов (exit 1), а не сырой ENOENT.
 */
async function readFigmaProvenance(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    invalid(`--figma file cannot be read: ${path} (${error.code ?? error.message})`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    invalid(`--figma file is not valid JSON: ${path} (${error.message})`);
  }
}

async function discoverComponent({ id, name, source, designSystem, intent }) {
  return requireOk("catalog search", await call("POST", "/catalog/candidates", {
    designSystem,
    intent,
    proposed: { kind: "component", id, name, source },
  }));
}

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

/**
 * Поверхность съёмки экрана — то, что реально попадает в PNG: canvas-стикершит снимается
 * целиком (вьюпорт влияет только на media queries), flow-экран — по каноническому вьюпорту
 * устройства. Не путать с `resolveViewport`: тот клампит canvas до лимитов вьюпорта.
 */
export function captureSurface(screen, device = "desktop") {
  const canvas = screen?.canvas;
  if (canvas && Number.isFinite(canvas.width) && Number.isFinite(canvas.height)) {
    return { width: Math.round(canvas.width), height: Math.round(canvas.height) };
  }
  const canonical = DEVICE_VIEWPORTS[device] ?? DESKTOP_VIEWPORT;
  return { width: canonical.width, height: canonical.height };
}

/** Лимит ингеста ассетов (server/assets/validate.ts MAX_ASSET_PIXELS): PNG больше — 413. */
export const MAX_ASSET_PIXELS = 16 * 1024 * 1024;

/** PNG = поверхность × dsf по обеим осям; проверяется до постановки задания в очередь. */
export function assertCaptureSurfaceBudget(surface, deviceScaleFactor = 1) {
  const pixels = surface.width * surface.height * deviceScaleFactor ** 2;
  if (pixels > MAX_ASSET_PIXELS) {
    throw new Error(`capture surface ${surface.width}x${surface.height} at dsf ${deviceScaleFactor} produces ${pixels} px, above the ${MAX_ASSET_PIXELS} px asset ingest limit`);
  }
  return surface;
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

function fullCatalog(system, manifest) {
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

function compactCatalog(system, manifest) {
  const custom = (manifest.components ?? []).map((component) => ({
    id: component.id,
    name: component.name,
    version: component.version,
    ...(component.atomicLevel === undefined ? {} : { atomicLevel: component.atomicLevel }),
    description: component.description ?? "",
    events: component.events ?? [],
    slots: component.slots ?? [],
    deprecated: component.deprecated === true,
  }));
  const compactDefinition = (component) => ({
    name: component.name,
    ...(component.atomicLevel === undefined ? {} : { atomicLevel: component.atomicLevel }),
    description: component.description ?? "",
    events: component.events ?? [],
    slots: component.slots ?? [],
  });
  return {
    designSystem: { id: system.id, name: system.name, description: system.description, resolvedSpaceScale: system.resolvedSpaceScale },
    custom,
    builtins: (system.components ?? []).map(compactDefinition),
    hostPrimitives: (system.hostPrimitives ?? []).map(compactDefinition),
  };
}

function catalogListLines(result) {
  const rows = [
    ...result.custom.map((item) => ({ kind: "custom", ...item })),
    ...result.builtins.map((item) => ({ kind: "builtin", ...item })),
    ...result.hostPrimitives.map((item) => ({ kind: "host", ...item })),
  ];
  return [
    `catalog ${result.designSystem.id}: ${rows.length} artifacts; use 'catalog get ${result.designSystem.id} <artifact...>' for full definitions`,
    "kind\tid\tname\tversion\tatomicLevel\tdeprecated\tevents\tslots\tdescription",
    ...rows.map((row) => `${row.kind}\t${row.id ?? row.name}\t${row.name}\t${row.version ?? "-"}\t${row.atomicLevel ?? "-"}\t${row.deprecated === undefined ? "-" : row.deprecated ? "yes" : "no"}\t${row.events.join(",") || "-"}\t${row.slots.join(",") || "-"}\t${row.description}`),
  ];
}

function catalogSearchLines(result) {
  return [
    `catalog search ${result.designSystem}: ${result.candidates.length} candidates at ${result.catalogRevision}`,
    "id\tname\tversion\tscore\tblocking\tdeprecated\treasons",
    ...result.candidates.map((candidate) => `${candidate.id}\t${candidate.name}\t${candidate.version || "draft"}\t${candidate.score}\t${candidate.blocking ? "yes" : "no"}\t${candidate.deprecated ? "yes" : "no"}\t${candidate.reasons.join("; ")}`),
  ];
}

function catalogGetLines(designSystem, artifacts) {
  return [
    `catalog get ${designSystem}: ${artifacts.length} artifacts`,
    ...artifacts.flatMap((artifact) => [`${artifact.kind} ${artifact.id ?? artifact.name} (${artifact.name})`, JSON.stringify(artifact.details, null, 2)]),
  ];
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

const formatRect = (rect) => (rect ? `${rect.x},${rect.y} ${rect.width}x${rect.height}` : "-");

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
  const gapRows = analyzeGeometryGaps(screen, definitions, state.result);
  const gaps = new Map(gapRows.map((item) => [`${item.key}\u0000${item.instance}`, item]));
  out(`geometry ${id}/${screenId} rev=${state.result.resolvedRev} viewport=${state.result.viewport.width}x${state.result.viewport.height} dpr=${state.result.dpr} rects=${state.result.rects.length}/${state.result.total}${state.result.truncated ? " truncated" : ""}`);
  const safeArea = state.result.safeArea;
  if (safeArea) out(`safeArea: top=${safeArea.top} right=${safeArea.right} bottom=${safeArea.bottom} left=${safeArea.left}`);
  for (const [role, rect] of Object.entries(state.result.roleRects ?? {})) out(`role ${role}: ${formatRect(rect)} (${rect.source})`);
  const ownership = state.result.viewportOwnership;
  if (ownership) {
    out(`viewportOwnership: frame=${ownership.frame ? `${ownership.frame.width}x${ownership.frame.height}` : "-"} scrollable=${ownership.scrollable} unowned=${ownership.unownedPct}%`);
    for (const owner of ownership.owners) out(`  owner ${owner.role}: area=${owner.areaPct}% height=${owner.heightPct}%`);
  }
  for (const issue of state.result.issues ?? []) out(`issue ${issue.severity} ${issue.code}: ${issue.message}`);
  for (const rect of state.result.rects) {
    out(`${rect.key}#${rect.instance} parent=${rect.parentKey === undefined ? "-" : `${rect.parentKey}#${rect.parentInstance}`} dom=${rect.domIndex} rect=${rect.x},${rect.y} ${rect.width}x${rect.height}${rect.hidden ? " hidden" : ""}`);
    out(`  layoutContext: ${rect.layoutContext ? JSON.stringify(rect.layoutContext) : "null"}`);
    const gap = gaps.get(`${rect.key}\u0000${rect.instance}`);
    if (gap?.reason) out(`  gaps: n/a (${gap.reason})`);
    else if (gap) out(`  CSS gap: row=${gap.cssGap.rowGap} column=${gap.cssGap.columnGap}; observed clearance: ${gap.observed.join(", ")}`);
  }
  if (jsonMode) report(null, { command: "geometry", prototypeId: id, screenId, ...state.result, gaps: gapRows });
}

/**
 * Normalizes a screenshot job result into the 7.1 capture contract. Servers
 * older than wave 7.1 do not classify errors, so their raw console/page errors
 * are treated as product errors — the previous, stricter behaviour.
 */
export function summarizeCapture(result) {
  const raw = [...(result?.consoleErrors ?? []), ...(result?.pageErrors ?? [])];
  const classified = Array.isArray(result?.productErrors);
  const productErrors = classified ? result.productErrors : raw;
  const infraNoise = classified ? (result.infraNoise ?? []) : [];
  return {
    imageProduced: result?.imageProduced ?? Boolean(result?.imageUrl),
    captureClean: result?.captureClean ?? productErrors.length === 0,
    productErrors,
    infraNoise,
    runtimeWarnings: result?.runtimeWarnings ?? [],
  };
}

/** snap contract: 1 when any screen produced no PNG, 2 when PNGs carry product errors, else 0. */
export function snapExitCode(rows) {
  if (rows.some((row) => !row.imageProduced)) return EXIT.failed;
  if (rows.some((row) => row.productErrors.length > 0)) return EXIT.productErrors;
  return EXIT.ok;
}

/** Infra failures (job error/timeout, 5xx) get one more attempt; product errors never do. */
export const SNAP_ATTEMPTS = 2;

async function snapScreen(id, screenId, outputDir, surface) {
  const encoded = encodeURIComponent(id);
  let failure = null;
  const body = {
    viewport: surface.viewport,
    ...(surface.deviceScaleFactor === undefined ? {} : { deviceScaleFactor: surface.deviceScaleFactor }),
    ...(surface.theme === undefined ? {} : { theme: surface.theme }),
  };
  for (let attempt = 1; attempt <= SNAP_ATTEMPTS; attempt++) {
    const queued = await call("POST", `/prototypes/${encoded}/screens/${encodeURIComponent(screenId)}/screenshot`, body, { retries: 1 });
    if (queued.status !== 202) {
      failure = `enqueue failed (${queued.status}): ${JSON.stringify(queued.json)}`;
      if (isTransient(queued.status)) continue;
      break;
    }
    const state = await pollJob(`/screenshot-jobs/${encodeURIComponent(queued.json.jobId)}`, { deadlineMs: 60_000 });
    if (state.status !== "done") { failure = `screenshot ${state.status}: ${JSON.stringify(state)}`; continue; }
    const summary = summarizeCapture(state.result);
    const path = `${outputDir}/${screenId}.png`;
    if (summary.imageProduced) await downloadImage(state.result.imageUrl, path);
    return { screenId, attempts: attempt, viewport: surface.viewport, failure: summary.imageProduced ? null : "job reported no image", path: summary.imageProduced ? path : null, ...summary };
  }
  return { screenId, attempts: SNAP_ATTEMPTS, viewport: surface.viewport, failure, path: null, imageProduced: false, captureClean: false, productErrors: [], infraNoise: [], runtimeWarnings: [] };
}

/**
 * План съёмки snap. Вьюпорт — canvas-aware, как у geometry/baseline: фиксированные 480x800
 * считали media queries по телефону даже для стикершита. Бюджет проверяется до постановки
 * заданий: превышение лимита ингеста ассетов иначе всплыло бы 413 после съёмки.
 */
export function buildSnapPlan(draft, flags = {}) {
  return draft.doc.screens.map((screen) => {
    const viewport = resolveViewport(screen, flags.viewport, draft.doc.device);
    try {
      assertCaptureSurfaceBudget(captureSurface(screen, draft.doc.device), flags.dsf ?? 1);
      assertViewportPixelBudget(viewport, flags.dsf ?? 1);
    } catch (error) {
      throw new Error(`${screen.id}: ${error.message}`);
    }
    return { screenId: screen.id, viewport, deviceScaleFactor: flags.dsf, theme: flags.theme };
  });
}

async function runSnap(args, flags) {
  const [id, outputDir = `author-shots/${id}`] = args;
  const draft = await requireOk("draft", await call("GET", `/prototypes/${encodeURIComponent(id)}/draft`));
  let plan;
  try { plan = buildSnapPlan(draft, flags); }
  catch (error) { throw new CliError(error.message); }
  await mkdir(outputDir, { recursive: true });
  const rows = [];
  for (const surface of plan) {
    const row = await snapScreen(id, surface.screenId, outputDir, surface);
    rows.push(row);
    if (row.path) out(row.path);
    if (row.failure) console.error(`${surface.screenId}: ${row.failure}`);
    if (row.productErrors.length) console.error(`${surface.screenId} product errors:`, JSON.stringify(row.productErrors));
    if (row.infraNoise.length && !jsonMode) console.error(`${surface.screenId} infra noise (ignored):`, JSON.stringify(row.infraNoise));
  }
  const exitCode = snapExitCode(rows);
  if (jsonMode) {
    report(null, {
      command: "snap", prototypeId: id, outputDir, rev: draft.rev, exitCode,
      // Применённые значения: сервер по умолчанию снимает dsf 1 в светлой теме.
      dsf: flags.dsf ?? 1, theme: flags.theme ?? "light", screens: rows,
    });
  }
  if (exitCode === EXIT.productErrors) throw new CliError("screenshots produced with product errors", { exitCode: EXIT.productErrors });
  if (exitCode === EXIT.failed) throw new CliError("one or more screenshots produced no PNG", { exitCode: EXIT.failed });
}

async function runStatus(args, flags) {
  const [id, screenId] = args;
  const encoded = encodeURIComponent(id);
  const screenIds = flags.allScreens
    ? (await requireOk("draft", await call("GET", `/prototypes/${encoded}/draft`))).doc.screens.map((screen) => screen.id)
    : [screenId];
  const rows = [];
  for (const screen of screenIds) {
    const result = await requireOk("render-status", await call("GET", `/prototypes/${encoded}/screens/${encodeURIComponent(screen)}/render-status`));
    rows.push({ screenId: screen, ...result });
    out(JSON.stringify(result, null, 2));
  }
  if (jsonMode) report(null, { command: "status", prototypeId: id, screens: rows });
  const broken = rows.filter((row) => !row.renderable).map((row) => row.screenId);
  if (broken.length) throw new CliError(`prototype screen is not renderable: ${broken.join(", ")}`);
}

async function downloadImage(imageUrl, outputPath) {
  const url = imageUrl.startsWith("/api/") ? `${API}${imageUrl.slice(4)}` : new URL(imageUrl, `${API}/`).toString();
  const path = url.startsWith(API) ? url.slice(API.length) : new URL(url).pathname.replace(/^\/api/, "");
  const response = await client.request(path);
  if (!response.ok) throw new CliError(`download ${imageUrl} failed (${response.status})`);
  await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
}

async function publishComponent(id, rev, reuseOverride, command = "component") {
  const published = await call("POST", `/components/${encodeURIComponent(id)}/publish`, { baseRev: rev, ...(reuseOverride === undefined ? {} : { reuseOverride }) });
  if (published.status !== 201) {
    failReuseConflict(command, "publish", published, id);
    await failRevisionConflict("publish", published, "components", id);
  }
  const meta = await getMeta("components", id);
  if (!jsonMode) console.log(`published ${id} version ${published.json.version} in ${meta.designSystem}`, published.json.warnings?.length ? published.json.warnings : "");
  return { version: published.json.version, designSystem: meta.designSystem, warnings: published.json.warnings ?? [] };
}

const REUSE_STOP_CODES = new Set(["component_reuse_required", "catalog_changed", "canonical_role_conflict"]);

function failReuseConflict(command, step, response, id) {
  const failure = response.json?.error;
  if (response.status !== 409 || !REUSE_STOP_CODES.has(failure?.code)) return;
  const candidates = failure.candidates ?? [];
  report(
    [
      `STOP: ${failure.code} while attempting to ${step} ${id}`,
      `decisionId: ${failure.decisionId ?? "-"}`,
      ...candidates.map((candidate) => `candidate ${candidate.key ?? `${candidate.designSystem}/${candidate.id}`}: ${candidate.name} v${candidate.version} score=${candidate.score} blocking=${candidate.blocking ? "yes" : "no"}`),
      ...(failure.nextSteps ?? []),
      "Do not retry or force creation automatically; present this decision to a human.",
    ],
    {
      command, id, published: false, stop: true, exitCode: EXIT.productErrors,
      ...(step === "save" ? { created: false } : { draftSaved: true }),
      ...failure,
    },
  );
  throw new CliError(`STOP: ${failure.code}; decisionId=${failure.decisionId ?? "-"}; no automatic retry or force-new`, { exitCode: EXIT.productErrors });
}

async function failRevisionConflict(step, response, kind, id) {
  if (response.status !== 409 || errorCode(response) !== "revision_conflict") requestFailed(step, response);
  const current = await getMeta(kind, id);
  throw new CliError(`${step} failed (409 revision_conflict); current metadata:\n${JSON.stringify(current, null, 2)}\nnot retrying automatically; inspect the current revision and run the command again`);
}

async function loadCatalog(id) {
  const encoded = encodeURIComponent(id);
  const [manifest, system] = await Promise.all([
    call("GET", `/catalog/manifest?designSystem=${encoded}`),
    call("GET", `/design-systems/${encoded}`),
  ]);
  if (manifest.status === 404 || system.status === 404) {
    throw new CliError(`design system ${id} not found; hint: run 'driver.mjs get design-systems'`);
  }
  return {
    manifest: await requireOk(`GET /catalog/manifest?designSystem=${id}`, manifest),
    system: await requireOk(`GET /design-systems/${id}`, system),
  };
}

async function runCatalog(args, flags) {
  const subcommand = ["list", "search", "get"].includes(args[0]) ? args[0] : null;
  if (subcommand === "list") {
    const id = args[1];
    const { manifest, system } = await loadCatalog(id);
    const result = compactCatalog(system, manifest);
    report(catalogListLines(result), { command: "catalog list", ...result });
    return;
  }
  if (subcommand === "search") {
    const id = args[1];
    const query = new URLSearchParams({ designSystem: id, intent: flags.intent });
    if (flags.limit !== undefined) query.set("limit", String(flags.limit));
    const result = await requireOk("catalog search", await call("GET", `/catalog/candidates?${query}`));
    report(catalogSearchLines(result), { command: "catalog search", ...result });
    return;
  }
  if (subcommand === "get") {
    const id = args[1];
    const requested = args.slice(2);
    const { manifest, system } = await loadCatalog(id);
    const artifacts = [];
    for (const artifact of requested) {
      const custom = (manifest.components ?? []).find((component) => component.id === artifact || component.name === artifact);
      if (custom) {
        const details = await requireOk(`catalog get ${artifact}`, await call("GET", `/components/${encodeURIComponent(custom.id)}/versions/${custom.version}`));
        artifacts.push({ kind: "custom", id: custom.id, name: custom.name, details });
        continue;
      }
      const builtin = (system.components ?? []).find((component) => component.name === artifact);
      if (builtin) { artifacts.push({ kind: "builtin", name: builtin.name, details: builtin }); continue; }
      const host = (system.hostPrimitives ?? []).find((component) => component.name === artifact);
      if (host) { artifacts.push({ kind: "host", name: host.name, details: host }); continue; }
      throw new CliError(`catalog get ${id}: artifact ${artifact} not found; run 'catalog list ${id}' first`);
    }
    report(catalogGetLines(id, artifacts), { command: "catalog get", designSystem: id, artifacts });
    return;
  }
  const [id, output] = args;
  const { manifest, system } = await loadCatalog(id);
  const result = flags.full ? fullCatalog(system, manifest) : compactCatalog(system, manifest);
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (output) await writeFile(output, text);
  else report(text.trimEnd(), result);
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
  report(diffSummary(result), result);
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
  if (jsonMode) report(null, { command: "baseline", prototypeId: id, rev: plan.rev, members: result.members });
  else for (const member of result.members) console.log(`${member.screenId} -> ${member.referenceId}`);
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
  report(
    ["screenId\tstatus\tdiffPercent\trefRev->candRev\tdiffUrl", ...rows.map((row) => `${row.screenId}\t${row.status}\t${row.diffPercent ?? "-"}\t${row.revisions}\t${row.diffUrl ?? "-"}`)],
    rows,
  );
  if (rows.some((row) => !["pass"].includes(row.status))) throw new CliError("visual check failed");
}

/** Gates the server reports as hard failures; `--verify` refuses to publish while any exists. */
export function failingGates(report) {
  return (report?.gates ?? []).filter((gate) => gate.status === "fail");
}

/**
 * readiness contract: 2 when the server says the prototype is not publishable or any gate
 * failed (a product-level problem with a full report), 0 otherwise. Transport errors are 1
 * and never reach here.
 */
export function readinessExitCode(report) {
  if (report?.publishable === false) return EXIT.productErrors;
  if ((report?.blocking ?? []).length) return EXIT.productErrors;
  return failingGates(report).length ? EXIT.productErrors : EXIT.ok;
}

export function readinessLines(report) {
  const header = `readiness ${report.prototypeId} rev=${report.rev} publishable=${report.publishable ? "yes" : "no"} blocking=${report.blocking.length ? report.blocking.join(",") : "-"}`;
  return [
    header,
    "gate\tstatus\tsummary",
    ...report.gates.map((gate) => `${gate.id}\t${gate.status}\t${gate.summary}`),
  ];
}

async function fetchReadiness(id) {
  return requireOk("readiness", await call("GET", `/prototypes/${encodeURIComponent(id)}/readiness`));
}

async function runReadiness(args) {
  const [id] = args;
  const readiness = await fetchReadiness(id);
  const exitCode = readinessExitCode(readiness);
  report(readinessLines(readiness), { command: "readiness", exitCode, ...readiness });
  if (exitCode !== EXIT.ok) {
    throw new CliError(`prototype ${id} is not ready to publish: ${(readiness.blocking.length ? readiness.blocking : failingGates(readiness).map((gate) => gate.id)).join(", ")}`, { exitCode });
  }
}

async function runPublish(args, flags) {
  const [id] = args;
  const encoded = encodeURIComponent(id);
  const readiness = await fetchReadiness(id);
  const failing = failingGates(readiness);
  if (flags.verify && failing.length) {
    report(
      ["publish refused by --verify", ...readinessLines(readiness)],
      { command: "publish", prototypeId: id, published: false, exitCode: EXIT.productErrors, refusedBy: failing.map((gate) => gate.id), readiness },
    );
    throw new CliError(`publish refused: failing gates ${failing.map((gate) => gate.id).join(", ")}`, { exitCode: EXIT.productErrors });
  }
  const response = await call("POST", `/prototypes/${encoded}/publish`, { baseRev: readiness.rev, ...(flags.force ? { force: true } : {}) });
  if (response.status === 409 && errorCode(response) === "publish_blocked") {
    const blocked = response.json.error.report ?? readiness;
    report(
      ["publish blocked by readiness gates", ...readinessLines(blocked)],
      { command: "publish", prototypeId: id, published: false, exitCode: EXIT.productErrors, blocking: blocked.blocking ?? [], readiness: blocked },
    );
    throw new CliError(`publish blocked: ${(blocked.blocking ?? []).join(", ") || "readiness gates"}; re-run with --force to override`, { exitCode: EXIT.productErrors });
  }
  const published = await requireOk("publish", response, [201]);
  const base = API.replace(/\/api$/, "");
  report(
    [
      `published ${id} version ${published.version} (rev ${published.rev})`,
      ...(published.screens ?? []).map((screen) => `screen:  ${base}${screen.url}`),
    ],
    {
      command: "publish", prototypeId: id, published: true, exitCode: EXIT.ok,
      version: published.version, rev: published.rev, forced: flags.force === true, verified: flags.verify === true,
      screens: (published.screens ?? []).map((screen) => ({ ...screen, url: `${base}${screen.url}` })),
      readiness,
    },
  );
}

function usageLines(usages) {
  const lines = [`usages ${usages.componentId} (${usages.name}) versions=${usages.versionsInUse.join(",") || "-"} safeToRemove=${usages.safeToRemove ? "yes" : "no"}`];
  lines.push(`head usages: ${usages.currentHeadUsages.length}`);
  for (const usage of usages.currentHeadUsages) {
    const screens = usage.screens.map((screen) => `${screen.screenId}[${screen.elementKeys.join(",")}]`).join(" ") || "-";
    lines.push(`  ${usage.prototypeId} rev=${usage.rev} v${usage.componentVersion} kind=${usage.kind} screens: ${screens}`);
  }
  lines.push(`immutable usages: ${usages.immutableUsages.length}`);
  for (const usage of usages.immutableUsages) lines.push(`  ${usage.prototypeId} version ${usage.version} v${usage.componentVersion}`);
  return lines;
}

function treeLines(tree, nodes = tree.nodes, depth = 0) {
  if (depth === 0) {
    return [
      `usages ${tree.componentId} (${tree.name}) versions=${tree.versionsInUse.join(",") || "-"} safeToRemove=${tree.safeToRemove ? "yes" : "no"}`,
      ...treeLines(tree, tree.nodes, 1),
      `immutable usages: ${tree.immutableUsages.length}`,
      ...tree.immutableUsages.map((usage) => `  ${usage.prototypeId} version ${usage.version} v${usage.componentVersion}`),
    ];
  }
  return nodes.flatMap((node) => [`${"  ".repeat(depth)}${node.kind} ${node.label}`, ...treeLines(tree, node.children ?? [], depth + 1)]);
}

async function runUsages(args, flags) {
  const [id] = args;
  const query = flags.tree ? "?format=tree" : "";
  const usages = await requireOk("usages", await call("GET", `/components/${encodeURIComponent(id)}/usages${query}`));
  report(flags.tree ? treeLines(usages) : usageLines(usages), { command: "usages", ...usages });
}

/**
 * Catalog-wide sweep: one row per published component of the design system, joining the
 * manifest (version, deprecated, architecture metadata) with the usage index (which head
 * revisions pin it). Pure so the exit-code mapping is testable without a server.
 */
export function auditRows(manifest, usages) {
  const byId = new Map((usages.components ?? []).map((entry) => [entry.componentId, entry]));
  return (manifest.components ?? []).map((component) => {
    const usage = byId.get(component.id);
    return {
      id: component.id,
      name: component.name,
      version: component.version,
      status: component.deprecated ? "deprecated" : "active",
      deprecated: component.deprecated === true,
      scope: component.scope ?? null,
      canonicalFor: component.canonicalFor ?? null,
      replacement: component.replacement ?? null,
      headUsageCount: usage?.headUsageCount ?? component.headUsageCount ?? 0,
      prototypes: (usage?.prototypes ?? []).map((prototype) => prototype.prototypeId),
    };
  });
}

/** Deprecated components still pinned by a head revision are the actionable finding. */
export function auditFindings(rows) {
  return {
    deprecatedInUse: rows.filter((row) => row.deprecated && row.headUsageCount > 0).map((row) => row.id),
    unused: rows.filter((row) => row.headUsageCount === 0).map((row) => row.id),
  };
}

export const auditExitCode = (findings) => (findings.deprecatedInUse.length ? EXIT.productErrors : EXIT.ok);

function auditLines(designSystem, rows, findings) {
  return [
    `audit ${designSystem}: ${rows.length} components, ${findings.deprecatedInUse.length} deprecated in use, ${findings.unused.length} unused`,
    "component\tversion\tstatus\tscope\tcanonicalFor\theadUsages",
    ...rows.map((row) => `${row.id}\tv${row.version}\t${row.status}\t${row.scope ?? "-"}\t${row.canonicalFor?.join(",") || "-"}\t${row.headUsageCount}`),
    ...(findings.deprecatedInUse.length ? [`deprecated with head usages: ${findings.deprecatedInUse.join(", ")}`] : []),
    ...(findings.unused.length ? [`no head usages: ${findings.unused.join(", ")}`] : []),
  ];
}

async function runAudit(flags) {
  const encoded = encodeURIComponent(flags.designSystem);
  const [manifest, usages] = await Promise.all([
    call("GET", `/catalog/manifest?designSystem=${encoded}`),
    call("GET", `/catalog/usages?designSystem=${encoded}`),
  ]);
  if (manifest.status === 404 || usages.status === 404) {
    throw new CliError(`design system ${flags.designSystem} not found; hint: run 'driver.mjs get design-systems'`);
  }
  const rows = auditRows(
    await requireOk("catalog manifest", manifest),
    await requireOk("catalog usages", usages),
  );
  const findings = auditFindings(rows);
  const exitCode = auditExitCode(findings);
  report(auditLines(flags.designSystem, rows, findings), { command: "audit", designSystem: flags.designSystem, exitCode, components: rows, findings });
  if (exitCode !== EXIT.ok) throw new CliError(`deprecated components are still used by head revisions: ${findings.deprecatedInUse.join(", ")}`, { exitCode });
}

/**
 * Человекочитаемый отчёт аудита гейта переиспользования (спека §5). Чистая функция: тест
 * проверяет форматирование без сервера, а `--json` отдаёт ответ API как есть.
 */
export function reuseAuditLines(report) {
  const decisionCounts = Object.entries(report.totals?.byDecision ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const scope = [
    report.filter?.designSystem ? `designSystem=${report.filter.designSystem}` : null,
    report.filter?.actorId ? `actor=${report.filter.actorId}` : null,
    report.filter?.since ? `since=${report.filter.since}` : null,
  ].filter(Boolean).join(" ");
  const lines = [
    `reuse audit${scope ? ` (${scope})` : ""}: ${report.totals?.decisions ?? 0} decisions from ${report.totals?.actors ?? 0} actors; gate active since ${report.gateActiveSince ?? "never"}`,
    `decisions: ${decisionCounts.map(([decision, count]) => `${decision}=${count}`).join(" ") || "-"}`,
    `gate modes: ${Object.entries(report.totals?.byGateMode ?? {}).map(([mode, count]) => `${mode}=${count}`).join(" ") || "-"}`,
    `would_block: ${report.wouldBlock?.total ?? 0} across ${report.wouldBlock?.actors ?? 0} actors${(report.wouldBlock?.byActor ?? []).length ? ` (${report.wouldBlock.byActor.map((row) => `${row.actorId}=${row.count}`).join(", ")})` : ""}`,
  ];
  const section = (title, rows, header, format) => {
    lines.push(`${title}: ${rows.length}`);
    if (!rows.length) return;
    lines.push(header);
    for (const row of rows) lines.push(format(row));
  };
  section("force-new overrides", report.forceNew ?? [], "decisionId\tactor\tartifact\tdesignSystem\tcreatedAt\treason",
    (row) => `${row.id}\t${row.actorId}\t${row.artifactKind}/${row.artifactId}\t${row.designSystem}\t${row.createdAt}\t${row.reason ?? "-"}`);
  section("repeated blocked attempts", report.repeatedBlocked ?? [], "actor\tartifact\tattempts\tblocked\twouldBlock\tlastAt\tcandidates",
    (row) => `${row.actorId}\t${row.artifactKind}/${row.artifactId}\t${row.attempts}\t${row.blocked}\t${row.wouldBlock}\t${row.lastAt}\t${row.candidateIds.join(",") || "-"}`);
  section("canonical role conflicts", report.canonicalRoleConflicts ?? [], "decisionId\tactor\tartifact\troles\tcreatedAt",
    (row) => `${row.id}\t${row.actorId}\t${row.artifactKind}/${row.artifactId}\t${row.roles.join(",") || "-"}\t${row.createdAt}`);
  section("would_block decisions", report.wouldBlock?.decisions ?? [], "decisionId\tactor\tartifact\tcandidates\tcreatedAt",
    (row) => `${row.id}\t${row.actorId}\t${row.artifactKind}/${row.artifactId}\t${row.candidates.map((candidate) => candidate.id).join(",") || "-"}\t${row.createdAt}`);
  const unreviewed = report.unreviewed ?? { total: 0, artifacts: [] };
  lines.push(`artifacts never reuse-reviewed: ${unreviewed.total} (showing ${unreviewed.artifacts.length})`);
  if (unreviewed.artifacts.length) {
    lines.push("kind\tid\tdesignSystem\tcreatedAt\tbeforeGate");
    for (const row of unreviewed.artifacts) lines.push(`${row.kind}\t${row.id}\t${row.designSystem}\t${row.createdAt}\t${row.createdBeforeGate ? "yes" : "no"}`);
  }
  return lines;
}

/** Чтение админского аудита гейта. Успешное чтение — всегда exit 0, находки — не ошибка CLI. */
async function runReuseAudit(flags) {
  const query = new URLSearchParams();
  if (flags.designSystem !== undefined) query.set("designSystem", flags.designSystem);
  if (flags.actor !== undefined) query.set("actorId", flags.actor);
  if (flags.since !== undefined) query.set("since", flags.since);
  if (flags.limit !== undefined) query.set("limit", String(flags.limit));
  if (flags.minAttempts !== undefined) query.set("minAttempts", String(flags.minAttempts));
  const path = `/catalog/reuse-decisions${query.size ? `?${query}` : ""}`;
  const response = await call("GET", path);
  if (response.status === 401 || response.status === 403) {
    throw new CliError(`reuse audit requires an administrator session (${response.status}): ${JSON.stringify(response.json, null, 2)}`);
  }
  const audit = await requireOk("reuse audit", response);
  report(reuseAuditLines(audit), { command: "audit reuse", ...audit });
}

async function runComposition(args, flags) {
  if (args[0] === "publish") {
    const id = args[1];
    const meta = await getMeta("compositions", id);
    if (!meta) throw new CliError(`compositions/${id} not found`);
    const response = await call("POST", `/compositions/${encodeURIComponent(id)}/publish`, { baseRev: meta.headRev, message: "driver publish" });
    if (response.status !== 201) await failRevisionConflict("composition publish", response, "compositions", id);
    report(
      `published composition ${id} version ${response.json.version} (rev ${response.json.rev})`,
      { command: "composition publish", id, version: response.json.version, rev: response.json.rev },
    );
    return;
  }
  const [id, documentPath] = args;
  const doc = JSON.parse(await readFile(documentPath, "utf8"));
  const meta = await getMeta("compositions", id);
  if (meta && meta.designSystem !== flags.designSystem) {
    throw new CliError(`composition ${id} belongs to ${meta.designSystem}; compositions cannot move to ${flags.designSystem}`);
  }
  const response = meta === null
    ? await call("POST", "/compositions", { id, doc, designSystem: flags.designSystem, message: "driver save" })
    : await call("PUT", `/compositions/${encodeURIComponent(id)}`, { doc, baseRev: meta.headRev, message: "driver save" });
  if (![200, 201].includes(response.status)) await failRevisionConflict("composition save", response, "compositions", id);
  const created = meta === null;
  report(
    `saved composition ${id} rev ${response.json.rev} in ${flags.designSystem}${created ? " (created)" : ""}`,
    { command: "composition", id, created, rev: response.json.rev, designSystem: flags.designSystem },
  );
}

export async function main(argv = process.argv.slice(2)) {
  const { cmd, args, flags } = parseArgs(argv);
  jsonMode = flags.json === true;
  if (cmd === "component") {
    const [id, name, sourcePath] = args;
    const selectedSystem = flags.designSystem ?? process.env.EASYUI_DESIGN_SYSTEM;
    // Provenance читается до любых сетевых вызовов: битый путь — ошибка аргументов, не ENOENT
    // посреди публикации. Схему (fileKey/nodeIds/…) валидирует сервер.
    const figma = flags.figma === undefined ? undefined : await readFigmaProvenance(flags.figma);
    const source = await readFile(sourcePath, "utf8");
    const meta = await getMeta("components", id);
    const systemBody = selectedSystem !== undefined && selectedSystem !== meta?.designSystem ? { designSystem: selectedSystem } : {};
    let discovery;
    let reuseOverride;
    let acknowledgedCandidateKeys = [];
    if (meta === null) {
      if (flags.intent === undefined) invalid("component create requires --intent <text>");
      if (selectedSystem === undefined) invalid("component create requires --design-system <id> or EASYUI_DESIGN_SYSTEM");
      discovery = await discoverComponent({ id, name, source, designSystem: selectedSystem, intent: flags.intent });
      if (!jsonMode) for (const line of catalogSearchLines(discovery)) out(line);
      if (flags.forceNew) {
        const template = discovery.overrideTemplate;
        if (template === undefined || !Array.isArray(template.candidateKeys) || typeof template.catalogRevision !== "string") {
          throw new CliError("catalog search did not return an authoritative overrideTemplate");
        }
        acknowledgedCandidateKeys = template.candidateKeys;
        if (acknowledgedCandidateKeys.length) {
          reuseOverride = { ...template, reason: flags.reason };
        }
      }
    }
    const figmaBody = figma === undefined ? {} : { figma };
    const saved = meta === null
      ? await call("POST", "/components", { id, name, source, ...systemBody, ...figmaBody, intent: flags.intent, ...(reuseOverride === undefined ? {} : { reuseOverride }), message: "driver save" })
      : await call("PUT", `/components/${encodeURIComponent(id)}`, { source, ...systemBody, ...figmaBody, message: "driver save", baseRev: meta.headRev });
    if (![200, 201].includes(saved.status)) {
      failReuseConflict("component", "save", saved, id);
      await failRevisionConflict("save", saved, "components", id);
    }
    const savedMeta = await getMeta("components", id);
    out(`saved ${id} rev ${saved.json.rev} in ${savedMeta.designSystem}`);
    const published = await publishComponent(id, saved.json.rev, reuseOverride);
    if (jsonMode) report(null, {
      command: "component", id, rev: saved.json.rev, ...published,
      ...(figma === undefined ? {} : { figma: true }),
      ...(discovery === undefined ? {} : { discovery }),
      ...(flags.forceNew ? { forceNew: true, acknowledgedCandidateKeys } : {}),
    });
  } else if (cmd === "component-move") {
    const [id] = args;
    const meta = await getMeta("components", id);
    if (!meta) throw new CliError(`components/${id} not found`);
    const saved = await call("PUT", `/components/${encodeURIComponent(id)}`, { designSystem: flags.designSystem, message: "driver move", baseRev: meta.headRev });
    if (saved.status !== 200) await failRevisionConflict("move", saved, "components", id);
    const savedMeta = await getMeta("components", id);
    out(`saved ${id} rev ${saved.json.rev} in ${savedMeta.designSystem}`);
    const published = await publishComponent(id, saved.json.rev, undefined, "component-move");
    if (jsonMode) report(null, { command: "component-move", id, rev: saved.json.rev, ...published });
  } else if (cmd === "composition") {
    await runComposition(args, flags);
  } else if (cmd === "design-system") {
    const [id, name, description] = args;
    const created = await call("POST", "/design-systems", { id, name, description });
    if (created.status === 201) process.stdout.write(`${JSON.stringify(created.json, null, 2)}\n`);
    else if (created.status === 409) process.stdout.write(`${JSON.stringify(await requireOk("design-system", await call("GET", `/design-systems/${encodeURIComponent(id)}`)), null, 2)}\n`);
    else requestFailed("design-system", created);
  } else if (cmd === "prototype") {
    const doc = JSON.parse(await readFile(args[0], "utf8"));
    const meta = await getMeta("prototypes", doc.id);
    const saved = meta === null
      ? await call("POST", "/prototypes", { doc, message: "driver save" })
      : await call("PUT", `/prototypes/${encodeURIComponent(doc.id)}`, { doc, message: "driver save", baseRev: meta.headRev });
    const result = await requireOk("save", saved, [200, 201]);
    if (!jsonMode) console.log(`saved ${doc.id} rev ${result.rev}`, result.warnings?.length ? result.warnings : "");
    const draft = await requireOk("draft", await call("GET", `/prototypes/${encodeURIComponent(doc.id)}/draft`));
    const base = API.replace(/\/api$/, "");
    out(`component pins: ${JSON.stringify(draft.components)}`);
    out(`player: ${base}/p/${doc.id}`);
    for (const screen of result.screens ?? []) out(`screen:  ${base}${screen.url}`);
    if (jsonMode) {
      report(null, {
        command: "prototype", id: doc.id, rev: result.rev, warnings: result.warnings ?? [],
        componentPins: draft.components, playerUrl: `${base}/p/${doc.id}`,
        screens: (result.screens ?? []).map((screen) => ({ ...screen, url: `${base}${screen.url}` })),
      });
    }
  } else if (cmd === "catalog") await runCatalog(args, flags);
  else if (cmd === "diff") await runDiff(args, flags);
  else if (cmd === "baseline") await runBaseline(args, flags);
  else if (cmd === "check") await runCheck(args, flags);
  else if (cmd === "geometry") await runGeometry(args);
  else if (cmd === "get") {
    // `get` принимает и составные пути (`prototypes/<id>/draft`), поэтому алиас применяется
    // только к точному совпадению с известной коллекцией.
    const kind = resolveCollection(args[0]);
    const id = args[1];
    const path = kind === "assets" && id ? `/assets/${encodeURIComponent(id)}/usage` : id ? `/${kind}/${encodeURIComponent(id)}` : `/${kind}`;
    process.stdout.write(`${JSON.stringify(await requireOk("get", await call("GET", path)), null, 2)}\n`);
  } else if (cmd === "delete") {
    const [rawKind, id] = args;
    const kind = resolveCollection(rawKind);
    const spec = DELETABLE[kind];
    if (!spec) throw new CliError(`cannot delete ${rawKind}; supported kinds: ${Object.keys(DELETABLE).join(", ")}`);
    const meta = await getMeta(kind, id);
    if (!meta) throw new CliError(`${kind}/${id} not found`);
    let body;
    if (spec.revisioned) {
      if (typeof meta.headRev !== "number") throw new CliError(`${kind}/${id} has no headRev to CAS on: ${JSON.stringify(meta)}`);
      body = { baseRev: meta.headRev };
    }
    await requireOk("delete", await call("DELETE", `/${kind}/${encodeURIComponent(id)}`, body), [204]);
    report(`${spec.verb} ${kind}/${id}`, { command: "delete", kind, id, deleted: true });
  } else if (cmd === "shoot") {
    const [id, outputDir = `author-shots/${id}`] = args;
    const draft = await requireOk("draft", await call("GET", `/prototypes/${encodeURIComponent(id)}/draft`));
    await mkdir(outputDir, { recursive: true });
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    await client.login();
    const context = await browser.newContext({ viewport: { width: 480, height: 800 }, ...(client.legacyAuthorization ? { extraHTTPHeaders: { authorization: client.legacyAuthorization } } : {}) });
    const [name, value] = client.cookieHeader.split("=", 2);
    await context.addCookies([{ name, value, url: API.replace(/\/api$/, "") }]);
    const page = await context.newPage();
    const errors = [];
    const shots = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    const base = API.replace(/\/api$/, "");
    for (const screen of draft.doc.screens) {
      await page.goto(`${base}/p/${id}/s/${screen.id}`, { waitUntil: "networkidle" });
      await page.screenshot({ path: `${outputDir}/${screen.id}.png` });
      shots.push({ screenId: screen.id, path: `${outputDir}/${screen.id}.png` });
      out(`${outputDir}/${screen.id}.png`);
    }
    await context.close();
    await browser.close();
    if (jsonMode) report(null, { command: "shoot", prototypeId: id, outputDir, shots, errors });
    if (errors.length) throw new CliError(`browser errors:\n${errors.join("\n")}`);
  } else if (cmd === "snap") await runSnap(args, flags);
  else if (cmd === "status") await runStatus(args, flags);
  else if (cmd === "readiness") await runReadiness(args);
  else if (cmd === "publish") await runPublish(args, flags);
  else if (cmd === "usages") await runUsages(args, flags);
  else if (cmd === "audit") await (args[0] === "reuse" ? runReuseAudit(flags) : runAudit(flags));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    if (error?.usage) console.error(usageLine);
    process.exitCode = error?.exitCode ?? EXIT.failed;
  });
}
