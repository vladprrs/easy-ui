#!/usr/bin/env node
// easy-ui authoring driver. Zero dependencies (Node 18+): любая съёмка идёт через серверный
// рендерер (план renderer-contract-2 §5 R8a — один рендерер, локального браузера в драйвере нет).

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEasyUiClient } from "../../../scripts/easyui-auth.mjs";
import { canonicalJson, nullCache, openCache, TERMINAL_RUN_STATUSES } from "./cache.mjs";

const API = (process.env.EASYUI_API ?? "https://easy-ui.pay-offline.ru/api").replace(/\/$/, "");
const client = createEasyUiClient({ apiBase: API });

export const DESKTOP_VIEWPORT = Object.freeze({ width: 1280, height: 800 });
export const DEVICE_VIEWPORTS = Object.freeze({
  mobile: Object.freeze({ width: 390, height: 844 }),
  tablet: Object.freeze({ width: 834, height: 1112 }),
  desktop: DESKTOP_VIEWPORT,
});
export const MAX_SCREENSHOT_PIXELS = 20_000_000;

const usageLine = "usage: driver.mjs component <id> <Name> <src.tsx> [--design-system <id>] [--intent <text>] [--figma <figma.json>] [--force-new --reason <text>] | component-move <id> --design-system <id> | composition <id> <doc.json> --design-system <id> | composition publish <id> | design-system <id> <name> <description> | prototype <doc.json> | catalog <system> [out.json] [--full] | catalog list <system> | catalog search <system> --intent <text> [--limit N] [--kind component|composition] [--doc <composition.json>] | catalog get <system> <artifact...> | diff <protoId> [revA] [revB] | baseline <protoId> [outDir] [--viewport WxH] [--theme light|dark] [--dsf 1|2|3] | check <protoId> [--threshold N] | geometry <protoId> <screenId> | expect <expected.json> <actual.json> [--tolerance N] | get <kind> [id] | delete <kind> <id> (prototypes/components/compositions/design-systems; design-system → ретайр) | shoot <prototypeId> [outDir] (deprecated alias of snap --all-screens) | snap <prototypeId> [outDir] [--all-screens] [--viewport WxH] [--theme light|dark] [--dsf 1|2|3] [--receipt <file.json>] | preview <componentId> [props.json] [--example <name>] [--rev head-draft] [--probe geometry] [--viewport WxH] [--theme light|dark] [--dsf 1|2|3] [--out file] [--receipt <file.json>] | status <prototypeId> [screenId] [--all-screens] | readiness <protoId> | publish <protoId> [--verify] [--force] | usages <componentId> [--tree] | promote <componentId> [--supersede auto|none] [--strict-catalog] [--candidate <candidateId>] [--acceptance-run <runId>]... [--acceptance-runs <runId,runId>] [--expected-cases N] | provenance <componentId> <figma.json|null> [--rev N] | case-set put <componentId> <manifest.json> | case-set validate <manifest.json> | case-set get <caseSetId> | case-set coverage <caseSetId> | accept <componentId> [--case-set <caseSetId>] [--policy <id>] [--refresh none|failed|all|id,id2] [--recapture] [--baseline-run <runId>] [--timeout-sec N] [--evidence <file.zip>] | accept-status <runId> [--evidence <file.zip>] | reject <candidateId> --reason <text> | impact <componentId> --candidate <candidateId> --baseline-run <runId> | audit --design-system <id> | audit --versions [--design-system <id>] | audit reuse [--design-system <id>] [--actor <id>] [--since <iso>] [--limit N] [--min-attempts N]\npromote --candidate/--acceptance-run link the published version to a durable acceptance candidate and run (both ids are checked against the validate receipt before the mutation and printed with it); a sharded family is promoted with a SET of runs (--acceptance-run repeated or --acceptance-runs a,b; needs features.acceptanceMultiRunPromote): shards must be disjoint by (propsHash, surface), the server sorts the set and --expected-cases N asserts the union coverage; accept --refresh failed = re-evaluate the verdict only (a captured frame may be reused), accept --recapture = force a re-capture of those cases (frame scope) instead of a verdict-only refresh\nevery verb accepts --json and the global cache flags --cache-dir <dir> (env EASYUI_CACHE_DIR) / --cache-refresh (force miss); snap/preview print receiptSha256 + renderer.rendererFingerprint + codes[] in --json and write the capture receipt with --receipt; snap/preview exit 0 (PNG, no product errors), 2 (PNG + product errors), 1 (no PNG); readiness/publish/audit and terminal reuse STOPs exit 2 on product-level failure";

/** Exit codes are part of the CLI contract: 0 ok, 2 product errors with an artifact, 1 everything else. */
export const EXIT = Object.freeze({ ok: 0, failed: 1, productErrors: 2 });
/** Потолок набора ранов одного promote (сервер: `PROMOTE_MAX_ACCEPTANCE_RUNS`, план W7). */
const PROMOTE_MAX_ACCEPTANCE_RUNS = 8;

class CliError extends Error {
  constructor(message, { usage = false, exitCode = EXIT.failed } = {}) {
    super(message);
    this.usage = usage;
    this.exitCode = exitCode;
  }
}

let jsonMode = false;
/**
 * Клиентский кэш ответов (план 2026-08-03 §5 W7). До разбора флагов — no-op: команда без
 * `--cache-dir`/`EASYUI_CACHE_DIR` работает ровно как раньше.
 */
let cache = nullCache("not configured");
/** Human line printed only outside --json; JSON mode owns stdout entirely. */
const out = (line) => { if (!jsonMode) console.log(line); };
/**
 * Terminal output of a verb: a JSON document in --json mode, human lines otherwise.
 *
 * Статус кэша едет в **каждом** отчёте: клиентский кэш — ускоритель, а не свидетельство, и
 * читатель обязан видеть, пришла цифра с сервера или с диска. В человекочитаемом режиме — та же
 * строка в stderr (stdout принадлежит отчёту).
 */
function report(lines, payload) {
  if (jsonMode) process.stdout.write(`${JSON.stringify({ ...payload, cache: cache.summary() }, null, 2)}\n`);
  else {
    for (const line of [lines].flat()) console.log(line);
    if (cache.enabled) process.stderr.write(`${cache.line()}\n`);
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

/** Один разбор поверхности съёмки на все команды, снимающие экраны (baseline и snap). */
const surfaceFlags = {
  "--viewport": { ...viewportFlag, key: "viewport" },
  "--theme": { value: true, key: "theme", enum: ["light", "dark"] },
  "--dsf": { value: true, key: "dsf", enum: ["1", "2", "3"], parse: Number },
};

const jsonFlag = { "--json": { value: false, key: "json" } };
/**
 * Глобальные флаги клиентского кэша (план 2026-08-03 §5 W7). Разбираются для **любой** команды,
 * поэтому не входят в `flagSpecs` (там — контракт конкретного глагола), а домешиваются в
 * `parseArgs`. `--cache-refresh`, а не `--refresh`: у `accept` `--refresh` уже занят серверной
 * политикой пересъёмки (`none|failed|all|ids`), и переиспользование имени сделало бы два разных
 * решения одним флагом.
 */
export const CACHE_FLAGS = Object.freeze({
  "--cache-dir": { value: true, key: "cacheDir" },
  "--cache-refresh": { value: false, key: "cacheRefresh" },
});
const CACHE_VALUE_FLAGS = Object.keys(CACHE_FLAGS).filter((flag) => CACHE_FLAGS[flag].value);
const allScreensFlag = { "--all-screens": { value: false, key: "allScreens" } };
/**
 * `--receipt <file.json>` (план renderer-contract-2 §5 **R8b**): скачать capture receipt снятой
 * джобы (R5) в файл. Один файл на команду — у `snap` это документ со списком экранов, у
 * `preview` — receipt единственной джобы; форма описана в `docs/server-api.md` (секция драйвера).
 */
const receiptFlag = { "--receipt": { value: true, key: "receipt" } };
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

/**
 * `--refresh` приёмки — форма сервера (`none|failed|all|{caseIds}`), а не «true/false»: режимы
 * различаются стоимостью рана, и молча деградировать один в другой нельзя. Список id — через
 * запятую (`--refresh alpha,beta`).
 */
function parseRefreshFlag(value) {
  if (value === "none" || value === "failed" || value === "all") return value;
  const caseIds = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (!caseIds.length) invalid("--refresh must be none|failed|all or a comma-separated list of case ids");
  return { caseIds };
}

export const flagSpecs = Object.freeze({
  component: {
    ...jsonFlag,
    "--design-system": { value: true, key: "designSystem" },
    "--intent": { value: true, key: "intent" },
    "--force-new": { value: false, key: "forceNew" },
    "--reason": { value: true, key: "reason" },
    // Опционально: provenance наследуется между ревизиями (R3a), смена/очистка — верб `provenance`.
    "--figma": { value: true, key: "figma" },
  },
  "component-move": { ...jsonFlag, "--design-system": { value: true, key: "designSystem" } },
  composition: { ...jsonFlag, "--design-system": { value: true, key: "designSystem" } },
  "composition publish": { ...jsonFlag },
  "design-system": { ...jsonFlag },
  prototype: { ...jsonFlag },
  catalog: { ...jsonFlag, "--full": { value: false, key: "full" } },
  "catalog list": { ...jsonFlag },
  // `--kind composition` (план 2026-08-03 W9): поиск кандидатов для **композиции** — тот же
  // роут, но ответ несёт три исхода workbench'а. `--doc` даёт серверу тело кандидата: без него
  // нет ни структурной сигнатуры (дубль не найдётся), ни вердикта анализатора.
  "catalog search": {
    ...jsonFlag,
    "--intent": { value: true, key: "intent" },
    "--limit": catalogLimitFlag,
    "--kind": { value: true, key: "kind", enum: ["component", "composition"] },
    "--doc": { value: true, key: "doc" },
  },
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
  // RFC candidate-acceptance R1: приёмка провалидированной head-ревизии одной командой.
  // План 2026-08-04 §W2a (P0-1): явная линковка версии с durable-кандидатом и его раном.
  // План 2026-08-04 §W7 (P1-8): шардированная семья публикуется набором ранов —
  // `--acceptance-run` повторяем, `--acceptance-runs a,b` — та же связка одним аргументом.
  // Порядок значений на хранение не влияет: сервер сортирует набор по `(created_at, run_id)`.
  promote: {
    ...jsonFlag,
    "--supersede": { value: true, key: "supersede", enum: ["auto", "none"] },
    "--strict-catalog": { value: false, key: "strictCatalog" },
    "--message": { value: true, key: "message" },
    "--candidate": { value: true, key: "candidate" },
    "--acceptance-run": { value: true, key: "acceptanceRun", repeat: true },
    "--acceptance-runs": {
      value: true,
      key: "acceptanceRuns",
      parse(value) {
        const ids = value.split(",").map((item) => item.trim()).filter((item) => item !== "");
        if (ids.length === 0) invalid("--acceptance-runs needs a comma-separated list of run ids");
        return ids;
      },
    },
    "--expected-cases": {
      value: true,
      key: "expectedCases",
      parse(value) {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1) invalid("--expected-cases must be a positive integer");
        return number;
      },
    },
  },
  // RFC candidate-acceptance R3a: правка provenance без новой ревизии и версии.
  provenance: {
    ...jsonFlag,
    "--rev": {
      value: true,
      key: "rev",
      parse(value) {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1) invalid("--rev must be a positive integer");
        return number;
      },
    },
  },
  // План 2026-08-03 §5 W1c: матричная приёмка семейства одной командой (кандидат → ран → poll).
  // План 2026-08-03 §5 W2: публикация и чтение case-set-манифеста семейства.
  "case-set": { ...jsonFlag },
  accept: {
    ...jsonFlag,
    "--case-set": { value: true, key: "caseSet" },
    "--policy": { value: true, key: "policy" },
    "--refresh": { value: true, key: "refresh", parse: parseRefreshFlag },
    // План 2026-08-04 §W2a (D5) — CLI-половина алгебры refresh: `--refresh` выбирает **какие**
    // случаи обновить, `--recapture` — **насколько глубоко**. Без него `--refresh failed` даёт
    // verdict-scope (кадр может быть переиспользован, пересчитывается только вердикт), с ним
    // скоуп поднимается до frame (принудительная пересъёмка).
    "--recapture": { value: false, key: "recapture" },
    // План 2026-08-03 §5 W6: частичная пересъёмка относительно терминального рана.
    "--baseline-run": { value: true, key: "baselineRun" },
    "--timeout-sec": {
      value: true,
      key: "timeoutSec",
      parse(value) {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 10 || number > 7200) invalid("--timeout-sec must be an integer from 10 to 7200");
        return number;
      },
    },
    "--evidence": { value: true, key: "evidence" },
  },
  "accept-status": { ...jsonFlag, "--evidence": { value: true, key: "evidence" } },
  // RFC candidate-acceptance R3b: отклонение кандидата человеком. Решение терминально — ручки
  // «разотклонить» нет ни в драйвере, ни на сервере; выход — новая ревизия компонента.
  reject: { ...jsonFlag, "--reason": { value: true, key: "reason" } },
  // План 2026-08-03 §5 W6: dry-run импакта кандидата к baseline-рану (ничего не снимает).
  impact: {
    ...jsonFlag,
    "--candidate": { value: true, key: "candidate" },
    "--baseline-run": { value: true, key: "baselineRun" },
  },
  get: { ...jsonFlag },
  delete: { ...jsonFlag },
  // R8a: `shoot` — алиас `snap --all-screens`, поэтому и контракт флагов у него снаповский.
  shoot: { ...jsonFlag, ...allScreensFlag, ...surfaceFlags, ...receiptFlag },
  snap: { ...jsonFlag, ...allScreensFlag, ...surfaceFlags, ...receiptFlag },
  preview: {
    ...jsonFlag,
    ...surfaceFlags,
    ...receiptFlag,
    "--example": { value: true, key: "example" },
    "--rev": { value: true, key: "rev", enum: ["head-draft"] },
    "--probe": { value: true, key: "probe", enum: ["geometry"] },
    "--out": { value: true, key: "out" },
  },
  expect: {
    ...jsonFlag,
    "--tolerance": {
      value: true,
      key: "tolerance",
      parse(value) {
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0) invalid("--tolerance must be a non-negative number of CSS px");
        return number;
      },
    },
  },
  status: { ...jsonFlag, ...allScreensFlag },
  readiness: { ...jsonFlag },
  publish: { ...jsonFlag, "--verify": { value: false, key: "verify" }, "--force": { value: false, key: "force" } },
  usages: { ...jsonFlag, "--tree": { value: false, key: "tree" } },
  audit: { ...jsonFlag, "--design-system": { value: true, key: "designSystem" }, "--versions": { value: false, key: "versions" } },
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
  expect: [2, 2],
  get: [1, 2],
  delete: [2, 2],
  shoot: [1, 2],
  snap: [1, 2],
  preview: [1, 2],
  status: [1, 2],
  readiness: [1, 1],
  publish: [1, 1],
  usages: [1, 1],
  promote: [1, 1],
  // `provenance <componentId> <figma.json>`; литерал `null` вместо файла — явная очистка.
  provenance: [2, 2],
  accept: [1, 1],
  "accept-status": [1, 1],
  reject: [1, 1],
  impact: [1, 1],
  // `case-set put <componentId> <manifest.json>` (3) | `case-set get|coverage <caseSetId>` (2).
  "case-set": [2, 3],
  // 0 — каталожный sweep `audit --design-system`, 1 — подкоманда `audit reuse`.
  audit: [0, 1],
});

export function parseArgs(argv) {
  const [command, ...tokens] = argv;
  const range = ranges[command];
  if (!range) invalid(command ? `unknown command: ${command}` : "command is required");
  // Значение глобального `--cache-dir` не должно быть принято за подкоманду (`catalog <тут>`).
  const firstPositional = (names) => {
    const valueFlags = new Set([...names, ...CACHE_VALUE_FLAGS]);
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (!token.startsWith("--")) return token;
      if (valueFlags.has(token)) index += 1;
    }
    return null;
  };
  const catalogFirst = command === "catalog" ? firstPositional(["--intent", "--limit", "--kind", "--doc"]) : null;
  const compositionFirst = command === "composition" ? firstPositional(["--design-system"]) : null;
  // `audit reuse` — чтение аудита гейта; у него собственный набор флагов, поэтому подкоманда
  // распознаётся до разбора флагов, как у `catalog list|search|get`.
  const auditFirst = command === "audit" ? firstPositional(["--design-system", "--actor", "--since", "--limit", "--min-attempts"]) : null;
  const catalogSubcommand = ["list", "search", "get"].includes(catalogFirst) ? catalogFirst : null;
  const compositionSubcommand = compositionFirst === "publish" ? "publish" : null;
  const auditSubcommand = auditFirst === "reuse" ? "reuse" : null;
  const commandForm = catalogSubcommand ? `catalog ${catalogSubcommand}`
    : compositionSubcommand ? "composition publish"
    : auditSubcommand ? "audit reuse"
    : command;
  const specs = { ...CACHE_FLAGS, ...(flagSpecs[commandForm] ?? {}) };
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
    // R8a: escape-hatch локального браузера не сохраняется — вместо «unknown flag» объясняем,
    // почему его нет, чтобы старый сценарий не искал опечатку.
    if (!spec && token === "--local-browser") {
      invalid("--local-browser is gone: every capture runs on the server renderer (GET /api/capabilities → renderer)");
    }
    if (!spec) invalid(`unknown flag for ${commandForm}: ${token}`);
    // `repeat` — единственное исключение из «повтор флага = опечатка»: у таких флагов значения
    // копятся списком (`--acceptance-run` под multi-run W7).
    if (seen.has(token) && !spec.repeat) invalid(`duplicate flag: ${token}`);
    seen.add(token);
    if (!spec.value) {
      flags[spec.key] = true;
      continue;
    }
    const value = tokens[++i];
    if (value === undefined || value.startsWith("--")) invalid(`flag ${token} requires a value`);
    if (spec.enum && !spec.enum.includes(value)) invalid(`${token} must be one of: ${spec.enum.join(", ")}`);
    const parsed = spec.parse ? spec.parse(value) : value;
    if (spec.repeat) flags[spec.key] = [...(flags[spec.key] ?? []), parsed];
    else flags[spec.key] = parsed;
  }
  if (positionals.length < range[0] || positionals.length > range[1]) invalid(`invalid arguments for ${commandForm}`);
  if (commandForm === "catalog list" && positionals.length !== 2) invalid("invalid arguments for catalog list");
  if (commandForm === "catalog search") {
    if (positionals.length !== 2) invalid("invalid arguments for catalog search");
    if (flags.intent === undefined) invalid("catalog search requires --intent <text>");
    if (flags.doc !== undefined && flags.kind !== "composition") invalid("catalog search --doc requires --kind composition");
  }
  if (commandForm === "catalog get" && positionals.length < 3) invalid("catalog get requires at least one artifact");
  if (commandForm === "catalog" && positionals.length > 2) invalid("invalid arguments for catalog");
  if (command === "component-move" && flags.designSystem === undefined) invalid("component-move requires --design-system <id>");
  if (command === "component" && flags.forceNew && flags.reason === undefined) invalid("component --force-new requires --reason <text>");
  if (commandForm === "composition" && flags.designSystem === undefined) invalid("composition requires --design-system <id>");
  if (commandForm === "audit reuse" && positionals.length !== 1) invalid("invalid arguments for audit reuse");
  // `--design-system` обязателен только у каталожного sweep: аудит гейта по построению
  // сквозной, дизайн-система в нём — необязательный фильтр.
  // `audit --versions` — KPI-срез по версиям (RFC candidate-acceptance §9): дизайн-система
  // здесь необязательный фильтр, в отличие от каталожного sweep'а.
  if (commandForm === "audit" && !flags.versions && flags.designSystem === undefined) invalid("audit requires --design-system <id> or --versions");
  if (commandForm === "audit" && positionals.length !== 0) invalid("invalid arguments for audit");
  // `case-set` — подкоманда в первом позиционале (канон `catalog list|search|get`); арность
  // проверяется здесь, чтобы `case-set get a.json b.json` не уехало в сервер как «лишний» аргумент.
  if (command === "case-set") {
    const [subcommand] = positionals;
    if (!["put", "validate", "get", "coverage"].includes(subcommand)) invalid("case-set requires a subcommand: put | validate | get | coverage");
    if (subcommand === "put" && positionals.length !== 3) invalid("usage: case-set put <componentId> <manifest.json>");
    // `validate` берёт componentId из самого манифеста (поле обязательное), поэтому позиционал
    // ровно один: дублировать id руками — способ разъехаться с манифестом.
    if (subcommand === "validate" && positionals.length !== 2) invalid("usage: case-set validate <manifest.json>");
    if (subcommand !== "put" && subcommand !== "validate" && positionals.length !== 2) invalid(`usage: case-set ${subcommand} <caseSetId>`);
  }
  // `impact` — dry-run отчёт (W6): обе стороны сравнения обязаны быть названы явно, иначе
  // «импакт компонента» ничего не значит.
  if (command === "impact" && (flags.candidate === undefined || flags.baselineRun === undefined)) {
    invalid("usage: impact <componentId> --candidate <candidateId> --baseline-run <runId>");
  }
  // `--recapture` — эскалация скоупа уже выбранных случаев, поэтому с `--refresh none`
  // («ничего не обновлять») он противоречив: два решения об одном ране не должны конфликтовать молча.
  if (command === "accept" && flags.recapture && flags.refresh === "none") {
    invalid("--recapture contradicts --refresh none: --refresh picks which cases to update, --recapture only deepens their scope to a re-capture");
  }
  if (command === "status" && positionals.length < 2 && !flags.allScreens) invalid("status requires <screenId> or --all-screens");
  if (command === "preview" && positionals.length === 2 && flags.example !== undefined) invalid("preview accepts either props.json or --example, not both");
  return { cmd: command, args: positionals, flags };
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Retries only transient server-side failures; the auth session is minted once per process. */
export const RETRY_BACKOFF_MS = [500, 1500];
const isTransient = (status) => status >= 500;

/**
 * Единственная точка HTTP драйвера — и единственная точка клиентского кэша (W7).
 *
 * Кэшируются только read-only GET'ы из allowlist'а `classify` (`cache.mjs`): каталог,
 * capabilities, case-set'ы, кандидаты, **терминальные** раны. Мутации, auth и нетерминальные
 * раны не кэшируются никогда, поэтому poll идущего рана по-прежнему ходит на сервер.
 */
async function call(method, path, body, options = {}) {
  // `noCache` — прямой сетевой запрос мимо чтения кэша (запись при этом обновляется). Нужен
  // там, где ответ мутабелен и «свежий по TTL» ≠ «актуальный»: автовыбор связки promote читает
  // раны кандидата только с сервера (план 2026-08-04 §W2b, C22).
  const hit = options.noCache === true ? null : await cache.read(method, path, body);
  // `cached: true` — ответ пришёл с диска, а не из сети. Флаг нужен вызывающему, который
  // делает из ответа вывод о **существовании** ресурса: отрицательный вывод из кэша не
  // авторитетен (план 2026-08-04 §W4, existence-provenance).
  if (hit) return { status: hit.status, json: hit.json ?? null, cached: true };
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
    const etag = response.headers.get("etag") ?? undefined;
    const text = await response.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (isTransient(response.status) && attempt < retries) continue;
    // `apiVersion` входит в ключ кэша: capabilities — единственный источник, откуда клиент
    // его узнаёт, и версия запоминается на идентичность (см. cache.mjs meta.json).
    if (path === "/capabilities" && response.status === 200) await cache.learn(json);
    await cache.write(method, path, body, { status: response.status, json, etag });
    return { status: response.status, json };
  }
  throw lastError;
}

function errorCode(response) {
  return response.json?.error?.code;
}

/**
 * Короткие человеческие формулировки поверх серверного `message` для кодов, у которых
 * сырой текст не говорит, что делать дальше (план agent-iteration DX, P5.2).
 */
const ERROR_HINTS = Object.freeze({
  already_published: (failure) => `nothing to publish: rev ${failure.currentRev ?? "?"} is already the published version — the head revision is identical to it`,
  queue_full: () => "screenshot queue is full on the server (concurrency 1, cap 5); retry later — 'preview' retries this automatically",
});

/** Одна строка issue из конверта ошибки: pointer уже посчитан сервером (RFC 6901). */
function issueLine(issue) {
  const where = typeof issue?.pointer === "string" ? issue.pointer
    : Array.isArray(issue?.path) ? `/${issue.path.join("/")}`
    : typeof issue?.path === "string" ? issue.path
    : "/";
  return `  issue ${where}: ${issue?.message ?? JSON.stringify(issue)}`;
}

/**
 * Единая точка форматирования ошибок API. Сервер отвечает конвертом
 * `{error: {code, message, ...details}}` (server/http.ts errorResponse): печатаем
 * человекочитаемый текст (сообщение + подсказка по коду + issues), сырой JSON —
 * только fallback для нестандартных ответов. В `--json` код и флаг retryable
 * сохраняются в payload на stdout, человекочитаемый текст остаётся на stderr.
 */
function requestFailed(step, response) {
  const failure = response.json?.error;
  const authHint = response.status === 401 ? "\nhint: set EASYUI_USERNAME/EASYUI_PASSWORD and, during the transition, EASYUI_LEGACY_BASIC_AUTH" : "";
  if (!failure || typeof failure !== "object" || typeof failure.message !== "string") {
    throw new CliError(`${step} failed (${response.status}): ${JSON.stringify(response.json, null, 2)}${authHint}`);
  }
  const code = typeof failure.code === "string" ? failure.code : "unknown";
  const lines = [`${step} failed (${response.status} ${code}): ${failure.message}`];
  if (code === "invalid_request" && failure.message === "Component source and design system are unchanged") {
    lines.push("nothing to save: the source is identical to the head revision");
  }
  const hint = ERROR_HINTS[code]?.(failure);
  if (hint) lines.push(hint);
  if (Array.isArray(failure.issues)) for (const issue of failure.issues.slice(0, 20)) lines.push(issueLine(issue));
  if (jsonMode) report(null, { failed: true, step, status: response.status, code, message: failure.message, retryable: failure.retryable === true, details: failure });
  throw new CliError(`${lines.join("\n")}${authHint}`);
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

/**
 * Existence lookup и его происхождение (план 2026-08-04 §W4, P1-5).
 *
 * Отрицательный ответ о ресурсе стоит дороже положительного: из «не нашли» клиент делает
 * вывод «не существует» и прекращает работу (`components/<id> not found` — терминальная
 * ошибка до создания рана). Поэтому у каждого такого вывода есть происхождение:
 *
 *   `list-cache`     — вывод сделан из **агрегированного** ответа (каталожный манифест),
 *                      к тому же кэшированного: отсутствие в списке ≠ 404 конкретного id
 *                      (манифест перечисляет только опубликованные версии, драфта там нет
 *                      никогда, а `fresh`-окно списка — 5 минут);
 *   `direct-cache`   — прямой `GET /<kind>/<id>`, отданный клиентским кэшем;
 *   `direct-network` — прямой `GET /<kind>/<id>`, полученный от сервера в этом вызове.
 *
 * Правило: **отрицательный** результат с провенансом ≠ `direct-network` не объявляется
 * «not found» — сначала ровно один принудительный прямой сетевой запрос (`noCache`), и
 * только его 404 терминален. Ровно один: второй 404 подряд — это ответ сервера, а не
 * состояние кэша, и повторять запрос дальше бессмысленно.
 *
 * Мутационные пути (`accept`, `promote`, publish, save, delete, `case-set put`) дополнительно
 * требуют `direct-*`: у них из этого же ответа берётся `headRev` для CAS, поэтому «свежий по
 * TTL» их не устраивает — они читают ресурс `noCache` и получают `direct-network`.
 */
export const EXISTENCE_SOURCES = Object.freeze(["list-cache", "direct-cache", "direct-network"]);

/** Провенанс последнего existence-вывода — попадает в `--json` (`existence`) команд. */
let lastExistence = null;
const recordExistence = (source, refreshed, status) => (lastExistence = { source, refreshed, status });
/** `{existence}` для `--json`-отчёта: пусто, пока команда ничего не проверяла на существование. */
export const existenceReport = () => (lastExistence === null ? {} : { existence: lastExistence });

/**
 * Прямой existence-lookup. Возвращает `{value, provenance, refreshed, status}`: `value` —
 * метаданные или `null` (404), `provenance` — по таблице выше.
 */
async function lookupMeta(kind, id, { mutating = false } = {}) {
  const path = `/${kind}/${encodeURIComponent(id)}`;
  let response = await call("GET", path, undefined, mutating ? { noCache: true } : {});
  let provenance = response.cached === true ? "direct-cache" : "direct-network";
  let refreshed = false;
  if (response.status === 404 && provenance !== "direct-network") {
    response = await call("GET", path, undefined, { noCache: true });
    provenance = "direct-network";
    refreshed = true;
  }
  recordExistence(provenance, refreshed, response.status);
  // Принудительный перезапрос виден в логе: читателю важно, что «not found» — ответ сервера,
  // а не состояние кэша (и что за него заплачен один лишний round-trip).
  if (refreshed) progress(`existence: ${kind}/${id} re-checked directly (the cached answer was negative)`);
  const value = response.status === 404 ? null : await requireOk(`GET ${path}`, response);
  return { value, provenance, refreshed, status: response.status };
}

/**
 * Метаданные ресурса либо `null`. Тонкая обёртка над `lookupMeta`: провенанс вывода пишется
 * в отчёт (`existence` в `--json`), а не растекается по четырнадцати вызывающим.
 * `{mutating: true}` — путь, который после проверки мутирует ресурс: читает мимо кэша.
 */
async function getMeta(kind, id, options = {}) {
  return (await lookupMeta(kind, id, options)).value;
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

/**
 * Поверхность экрана мульти-поверхностного документа (`doc.surfaces`, формат D1–D3).
 *
 * Оборонительно: документ без `surfaces` (обычный случай) даёт `null`, неизвестный/отсутствующий
 * тег `screen.surface` — primary (`surfaces[0]`). Тем самым любое производное значение
 * (устройство, дизайн-система) у одно-поверхностных доков остаётся ровно прежним.
 */
export function surfaceOfScreen(doc, screen) {
  const surfaces = Array.isArray(doc?.surfaces) ? doc.surfaces.filter((surface) => surface && typeof surface === "object") : [];
  if (!surfaces.length) return null;
  const tagged = screen?.surface === undefined ? undefined : surfaces.find((surface) => surface.id === screen.surface);
  return tagged ?? surfaces[0] ?? null;
}

/**
 * Устройство экрана — от его **поверхности** (D10/D14), а не от `doc.device`: у дуо-дока
 * КСО-поверхность desktop, а приложение mobile, и вьюпорт съёмки обязан различаться.
 * Фолбэк — `doc.device` (и `desktop`, если и его нет), то есть прежнее поведение.
 */
export function screenDevice(doc, screen) {
  return surfaceOfScreen(doc, screen)?.device ?? doc?.device ?? "desktop";
}

/**
 * Дизайн-система экрана — от его поверхности (`surface.designSystem`, дефолт — `doc.designSystem`,
 * D3/D8). Нужна там, где драйвер тянет каталог/шкалу спейсинга под конкретный экран (geometry).
 */
export function screenDesignSystem(doc, screen) {
  return surfaceOfScreen(doc, screen)?.designSystem ?? doc?.designSystem;
}

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
    const viewport = resolveViewport(screen, options.viewport, screenDevice(draft.doc, screen));
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
  const lines = [
    `catalog search ${result.designSystem}: ${result.candidates.length} candidates at ${result.catalogRevision}`,
    "kind\tid\tname\tversion\tscore\tblocking\tdeprecated\treasons",
    ...result.candidates.map((candidate) => `${candidate.kind}\t${candidate.id}\t${candidate.name}\t${candidate.version || "draft"}\t${candidate.score}\t${candidate.blocking ? "yes" : "no"}\t${candidate.deprecated ? "yes" : "no"}\t${candidate.reasons.join("; ")}`),
  ];
  // Композиционный поиск (W9): три исхода **рекомендательные** — сервер ничего не запрещает,
  // 409 переиспользования на композиции не выдаётся. Решение остаётся за автором.
  if (result.outcome !== undefined) {
    lines.push(
      `outcome: ${result.outcome}${result.analyzerVerdict === undefined ? "" : ` (analyzer: ${result.analyzerVerdict})`}`,
      `why: ${result.explanation}`,
    );
    if (result.matches?.length) {
      lines.push("match\tkind\tid\tscore\tblocking\twhy");
      for (const match of result.matches) {
        lines.push(`match\t${match.kind}\t${match.id}\t${match.score}\t${match.blocking ? "yes" : "no"}\t${match.why}`);
      }
    }
    const impact = result.dependencyImpact;
    if (impact) {
      for (const component of impact.components) lines.push(`depends on component ${component.name}: ${component.headUsageCount} head usages, ${component.immutableUsageCount} pinned`);
      for (const composition of impact.compositions) lines.push(`depends on composition ${composition.id}: ${composition.headUsageCount} head usages, ${composition.immutableUsageCount} pinned`);
      if (impact.unknownTypes.length) lines.push(`unknown types in the design system: ${impact.unknownTypes.join(", ")}`);
    }
    for (const entry of result.analysis?.unsupported ?? []) lines.push(`unsupported ${entry.feature} at ${entry.elementKey}: ${entry.hint}`);
  }
  return lines;
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
  const viewport = assertViewportPixelBudget(resolveViewport(screen, undefined, screenDevice(draft.doc, screen)), 1);
  // Каталог и шкала спейсинга — от ДС **поверхности** экрана: на дуо-доке замер второй
  // поверхности иначе разбирался бы определениями чужой системы (D8/D14, R3-M6).
  const designSystem = screenDesignSystem(draft.doc, screen);
  const [system, manifest] = await Promise.all([
    requireOk("design system", await call("GET", `/design-systems/${encodeURIComponent(designSystem)}`)),
    requireOk("catalog manifest", await call("GET", `/catalog/manifest?designSystem=${encodeURIComponent(designSystem)}`)),
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

// --- expect: числовая приёмка геометрии против выписки из Figma (план agent-iteration DX, P4) ---

/** Допуск по умолчанию: субпиксельный layout и округление до 0.01 px дают расхождение до 1 px. */
export const DEFAULT_EXPECT_TOLERANCE = 1;
const EXPECT_ELEMENT_KEYS = new Set(["key", "instance", "size", "gap", "padding", "axis", "tolerance"]);
const PADDING_SIDES = ["top", "right", "bottom", "left"];

/**
 * Actual — это geometry-результат: `driver.mjs geometry <proto> <screen> --json` (прототипная
 * поверхность) либо `driver.mjs preview <id> --probe geometry [--rev head-draft] --json`
 * (компонентная). Принимаем и сырой результат джобы, и обёртки `{result}`/`{geometry}`.
 */
export function readGeometryRects(document) {
  const source = [document, document?.result, document?.geometry].find((value) => Array.isArray(value?.rects));
  if (!source) throw new Error("actual geometry JSON has no rects[]; pass the --json output of 'driver.mjs geometry' or 'driver.mjs preview --probe geometry'");
  return source.rects;
}

/** Прямые дети маркера в geometry-замере; скрытые не участвуют в gap/padding. */
export function directChildren(rects, rect) {
  return rects.filter((item) => item.parentKey === rect.key && (item.parentInstance ?? 0) === rect.instance && item.hidden !== true);
}

/**
 * Ось раскладки: явная из expected, иначе computed `flexDirection` layout owner'а, иначе
 * вывод из самих прямоугольников (непересекающиеся по вертикали дети — колонка).
 */
export function resolveAxis(rect, children, override) {
  if (override) return override;
  const direction = rect.layoutContext?.flexDirection;
  if (typeof direction === "string" && direction.length) return direction.startsWith("column") ? "column" : "row";
  const byY = [...children].sort((a, b) => a.y - b.y);
  const columnLike = byY.every((item, index) => index === 0 || item.y >= byY[index - 1].y + byY[index - 1].height - 0.01);
  return columnLike && children.length > 1 ? "column" : "row";
}

/** Наблюдаемые зазоры между соседними детьми по оси (может отличаться от CSS gap из-за margins). */
export function observedGaps(children, axis) {
  const vertical = axis === "column";
  const sorted = [...children].sort((a, b) => (vertical ? a.y - b.y : a.x - b.x));
  return sorted.slice(1).map((item, index) => {
    const previous = sorted[index];
    const value = vertical ? item.y - (previous.y + previous.height) : item.x - (previous.x + previous.width);
    return Math.round((value + Number.EPSILON) * 100) / 100;
  });
}

/** Наблюдаемые отступы: зазор между box'ом элемента и bounding box'ом его прямых детей. */
export function observedPadding(rect, children) {
  if (!children.length) return null;
  const left = Math.min(...children.map((item) => item.x));
  const top = Math.min(...children.map((item) => item.y));
  const right = Math.max(...children.map((item) => item.x + item.width));
  const bottom = Math.max(...children.map((item) => item.y + item.height));
  const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
  return {
    top: round(top - rect.y),
    left: round(left - rect.x),
    right: round(rect.x + rect.width - right),
    bottom: round(rect.y + rect.height - bottom),
  };
}

function expectNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

/** Нормализация одной записи expected.json — формат описан в скилле авторинга (§expect). */
function normalizeExpectation(entry, index) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`elements[${index}] must be an object`);
  for (const key of Object.keys(entry)) {
    if (!EXPECT_ELEMENT_KEYS.has(key)) throw new Error(`elements[${index}] has an unknown field ${key}; allowed: ${[...EXPECT_ELEMENT_KEYS].join(", ")}`);
  }
  if (typeof entry.key !== "string" || !entry.key.length) throw new Error(`elements[${index}].key must be a non-empty string`);
  const instance = entry.instance === undefined ? 0 : expectNumber(entry.instance, `elements[${index}].instance`);
  let size;
  if (entry.size !== undefined) {
    if (entry.size === null || typeof entry.size !== "object" || Array.isArray(entry.size)) throw new Error(`elements[${index}].size must be an object {width?,height?}`);
    for (const key of Object.keys(entry.size)) if (key !== "width" && key !== "height") throw new Error(`elements[${index}].size has an unknown field ${key}`);
    size = {};
    if (entry.size.width !== undefined) size.width = expectNumber(entry.size.width, `elements[${index}].size.width`);
    if (entry.size.height !== undefined) size.height = expectNumber(entry.size.height, `elements[${index}].size.height`);
    if (!Object.keys(size).length) throw new Error(`elements[${index}].size must declare width and/or height`);
  }
  let gaps;
  if (entry.gap !== undefined) {
    gaps = Array.isArray(entry.gap)
      ? entry.gap.map((value, position) => expectNumber(value, `elements[${index}].gap[${position}]`))
      : [expectNumber(entry.gap, `elements[${index}].gap`)];
    if (!gaps.length) throw new Error(`elements[${index}].gap must not be an empty array`);
  }
  const uniformGap = entry.gap !== undefined && !Array.isArray(entry.gap);
  let padding;
  if (entry.padding !== undefined) {
    if (typeof entry.padding === "number") padding = Object.fromEntries(PADDING_SIDES.map((side) => [side, expectNumber(entry.padding, `elements[${index}].padding`)]));
    else if (entry.padding !== null && typeof entry.padding === "object" && !Array.isArray(entry.padding)) {
      for (const key of Object.keys(entry.padding)) if (!PADDING_SIDES.includes(key)) throw new Error(`elements[${index}].padding has an unknown side ${key}`);
      padding = Object.fromEntries(Object.entries(entry.padding).map(([side, value]) => [side, expectNumber(value, `elements[${index}].padding.${side}`)]));
      if (!Object.keys(padding).length) throw new Error(`elements[${index}].padding must declare at least one side`);
    } else throw new Error(`elements[${index}].padding must be a number or an object of sides`);
  }
  if (entry.axis !== undefined && entry.axis !== "row" && entry.axis !== "column") throw new Error(`elements[${index}].axis must be "row" or "column"`);
  if (size === undefined && gaps === undefined && padding === undefined) throw new Error(`elements[${index}] declares nothing to check (size/gap/padding)`);
  return {
    key: entry.key, instance, size, gaps, uniformGap, padding, axis: entry.axis,
    tolerance: entry.tolerance === undefined ? undefined : expectNumber(entry.tolerance, `elements[${index}].tolerance`),
  };
}

/** Разбор expected.json: агент пишет его из выписки Figma, поэтому ошибки формата — явные. */
export function parseExpectations(document, cliTolerance) {
  if (document === null || typeof document !== "object" || Array.isArray(document)) throw new Error("expected.json must contain a JSON object");
  for (const key of Object.keys(document)) {
    if (!["tolerance", "elements", "note"].includes(key)) throw new Error(`expected.json has an unknown field ${key}; allowed: tolerance, elements, note`);
  }
  if (!Array.isArray(document.elements) || !document.elements.length) throw new Error("expected.json must contain a non-empty elements[]");
  const tolerance = cliTolerance ?? (document.tolerance === undefined ? DEFAULT_EXPECT_TOLERANCE : expectNumber(document.tolerance, "tolerance"));
  if (tolerance < 0) throw new Error("tolerance must be non-negative");
  return { tolerance, elements: document.elements.map(normalizeExpectation) };
}

/**
 * Числовой вердикт до пиксельного: сравнение размеров/gap/паддингов замера с выпиской из
 * Figma. Чистая функция — CLI-тест проверяет форматирование без сервера.
 */
export function evaluateExpectations(expectations, rects) {
  const checks = [];
  for (const element of expectations.elements) {
    const tolerance = element.tolerance ?? expectations.tolerance;
    const label = `${element.key}#${element.instance}`;
    const rect = rects.find((item) => item.key === element.key && (item.instance ?? 0) === element.instance);
    if (!rect) {
      checks.push({ label, metric: "rect", ok: false, message: `${label}: not measured (keys in actual: ${[...new Set(rects.map((item) => item.key))].join(", ") || "none"})` });
      continue;
    }
    const children = directChildren(rects, rect);
    if (element.size) {
      for (const [side, expectedValue] of Object.entries(element.size)) {
        const actual = rect[side];
        const ok = Math.abs(actual - expectedValue) <= tolerance;
        checks.push({ label, metric: side, expected: expectedValue, actual, ok, message: `${label}: ${side} expected ${expectedValue}, got ${actual}` });
      }
    }
    if (element.gaps) {
      const axis = resolveAxis(rect, children, element.axis);
      const observed = observedGaps(children, axis);
      if (!observed.length) {
        checks.push({ label, metric: "gap", ok: false, message: `${label}: gap expected ${element.gaps.join(", ")}, got nothing measurable (fewer than two visible child markers)` });
      } else if (!element.uniformGap && element.gaps.length !== observed.length) {
        checks.push({ label, metric: "gap", ok: false, message: `${label}: expected ${element.gaps.length} gaps, measured ${observed.length} (${observed.join(", ")})` });
      } else {
        observed.forEach((actual, index) => {
          const expectedValue = element.uniformGap ? element.gaps[0] : element.gaps[index];
          const ok = Math.abs(actual - expectedValue) <= tolerance;
          const name = observed.length > 1 ? `gap[${index}]` : "gap";
          checks.push({ label, metric: name, expected: expectedValue, actual, ok, axis, message: `${label}: ${name} expected ${expectedValue}, got ${actual}` });
        });
      }
    }
    if (element.padding) {
      const observed = observedPadding(rect, children);
      if (!observed) {
        checks.push({ label, metric: "padding", ok: false, message: `${label}: padding expected, got nothing measurable (no visible child markers)` });
      } else {
        for (const side of PADDING_SIDES) {
          if (element.padding[side] === undefined) continue;
          const actual = observed[side];
          const ok = Math.abs(actual - element.padding[side]) <= tolerance;
          checks.push({ label, metric: `padding.${side}`, expected: element.padding[side], actual, ok, message: `${label}: padding.${side} expected ${element.padding[side]}, got ${actual}` });
        }
      }
    }
  }
  const mismatches = checks.filter((check) => !check.ok);
  return { tolerance: expectations.tolerance, checks, mismatches };
}

export function expectLines(evaluation, expectedPath, actualPath) {
  return [
    `expect ${expectedPath} vs ${actualPath}: ${evaluation.checks.length} checks, ${evaluation.mismatches.length} mismatch${evaluation.mismatches.length === 1 ? "" : "es"} (tolerance ±${evaluation.tolerance}px)`,
    ...evaluation.checks.map((check) => `${check.ok ? "ok  " : "FAIL"} ${check.message}`),
  ];
}

export const expectExitCode = (evaluation) => (evaluation.mismatches.length ? EXIT.productErrors : EXIT.ok);

async function readJsonArgument(path, label) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    invalid(`${label} cannot be read: ${path} (${error.code ?? error.message})`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    invalid(`${label} is not valid JSON: ${path} (${error.message})`);
  }
}

/** `expect <expected.json> <actual.json>` — оффлайновый верб, сети не касается. */
async function runExpect(args, flags) {
  const [expectedPath, actualPath] = args;
  const expectedDocument = await readJsonArgument(expectedPath, "expected.json");
  const actualDocument = await readJsonArgument(actualPath, "actual.json");
  let expectations;
  let rects;
  try {
    expectations = parseExpectations(expectedDocument, flags.tolerance);
    rects = readGeometryRects(actualDocument);
  } catch (error) {
    throw new CliError(error.message);
  }
  const evaluation = evaluateExpectations(expectations, rects);
  const exitCode = expectExitCode(evaluation);
  report(expectLines(evaluation, expectedPath, actualPath), {
    command: "expect", expected: expectedPath, actual: actualPath,
    tolerance: evaluation.tolerance, exitCode,
    checks: evaluation.checks.map(({ label, metric, expected, actual, ok, message }) => ({ element: label, metric, expected, actual, ok, message })),
    mismatches: evaluation.mismatches.length,
  });
  if (exitCode !== EXIT.ok) {
    throw new CliError(`geometry does not match ${expectedPath}: ${evaluation.mismatches.map((check) => check.message).join("; ")}`, { exitCode });
  }
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

/**
 * Типизированные коды капчура (R3) одного кадра, собранные из всех источников, которые их
 * публикуют: терминальный `failure` джобы (HTTP-контракт `GET /screenshot-jobs/:id`),
 * `verdict.codes` receipt'а (readiness) и `renderer.drift` (расхождение объявленного и
 * наблюдённого рендерера, доехавшее с выключенной строгой сверкой).
 *
 * Дедупликация по тройке `code|severity|detail`: один и тот же код может приехать и джобой, и
 * receipt'ом — печатать его дважды значит врать о числе причин.
 */
export function captureCodes(state, receipt) {
  const codes = [];
  const seen = new Set();
  const push = (code) => {
    if (!code || typeof code.code !== "string") return;
    const entry = { code: code.code, severity: code.severity ?? "error", detail: code.detail ?? "" };
    const key = `${entry.code}|${entry.severity}|${entry.detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    codes.push(entry);
  };
  if (state?.failure?.code) push({ code: state.failure.code, severity: "error", detail: state.failure.message ?? "" });
  // Коды readiness есть прямо в результате джобы (R3) — receipt для них не обязателен.
  for (const code of state?.result?.readinessCodes ?? []) push(code);
  for (const code of receipt?.verdict?.codes ?? []) push(code);
  for (const code of receipt?.renderer?.drift ?? []) push(code);
  return codes;
}

/**
 * Свидетельство происхождения кадра для `--json` (R8b): адрес receipt'а, отпечаток рендерера и
 * типизированные коды. Отпечаток берётся из результата джобы (`result.renderer`, R1) — он есть и
 * без чтения receipt'а; документ receipt'а, если он прочитан, уточняет коды и служит фолбэком
 * для старых результатов. Ничего не выдумываем: неизвестное — `null`.
 */
export function captureReceiptEvidence(state, receiptDocument) {
  const result = state?.result ?? {};
  const receipt = receiptDocument?.receipt ?? null;
  const declared = result.renderer ?? receipt?.renderer ?? null;
  return {
    receiptSha256: result.receiptSha256 ?? receiptDocument?.receiptSha256 ?? null,
    renderer: declared === null ? null : {
      rendererFingerprint: declared.fingerprint ?? null,
      rendererVersion: declared.rendererVersion ?? null,
      source: declared.source ?? null,
      browserVersion: declared.browserVersion ?? null,
    },
    codes: captureCodes(state, receipt),
  };
}

/**
 * Документ receipt'а джобы. Ручка **job-scoped** (N12: ручки «по sha» нет), а чтение — мягкое:
 * receipts могут быть выключены kill-switch'ем, вытеснены свипером или отсутствовать на сборке
 * до волны R5. Ни один из этих случаев не имеет права уронить съёмку — кадр уже снят.
 */
async function fetchReceipt(jobId) {
  try {
    const response = await call("GET", `/screenshot-jobs/${encodeURIComponent(jobId)}/receipt`);
    if (response.status !== 200 || !response.json?.receipt) {
      lastReceiptFailure = response.status === 200 ? "empty receipt" : `HTTP ${response.status}${response.status === 403 ? " forbidden (owner changed?)" : ""}`;
      return null;
    }
    lastReceiptFailure = null;
    return response.json;
  } catch (error) { lastReceiptFailure = String(error?.message ?? error); return null; }
}
let lastReceiptFailure = null;

/**
 * Свидетельство одной джобы. Документ receipt'а тянем только когда он кому-то нужен: файл
 * `--receipt` или `--json` (там коды readiness видны только через receipt).
 */
async function captureEvidence(jobId, state, wantDocument) {
  const document = wantDocument && jobId ? await fetchReceipt(jobId) : null;
  return { ...captureReceiptEvidence(state, document), document };
}

async function writeReceiptFile(path, payload) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`);
}

/** snap contract: 1 when any screen produced no PNG, 2 when PNGs carry product errors, else 0. */
export function snapExitCode(rows) {
  if (rows.some((row) => !row.imageProduced)) return EXIT.failed;
  if (rows.some((row) => row.productErrors.length > 0)) return EXIT.productErrors;
  return EXIT.ok;
}

/** Infra failures (job error/timeout, 5xx) get one more attempt; product errors never do. */
export const SNAP_ATTEMPTS = 2;

async function snapScreen(id, screenId, outputDir, surface, wantReceipt = false) {
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
    const jobId = queued.json.jobId;
    const state = await pollJob(`/screenshot-jobs/${encodeURIComponent(jobId)}`, { deadlineMs: 60_000 });
    if (state.status !== "done") { failure = `screenshot ${state.status}: ${JSON.stringify(state)}`; continue; }
    const summary = summarizeCapture(state.result);
    const path = `${outputDir}/${screenId}.png`;
    if (summary.imageProduced) await downloadImage(state.result.imageUrl, path);
    // Свидетельство происхождения кадра (R8b) — на том же jobId, что и сам кадр.
    // Документ receipt тянем только под --receipt: в --json коды readiness и отпечаток берутся
    // из результата джобы, а лишний HTTP-раунд на каждый экран делал горячий путь флаки (R8b).
    const evidence = await captureEvidence(jobId, state, wantReceipt);
    return {
      screenId, attempts: attempt, viewport: surface.viewport,
      failure: summary.imageProduced ? null : "job reported no image",
      path: summary.imageProduced ? path : null, ...summary,
      jobId, receiptSha256: evidence.receiptSha256, renderer: evidence.renderer, codes: evidence.codes,
      receiptDocument: evidence.document,
    };
  }
  return {
    screenId, attempts: SNAP_ATTEMPTS, viewport: surface.viewport, failure, path: null,
    imageProduced: false, captureClean: false, productErrors: [], infraNoise: [], runtimeWarnings: [],
    jobId: null, receiptSha256: null, renderer: null, codes: [], receiptDocument: null,
  };
}

/**
 * План съёмки snap. Вьюпорт — canvas-aware, как у geometry/baseline: фиксированные 480x800
 * считали media queries по телефону даже для стикершита. Бюджет проверяется до постановки
 * заданий: превышение лимита ингеста ассетов иначе всплыло бы 413 после съёмки.
 */
export function buildSnapPlan(draft, flags = {}) {
  return draft.doc.screens.map((screen) => {
    const viewport = resolveViewport(screen, flags.viewport, screenDevice(draft.doc, screen));
    try {
      assertCaptureSurfaceBudget(captureSurface(screen, screenDevice(draft.doc, screen)), flags.dsf ?? 1);
      assertViewportPixelBudget(viewport, flags.dsf ?? 1);
    } catch (error) {
      throw new Error(`${screen.id}: ${error.message}`);
    }
    return { screenId: screen.id, viewport, deviceScaleFactor: flags.dsf, theme: flags.theme };
  });
}

/**
 * Предполётная сверка рендерера (R8a). Съёмка идёт только на сервере, поэтому агент обязан
 * знать, **чем** сняли: сборка без манифеста (`source: "fallback"`) рисует локально
 * установленным браузером, и её кадры несопоставимы с эталонами прода. Проверка мягкая —
 * старый сервер без секции `renderer` и недоступные capabilities не должны валить съёмку.
 */
export function rendererPreflightWarning(capabilities) {
  const renderer = capabilities?.renderer;
  if (!renderer) return "server capabilities carry no renderer section: build predates the renderer contract, frames are not comparable to baselines";
  if (renderer.source === "fallback") {
    return `server renderer has no manifest (source: fallback, chromium ${renderer.browserVersion ?? "unknown"}): dev build, frames are not comparable to baselines`;
  }
  return null;
}

async function warnOnRenderer() {
  let capabilities;
  try {
    const response = await call("GET", "/capabilities");
    if (response.status !== 200) return;
    capabilities = response.json;
  } catch { return; }
  const warning = rendererPreflightWarning(capabilities);
  if (warning) console.error(`renderer: ${warning}`);
}

async function runSnap(args, flags, command = "snap") {
  const [id, outputDir = `author-shots/${id}`] = args;
  await warnOnRenderer();
  const draft = await requireOk("draft", await call("GET", `/prototypes/${encodeURIComponent(id)}/draft`));
  let plan;
  try { plan = buildSnapPlan(draft, flags); }
  catch (error) { throw new CliError(error.message); }
  await mkdir(outputDir, { recursive: true });
  const rows = [];
  const receipts = [];
  const wantReceipt = flags.receipt !== undefined;
  for (const surface of plan) {
    const { receiptDocument, ...row } = await snapScreen(id, surface.screenId, outputDir, surface, wantReceipt);
    rows.push(row);
    receipts.push({ screenId: surface.screenId, jobId: row.jobId, receiptSha256: row.receiptSha256, receipt: receiptDocument?.receipt ?? null });
    if (row.path) out(row.path);
    if (row.failure) console.error(`${surface.screenId}: ${row.failure}`);
    if (row.productErrors.length) console.error(`${surface.screenId} product errors:`, JSON.stringify(row.productErrors));
    if (row.codes.length) console.error(`${surface.screenId} capture codes:`, JSON.stringify(row.codes));
    if (row.infraNoise.length && !jsonMode) console.error(`${surface.screenId} infra noise (ignored):`, JSON.stringify(row.infraNoise));
  }
  if (wantReceipt) {
    // Один файл на команду: `snap` снимает все экраны прототипа, и receipt у каждого свой.
    await writeReceiptFile(flags.receipt, { command, prototypeId: id, rev: draft.rev, receipts });
    out(flags.receipt);
    if (receipts.every((entry) => entry.receipt === null)) {
      console.error(`receipt: server returned no capture receipt (${lastReceiptFailure ?? "receipts disabled, evicted, or a build older than the receipt contract"}); ${flags.receipt} carries nulls`);
    }
  }
  const exitCode = snapExitCode(rows);
  if (jsonMode) {
    report(null, {
      command, prototypeId: id, outputDir, rev: draft.rev, exitCode,
      // Применённые значения: сервер по умолчанию снимает dsf 1 в светлой теме.
      dsf: flags.dsf ?? 1, theme: flags.theme ?? "light",
      receipt: wantReceipt ? flags.receipt : null, screens: rows,
    });
  }
  if (exitCode === EXIT.productErrors) throw new CliError("screenshots produced with product errors", { exitCode: EXIT.productErrors });
  if (exitCode === EXIT.failed) throw new CliError("one or more screenshots produced no PNG", { exitCode: EXIT.failed });
}

/** Бэкофф ретрая постановки job'а при 429 queue_full (очередь сервера: concurrency 1, cap 5). */
export const QUEUE_RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000, 8000, 16000]);

/**
 * Единственный ретраимый ответ enqueue компонентной съёмки — переполненная очередь;
 * всё остальное (400/422/501) терминально и уходит в requireOk как есть. Заметка о
 * ретрае уходит на stderr в обоих режимах; факт ретрая попадает в --json payload.
 * URL параметризован: published-съёмка — `/versions/:v/screenshot`, драфт (P1b) —
 * `/head/screenshot`; у драфта 429 может прийти и от троттлинга validate-префлайта.
 */
async function enqueueComponentShot(id, urlPath, body) {
  let queueRetries = 0;
  for (let attempt = 0; ; attempt += 1) {
    const response = await call("POST", urlPath, body);
    if (response.status !== 429 || errorCode(response) !== "queue_full" || attempt >= QUEUE_RETRY_DELAYS_MS.length) {
      return { response, queueRetries };
    }
    queueRetries += 1;
    const wait = QUEUE_RETRY_DELAYS_MS[attempt];
    console.error(`preview ${id}: screenshot queue is full; retrying in ${wait / 1000}s (attempt ${queueRetries + 1} of ${QUEUE_RETRY_DELAYS_MS.length + 1})`);
    await delay(wait);
  }
}

/** Дефолтный путь PNG: author-shots/<id>/<id>-v<version>[-<example|props-стем>].png, как у snap. */
export function previewOutputPath(id, version, variant) {
  return `author-shots/${id}/${id}-v${version}${variant === undefined ? "" : `-${variant}`}.png`;
}

/** Дефолтный путь PNG драфт-превью (P1b): author-shots/<id>/<id>-draft-r<rev>[-<example|props-стем>].png. */
export function previewDraftOutputPath(id, rev, variant) {
  return `author-shots/${id}/${id}-draft-r${rev}${variant === undefined ? "" : `-${variant}`}.png`;
}

/**
 * `preview <componentId> [props.json]` — файл обязан содержать JSON-объект; битый путь или
 * не-JSON — ошибка аргументов (exit 1), а не сырой ENOENT посреди команды.
 */
async function readPropsArgument(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    invalid(`props file cannot be read: ${path} (${error.code ?? error.message})`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    invalid(`props file is not valid JSON: ${path} (${error.message})`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`props file must contain a JSON object: ${path}`);
  return value;
}

/**
 * `preview --probe geometry` (P1b + P4): geometry-замер компонентной поверхности вместо PNG.
 * Печатает те же строки rect'ов, что и прототипный `geometry`, и по `--out` кладёт сырой
 * результат джобы на диск — это готовый `actual.json` для `driver.mjs expect`.
 */
async function finishPreviewProbe(id, result, { flags, viewport, deviceScaleFactor, queueRetries, system, evidence }) {
  const summary = summarizeCapture(result);
  if (flags.out !== undefined) {
    await mkdir(dirname(flags.out), { recursive: true });
    await writeFile(flags.out, `${JSON.stringify(result, null, 2)}\n`);
  }
  const target = result.draftRev === undefined ? `v${result.version}` : `draft rev ${result.draftRev}`;
  out(`preview ${id} ${target} probe=geometry bundleHash=${result.bundleHash ?? "-"} designSystemMetaVersion=${result.designSystemMetaVersion ?? system.latestMetaVersion ?? "-"} viewport=${viewport.width}x${viewport.height} dsf=${deviceScaleFactor} rects=${result.rects.length}/${result.total}${result.truncated ? " truncated" : ""}`);
  for (const rect of result.rects) {
    out(`${rect.key}#${rect.instance} parent=${rect.parentKey === undefined ? "-" : `${rect.parentKey}#${rect.parentInstance}`} dom=${rect.domIndex} rect=${rect.x},${rect.y} ${rect.width}x${rect.height}${rect.hidden ? " hidden" : ""}`);
    out(`  layoutContext: ${rect.layoutContext ? JSON.stringify(rect.layoutContext) : "null"}`);
  }
  if (flags.out !== undefined) out(flags.out);
  if (summary.productErrors.length) console.error(`preview ${id} product errors:`, JSON.stringify(summary.productErrors));
  const exitCode = summary.productErrors.length ? EXIT.productErrors : EXIT.ok;
  if (jsonMode) {
    report(null, {
      command: "preview", componentId: id, probe: "geometry", ...existenceReport(),
      ...result, path: flags.out ?? null, queueRetries, exitCode,
      // Receipt измерительной джобы существует, но `output` в нём `null`: кадра здесь нет (C-M8).
      receiptSha256: evidence?.receiptSha256 ?? null, renderer: evidence?.renderer ?? null,
      codes: evidence?.codes ?? [], receipt: flags.receipt ?? null,
      captureClean: summary.captureClean, productErrors: summary.productErrors,
      infraNoise: summary.infraNoise, runtimeWarnings: summary.runtimeWarnings,
    });
  }
  if (exitCode !== EXIT.ok) throw new CliError("geometry probe reported product errors", { exitCode });
}

/**
 * Компонентная съёмка опубликованной head-версии (план agent-iteration DX, P1a) поверх
 * существующего `POST /components/:id/versions/:version/screenshot`. Вывод всегда сообщает,
 * что именно отрендерено: version / bundleHash / designSystemMetaVersion — пин темы,
 * который зафиксирует enqueue (компонентная съёмка берёт последнюю версию темы, поэтому
 * читаем `latestMetaVersion` до постановки job'а).
 *
 * `--rev head-draft` (P1b): съёмка сохранённой, но не опубликованной head-ревизии через
 * `POST /components/:id/head/screenshot` — сервер собирает эфемерный candidate-bundle
 * префлайтом validate, поэтому постановка может занять заметное время и ответить 429
 * validate_in_flight/queue_full (queue_full ретраится, как у published). Published-версии
 * для этого режима не требуется; capability `features.componentDraftPreview` проверяется
 * до постановки, чтобы kill-switch не маскировался под странный 404.
 */
async function runPreview(args, flags) {
  await warnOnRenderer();
  const [id, propsPath] = args;
  const draft = flags.rev === "head-draft";
  const probe = flags.probe === "geometry";
  const props = propsPath === undefined ? undefined : await readPropsArgument(propsPath);
  const meta = await getMeta("components", id);
  if (!meta) throw new CliError(`components/${id} not found; hint: run 'driver.mjs get components'`);
  let version;
  if (draft || probe) {
    const capabilities = await requireOk("capabilities", await call("GET", "/capabilities"));
    if (draft && capabilities.features?.componentDraftPreview !== true) {
      throw new CliError(`server does not support component draft preview (features.componentDraftPreview is off); drop --rev head-draft or enable the validate preflight`);
    }
    if (probe && capabilities.features?.componentGeometry !== true) {
      throw new CliError(`server does not support the component geometry probe (features.componentGeometry is off); drop --probe geometry and measure on a prototype probe screen instead`);
    }
  }
  if (!draft) {
    if (typeof meta.publishedVersion !== "number") {
      throw new CliError(`component ${id} has no published version; render the saved draft with --rev head-draft or publish first (driver.mjs component ...)`);
    }
    version = meta.publishedVersion;
  }
  const deviceScaleFactor = flags.dsf ?? 1;
  const viewport = flags.viewport ?? DESKTOP_VIEWPORT;
  try { assertViewportPixelBudget(viewport, deviceScaleFactor); }
  catch (error) { throw new CliError(error.message); }
  const system = await requireOk("design system", await call("GET", `/design-systems/${encodeURIComponent(meta.designSystem)}`));
  const encoded = encodeURIComponent(id);
  const { response, queueRetries } = await enqueueComponentShot(id, draft ? `/components/${encoded}/head/screenshot` : `/components/${encoded}/versions/${version}/screenshot`, {
    viewport,
    ...(flags.dsf === undefined ? {} : { deviceScaleFactor: flags.dsf }),
    ...(flags.theme === undefined ? {} : { theme: flags.theme }),
    ...(props === undefined ? {} : { props }),
    ...(flags.example === undefined ? {} : { exampleName: flags.example }),
    ...(probe ? { probe: "geometry" } : {}),
  });
  const queued = await requireOk("preview enqueue", response, [202]);
  const state = await pollJob(`/screenshot-jobs/${encodeURIComponent(queued.jobId)}`, { deadlineMs: 120_000 });
  if (state.status !== "done" || state.result?.kind !== (probe ? "geometry" : "image")) {
    throw new CliError(`preview ${state.status}: ${JSON.stringify(state.error ?? state)}`);
  }
  const wantReceipt = flags.receipt !== undefined;
  const evidence = await captureEvidence(queued.jobId, state, wantReceipt || jsonMode);
  if (wantReceipt) {
    await writeReceiptFile(flags.receipt, {
      command: "preview", componentId: id, jobId: queued.jobId, ...existenceReport(),
      receiptSha256: evidence.receiptSha256, receipt: evidence.document?.receipt ?? null,
    });
    out(flags.receipt);
    if (evidence.document === null) {
      console.error(`receipt: server returned no capture receipt (${lastReceiptFailure ?? "receipts disabled, evicted, or a build older than the receipt contract"}); ${flags.receipt} carries nulls`);
    }
  }
  if (evidence.codes.length) console.error(`preview ${id} capture codes:`, JSON.stringify(evidence.codes));
  if (probe) return finishPreviewProbe(id, state.result, { flags, viewport, deviceScaleFactor, queueRetries, system, evidence });
  const summary = summarizeCapture(state.result);
  const draftRev = draft ? state.result.draftRev : undefined;
  const variant = flags.example ?? (propsPath === undefined ? undefined : propsPath.replace(/\.json$/i, "").split("/").pop());
  const outputPath = flags.out ?? (draft ? previewDraftOutputPath(id, draftRev, variant) : previewOutputPath(id, version, variant));
  if (summary.imageProduced) {
    await mkdir(dirname(outputPath), { recursive: true });
    await downloadImage(state.result.imageUrl, outputPath);
  }
  const exitCode = !summary.imageProduced ? EXIT.failed : summary.productErrors.length ? EXIT.productErrors : EXIT.ok;
  const theme = flags.theme ?? "light";
  const pins = `preview ${id} ${draft ? `draft rev ${draftRev ?? "-"}` : `v${version}`} bundleHash=${state.result.bundleHash ?? "-"} designSystemMetaVersion=${system.latestMetaVersion ?? "-"} viewport=${viewport.width}x${viewport.height} dsf=${deviceScaleFactor} theme=${theme}${flags.example === undefined ? "" : ` example=${flags.example}`} receipt=${evidence.receiptSha256 ?? "-"}`;
  out(pins);
  if (summary.imageProduced) out(outputPath);
  if (summary.productErrors.length) console.error(`preview ${id} product errors:`, JSON.stringify(summary.productErrors));
  if (summary.infraNoise.length && !jsonMode) console.error(`preview ${id} infra noise (ignored):`, JSON.stringify(summary.infraNoise));
  if (jsonMode) {
    report(null, {
      command: "preview", componentId: id, ...existenceReport(),
      ...(draft ? { rev: "head-draft", draftRev: draftRev ?? null } : { version }),
      bundleHash: state.result.bundleHash ?? null,
      designSystemMetaVersion: system.latestMetaVersion ?? null,
      viewport, dsf: deviceScaleFactor, theme,
      ...(flags.example === undefined ? {} : { example: flags.example }),
      path: summary.imageProduced ? outputPath : null, queueRetries, exitCode, ...summary,
      receiptSha256: evidence.receiptSha256, renderer: evidence.renderer, codes: evidence.codes,
      receipt: wantReceipt ? flags.receipt : null,
    });
  }
  if (exitCode === EXIT.productErrors) throw new CliError("preview produced a PNG with product errors", { exitCode: EXIT.productErrors });
  if (exitCode === EXIT.failed) throw new CliError("preview produced no PNG", { exitCode: EXIT.failed });
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
  const meta = await getMeta("components", id, { mutating: true });
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
  const current = await getMeta(kind, id, { mutating: true });
  throw new CliError(`${step} failed (409 revision_conflict); current metadata:\n${JSON.stringify(current, null, 2)}\nnot retrying automatically; inspect the current revision and run the command again`);
}

/**
 * Каталог дизайн-системы. `direct: true` — принудительно мимо клиентского кэша: манифест
 * кэшируется на 5 минут (`cache.mjs` `fresh`), и вывод «такого артефакта нет» из тёплой
 * записи — тот самый негатив из списка, который не считается ответом о конкретном id (§W4).
 */
async function loadCatalog(id, { direct = false } = {}) {
  const encoded = encodeURIComponent(id);
  const options = direct ? { noCache: true } : {};
  const [manifest, system] = await Promise.all([
    call("GET", `/catalog/manifest?designSystem=${encoded}`, undefined, options),
    call("GET", `/design-systems/${encoded}`, undefined, options),
  ]);
  if (manifest.status === 404 || system.status === 404) {
    throw new CliError(`design system ${id} not found; hint: run 'driver.mjs get design-systems'`);
  }
  return {
    manifest: await requireOk(`GET /catalog/manifest?designSystem=${id}`, manifest),
    system: await requireOk(`GET /design-systems/${id}`, system),
    cached: manifest.cached === true || system.cached === true,
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
    if (flags.kind === "composition") {
      // Композиционный кандидат — только POST: тело документа в query не поместится.
      const doc = flags.doc === undefined ? undefined : await readJsonArgument(flags.doc, "--doc file");
      const result = await requireOk("catalog search", await call("POST", "/catalog/candidates", {
        designSystem: id,
        intent: flags.intent,
        ...(flags.limit === undefined ? {} : { limit: flags.limit }),
        proposed: { kind: "composition", ...(doc === undefined ? {} : { compositionDoc: doc }) },
      }));
      report(catalogSearchLines(result), { command: "catalog search", ...result });
      return;
    }
    const query = new URLSearchParams({ designSystem: id, intent: flags.intent });
    if (flags.limit !== undefined) query.set("limit", String(flags.limit));
    const result = await requireOk("catalog search", await call("GET", `/catalog/candidates?${query}`));
    report(catalogSearchLines(result), { command: "catalog search", ...result });
    return;
  }
  if (subcommand === "get") {
    const id = args[1];
    const requested = args.slice(2);
    let catalog = await loadCatalog(id);
    let refreshed = false;
    const findArtifact = (artifact) => {
      const custom = (catalog.manifest.components ?? []).find((component) => component.id === artifact || component.name === artifact);
      if (custom) return { kind: "custom", value: custom };
      const builtin = (catalog.system.components ?? []).find((component) => component.name === artifact);
      if (builtin) return { kind: "builtin", value: builtin };
      const host = (catalog.system.hostPrimitives ?? []).find((component) => component.name === artifact);
      if (host) return { kind: "host", value: host };
      return null;
    };
    const artifacts = [];
    for (const artifact of requested) {
      let found = findArtifact(artifact);
      // Негатив из **кэшированного списка** не авторитетен (§W4): ровно один принудительный
      // сетевой перечит каталога, и только после него «не найдено» — вердикт.
      if (!found && catalog.cached && !refreshed) {
        catalog = await loadCatalog(id, { direct: true });
        refreshed = true;
        found = findArtifact(artifact);
      }
      recordExistence(catalog.cached ? "list-cache" : "direct-network", refreshed, found ? 200 : 404);
      if (!found) throw new CliError(`catalog get ${id}: artifact ${artifact} not found; run 'catalog list ${id}' first`);
      if (found.kind === "custom") {
        const custom = found.value;
        const details = await requireOk(`catalog get ${artifact}`, await call("GET", `/components/${encodeURIComponent(custom.id)}/versions/${custom.version}`));
        artifacts.push({ kind: "custom", id: custom.id, name: custom.name, details });
        continue;
      }
      artifacts.push({ kind: found.kind, name: found.value.name, details: found.value });
    }
    report(catalogGetLines(id, artifacts), { command: "catalog get", designSystem: id, artifacts, ...existenceReport() });
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
  await warnOnRenderer();
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
  await warnOnRenderer();
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
 * RFC candidate-acceptance-pipeline (R1): приёмка головной ревизии одной командой —
 * `validate` (receipt с `sourceHash`) → `promote` (сага: stage готовыми артефактами,
 * import-верификация, activate + pinAssets + auto-supersede прочих active в одной
 * транзакции). Ровно одна публичная версия на принятый head вместо цепочки publish'ей
 * и ручных status-переходов.
 *
 * Терминальные отказы печатаются человеку и НЕ ретраятся: `revision_conflict` (голова
 * ушла), `source_hash_mismatch` (голова изменилась между validate и promote),
 * `already_published` (у ревизии уже есть версия), reuse-STOP'ы гейта каноничной роли.
 */
/**
 * `provenance <componentId> <figma.json|null> [--rev N]` (RFC candidate-acceptance §6, R3a) —
 * правка ссылки на Figma **без** новой ревизии и без новой версии. `null` вместо пути к файлу —
 * явная очистка (сервер пишет tombstone). Повтор идентичного значения дедуплицируется и
 * отвечает `unchanged: true`.
 */
async function runProvenance(args, flags) {
  const [id, figmaPath] = args;
  const capabilities = await requireOk("capabilities", await call("GET", "/capabilities"));
  if (capabilities.features?.acceptanceProvenance !== true) {
    throw new CliError("server does not support the provenance handle (features.acceptanceProvenance is off); upgrade the server or send --figma with 'driver.mjs component ...'");
  }
  const figma = figmaPath === "null" ? null : await readFigmaProvenance(figmaPath);
  const response = await call("PUT", `/components/${encodeURIComponent(id)}/provenance`, {
    ...(flags.rev === undefined ? {} : { rev: flags.rev }),
    figma,
  });
  const result = await requireOk("provenance", response);
  report(
    result.unchanged
      ? `provenance ${id} rev ${result.rev} unchanged`
      : `provenance ${id} rev ${result.rev} seq ${result.seq}`,
    { command: "provenance", id, ...result },
  );
}

/**
 * Локальный pre-flight линковки promote (план 2026-08-04 §W2a, корневая причина P0-1).
 *
 * Сервер принимает `candidateId`/`acceptanceRunId` в теле promote, но драйвер обязан проверить
 * связку **до** мутации: версия публикуется один раз, и «доказательная база» с чужим кандидатом
 * или раном не того компонента — не ошибка сети, а ложь в provenance. Проверяются три вещи:
 * кандидат описывает ту же сборку, что и validate-receipt (`sourceHash` + `rev` головы), ран
 * принадлежит этому компоненту и именно этому кандидату. Любое расхождение — `CliError` до POST.
 */
async function resolvePromoteAcceptance(id, meta, receipt, flags, capabilities) {
  const listed = [
    ...(flags.acceptanceRun === undefined ? [] : [flags.acceptanceRun].flat()),
    ...(flags.acceptanceRuns === undefined ? [] : [flags.acceptanceRuns].flat(2)),
  ];
  const runIds = [...new Set(listed)];
  if (runIds.length !== listed.length) {
    throw new CliError(`the same acceptance run is listed twice (${listed.join(", ")}); each shard of the family is one run`);
  }
  const candidateId = flags.candidate ?? null;
  if (candidateId === null && runIds.length === 0) return null;
  if (runIds.length > PROMOTE_MAX_ACCEPTANCE_RUNS) {
    throw new CliError(`promote accepts at most ${PROMOTE_MAX_ACCEPTANCE_RUNS} acceptance runs, got ${runIds.length}; a family that needs more shards should be split into components`);
  }
  const runId = runIds[0] ?? null;
  if (capabilities.features?.acceptanceMatrix !== true) {
    throw new CliError("--candidate/--acceptance-run need the matrix acceptance stack (features.acceptanceMatrix is off; needs EASYUI_ACCEPTANCE_MATRIX=1); promote without them publishes the validated head unlinked");
  }
  // Гейт возможности (C23): старый сервер отвергнет массив как unknown field уже после validate.
  // Узнать это до мутации — дешевле и честнее, чем читать код ошибки промаха.
  if (runIds.length > 1 && capabilities.features?.acceptanceMultiRunPromote !== true) {
    throw new CliError(`this server does not support multi-run promote (features.acceptanceMultiRunPromote is off): ${runIds.length} runs given (${runIds.join(", ")}); upgrade the server or promote a family that fits one run`);
  }
  const readCandidate = async (wanted) => {
    const response = await call("GET", `/component-candidates/${encodeURIComponent(wanted)}`);
    if (response.status === 404) throw new CliError(`candidate ${wanted} not found (expired or never created); re-run 'driver.mjs accept ${id}' to build a fresh one`);
    return requireOk(`GET /component-candidates/${wanted}`, response);
  };
  let candidate = candidateId === null ? null : await readCandidate(candidateId);
  const runs = [];
  // Набор проверяется поштучно и целиком: каждый ран — про этот компонент, и все раны — про
  // одного кандидата. Сервер проверит то же самое, но версия публикуется один раз, и «половина
  // семьи от чужой сборки» обязана останавливаться до POST.
  for (const wanted of runIds) {
    const response = await call("GET", `/acceptance-runs/${encodeURIComponent(wanted)}`);
    if (response.status === 404) throw new CliError(`acceptance run ${wanted} not found; list runs of the candidate with 'driver.mjs get components ${id}' evidence or re-run acceptance`);
    const row = await requireOk(`GET /acceptance-runs/${wanted}`, response);
    if (row.componentId !== id) {
      throw new CliError(`acceptance run ${wanted} belongs to component ${row.componentId}, not ${id}; promote refuses to link a foreign run`);
    }
    const owner = candidateId ?? runs[0]?.candidateId ?? null;
    if (owner !== null && row.candidateId !== owner) {
      throw new CliError(`acceptance run ${wanted} belongs to candidate ${row.candidateId}, not ${owner}; pass the run of that candidate (or drop --candidate)`);
    }
    runs.push(row);
  }
  const run = runs[0] ?? null;
  // Ран без явного `--candidate` всё равно сверяется через своего кандидата: связка «ран →
  // сборка» проверяема, а линковать candidateId за агента — работа автовыбора (W2b).
  if (candidate === null && typeof run?.candidateId === "string") candidate = await readCandidate(run.candidateId);
  if (candidate !== null) {
    if (candidate.componentId !== id) {
      throw new CliError(`candidate ${candidate.candidateId} belongs to component ${candidate.componentId}, not ${id}; promote refuses to link a foreign candidate`);
    }
    if (candidate.sourceHash !== receipt.sourceHash) {
      throw new CliError(`candidate ${candidate.candidateId} describes another build: sourceHash ${candidate.sourceHash} vs validated head ${receipt.sourceHash}; accept the current head before promoting it`);
    }
    if (candidate.rev !== meta.headRev) {
      throw new CliError(`candidate ${candidate.candidateId} is for rev ${candidate.rev}, the head is rev ${meta.headRev}; accept the current head before promoting it`);
    }
  }
  return { candidateId, acceptanceRunId: runId, acceptanceRunIds: runIds, candidate, run, runs };
}

/**
 * Автовыбор связки promote без флагов (план 2026-08-04 §W2b, остаток P0-1).
 *
 * Правила, которые здесь важнее кода:
 *
 * 1. **Раны читаются с сервера, а не из кэша.** `component-candidates/:id` кэшируется как `fresh`
 *    (мутабельные `status`/`runs[]`), и «свежий по TTL» ответ вполне может не знать о ране,
 *    поставленном минуту назад. Автовыбор ходит `noCache` — иначе тёплый кэш молча превращал бы
 *    приёмленную сборку в публикацию без provenance (C22).
 * 2. **Скалярный `candidate.acceptanceRunId` источником не является** — это последний
 *    *поставленный* ран, а не принятый (C4). Выбор идёт только по `runs[].promotionEligible`,
 *    который сервер посчитал профильным предикатом promote.
 * 3. **link-store — подсказка, а не свидетельство** (C13): он лишь называет кандидата, по
 *    которому уже шла приёмка; всё, что решает исход, перечитывается с сервера, а несовпадение
 *    подсказки с головой просто уводит на идемпотентный `POST …/candidates`.
 * 4. **Автовыбор не превращает `promote` в ошибку** — кроме неоднозначности: 0 подходящих ранов
 *    даёт прежнее поведение (публикация без линковки + warning), ≥2 — терминальную локальную
 *    ошибку до POST, потому что «взять первый» приписало бы версии произвольное свидетельство.
 */
async function autoSelectPromoteAcceptance(id, meta, receipt, capabilities) {
  if (capabilities.features?.acceptanceMatrix !== true) return null;
  const describesHead = (candidate) => Boolean(candidate)
    && candidate.componentId === id
    && candidate.sourceHash === receipt.sourceHash
    && candidate.rev === meta.headRev;
  const readView = async (candidateId) => {
    if (typeof candidateId !== "string" || candidateId === "") return null;
    const response = await call("GET", `/component-candidates/${encodeURIComponent(candidateId)}`, undefined, { noCache: true });
    return response.status === 200 ? response.json : null;
  };

  // Подсказка link-store: имя кандидата, по которому эта машина уже гоняла приёмку. Всё
  // остальное (в том числе «а он вообще про эту сборку?») проверяется по свежему ответу.
  let candidate = null;
  const links = await cache.links();
  for (let index = links.length - 1; index >= 0 && candidate === null; index -= 1) {
    const record = links[index];
    if (record?.componentId !== id) continue;
    const view = await readView(record.candidateId);
    if (describesHead(view)) candidate = view;
  }
  if (candidate === null) {
    // Идемпотентный кандидат головы: повтор на неизменённом билде возвращает ту же строку
    // (`cached: true`) и не сбрасывает её статус — это чтение состояния, а не новая сборка.
    const created = await call("POST", `/components/${encodeURIComponent(id)}/candidates`, {});
    if (created.status !== 200 && created.status !== 201) {
      out(`warning: acceptance auto-link skipped: could not read the head candidate of ${id} (${created.status}${errorCode(created) ? ` ${errorCode(created)}` : ""}); promoting without an acceptance link`);
      return null;
    }
    candidate = await readView(created.json?.candidateId);
  }
  if (!describesHead(candidate)) {
    out(`warning: acceptance auto-link skipped: no candidate describes the validated head (rev ${meta.headRev}); promoting without an acceptance link`);
    return null;
  }
  const runs = Array.isArray(candidate.runs) ? candidate.runs : [];
  const eligible = runs.filter((run) => run?.promotionEligible === true && typeof run.runId === "string");
  if (eligible.length === 0) {
    out(`warning: no promotion-eligible acceptance run for candidate ${candidate.candidateId} (${runs.length} run(s) known); promoting without an acceptance link — run 'driver.mjs accept ${id}' to build one`);
    return null;
  }
  if (eligible.length > 1) {
    throw new CliError([
      `promote cannot pick an acceptance run for ${id}: ${eligible.length} runs of candidate ${candidate.candidateId} are promotion-eligible; pass the one you mean with --candidate ${candidate.candidateId} --acceptance-run <runId>:`,
      ...eligible.map((run) => `  ${run.runId} status=${run.status ?? "-"} policy=${run.policyProfileId ?? "-"} finished=${run.finishedAt ?? "-"}`),
    ].join("\n"));
  }
  const [run] = eligible;
  return {
    candidateId: candidate.candidateId,
    acceptanceRunId: run.runId,
    candidate,
    run: { runId: run.runId, status: run.status, policy: { id: run.policyProfileId } },
    auto: true,
  };
}

/** Строка выбранной связки: что именно приписывается будущей версии (печатается до мутации). */
export function promoteLinkLine(link) {
  const candidate = link.candidate
    ? `${link.candidate.candidateId} (rev ${link.candidate.rev}${link.candidate.status ? `, ${link.candidate.status}` : ""})`
    : link.candidateId ?? "-";
  const describe = (row, fallback) => (row
    ? `${row.runId} (${row.status}${row.policy?.id ? `, policy ${row.policy.id}` : ""})`
    : fallback ?? "-");
  // Набор печатается целиком: читатель лога обязан видеть все шарды доказательной базы, а не
  // первый из них (W7).
  const rows = Array.isArray(link.runs) && link.runs.length > 1 ? link.runs : null;
  const run = rows
    ? `${rows.length} runs [${rows.map((row) => describe(row)).join("; ")}]`
    : describe(link.run, link.acceptanceRunId);
  return `acceptance link: candidate=${candidate} run=${run}${link.auto ? " (auto-selected from the candidate runs)" : ""}`;
}

async function runPromote(args, flags) {
  const [id] = args;
  const encoded = encodeURIComponent(id);
  const capabilities = await requireOk("capabilities", await call("GET", "/capabilities"));
  if (capabilities.features?.acceptancePromote !== true) {
    throw new CliError("server does not support promote (features.acceptancePromote is off); upgrade the server or publish with 'driver.mjs component ...' instead");
  }
  const meta = await getMeta("components", id, { mutating: true });
  if (!meta) throw new CliError(`components/${id} not found; hint: run 'driver.mjs get components'`);
  const receipt = await requireOk("validate", await call("POST", `/components/${encoded}/validate`));
  for (const warning of receipt.warnings ?? []) out(`warning: ${warning}`);
  // Явные флаги — источник истины; без них связка ищется автоматически (W2b) и её отсутствие
  // остаётся штатным исходом: promote публикует голову без линковки, как и раньше.
  const link = await resolvePromoteAcceptance(id, meta, receipt, flags, capabilities)
    ?? await autoSelectPromoteAcceptance(id, meta, receipt, capabilities);
  // Выбранная связка печатается **до** мутации: читатель лога видит, какой кандидат и какой ран
  // приписываются версии, ещё до того, как версия появилась.
  if (link) out(promoteLinkLine(link));
  const promoted = await call("POST", `/components/${encoded}/promote`, {
    baseRev: meta.headRev,
    sourceHash: receipt.sourceHash,
    ...(flags.supersede === undefined ? {} : { supersede: flags.supersede }),
    ...(flags.strictCatalog ? { expectedCatalogRevision: receipt.catalogRevision } : {}),
    ...(flags.message === undefined ? {} : { message: flags.message }),
    ...(link?.candidateId ? { candidateId: link.candidateId } : {}),
    // Один ран — легаси-поле (байтовая совместимость с сервером до W7); набор — `acceptanceRunIds`.
    // Оба поля сразу сервер отвергает `400`, поэтому ветка именно взаимоисключающая.
    ...(link?.acceptanceRunIds?.length > 1
      ? { acceptanceRunIds: link.acceptanceRunIds }
      : (link?.acceptanceRunId ? { acceptanceRunId: link.acceptanceRunId } : {})),
    // `--expected-cases` без связки бессмысленно (сверять нечего) и уехало бы в 404 «нет кандидата».
    ...(flags.expectedCases === undefined || !link ? {} : { expectedCases: flags.expectedCases }),
  });
  if (promoted.status !== 201) {
    failReuseConflict("promote", "promote", promoted, id);
    const code = errorCode(promoted);
    if (promoted.status === 409 && code === "source_hash_mismatch") {
      throw new CliError(`promote failed (409 source_hash_mismatch): the head revision changed between validate and promote; re-run 'driver.mjs promote ${id}'`, { exitCode: EXIT.productErrors });
    }
    if (promoted.status === 409 && code === "candidate_unavailable") {
      throw new CliError(`promote failed (409 candidate_unavailable): the validated candidate was evicted from the server cache; re-run 'driver.mjs promote ${id}'`, { exitCode: EXIT.productErrors });
    }
    if (promoted.status === 409 && code === "already_published") {
      throw new CliError(`promote failed (409 already_published): rev ${meta.headRev} already has a public version; save a new revision before promoting again`, { exitCode: EXIT.productErrors });
    }
    if (promoted.status === 409 && code === "catalog_changed" && flags.strictCatalog) {
      throw new CliError("promote failed (409 catalog_changed): the catalog moved since validate; re-run promote to re-validate against the current catalog", { exitCode: EXIT.productErrors });
    }
    await failRevisionConflict("promote", promoted, "components", id);
  }
  const result = promoted.json;
  // Оба id в отчёте — от сервера, если он их вернул, иначе из проверенной связки: `--json`
  // и человеческий вывод обязаны нести одну и ту же доказательную базу версии.
  const candidateId = result.candidateId ?? link?.candidateId ?? null;
  const acceptanceRunId = result.acceptanceRunId ?? link?.acceptanceRunId ?? null;
  // Набор ранов версии — от сервера (он же его отсортировал); фолбэк на проверенную связку
  // нужен только для сборок до W7, которые поля не вернут.
  const acceptanceRunIds = Array.isArray(result.acceptanceRunIds) && result.acceptanceRunIds.length
    ? result.acceptanceRunIds
    : (link?.acceptanceRunIds?.length ? link.acceptanceRunIds : (acceptanceRunId ? [acceptanceRunId] : []));
  report(
    [
      `promoted ${id} version ${result.version} (rev ${result.rev}) in ${meta.designSystem}`,
      `acceptance: candidate=${candidateId ?? "-"} run=${acceptanceRunIds.length > 1 ? acceptanceRunIds.join(",") : (acceptanceRunId ?? "-")}`,
      `fingerprints: sourceHash=${result.sourceHash} bundleHash=${result.bundleHash} hostAbi=${result.hostAbiVersion} themeVersion=${result.themeVersion ?? "-"} catalogRevision=${result.catalogRevision}`,
      `superseded: ${result.superseded?.length ? result.superseded.map((version) => `v${version}`).join(", ") : "-"}${result.cached ? " (warm candidate: no recompile)" : ""}`,
      ...(result.warnings ?? []).map((warning) => `warning: ${warning}`),
    ],
    // `acceptanceLinkSource` отвечает на вопрос «откуда взялась доказательная база версии»:
    // флаги агента, автовыбор по runs[] кандидата или её нет вовсе (W2b).
    { command: "promote", id, designSystem: meta.designSystem, ...result, candidateId, acceptanceRunId, acceptanceRunIds, acceptanceLinkSource: link ? (link.auto ? "auto" : "flags") : "none", ...existenceReport() },
  );
}

/**
 * Матричная приёмка одной командой (план 2026-08-03 §5 W1c; RFC candidate-acceptance §4.1–4.2).
 *
 * `accept <componentId>` = `POST /components/:id/candidates` → `POST /acceptance-runs` → poll
 * `GET /acceptance-runs/:runId` до терминала. Клиент **не** собирает матрицу сам: набор случаев
 * строит сервер (в этой волне — именованные examples кандидата), он же считает reuse и evidence.
 *
 * Байты evidence по умолчанию не качаются: печатается адрес архива, а `--evidence <file.zip>`
 * сохраняет его. Прогресс идёт в stderr — stdout принадлежит `--json`.
 */
const ACCEPT_POLL_INTERVAL_MS = 2000;
const ACCEPT_DEFAULT_TIMEOUT_SEC = 1800;
/** Канон терминальных статусов один на драйвер и кэш: кэшируются только терминальные раны. */
const ACCEPT_TERMINAL = TERMINAL_RUN_STATUSES;
/** Вердикт → exit code: приёмка без `pass` — продуктовый отказ (exit 2), как у readiness/publish. */
const acceptExitCode = (status) => (status === "pass" || status === "pass_with_exceptions" ? EXIT.ok : EXIT.productErrors);

const progress = (line) => process.stderr.write(`${line}\n`);

/** Одна строка провалившегося случая: имя, вердикт, класс severity и упавшие гейты с причиной. */
function failedCaseLines(failed) {
  return failed.map((item) => {
    const gates = (item.failedGates ?? [])
      .map((gate) => `${gate.gate}=${gate.status}${gate.detail ? ` (${gate.detail})` : ""}`)
      .join(" ") || "-";
    const severity = item.severity ? `${item.severity.class}#${item.severity.rank}` : "-";
    return `  ${item.caseId} [${item.verdict ?? item.status}] severity=${severity} gates: ${gates}`;
  });
}

/**
 * Один элемент алгебры refresh (W1): либо строка режима (`none|failed|all`), либо скоуп-объект
 * (`{mode|scope|caseIds}`). Форма читается защитно: старый сервер поля не отдаёт вовсе, и это
 * не ошибка клиента, а отсутствие фичи.
 */
function refreshScopeText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.length ? value.join(",") : "-";
  if (typeof value !== "object") return String(value);
  const caseIds = Array.isArray(value.caseIds) ? value.caseIds : null;
  const mode = value.mode ?? value.refresh ?? (caseIds ? `${caseIds.length} case(s)` : null);
  const scope = value.scope ?? null;
  const head = mode ?? "-";
  return `${head}${scope ? `:${scope}` : ""}${caseIds && caseIds.length <= 5 ? ` [${caseIds.join(",")}]` : ""}`;
}

/**
 * Тройка `{requested, impact, effective}` рана (план 2026-08-04 §W2a, D5): что попросил агент,
 * что добавил импакт и что сервер реально применил. Пустой результат означает «сервер поле не
 * отдаёт» (сборка до W1) — строка тогда не печатается, а не врёт нулями.
 */
export function refreshLine(refresh) {
  if (refresh === null || typeof refresh !== "object" || Array.isArray(refresh)) return null;
  const parts = ["requested", "impact", "effective"]
    .map((key) => [key, refreshScopeText(refresh[key])])
    .filter(([, text]) => text !== null);
  return parts.length ? `refresh: ${parts.map(([key, text]) => `${key}=${text}`).join(" ")}` : null;
}

function acceptLines(run, { componentId, evidencePath }) {
  const done = run.progress ?? {};
  const lines = [
    `acceptance ${componentId ?? run.componentId} run ${run.runId} verdict ${run.status}`,
    `cases: ${done.completed ?? 0}/${done.total ?? 0} reused=${done.reused ?? 0} failed=${done.failed ?? 0} policy=${run.policy?.id ?? "-"}`,
  ];
  const refresh = refreshLine(run.refresh ?? null);
  if (refresh) lines.push(refresh);
  if (run.failedCases?.length) lines.push("failed cases (worst first):", ...failedCaseLines(run.failedCases));
  lines.push(evidencePath
    ? `evidence: ${evidencePath}`
    : `evidence: GET /api/acceptance-runs/${run.runId}/evidence (pass --evidence <file.zip> to download)`);
  return lines;
}

/** Приёмка выключена на сервере — читаемый отказ вместо серии 404 по ручкам. */
async function requireAcceptanceMatrix() {
  const capabilities = await requireOk("capabilities", await call("GET", "/capabilities"));
  if (capabilities.features?.acceptanceMatrix !== true) {
    throw new CliError("server does not support matrix acceptance (features.acceptanceMatrix is off; needs EASYUI_ACCEPTANCE_MATRIX=1); use 'driver.mjs promote <id>' for the receipt-based path");
  }
  return capabilities;
}

/**
 * Evidence-архив терминального рана — content-addressed по своей природе, поэтому кэшируется
 * blob'ом (`<cache>/blobs/<sha256>`) с обязательной сверкой SHA256SUMS при чтении. Файл на диске
 * агента — копия, а не свидетельство: доказательная запись остаётся серверной.
 */
async function downloadEvidence(runId, outputPath) {
  const path = `/acceptance-runs/${encodeURIComponent(runId)}/evidence`;
  const hit = await cache.read("GET", path);
  let bytes;
  if (hit) bytes = hit.bytes;
  else {
    const response = await client.request(path);
    if (!response.ok) throw new CliError(`evidence download failed (${response.status}) for run ${runId}`);
    bytes = Buffer.from(await response.arrayBuffer());
    await cache.write("GET", path, undefined, {
      status: response.status, bytes,
      contentType: response.headers.get("content-type") ?? "application/zip",
      etag: response.headers.get("etag") ?? undefined,
    });
  }
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await writeFile(outputPath, bytes);
  return outputPath;
}

/** Poll до терминального вердикта. Таймаут — клиентский: ран на сервере продолжает идти. */
async function pollAcceptanceRun(runId, { deadlineMs }) {
  const deadline = Date.now() + deadlineMs;
  let last = null;
  for (;;) {
    const run = await requireOk(`poll acceptance run ${runId}`, await call("GET", `/acceptance-runs/${encodeURIComponent(runId)}`));
    if (ACCEPT_TERMINAL.has(run.status)) return run;
    const done = run.progress ?? {};
    const eta = run.eta?.remainingMs ?? run.eta?.etaMs;
    const line = `run ${runId} ${run.status} ${done.completed ?? 0}/${done.total ?? 0} reused=${done.reused ?? 0}${Number.isFinite(eta) ? ` eta~${Math.round(eta / 1000)}s` : ""}`;
    if (line !== last) { progress(line); last = line; }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new CliError(`acceptance run ${runId} did not finish within the timeout; it keeps running on the server — poll it with 'driver.mjs accept-status ${runId}'`, { exitCode: EXIT.productErrors });
    }
    await delay(Math.min(ACCEPT_POLL_INTERVAL_MS, remaining));
  }
}

async function reportAcceptance(run, { command, componentId, candidateId, flags }) {
  const evidencePath = flags.evidence === undefined ? null : await downloadEvidence(run.runId, flags.evidence);
  const exitCode = acceptExitCode(run.status);
  // Квитанция и связи (W7): candidate → run → cases → artifacts → report. Кэш хранит навигацию
  // по уже полученному, а не доказательства: вердикт остаётся серверным.
  await cache.link({
    componentId: componentId ?? run.componentId, candidateId: candidateId ?? run.candidateId,
    runId: run.runId, caseSetId: run.caseSetId ?? null, status: run.status,
    cases: (run.failedCases ?? []).map((item) => ({ caseId: item.caseId, verdict: item.verdict ?? item.status, caseFingerprint: item.caseFingerprint ?? null })),
    evidence: evidencePath, report: `receipts/${command}/${run.runId}.json`,
  });
  await cache.receipt(command, run.runId, {
    componentId: componentId ?? run.componentId, candidateId: candidateId ?? run.candidateId,
    runId: run.runId, status: run.status, exitCode,
    progress: run.progress ?? null, evidence: evidencePath,
  });
  report(acceptLines(run, { componentId, evidencePath }), {
    command, componentId: componentId ?? run.componentId, candidateId: candidateId ?? run.candidateId,
    exitCode, ...(evidencePath ? { evidence: evidencePath } : {}), ...run, ...existenceReport(),
  });
  if (exitCode !== EXIT.ok) {
    throw new CliError(`acceptance run ${run.runId} finished as ${run.status}${run.failedCases?.length ? `: ${run.failedCases.map((item) => item.caseId).join(", ")}` : ""}`, { exitCode });
  }
}

/**
 * Case-set-манифесты (план 2026-08-03 §5 W2).
 *
 * `case-set put` публикует манифест семейства (контентный адрес: повтор идемпотентен), `get`
 * читает его обратно, `coverage` печатает покрытие измерений. Матрицу клиент не собирает: он
 * отдаёт манифест, а полноту tuples, ссылки на эталоны и дубли props проверяет сервер.
 */
/**
 * Локальные лимиты case-set-манифеста (план 2026-08-04 §W6). Это **дефолты**, а не истина:
 * настоящие значения приезжают из `GET /api/capabilities → limits.caseSet*` и перекрывают их
 * (`caseSetLimits`). Держать копию всё равно приходится — драйвер обязан отвергать битый
 * манифест **до** сети, а сеть может быть недоступна ровно в тот момент, когда автор правит JSON.
 */
export const CASE_SET_LIMITS = Object.freeze({
  manifestVersion: 1,
  maxCases: 512,
  maxCasesPerRun: 64,
  maxDimensions: 8,
  maxDimensionValues: 64,
  maxExpectedTuples: 4096,
});

/** Лимиты из ответа `/capabilities` поверх дефолтов: сервер — источник истины, драйвер — эхо. */
export function caseSetLimits(capabilities) {
  const limits = capabilities?.limits ?? {};
  const number = (value, fallback) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
  return {
    manifestVersion: number(limits.caseSetManifestVersion, CASE_SET_LIMITS.manifestVersion),
    maxCases: number(limits.caseSetMaxCases, CASE_SET_LIMITS.maxCases),
    maxCasesPerRun: number(limits.acceptanceMaxCasesPerRun, CASE_SET_LIMITS.maxCasesPerRun),
    maxDimensions: number(limits.caseSetMaxDimensions, CASE_SET_LIMITS.maxDimensions),
    maxDimensionValues: number(limits.caseSetMaxDimensionValues, CASE_SET_LIMITS.maxDimensionValues),
    maxExpectedTuples: number(limits.caseSetMaxExpectedTuples, CASE_SET_LIMITS.maxExpectedTuples),
  };
}

const CASE_SET_ID_CHARSET = /^[A-Za-z0-9._-]{1,64}$/;
const CASE_SET_TOP_LEVEL_KEYS = new Set(["manifestVersion", "componentId", "source", "capture", "dimensions", "requireVisual", "policy", "cases"]);
const CASE_SET_CASE_KEYS = new Set([
  "id", "props", "referenceAssetId", "expectedGeometry", "cropLineage", "referenceSurface",
  "referencePlacement", "aliasOf", "dims",
]);
const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** Каждый `null` в манифесте — ошибка: схема сервера не принимает `null` **нигде**. */
function nullPaths(value, path = [], found = []) {
  if (value === null) found.push(path.join("."));
  else if (Array.isArray(value)) value.forEach((item, index) => nullPaths(item, [...path, index], found));
  else if (isPlainObject(value)) for (const [key, item] of Object.entries(value)) nullPaths(item, [...path, key], found);
  return found;
}

/**
 * Структурная проверка манифеста **до сети** (план 2026-08-04 §W6, C20).
 *
 * Драйвер — zero-dependency Node-скрипт (и зеркалится в share-пакеты без сборки), поэтому
 * серверный `zod` сюда не импортируется: полный разбор остаётся за сервером, а здесь живёт
 * дешёвый набор проверок, закрывающий ровно те ошибки, на которых автор терял round-trip —
 * форму, обязательные поля, charset id, `null` вместо опущенного поля (классика — `cropLineage: null`)
 * и все лимиты, включая потолок декартова произведения. Возвращает список строк-претензий;
 * пустой список означает «локально претензий нет», а не «сервер это примет».
 */
export function caseSetManifestIssues(manifest, limits = CASE_SET_LIMITS) {
  const issues = [];
  if (!isPlainObject(manifest)) return ["manifest must be a JSON object"];
  for (const path of nullPaths(manifest)) {
    issues.push(`${path || "manifest"}: null is not a value the schema accepts — omit the field entirely (cropLineage: null is the classic case)`);
  }
  for (const key of Object.keys(manifest)) {
    if (!CASE_SET_TOP_LEVEL_KEYS.has(key)) issues.push(`unknown field "${key}": the manifest schema is strict, a typo is a refusal, not a default`);
  }
  if (manifest.manifestVersion !== limits.manifestVersion) {
    issues.push(`manifestVersion must be ${limits.manifestVersion} (got ${JSON.stringify(manifest.manifestVersion)})`);
  }
  if (typeof manifest.componentId !== "string" || manifest.componentId.length === 0 || manifest.componentId.length > 64) {
    issues.push("componentId is required: it names the component the set belongs to and must equal the route's id");
  }
  const viewport = manifest.capture?.viewport;
  if (!isPlainObject(manifest.capture) || !isPlainObject(viewport)
    || !Number.isInteger(viewport.width) || !Number.isInteger(viewport.height)
    || viewport.width <= 0 || viewport.height <= 0) {
    issues.push("capture.viewport {width, height} is required and must be positive integers (CSS px)");
  }

  const dimensions = manifest.dimensions;
  if (dimensions !== undefined) {
    if (!isPlainObject(dimensions)) issues.push("dimensions must be an object of axis → values[]");
    else {
      const names = Object.keys(dimensions);
      if (names.length > limits.maxDimensions) issues.push(`dimensions: at most ${limits.maxDimensions} axes (got ${names.length})`);
      let product = 1;
      for (const name of names) {
        const values = dimensions[name];
        if (!Array.isArray(values) || values.length === 0) { issues.push(`dimensions."${name}" must be a non-empty array of values`); continue; }
        if (values.length > limits.maxDimensionValues) {
          issues.push(`dimensions."${name}": at most ${limits.maxDimensionValues} values (got ${values.length})`);
        }
        product *= values.length;
      }
      if (product > limits.maxExpectedTuples) {
        issues.push(`dimensions span ${product} tuples, above the ceiling of ${limits.maxExpectedTuples}`
          + " (422 case_set_coverage_too_large): split the family or drop an axis");
      }
    }
  }

  const cases = manifest.cases;
  if (!Array.isArray(cases) || cases.length === 0) return [...issues, "cases must be a non-empty array"];
  if (cases.length > limits.maxCases) issues.push(`cases: at most ${limits.maxCases} entries (got ${cases.length})`);
  if (cases.length > limits.maxCasesPerRun) {
    issues.push(`cases: ${cases.length} exceeds the per-run ceiling of ${limits.maxCasesPerRun} (422 case_set_too_large)`);
  }
  const byId = new Map();
  for (const [index, item] of cases.entries()) {
    if (!isPlainObject(item)) { issues.push(`cases[${index}] must be an object`); continue; }
    for (const key of Object.keys(item)) {
      if (!CASE_SET_CASE_KEYS.has(key)) issues.push(`cases[${index}]: unknown field "${key}"`);
    }
    if (typeof item.id !== "string" || !CASE_SET_ID_CHARSET.test(item.id)) {
      issues.push(`cases[${index}].id must match ^[A-Za-z0-9._-]{1,64}$ (a Figma node id like "54863:9537" does not)`);
    } else if (byId.has(item.id)) issues.push(`duplicate case id: ${item.id}`);
    else byId.set(item.id, item);
    if (!isPlainObject(item.props)) issues.push(`cases[${index}].props must be an object`);
    if (item.referenceAssetId !== undefined && !/^asset_[0-9a-f]{64}$/.test(String(item.referenceAssetId))) {
      issues.push(`cases[${index}].referenceAssetId must be an asset registry id (asset_<sha256>), not bytes or a path`);
    }
  }
  for (const item of cases) {
    if (!isPlainObject(item) || item.aliasOf === undefined) continue;
    const target = byId.get(item.aliasOf);
    if (!target || item.aliasOf === item.id) issues.push(`case ${item.id}: aliasOf "${item.aliasOf}" is not another case of this set`);
    else if (target.aliasOf !== undefined) issues.push(`case ${item.id}: aliasOf "${item.aliasOf}" is itself an alias; alias chains are not allowed`);
  }
  return issues;
}

/**
 * Контентный адрес манифеста, посчитанный локально — тот же алгоритм, что у сервера
 * (`cset_` + sha256 канонизованного JSON). Нужен до сети: по нему автор понимает, публиковал ли
 * он уже этот набор, и им же сверяется ответ сервера.
 */
export function caseSetIdOfManifest(manifest) {
  return `cset_${createHash("sha256").update(canonicalJson(manifest)).digest("hex")}`;
}

function coverageLines(coverage, { caseSetId, componentId }) {
  const names = Object.keys(coverage.dimensions ?? {}).sort();
  const lines = [
    // `missingCount` — полное число незакрытых ячеек; `missingTuples` сервер усекает до 64 (W6),
    // поэтому считать пропуски по длине списка нельзя: он врёт ровно на больших семьях.
    `case-set ${caseSetId}${componentId ? ` (${componentId})` : ""} coverage: ${coverage.presentTuples}/${coverage.expectedTuples} tuples,`
    + ` missing ${coverage.missingCount ?? coverage.missingTuples?.length ?? 0}${coverage.truncated ? " (list truncated below)" : ""}`,
    `dimensions: ${names.length ? names.map((name) => `${name}=${coverage.dimensions[name].join("|")}`).join(" ") : "-"}`,
  ];
  const tuple = (item) => names.map((name) => `${name}=${item[name]}`).join(",");
  for (const item of (coverage.missingTuples ?? []).slice(0, 20)) lines.push(`  missing: ${tuple(item)}`);
  for (const item of coverage.duplicates ?? []) lines.push(`  duplicate: ${tuple(item.tuple)} → ${item.caseIds.join(", ")}`);
  return lines;
}

/**
 * `case-set validate <manifest.json>` — dry-run манифеста, локально-первый (C20/C23).
 *
 * Порядок обязателен: структурная проверка и локальный `caseSetId` считаются **до** любого
 * запроса, поэтому битый манифест диагностируется без сети и без единой строки в БД. Сервер
 * подключается вторым шагом и только если он умеет dry-run (`features.caseSetValidate`):
 * молчаливый фолбэк на мутирующий PUT — ровно то, чего эта команда и должна избегать.
 */
async function runCaseSetValidate(args) {
  const [, manifestPath] = args;
  const manifest = await readJsonArgument(manifestPath, "case-set manifest");
  const local = caseSetManifestIssues(manifest, CASE_SET_LIMITS);
  if (local.length > 0) {
    throw new CliError([`case-set validate failed locally (${local.length} issue(s)); nothing was sent to the server:`,
      ...local.map((issue) => `  ${issue}`)].join("\n"));
  }
  const caseSetId = caseSetIdOfManifest(manifest);
  const componentId = manifest.componentId;

  let capabilities = null;
  try {
    const response = await call("GET", "/capabilities");
    if (response.status === 200) capabilities = response.json;
  } catch {
    capabilities = null;
  }
  if (capabilities === null) {
    report([
      `case-set manifest is locally valid: ${manifest.cases.length} cases for ${componentId}`,
      `local caseSetId: ${caseSetId}`,
      "warning: the server is unreachable — server-side checks (assets, props schema, coverage) were not run",
    ], { command: "case-set validate", checked: "local", caseSetId, componentId, cases: manifest.cases.length, issues: [] });
    return;
  }
  // Лимиты сервера перекрывают локальные дефолты: сборка могла поднять потолок (или опустить).
  const serverIssues = caseSetManifestIssues(manifest, caseSetLimits(capabilities));
  if (serverIssues.length > 0) {
    throw new CliError([`case-set validate failed against the limits of this server (${serverIssues.length} issue(s)):`,
      ...serverIssues.map((issue) => `  ${issue}`)].join("\n"));
  }
  if (capabilities.features?.caseSetValidate !== true) {
    report([
      `case-set manifest is locally valid: ${manifest.cases.length} cases for ${componentId}`,
      `local caseSetId: ${caseSetId}`,
      "warning: this server has no dry-run handle (features.caseSetValidate is off); the server-side checks run only on 'case-set put'",
    ], { command: "case-set validate", checked: "local", caseSetId, componentId, cases: manifest.cases.length, issues: [] });
    return;
  }

  const result = await requireOk("case-set validate",
    await call("POST", `/components/${encodeURIComponent(componentId)}/case-sets/validate`, { manifest }));
  report([
    `case-set validate ok for ${result.componentId}: ${result.cases?.count ?? manifest.cases.length} cases,`
    + ` caseSetId ${result.caseSetId}${result.wouldBeCached ? " (already published: a PUT would be an idempotent repeat)" : " (not published yet)"}`,
    ...(result.caseSetId !== caseSetId
      ? [`warning: the server computed a different caseSetId (${result.caseSetId}) than this client (${caseSetId})`]
      : []),
    ...coverageLines(result.coverage ?? {}, { caseSetId: result.caseSetId }),
    ...(result.warnings ?? []).map((warning) => `warning: ${warning}`),
  ], { command: "case-set validate", checked: "server", localCaseSetId: caseSetId, ...result });
}

async function runCaseSet(args, flags) {
  const [subcommand] = args;
  // `validate` — единственная подкоманда, которая начинает работу локально: гейт матрицы
  // проверяется внутри неё, после структурного разбора манифеста.
  if (subcommand === "validate") return runCaseSetValidate(args);
  await requireAcceptanceMatrix();
  if (subcommand === "put") {
    const [, componentId, manifestPath] = args;
    const manifest = await readJsonArgument(manifestPath, "case-set manifest");
    // Мутация требует прямой проверки существования (§W4): иначе первым свидетельством
    // «компонента нет» становится 404 самой мутации, а его легко списать на манифест.
    if (await getMeta("components", componentId, { mutating: true }) === null) {
      throw new CliError(`components/${componentId} not found; hint: run 'driver.mjs get components'`);
    }
    const result = await requireOk("case-set put", await call("PUT", `/components/${encodeURIComponent(componentId)}/case-sets`, { manifest }));
    await cache.receipt("case-set", result.caseSetId, { componentId: result.componentId, caseSetId: result.caseSetId, cases: result.cases, cached: result.cached === true });
    report([
      `case-set ${result.caseSetId} for ${result.componentId} (${result.designSystem}): ${result.cases} cases${result.cached ? " (cached: identical manifest already published)" : ""}`,
      ...coverageLines(result.coverage ?? {}, { caseSetId: result.caseSetId }),
      ...(result.warnings ?? []).map((warning) => `warning: ${warning}`),
    ], { command: "case-set put", ...result, ...existenceReport() });
    return;
  }
  const [, caseSetId] = args;
  const encoded = encodeURIComponent(caseSetId);
  if (subcommand === "coverage") {
    const coverage = await requireOk("case-set coverage", await call("GET", `/case-sets/${encoded}/coverage`));
    report(coverageLines(coverage, coverage), { command: "case-set coverage", ...coverage });
    return;
  }
  const result = await requireOk("case-set get", await call("GET", `/case-sets/${encoded}`));
  report([
    `case-set ${result.caseSetId} for ${result.componentId} (${result.designSystem}): ${result.caseCount} cases, created ${result.createdAt}`,
    `source: ${result.source ? `${result.source.fileKey}${result.source.componentSetNodeId ? `#${result.source.componentSetNodeId}` : ""}` : "-"}`,
  ], { command: "case-set get", ...result });
}

async function runAccept(args, flags) {
  const [id] = args;
  const encoded = encodeURIComponent(id);
  await requireAcceptanceMatrix();
  const meta = await getMeta("components", id, { mutating: true });
  if (!meta) throw new CliError(`components/${id} not found; hint: run 'driver.mjs get components'`);
  // Кандидат — тот же validate-префлайт: его предупреждения принадлежат приёмке, а не съёмке.
  const candidate = await requireOk("candidate", await call("POST", `/components/${encoded}/candidates`, {}));
  for (const warning of candidate.warnings ?? []) out(`warning: ${warning}`);
  progress(`candidate ${candidate.candidateId} rev=${candidate.rev}${candidate.cached ? " (cached)" : ""}`);
  const started = await call("POST", "/acceptance-runs", {
    candidateId: candidate.candidateId,
    // `--case-set` (W2): набор случаев, поверхность съёмки и per-case допуски берутся из
    // опубликованного манифеста; без него источник — именованные examples кандидата.
    ...(flags.caseSet === undefined ? {} : { caseSetId: flags.caseSet }),
    ...(flags.policy === undefined ? {} : { policy: flags.policy }),
    ...(flags.refresh === undefined ? {} : { refresh: flags.refresh }),
    // `--recapture` (план 2026-08-04 §W2a, D5): скоуп обновления. Поле отправляется **только**
    // под флагом — сервер без алгебры refresh (до W1) не должен получать незнакомое поле,
    // а дефолтный скоуп выбирает он сам.
    ...(flags.recapture ? { refreshMode: "frame" } : {}),
    // `--baseline-run` (W6): частичная пересъёмка. Сервер сам считает импакт и снимает только
    // затронутые случаи; недоказуемый импакт означает полный ран, а не тихую экономию.
    ...(flags.baselineRun === undefined ? {} : { baselineRunId: flags.baselineRun }),
  });
  if (started.status === 409 && errorCode(started) === "acceptance_run_in_flight") {
    const runId = started.json?.error?.runId;
    throw new CliError(`acceptance run already in flight for candidate ${candidate.candidateId}${runId ? ` (run ${runId}); poll it with 'driver.mjs accept-status ${runId}'` : ""}`, { exitCode: EXIT.productErrors });
  }
  const queued = await requireOk("acceptance run", started, [202]);
  progress(`run ${queued.runId} queued with ${queued.cases} cases`);
  const queuedRefresh = refreshLine(queued.refresh ?? null);
  if (queuedRefresh) progress(queuedRefresh);
  if (queued.impact) progress(impactLines(queued.impact, id)[0]);
  const run = await pollAcceptanceRun(queued.runId, { deadlineMs: (flags.timeoutSec ?? ACCEPT_DEFAULT_TIMEOUT_SEC) * 1000 });
  await reportAcceptance(run, { command: "accept", componentId: id, candidateId: candidate.candidateId, flags });
}

/**
 * Импакт-анализ (план 2026-08-03 §5 W6) — **dry-run**: ничего не снимает и ничего не пишет.
 *
 * Печатает базис (`asset-only` / `theme-only` / `conservative`), что именно изменилось и сколько
 * случаев придётся снять заново. `conservative` — не ошибка, а честный ответ «сузить пересъёмку
 * нечем»; молчаливого reuse не бывает, поэтому случай без доказательств всегда затронут.
 */
function impactLines(impact, componentId) {
  const lines = [
    `impact ${componentId ?? ""} basis=${impact.basis} recapture ${impact.recaptureCount} of ${impact.affectedCases.length + impact.unaffectedCases.length} case(s)`.replace(/ {2,}/g, " "),
    `reason: ${impact.reason}`,
  ];
  if (impact.changedAssets?.length) lines.push(`changed assets: ${impact.changedAssets.join(", ")}`);
  if (impact.changedTokens?.length) lines.push(`changed tokens: ${impact.changedTokens.join(", ")}`);
  lines.push(`affected: ${impact.affectedCases.length ? impact.affectedCases.join(", ") : "-"}`);
  lines.push(`unaffected: ${impact.unaffectedCases.length ? impact.unaffectedCases.join(", ") : "-"}`);
  lines.push(`rerun with: driver.mjs accept ${componentId ?? ""} --baseline-run ${impact.baselineRunId}`.replace(/ {2,}/g, " "));
  return lines;
}

async function runImpact(args, flags) {
  const [id] = args;
  await requireAcceptanceMatrix();
  const impact = await requireOk("impact", await call("POST", `/components/${encodeURIComponent(id)}/impact`, {
    candidateId: flags.candidate,
    baselineRunId: flags.baselineRun,
  }));
  await cache.receipt("impact", `${id}-${flags.baselineRun}`, {
    componentId: id, candidateId: flags.candidate, baselineRunId: flags.baselineRun,
    basis: impact.basis, recaptureCount: impact.recaptureCount,
  });
  report(impactLines(impact, id), { command: "impact", componentId: id, ...impact });
}

async function runAcceptStatus(args, flags) {
  const [runId] = args;
  await requireAcceptanceMatrix();
  const run = await requireOk("acceptance run", await call("GET", `/acceptance-runs/${encodeURIComponent(runId)}`));
  if (!ACCEPT_TERMINAL.has(run.status)) {
    report(
      [`acceptance run ${run.runId} is ${run.status} ${run.progress?.completed ?? 0}/${run.progress?.total ?? 0} reused=${run.progress?.reused ?? 0}`],
      { command: "accept-status", exitCode: EXIT.ok, ...run },
    );
    return;
  }
  await reportAcceptance(run, { command: "accept-status", flags });
}

/**
 * `reject <candidateId> --reason <text>` (RFC candidate-acceptance §4.1, R3b) — отклонение сборки
 * человеком.
 *
 * **Решение терминально.** Оно блокирует не только этот кандидат, но и любой promote **той же
 * ревизии** компонента (`409 candidate_rejected`, оба пути promote), переживает TTL кандидата и не
 * снимается повторным `accept`: тот вернёт того же кандидата с `rejected: true`. Выход из
 * отклонения один — новая ревизия исходника.
 *
 * Reject не отменяет живой ран приёмки (для этого есть cancel на самом ране) и ничего не мутирует
 * в самом кандидате: это надгробие, а не переход статуса.
 */
async function runReject(args, flags) {
  const [candidateId] = args;
  if (typeof flags.reason !== "string" || flags.reason.trim() === "") invalid("reject requires --reason <text>");
  await requireAcceptanceMatrix();
  const response = await call("POST", `/component-candidates/${encodeURIComponent(candidateId)}/reject`, { reason: flags.reason });
  if (response.status === 409) {
    const code = errorCode(response);
    const details = response.json?.error ?? {};
    if (code === "candidate_already_rejected") {
      throw new CliError(`candidate ${candidateId} is already rejected by ${details.actor ?? "?"} at ${details.createdAt ?? "?"}: ${details.reason ?? "-"}; rejection is terminal, save a new revision instead`, { exitCode: EXIT.productErrors });
    }
    if (code === "candidate_promoted") {
      throw new CliError(`candidate ${candidateId} is already promoted to version ${details.currentVersion ?? "?"} and cannot be rejected; deprecate or supersede that version instead`, { exitCode: EXIT.productErrors });
    }
  }
  const rejected = await requireOk("reject", response);
  report([
    `rejected candidate ${rejected.candidateId} (${rejected.componentId} rev ${rejected.rev}) by ${rejected.decision?.actor ?? "-"}`,
    `reason: ${rejected.decision?.reason ?? "-"}`,
    `terminal: promote of rev ${rejected.rev} now fails with 409 candidate_rejected; save a new revision to move on`,
  ], { command: "reject", ...rejected });
}

/**
 * KPI-инструмент RFC §9: сколько публичных версий стоил каждый компонент. Читает
 * `GET /api/components/:id/versions` и сводит статусы; `versionsPerComponent` — та самая
 * метрика churn'а (baseline yandex-pay-v2: 2,4 → цель ≤1,2).
 */
export function versionAuditRows(components, versionsById) {
  return components.map((component) => {
    const versions = versionsById[component.id] ?? [];
    const active = versions.filter((version) => version.status === "active");
    const byStatus = {};
    for (const version of versions) byStatus[version.status] = (byStatus[version.status] ?? 0) + 1;
    // Есть ли за версией acceptance-evidence (RFC §12.6(в), волна R3c): плоский receipt
    // `acceptanceRunId` на строке публикации. Колонка read-only и нужна, чтобы измерить масштаб
    // будущего бэкфилла legacy-версий (R4+). Пустая строка считается отсутствием наравне с
    // null/undefined; сервер до R3c поля вовсе не отдавал — там тоже «нет».
    const withEvidence = versions.filter((version) => (version.acceptanceRunId ?? "") !== "");
    return {
      id: component.id,
      designSystem: component.designSystem,
      versions: versions.length,
      active: active.length,
      byStatus,
      acceptanceEvidence: withEvidence.length,
      acceptedActive: active.some((version) => (version.acceptanceRunId ?? "") !== ""),
      latestVersion: versions.length ? versions[versions.length - 1].version : null,
      firstPublishedAt: versions.length ? versions[0].publishedAt : null,
      lastPublishedAt: versions.length ? versions[versions.length - 1].publishedAt : null,
    };
  });
}

export function versionAuditFindings(rows) {
  const published = rows.filter((row) => row.versions > 0);
  const totalVersions = published.reduce((sum, row) => sum + row.versions, 0);
  return {
    components: rows.length,
    published: published.length,
    totalVersions,
    // Округление до сотых: метрика сравнивается с целью 1,2 из RFC §9.
    versionsPerComponent: published.length ? Math.round((totalVersions / published.length) * 100) / 100 : 0,
    firstVersionOnly: published.filter((row) => row.versions === 1).map((row) => row.id),
    noActiveVersion: published.filter((row) => row.active === 0).map((row) => row.id),
    multipleActive: published.filter((row) => row.active > 1).map((row) => row.id),
    unpublished: rows.filter((row) => row.versions === 0).map((row) => row.id),
    // Срез покрытия приёмкой (RFC §12.6): сколько публичных версий несут evidence и у скольких
    // компонентов принята сама активная версия. Ноль здесь — **ожидаемое** состояние прода до
    // включения promote-практики с EASYUI_ACCEPTANCE_MATRIX, а не дефект (§11-R3c).
    versionsWithEvidence: published.reduce((sum, row) => sum + row.acceptanceEvidence, 0),
    acceptedComponents: published.filter((row) => row.acceptedActive).map((row) => row.id),
    withoutEvidence: published.filter((row) => row.acceptanceEvidence === 0).map((row) => row.id),
  };
}

/** Компонент без единой active-версии — сломанное состояние каталога (readiness M7). */
export const versionAuditExitCode = (findings) => (findings.noActiveVersion.length ? EXIT.productErrors : EXIT.ok);

export function versionAuditLines(scope, rows, findings) {
  return [
    `version audit${scope ? ` (${scope})` : ""}: ${findings.published}/${findings.components} components published, ${findings.totalVersions} public versions, ${findings.versionsPerComponent} versions per published component`,
    `first-version-only: ${findings.firstVersionOnly.length} · no active version: ${findings.noActiveVersion.length} · multiple active: ${findings.multipleActive.length} · never published: ${findings.unpublished.length}`,
    `acceptance evidence: ${findings.versionsWithEvidence}/${findings.totalVersions} versions · accepted active version: ${findings.acceptedComponents.length}/${findings.published} components · published components without any evidence: ${findings.withoutEvidence.length}`,
    "component	designSystem	versions	active	latest	statuses	acceptance	firstPublishedAt	lastPublishedAt",
    ...rows.map((row) => [
      row.id, row.designSystem, row.versions, row.active,
      row.latestVersion === null ? "-" : `v${row.latestVersion}`,
      Object.entries(row.byStatus).sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) => `${status}=${count}`).join(",") || "-",
      // «есть/нет acceptance evidence»: сколько версий несут ран и принята ли активная.
      `${row.acceptanceEvidence}/${row.versions}${row.acceptedActive ? " active=yes" : row.versions ? " active=no" : ""}`,
      row.firstPublishedAt ?? "-", row.lastPublishedAt ?? "-",
    ].join("\t")),
    ...(findings.noActiveVersion.length ? [`no active version: ${findings.noActiveVersion.join(", ")}`] : []),
    ...(findings.multipleActive.length ? [`multiple active versions: ${findings.multipleActive.join(", ")}`] : []),
  ];
}

async function runVersionsAudit(flags) {
  const components = (await requireOk("components", await call("GET", "/components")))
    .filter((component) => flags.designSystem === undefined || component.designSystem === flags.designSystem)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (flags.designSystem !== undefined && components.length === 0) {
    const systems = await requireOk("design systems", await call("GET", "/design-systems"));
    if (!systems.some((system) => system.id === flags.designSystem)) {
      throw new CliError(`design system ${flags.designSystem} not found; hint: run 'driver.mjs get design-systems'`);
    }
  }
  const versionsById = {};
  for (const component of components) {
    versionsById[component.id] = await requireOk("versions", await call("GET", `/components/${encodeURIComponent(component.id)}/versions`));
  }
  const rows = versionAuditRows(components, versionsById);
  const findings = versionAuditFindings(rows);
  const exitCode = versionAuditExitCode(findings);
  const scope = flags.designSystem === undefined ? "" : `designSystem=${flags.designSystem}`;
  report(versionAuditLines(scope, rows, findings), { command: "audit versions", ...(flags.designSystem === undefined ? {} : { designSystem: flags.designSystem }), exitCode, components: rows, findings });
  if (exitCode !== EXIT.ok) throw new CliError(`components without an active version: ${findings.noActiveVersion.join(", ")}`, { exitCode });
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
    const meta = await getMeta("compositions", id, { mutating: true });
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
  const meta = await getMeta("compositions", id, { mutating: true });
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

/**
 * Клиентский кэш конфигурируется до первого запроса (план 2026-08-03 §5 W7).
 *
 * Идентичность ключа — `sha256(baseUrl + "\n" + username)`: общий каталог кэша двух учёток
 * не отдаёт ответы чужой. При legacy-Basic кэш выключен: барьер общий на всех, различить
 * учётку по нему нельзя, а значит и изолировать записи нечем.
 */
async function configureCache(flags) {
  const dir = flags.cacheDir ?? process.env.EASYUI_CACHE_DIR;
  const legacy = Boolean(client.legacyAuthorization);
  cache = await openCache({
    dir, baseUrl: API, user: process.env.EASYUI_USERNAME ?? "",
    refresh: flags.cacheRefresh === true || process.env.EASYUI_CACHE_REFRESH === "1",
    refreshReason: flags.cacheRefresh === true ? "flag:--cache-refresh" : "env:EASYUI_CACHE_REFRESH",
    disabled: legacy || !dir,
    disabledReason: legacy ? "LEGACY_BASIC_AUTH" : "no --cache-dir",
  });
}

export async function main(argv = process.argv.slice(2)) {
  const { cmd, args, flags } = parseArgs(argv);
  jsonMode = flags.json === true;
  await configureCache(flags);
  if (cmd === "component") {
    const [id, name, sourcePath] = args;
    const selectedSystem = flags.designSystem ?? process.env.EASYUI_DESIGN_SYSTEM;
    // Provenance читается до любых сетевых вызовов: битый путь — ошибка аргументов, не ENOENT
    // посреди публикации. Схему (fileKey/nodeIds/…) валидирует сервер.
    const figma = flags.figma === undefined ? undefined : await readFigmaProvenance(flags.figma);
    const source = await readFile(sourcePath, "utf8");
    const meta = await getMeta("components", id, { mutating: true });
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
    const savedMeta = await getMeta("components", id, { mutating: true });
    out(`saved ${id} rev ${saved.json.rev} in ${savedMeta.designSystem}`);
    const published = await publishComponent(id, saved.json.rev, reuseOverride);
    if (jsonMode) report(null, {
      command: "component", id, rev: saved.json.rev, ...published, ...existenceReport(),
      ...(figma === undefined ? {} : { figma: true }),
      ...(discovery === undefined ? {} : { discovery }),
      ...(flags.forceNew ? { forceNew: true, acknowledgedCandidateKeys } : {}),
    });
  } else if (cmd === "component-move") {
    const [id] = args;
    const meta = await getMeta("components", id, { mutating: true });
    if (!meta) throw new CliError(`components/${id} not found`);
    const saved = await call("PUT", `/components/${encodeURIComponent(id)}`, { designSystem: flags.designSystem, message: "driver move", baseRev: meta.headRev });
    if (saved.status !== 200) await failRevisionConflict("move", saved, "components", id);
    const savedMeta = await getMeta("components", id, { mutating: true });
    out(`saved ${id} rev ${saved.json.rev} in ${savedMeta.designSystem}`);
    const published = await publishComponent(id, saved.json.rev, undefined, "component-move");
    if (jsonMode) report(null, { command: "component-move", id, rev: saved.json.rev, ...published, ...existenceReport() });
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
    const meta = await getMeta("prototypes", doc.id, { mutating: true });
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
  else if (cmd === "expect") await runExpect(args, flags);
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
    const meta = await getMeta(kind, id, { mutating: true });
    if (!meta) throw new CliError(`${kind}/${id} not found`);
    let body;
    if (spec.revisioned) {
      if (typeof meta.headRev !== "number") throw new CliError(`${kind}/${id} has no headRev to CAS on: ${JSON.stringify(meta)}`);
      body = { baseRev: meta.headRev };
    }
    await requireOk("delete", await call("DELETE", `/${kind}/${encodeURIComponent(id)}`, body), [204]);
    report(`${spec.verb} ${kind}/${id}`, { command: "delete", kind, id, deleted: true, ...existenceReport() });
  } else if (cmd === "shoot") {
    // R8a: одна съёмочная дорога. Локальный playwright снимал другим браузером, другими
    // шрифтами и без readiness — кадры были несравнимы с эталонами и с приёмкой.
    console.error("shoot is a deprecated alias of `snap --all-screens` (single server renderer); use snap directly");
    await runSnap(args, { ...flags, allScreens: true }, "shoot");
  } else if (cmd === "snap") await runSnap(args, flags);
  else if (cmd === "preview") await runPreview(args, flags);
  else if (cmd === "status") await runStatus(args, flags);
  else if (cmd === "readiness") await runReadiness(args);
  else if (cmd === "publish") await runPublish(args, flags);
  else if (cmd === "usages") await runUsages(args, flags);
  else if (cmd === "promote") await runPromote(args, flags);
  else if (cmd === "provenance") await runProvenance(args, flags);
  else if (cmd === "accept") await runAccept(args, flags);
  else if (cmd === "accept-status") await runAcceptStatus(args, flags);
  else if (cmd === "reject") await runReject(args, flags);
  else if (cmd === "impact") await runImpact(args, flags);
  else if (cmd === "case-set") await runCaseSet(args, flags);
  else if (cmd === "audit") await (args[0] === "reuse" ? runReuseAudit(flags) : flags.versions ? runVersionsAudit(flags) : runAudit(flags));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    if (error?.usage) console.error(usageLine);
    process.exitCode = error?.exitCode ?? EXIT.failed;
  });
}
