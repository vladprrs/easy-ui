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

const usageLine = "usage: driver.mjs component <id> <Name> <src.tsx> [--design-system <id>] [--intent <text>] [--figma <figma.json>] [--force-new --reason <text>] | component-move <id> --design-system <id> | composition <id> <doc.json> --design-system <id> | composition publish <id> | design-system <id> <name> <description> | prototype <doc.json> | catalog <system> [out.json] [--full] | catalog list <system> | catalog search <system> --intent <text> [--limit N] [--kind component|composition] [--doc <composition.json>] | catalog get <system> <artifact...> | diff <protoId> [revA] [revB] | baseline <protoId> [outDir] [--viewport WxH] [--theme light|dark] [--dsf 1|2|3] | check <protoId> [--threshold N] | geometry <protoId> <screenId> | expect <expected.json> <actual.json> [--tolerance N] | get <kind> [id] | delete <kind> <id> (prototypes/components/compositions/design-systems; design-system → ретайр) | shoot <prototypeId> [outDir] (deprecated alias of snap --all-screens) | snap <prototypeId> [outDir] [--all-screens] [--viewport WxH] [--theme light|dark] [--dsf 1|2|3] [--receipt <file.json>] [--candidate <candidateId>]... [--no-barrier] | preview <componentId> [props.json] [--example <name>] [--rev head-draft] [--probe geometry] [--viewport WxH] [--theme light|dark] [--dsf 1|2|3] [--out file] [--receipt <file.json>] | status <prototypeId> [screenId] [--all-screens] | readiness <protoId> | publish <protoId> [--verify] [--force] | usages <componentId> [--tree] | promote <componentId> [--supersede auto|none] [--strict-catalog] [--candidate <candidateId>] [--acceptance-run <runId>]... [--acceptance-runs <runId,runId>] [--expected-cases N] | provenance <componentId> <figma.json|null> [--rev N] | case-set put <componentId> <manifest.json> [--overlay <json|file>] | case-set validate <manifest.json> [--overlay <json|file>] | case-set get <caseSetId> | case-set coverage <caseSetId> | source-package upload <manifest.json> [--design-system <id>] | source-package list [--design-system <id>] [--file-key <key>] [--limit N] | source-package show <packageId> | source-package skeleton <packageId> --component <componentId> [--nodes a,b] [--out file.json] | accept <componentId> [--case-set <caseSetId>] [--policy <id>] [--refresh none|failed|all|id,id2] [--recapture] [--baseline-run <runId>] [--timeout-sec N] [--evidence <file.zip>] [--summary] | accept-status <runId> [--evidence <file.zip>] [--summary] [--case <caseId>] | accept-resume <runId> [--timeout-sec N] [--evidence <file.zip>] [--summary] | reject <candidateId> --reason <text> | impact <componentId> --candidate <candidateId> --baseline-run <runId> | migration-commit start <componentId> [--gallery <prototypeId>] [--screen <fragment.json>] [--candidate <candidateId>] [--acceptance-run <runId>]... [--expected-cases N] [--supersede auto|none] [--message <text>] [--audit-design-system <id>] [--idempotency-key <key>] [--receipt <file.json|file.txt>] [--timeout-sec N] [--dry-run] | migration-commit --status <commitId> | migration-commit --advance <commitId> | migration-commit --cancel <commitId> [--reason <text>] | audit --design-system <id> | audit --versions [--design-system <id>] | audit reuse [--design-system <id>] [--actor <id>] [--since <iso>] [--limit N] [--min-attempts N]\npromote --candidate/--acceptance-run link the published version to a durable acceptance candidate and run (both ids are checked against the validate receipt before the mutation and printed with it); a sharded family is promoted with a SET of runs (--acceptance-run repeated or --acceptance-runs a,b; needs features.acceptanceMultiRunPromote): shards must be disjoint by (propsHash, slotsHash, surface), the server sorts the set and --expected-cases N asserts the union coverage; accept --refresh failed = re-evaluate the verdict only (a captured frame may be reused), accept --recapture = force a re-capture of those cases (frame scope) instead of a verdict-only refresh; accept-resume <runId> continues a run that STOPPED WITHOUT A VERDICT (server restart -> statusReason interrupted, typed phase_timeout, or the allocate circuit breaker: renderer_unavailable/capture_budget_exhausted/queue_starvation) by queueing a NEW run with lineage (resumedFromRunId/attempt): finished contract/defaults/audit gates whose per-gate fingerprint still matches are NOT re-executed, everything from capture onward is captured again; a run that produced a verdict is 409 run_not_resumable (re-run it with accept --refresh), an already continued run is 409 run_already_resumed naming the successor; accept/accept-status --summary print the compact agent report (server ?view=summary when features.acceptanceSummaryView is on, otherwise the same shape summarised locally) and accept-status --case <caseId> drills into one case with its gates, causes and reuse receipt — --json keeps its meaning in every case\nevery verb accepts --json, --summary-json (stdout carries ONLY the envelope receipt {schemaVersion, command, ok, summary, items, artifacts, warnings, nextActions} — the same object --json nests under `envelope`) and the global cache flags --cache-dir <dir> (env EASYUI_CACHE_DIR) / --cache-refresh (force miss); snap --candidate <candidateId> (repeatable, needs features.prototypeCandidateOverlay) swaps the pin of an ALREADY PUBLISHED component for that acceptance candidate's bundle for the duration of the frame: the PNG is bytes-only (no asset, no baseline, no receipt), the driver reads it from /screenshot-jobs/:id/bytes and aborts if the server did not apply every override; snap asks the server for the deterministic resource barrier (readiness: \"barrier\") by default because driver captures are SERVICE captures — --no-barrier is the rollback to the pre-wave v1 readiness; with --receipt snap/preview also print the barrier block (decoded/expected, fonts, stable frames, late resources, ms) and one summary line of suppressed console noise; case-set put/validate --overlay <json|file> merges the candidateOverlay map {\"<componentId>\": \"cand_...\"} into the manifest (accept has no --overlay: the graph belongs to the manifest); snap/preview print receiptSha256 + renderer.rendererFingerprint + codes[] in --json and write the capture receipt with --receipt; snap/preview exit 0 (PNG, no product errors), 2 (PNG + product errors), 1 (no PNG); readiness/publish/audit and terminal reuse STOPs exit 2 on product-level failure; migration-commit polls the SERVER-side saga (preflight \u2192 promote \u2192 gallery-save \u2192 verify \u2192 impacted-regression \u2192 audit): the idempotency key defaults to (component, headRev, sourceHash) so a repeat returns the same saga, a saga stopped in needs-<phase> exits 2 and is resumed with --advance or closed with --cancel, and --receipt writes the single agent record (.json = machine receipt, .txt = the printed lines)\nsource-package uploads the Figma source manifest (nodes + exports by assetId, never bytes: upload the PNGs with POST /api/assets first) — the package id is the content address of the manifest, so re-uploading the same one answers deduplicated: true; the manifest form (required fields, exports ≤ limits.sourcePackageMaxExports, every referenced nodeId declared in nodes[]) is checked BEFORE the request, and 'source-package skeleton <packageId> --component <id>' asks the server for a DRAFT case-set manifest (empty props, no invented expectedGeometry) that --out file.json writes for 'case-set put'";

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
 * `--summary-json` (план 2026-08-07 §1.4, W6b): stdout получает **ровно** объект `envelope` и
 * ничего больше. Симметрия к `--json`, где тот же объект лежит вложенным ключом: агенту, которому
 * нужна только квитанция, не приходится ни знать форму payload'а конкретного верба, ни вычитывать
 * из него ключ. Режим включает `jsonMode` (человекочитаемые строки принадлежат stdout и должны
 * замолчать), но печатает другой документ.
 */
let summaryJsonMode = false;
/**
 * Клиентский кэш ответов (план 2026-08-03 §5 W7). До разбора флагов — no-op: команда без
 * `--cache-dir`/`EASYUI_CACHE_DIR` работает ровно как раньше.
 */
let cache = nullCache("not configured");
/** Human line printed only outside --json; JSON mode owns stdout entirely. */
const out = (line) => { if (!jsonMode) console.log(line); };
/**
 * Версия схемы агентской квитанции (`envelope`, план 2026-08-07 §1.4 W6a). Растёт только при
 * несовместимом изменении формы конверта; добавление полей внутрь `summary` версию не двигает.
 */
export const ENVELOPE_SCHEMA_VERSION = 1;
/**
 * Верб текущего запуска — как его набрал агент (argv). Нужен общему обработчику отказа
 * (`requestFailed`): у него нет собственного контекста команды, а квитанция обязана называть
 * ту команду, которая упала, а не шаг запроса.
 */
let currentCommand = null;
/**
 * Стабильная агентская квитанция поверх любого `--json`-вывода (план 2026-08-07 §1.4 W6a).
 *
 * Форма **вложенная** (`envelope: {...}`), а не плоская: payload'ы вербов уже несут ключи
 * `warnings`/`artifacts` и целиком спредят ответ сервера — плоский конверт коллидировал бы с
 * ними. `ok` обязателен и равен `exitCode === EXIT.ok` вызывающего верба: конверт не считает
 * успех сам, он его лишь публикует. `summary` в W6a пуст — per-verb контракты приезжают в W6b.
 */
export function buildEnvelope(envelope) {
  if (envelope === null || typeof envelope !== "object") throw new TypeError("report() requires an envelope object");
  if (typeof envelope.ok !== "boolean") throw new TypeError("report() envelope requires a boolean ok");
  return {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    command: envelope.command ?? currentCommand ?? null,
    ok: envelope.ok,
    summary: envelope.summary ?? {},
    items: envelope.items ?? [],
    artifacts: envelope.artifacts ?? [],
    warnings: envelope.warnings ?? [],
    nextActions: envelope.nextActions ?? [],
  };
}
/**
 * Terminal output of a verb: a JSON document in --json mode, human lines otherwise.
 *
 * Статус кэша едет в **каждом** отчёте: клиентский кэш — ускоритель, а не свидетельство, и
 * читатель обязан видеть, пришла цифра с сервера или с диска. В человекочитаемом режиме — та же
 * строка в stderr (stdout принадлежит отчёту).
 *
 * `envelope` обязателен (W6a) и печатается **только** в json-режимах: человекочитаемый вывод
 * остаётся байт-в-байт прежним. `--summary-json` (W6b) печатает тот же объект **один**, без
 * payload'а и без блока `cache`: статус кэша — свойство запроса, а не квитанции верба, и в
 * сводке его место занимает `summary`.
 */
function report(lines, payload, envelope) {
  const receipt = buildEnvelope(envelope);
  if (summaryJsonMode) process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  else if (jsonMode) process.stdout.write(`${JSON.stringify({ ...payload, envelope: receipt, cache: cache.summary() }, null, 2)}\n`);
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
/**
 * Глобальная квитанция (план 2026-08-07 §1.4, W6b). Как и кэш-флаги, разбирается для **любой**
 * команды и не входит в `flagSpecs`: `--summary-json` — не контракт конкретного верба, а способ
 * прочитать общий конверт, и требовать его объявления у каждого глагола значило бы гарантировать
 * расхождение списков.
 */
export const ENVELOPE_FLAGS = Object.freeze({
  "--summary-json": { value: false, key: "summaryJson" },
});
const allScreensFlag = { "--all-screens": { value: false, key: "allScreens" } };
/**
 * `--receipt <file.json>` (план renderer-contract-2 §5 **R8b**): скачать capture receipt снятой
 * джобы (R5) в файл. Один файл на команду — у `snap` это документ со списком экранов, у
 * `preview` — receipt единственной джобы; форма описана в `docs/server-api.md` (секция драйвера).
 */
const receiptFlag = { "--receipt": { value: true, key: "receipt" } };
/**
 * `--candidate <candidateId>` у `snap`/`shoot` (план 2026-08-05 §B): подмена пина уже
 * опубликованного компонента бандлом acceptance-кандидата на время съёмки. Повторяемый —
 * потолок объявлен сервером (`limits.prototypeCandidateOverlayMax`), и локально не дублируется.
 * Кадр такой джобы **не** попадает в реестр ассетов: он качается из `/screenshot-jobs/:id/bytes`.
 */
const overlayCandidateFlag = { "--candidate": { value: true, key: "candidate", repeat: true } };
/**
 * `--no-barrier` у `snap`/`shoot` (план 2026-08-07 §W2, §1.5).
 *
 * Драйверная съёмка — **сервисная** (галереи, регрессия, приёмочные стенды), а именно на ней
 * воспроизводилась потеря registry-листов: кадр уезжал раньше, чем декодировался ресурс, и
 * пропажа была неотличима от «так нарисовано». Поэтому дефолт `snap` — `readiness: "barrier"`
 * (v3 для этой джобы), а не молчаливый v1. Интерактивный путь (редактор, превью человека) остаётся
 * на v1 и живёт вне драйвера — здесь его переключать нечем и незачем.
 *
 * Флаг — **откат**, а не тюнинг: барьер стоит до 8 с на кадр, и когда съёмка нужна быстро (или
 * сервер до волны W2 и параметр ему незнаком), `--no-barrier` возвращает доволновое поведение
 * ровно одним способом — поле в запрос не кладётся вовсе.
 */
const noBarrierFlag = { "--no-barrier": { value: false, key: "noBarrier" } };
/**
 * `--impacted` / `--full` у `snap`/`shoot` (план 2026-08-07 §W5, P1.1).
 *
 * `--impacted` спрашивает сервер (`POST /api/prototypes/:id/snap-plan`), какие экраны обязаны
 * быть сняты и почему, и снимает **только** их; остальные уезжают в отчёт строкой `reuse` с
 * отпечатком кадра и квитанцией переиспользования. `--full` — сегодняшнее поведение, съёмка
 * всех экранов без плана; он же дефолт, потому что сервер волны деплоится раньше драйвера, а
 * дефолт «снять меньше» на старом сервере читался бы как тихая потеря кадров.
 *
 * Фича opt-in ещё и потому, что план — **доказательство**, а не догадка: недоказуемый экран
 * сервер сам помечает `capture`, но снятые мимо галерейного пути кадры (probe, candidate
 * overlay) в реестр кадров не попадают, и планировать по ним нечего.
 */
const impactedFlags = {
  "--impacted": { value: false, key: "impacted" },
  "--full": { value: false, key: "full" },
};
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
  // `--overlay` (план 2026-08-07 §W3) — карта неопубликованных зависимостей манифеста
  // (`put`/`validate`); у `get`/`coverage` она бессмысленна и отвергается арностью ниже.
  "case-set": { ...jsonFlag, "--overlay": { value: true, key: "overlay" } },
  // §W8: пакет исходников Figma. Один набор флагов на четыре подкоманды (канон `case-set`),
  // применимость каждого проверяется арностью ниже — «unknown flag» не объяснил бы, что флаг
  // существует, но принадлежит другой подкоманде.
  "source-package": {
    ...jsonFlag,
    "--design-system": { value: true, key: "designSystem" },
    "--file-key": { value: true, key: "fileKey" },
    "--component": { value: true, key: "component" },
    "--out": { value: true, key: "out" },
    "--limit": {
      value: true,
      key: "limit",
      parse(value) {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1 || number > 100) invalid("--limit must be an integer from 1 to 100");
        return number;
      },
    },
    // `--nodes a,b` — подмножество узлов пакета для скелета. Список, а не повторяемый флаг:
    // узлы называют одну выборку, и запись через запятую короче четырёх `--node`.
    "--nodes": {
      value: true,
      key: "nodes",
      parse(value) {
        const ids = value.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
        if (ids.length === 0) invalid("--nodes must list at least one nodeId (comma-separated)");
        if (ids.length > 256) invalid("--nodes lists more than 256 nodeIds");
        return ids;
      },
    },
  },
  accept: {
    ...jsonFlag,
    // §W3: у рана карты overlay нет — она живёт в манифесте набора. Флаг объявлен только затем,
    // чтобы отказ назвал верный путь вместо «unknown flag» (см. parseArgs).
    "--overlay": { value: true, key: "overlay" },
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
    // План 2026-08-04 §W8 (P1-9) — компактный отчёт. Строго opt-in: смысл `--json` не меняется
    // (C11/C17/C24), полный вид остаётся дефолтом и инструментом отладки.
    "--summary": { value: false, key: "summary" },
  },
  "accept-status": {
    ...jsonFlag,
    "--evidence": { value: true, key: "evidence" },
    "--summary": { value: false, key: "summary" },
    // Drill-down одного случая после сводки (§W8): полные гейты, причины, квитанция reuse и
    // артефакты ровно одного случая вместо всего рана.
    "--case": { value: true, key: "case" },
  },
  /**
   * BR-06 (план 2026-08-08 §6): продолжение остановленного рана. Флаги — те же, что у `accept`
   * **после** постановки: ждать вердикт, скачать evidence, напечатать сводку. Ни `--policy`, ни
   * `--case-set`, ни `--refresh` тут нет намеренно: продолжение исполняет ран предка, а «снять
   * иначе» — это `accept`, а не resume.
   */
  "accept-resume": {
    ...jsonFlag,
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
    "--summary": { value: false, key: "summary" },
  },
  // RFC candidate-acceptance R3b: отклонение кандидата человеком. Решение терминально — ручки
  // «разотклонить» нет ни в драйвере, ни на сервере; выход — новая ревизия компонента.
  reject: { ...jsonFlag, "--reason": { value: true, key: "reason" } },
  // План 2026-08-03 §5 W6: dry-run импакта кандидата к baseline-рану (ничего не снимает).
  /**
   * `migration-commit` (план 2026-08-07 §W4): один верб на весь набор ручек саги. Режим —
   * подкоманда `start` либо ровно один из `--status`/`--advance`/`--cancel`: сага адресуется
   * либо компонентом (её ещё нет), либо `commitId` (она уже есть), и смешивать эти адреса в
   * одном позиционале значило бы гадать, что имел в виду агент.
   */
  "migration-commit": {
    ...jsonFlag, ...surfaceFlags, ...receiptFlag, ...noBarrierFlag,
    "--status": { value: true, key: "status" },
    "--advance": { value: true, key: "advance" },
    "--cancel": { value: true, key: "cancel" },
    "--dry-run": { value: false, key: "dryRun" },
    "--gallery": { value: true, key: "gallery" },
    "--screen": { value: true, key: "screen" },
    "--candidate": { value: true, key: "candidate" },
    "--acceptance-run": { value: true, key: "acceptanceRun", repeat: true },
    "--expected-cases": {
      value: true,
      key: "expectedCases",
      parse(value) {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1) invalid("--expected-cases must be a positive integer");
        return number;
      },
    },
    "--supersede": { value: true, key: "supersede", enum: ["auto", "none"] },
    "--message": { value: true, key: "message" },
    "--audit-design-system": { value: true, key: "auditDesignSystem" },
    "--idempotency-key": { value: true, key: "idempotencyKey" },
    "--reason": { value: true, key: "reason" },
    "--timeout-sec": {
      value: true,
      key: "timeoutSec",
      parse(value) {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1 || number > 7200) invalid("--timeout-sec must be an integer from 1 to 7200");
        return number;
      },
    },
  },
  impact: {
    ...jsonFlag,
    "--candidate": { value: true, key: "candidate" },
    "--baseline-run": { value: true, key: "baselineRun" },
  },
  get: { ...jsonFlag },
  delete: { ...jsonFlag },
  // R8a: `shoot` — алиас `snap --all-screens`, поэтому и контракт флагов у него снаповский.
  shoot: { ...jsonFlag, ...allScreensFlag, ...surfaceFlags, ...receiptFlag, ...overlayCandidateFlag, ...noBarrierFlag, ...impactedFlags },
  snap: { ...jsonFlag, ...allScreensFlag, ...surfaceFlags, ...receiptFlag, ...overlayCandidateFlag, ...noBarrierFlag, ...impactedFlags },
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
  // BR-06: `accept-resume <runId>` — ровно один позиционал, ран-предок.
  "accept-resume": [1, 1],
  reject: [1, 1],
  impact: [1, 1],
  // `migration-commit start <componentId>` (2) | `migration-commit --status|--advance|--cancel <id>` (0).
  "migration-commit": [0, 2],
  // `case-set put <componentId> <manifest.json>` (3) | `case-set get|coverage <caseSetId>` (2).
  "case-set": [2, 3],
  // §W8: `source-package list` (1) | `upload <manifest.json>` / `show|skeleton <packageId>` (2).
  "source-package": [1, 2],
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
  const specs = { ...CACHE_FLAGS, ...ENVELOPE_FLAGS, ...(flagSpecs[commandForm] ?? {}) };
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
    // §W3: карта overlay — часть **манифеста**; читающим подкомандам её вносить некуда.
    if (flags.overlay !== undefined && subcommand !== "put" && subcommand !== "validate") {
      invalid("case-set --overlay applies to put and validate only: candidateOverlay is a field of the manifest being published");
    }
  }
  // §W8: `source-package` — четыре подкоманды с общим набором флагов. Применимость флага и форма
  // идентификатора проверяются до сети: `show <мусор>` иначе стоил бы round-trip'а ради 404, а
  // 404 «пакет не найден» на строке, которая пакетом быть не может, — диагностика, вводящая в
  // заблуждение.
  if (command === "source-package") {
    const [subcommand, second] = positionals;
    if (!["upload", "list", "show", "skeleton"].includes(subcommand)) {
      invalid("source-package requires a subcommand: upload | list | show | skeleton");
    }
    const only = (allowed, form) => {
      for (const [key, flag] of Object.entries({ designSystem: "--design-system", fileKey: "--file-key", component: "--component", nodes: "--nodes", out: "--out", limit: "--limit" })) {
        if (flags[key] !== undefined && !allowed.includes(key)) invalid(`source-package ${subcommand} has no ${flag} (usage: ${form})`);
      }
    };
    if (subcommand === "upload") {
      if (positionals.length !== 2) invalid("usage: source-package upload <manifest.json> [--design-system <id>]");
      only(["designSystem"], "source-package upload <manifest.json> [--design-system <id>]");
    } else if (subcommand === "list") {
      if (positionals.length !== 1) invalid("usage: source-package list [--design-system <id>] [--file-key <key>] [--limit N]");
      only(["designSystem", "fileKey", "limit"], "source-package list [--design-system <id>] [--file-key <key>] [--limit N]");
      // Серверная ручка требует `designSystem`: пакеты принадлежат каталогу, сквозного списка нет.
      if (flags.designSystem === undefined && process.env.EASYUI_DESIGN_SYSTEM === undefined) {
        invalid("source-package list requires --design-system <id> (or EASYUI_DESIGN_SYSTEM): packages belong to a design system");
      }
      if (flags.designSystem === undefined) flags.designSystem = process.env.EASYUI_DESIGN_SYSTEM;
    } else {
      if (positionals.length !== 2) invalid(`usage: source-package ${subcommand} <packageId>${subcommand === "skeleton" ? " --component <componentId> [--nodes a,b] [--out file.json]" : ""}`);
      if (!SOURCE_PACKAGE_ID_PATTERN.test(second)) invalid(`source-package ${subcommand} takes a package id (fsp_<64 hex>), got: ${second}`);
      if (subcommand === "show") only([], "source-package show <packageId>");
      else {
        only(["component", "nodes", "out"], "source-package skeleton <packageId> --component <componentId> [--nodes a,b] [--out file.json]");
        if (flags.component === undefined) invalid("source-package skeleton requires --component <componentId>: the skeleton is a case-set manifest, and a manifest names its component");
        // W6b, правило файлов: расширение решает формат, и проверяется оно **до** сети. Скелет —
        // машинный артефакт (его отдают в `case-set put`), поэтому текстовой половины у него нет:
        // `.txt` отвергается по имени, а не молча пишется файлом, который никуда не отправить.
        if (flags.out !== undefined && receiptFileFormat(flags.out, "source-package skeleton --out") !== "json") {
          invalid(`source-package skeleton --out writes the draft case-set manifest: name it .json, not .txt (${flags.out})`);
        }
      }
    }
  }
  // §W3: `accept --overlay` не существует по построению — `POST /acceptance-runs` карты не
  // принимает, граф приезжает в ран из опубликованного набора. Отказ называет верный путь:
  // молчаливое игнорирование флага стоило бы рана, снятого не против тех зависимостей.
  if (command === "accept" && flags.overlay !== undefined) {
    invalid("accept has no --overlay: the dependency graph belongs to the case-set manifest, not to the run —"
      + " publish it with 'case-set put <componentId> <manifest.json> --overlay <json|file>' and accept that caseSetId");
  }
  // `migration-commit` — либо `start <componentId>`, либо ровно одна ручка над существующей
  // сагой. Смешение форм отвергается до сети: `--advance` со `start` читался бы как «создай и
  // продолжи», а сага, которую только что создали, продолжения не требует.
  if (command === "migration-commit") {
    const targets = ["status", "advance", "cancel"].filter((key) => flags[key] !== undefined);
    if (targets.length > 1) invalid("migration-commit takes exactly one of --status <id> | --advance <id> | --cancel <id>");
    if (targets.length === 1) {
      if (positionals.length !== 0) invalid(`usage: migration-commit --${targets[0]} <commitId>`);
      if (flags.dryRun) invalid("migration-commit --dry-run applies to 'start' only: an existing saga is not a plan");
    } else {
      if (positionals[0] !== "start" || positionals.length !== 2) {
        invalid("usage: migration-commit start <componentId> [--gallery <prototypeId> [--screen <fragment.json>]] [--candidate <id>] [--acceptance-run <runId>]... [--dry-run]");
      }
      if (flags.reason !== undefined) invalid("migration-commit --reason applies to --cancel only");
    }
  }
  // W6b: формат квитанции выводится из расширения (`.json` — JSON, `.txt` — текст), и проверять
  // его надо **до** работы: узнать о неверном имени файла после съёмки — значит потерять её.
  if (flags.receipt !== undefined) receiptFileFormat(flags.receipt);
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
  // §W5: два решения об одной съёмке. `--impacted` снимает только запланированное сервером,
  // `--full` — всё; вместе они не значат ничего, и молчаливый выбор одного из них стоил бы либо
  // непонятого кадра, либо непонятого его отсутствия. Отказ — до сети.
  if ((command === "snap" || command === "shoot") && flags.impacted && flags.full) {
    invalid("--impacted and --full are mutually exclusive: --impacted captures only the screens the server plans to re-capture,"
      + " --full captures every screen (the default)");
  }
  // §W5 × §B: план доказывает reuse по кадрам **галерейного** пути, а кадр с candidate-overlay
  // в реестр кадров не пишется вовсе. Переиспользовать published-кадр под именем кандидатского —
  // ровно та подмена, которую §B2.3 ловит на другой стороне, поэтому связка отвергается заранее.
  if ((command === "snap" || command === "shoot") && flags.impacted && flags.candidate !== undefined) {
    invalid("--impacted cannot be combined with --candidate: the snap plan proves reuse from gallery frames,"
      + " and candidate-overlay frames are never recorded as such — drop --impacted to capture the overlay frames");
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
  // Команда — из argv (§1.4 N12): `step` называет запрос, а квитанция обязана называть верб.
  if (jsonMode) {
    report(null, { failed: true, step, status: response.status, code, message: failure.message, retryable: failure.retryable === true, details: failure }, {
      command: currentCommand, ok: false, nextActions: failure.nextSteps ?? [],
    });
  }
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

/**
 * BR-05 (план 2026-08-08 §5, маршрут 1): габариты замера **двумя числами**.
 *
 * `content` — union `getClientRects()` всех потомков, то есть **paint**-габарит: он включает
 * декоративный хвост, тень и всё, что вылезло из потока. Именно это число автор кейса читал здесь
 * и переносил в `expectedGeometry`, получая безусловный `layout-overflow`. `layout` — union тех же
 * in-flow боксов, по которым вердикт и считается. Строка печатается, только когда сервер прислал
 * `layout` (доволновой сервер его не шлёт).
 */
function geometryBoundsLine(result) {
  if (!result || typeof result !== "object" || !result.layout || !result.content) return null;
  const same = result.layout.width === result.content.width && result.layout.height === result.content.height;
  return `bounds: layout=${result.layout.width}x${result.layout.height} (declare THIS as expectedGeometry/expectedSurfaces.layoutUnion)`
    + ` paint=${result.content.width}x${result.content.height}`
    + (same ? " (identical: no decoration outside the flow)" : " (includes decorations/effects outside the flow)");
}

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
  const boundsLine = geometryBoundsLine(state.result);
  if (boundsLine) out(boundsLine);
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
  if (jsonMode) {
    report(null, { command: "geometry", prototypeId: id, screenId, ...state.result, gaps: gapRows }, {
      command: "geometry", ok: true, items: state.result.rects ?? [],
      warnings: (state.result.issues ?? []).map((issue) => `${issue.severity} ${issue.code}: ${issue.message}`),
      // W6b, контракт §1.4. `verdict` — свод по `issues` замера (ошибка > предупреждение >
      // чисто). `divergingSurfaces` — **null**, а не пустой массив: пер-поверхностные вердикты
      // (`root`/`layoutUnion`/`paint`/`referenceExport`) живут в приёмке случая (§W1a), у
      // прототипного замера их нет вовсе, и `[]` читалось бы как «поверхности сошлись».
      // `gaps` — сколько зазоров удалось измерить (строки с `reason` — те, где замер невозможен).
      summary: {
        verdict: (state.result.issues ?? []).some((issue) => issue.severity === "error")
          ? "error"
          : (state.result.issues ?? []).length ? "warn" : "clean",
        divergingSurfaces: null,
        gaps: gapRows.filter((row) => row.reason === null).length,
      },
    });
  }
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

/**
 * `--overlay '<json>' | --overlay <file.json>` (план 2026-08-07 §W3): карта неопубликованных
 * зависимостей `{"<componentId>": "cand_…"}`. Инлайн-JSON — потому что карта на один-два узла
 * короче имени файла, который под неё пришлось бы завести; файл — потому что граф из восьми узлов
 * в командной строке нечитаем. Различаются по первому символу: `{` — тело, иначе путь.
 */
async function readOverlayArgument(value) {
  const document = value.trimStart().startsWith("{")
    ? (() => {
      try { return JSON.parse(value); }
      catch (error) { invalid(`--overlay is not valid JSON: ${error.message}`); }
    })()
    : await readJsonArgument(value, "--overlay map");
  if (!isPlainObject(document)) invalid("--overlay must be a JSON object of componentId → candidate id (cand_<sha256>)");
  return document;
}

/**
 * Внесение карты overlay в манифест перед проверкой и отправкой (§W3).
 *
 * Карта — **часть манифеста**, а не параметр вызова: `caseSetId` контентно адресован, и набор,
 * снятый против неопубликованных зависимостей, обязан отличаться от набора без них. Поэтому
 * `--overlay` именно правит документ, а расхождение с уже объявленной в файле картой — отказ:
 * две декларации одного графа означают, что одна из них забыта.
 */
function withCandidateOverlay(manifest, overlay) {
  if (overlay === undefined) return manifest;
  const declared = manifest?.candidateOverlay;
  if (declared !== undefined && canonicalJson(declared) !== canonicalJson(overlay)) {
    throw new CliError("--overlay contradicts the candidateOverlay already declared in the manifest;"
      + " keep one declaration — the map is part of the content-addressed manifest, not a call parameter");
  }
  return { ...manifest, candidateOverlay: overlay };
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
  }, {
    command: "expect", ok: exitCode === EXIT.ok, items: evaluation.checks,
    warnings: evaluation.mismatches.map((check) => check.message),
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
    // §W10: сколько сообщений консоли классификация подавила. Сервер до волны W10 числа не
    // присылает — тогда его несёт сам список `infraNoise`, и врать нулём здесь нельзя.
    suppressedCount: Number.isInteger(result?.suppressedCount) ? result.suppressedCount : infraNoise.length,
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

/**
 * Правило файлов квитанций (план 2026-08-07 §1.4, W6b): **`.json` — всегда JSON, текст — `.txt`**.
 *
 * Расширение — единственное, что читатель файла видит до его открытия, и «текстовая квитанция с
 * расширением .json» ломает всякий машинный конвейер (jq, импорт, валидация схемой) молча.
 * Поэтому формат выводится из имени, а незнакомое расширение — ошибка аргументов, а не тихая
 * запись «во что-нибудь».
 */
export function receiptFileFormat(path, flag = "--receipt") {
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".txt")) return "text";
  return invalid(`${flag} must name a .json (machine receipt) or .txt (human receipt) file: ${path}`);
}

async function writeReceiptFile(path, payload) {
  // Существующие вызовы пишут документ — расширение обязано это подтверждать.
  receiptFileFormat(path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`);
}

/** Текстовая квитанция (`.txt`): те же строки, что печатает верб человеку. */
async function writeTextReceiptFile(path, lines) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${[lines].flat().join("\n")}\n`);
}

/**
 * Единственное значение opt-in'а readiness прототипной джобы (`POST …/screenshot`, §W2): сервер
 * принимает ровно `"barrier"`, всё остальное — `400 invalid_request`. Держим константой, чтобы
 * «строка в двух местах» не разъехалась с контрактом.
 */
export const SNAP_READINESS = "barrier";

/**
 * Строка блока барьера ресурсов из receipt'а (§W2): что кадр ждал и сколько это стоило.
 * `null` — политика барьера кадру не требовалась (v1/v2) или доказательство не приехало;
 * выдумывать «барьер прошёл» по отсутствию блока нельзя, поэтому строки просто нет.
 *
 * `lateAfterBarrier` печатается целиком: ресурс, приехавший **после** барьера, — это и есть
 * причина, по которой кадр нельзя считать детерминированным, и усечение списка спрятало бы её.
 */
export function resourceBarrierLine(where, receipt) {
  const barrier = receipt?.resources?.resourceBarrier ?? null;
  if (!barrier) return null;
  const late = barrier.lateAfterBarrier ?? [];
  const barrierMs = receipt?.timings?.barrierMs ?? barrier.durationMs;
  return `${where} barrier: decoded ${barrier.decoded}/${barrier.expected} resources, fonts ${barrier.fontsReady ? "ready" : "not-ready"},`
    + ` stableFrames ${barrier.stableFrames}, late ${late.length ? late.join(", ") : "-"}, ${barrierMs ?? "-"}ms`;
}

/**
 * Сводная строка подавленного шума (§W10, P2.2).
 *
 * До волны подавленное было невидимым: классификация капчура уносила `infraNoise` из вердикта, и
 * «сто раз не загрузился шрифт» читалось как чистый кадр. Строка ровно одна — это гигиена, а не
 * отказ: количество берётся из `quality.suppressedCount` результата джобы (он есть всегда), а
 * топ-сигнатура — из `console.suppressed` receipt'а (он читается только под `--receipt`/`--json`).
 */
export function suppressedNoiseLine(where, result, receipt) {
  const count = Number.isInteger(result?.suppressedCount) ? result.suppressedCount : (result?.infraNoise?.length ?? 0);
  if (!count) return null;
  // Порядок `console.suppressed` детерминирован сервером (частота убыв., затем сигнатура возр.).
  const top = receipt?.console?.suppressed?.[0] ?? null;
  return `${where} suppressed ${count}${top ? ` (top: ${top.signature} ×${top.count})` : ""}`;
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
    ...(surface.candidateOverrides === undefined ? {} : { candidateOverrides: surface.candidateOverrides }),
    // §W2: opt-in барьера ресурсов этой джобы. Поле аддитивно и **не** отправляется под
    // `--no-barrier` — сервер до волны W2 его просто не читает, а не отказывает.
    ...(surface.readiness === undefined ? {} : { readiness: surface.readiness }),
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
    if (summary.imageProduced) await downloadJobFrame(jobId, state.result, path);
    // §B2.3, сигнал детекции overlay'я: подменённый пин обязан приехать со статусом `candidate` и
    // bundleHash кандидата. Совпал с опубликованным ⇒ подмена не применилась (старая сборка,
    // выключенная фича), и молча отдать published-кадр под именем кандидатского нельзя.
    const overlayPins = (queued.json.components ?? []).filter((pin) => pin.candidate !== undefined);
    if (body.candidateOverrides !== undefined && overlayPins.length !== body.candidateOverrides.length) {
      throw new CliError(`${screenId}: server applied ${overlayPins.length} of ${body.candidateOverrides.length} candidate override(s); the frame is not a candidate frame`);
    }
    // Свидетельство происхождения кадра (R8b) — на том же jobId, что и сам кадр.
    // Документ receipt тянем только под --receipt: в --json коды readiness и отпечаток берутся
    // из результата джобы, а лишний HTTP-раунд на каждый экран делал горячий путь флаки (R8b).
    const evidence = await captureEvidence(jobId, state, wantReceipt);
    // §W2: блок барьера — часть свидетельства кадра, поэтому едет строкой отчёта и полем items.
    // Условным спредом: у кадра без барьера (v1/v2, `--no-barrier`, сервер до волны) записи нет
    // вовсе — `resourceBarrier: null` читался бы как «барьер был и ничего не нашёл».
    const barrier = evidence.document?.receipt?.resources?.resourceBarrier ?? null;
    return {
      screenId, attempts: attempt, viewport: surface.viewport,
      failure: summary.imageProduced ? null : "job reported no image",
      path: summary.imageProduced ? path : null, ...summary,
      ...(barrier ? { resourceBarrier: barrier, barrierMs: evidence.document?.receipt?.timings?.barrierMs ?? barrier.durationMs } : {}),
      jobId, receiptSha256: evidence.receiptSha256, renderer: evidence.renderer, codes: evidence.codes,
      receiptDocument: evidence.document,
      candidateOverlay: overlayPins.map((pin) => ({ componentId: pin.id, candidateId: pin.candidate.candidateId, rev: pin.candidate.rev, bundleHash: pin.bundleHash })),
    };
  }
  return {
    screenId, attempts: SNAP_ATTEMPTS, viewport: surface.viewport, failure, path: null,
    imageProduced: false, captureClean: false, productErrors: [], infraNoise: [], runtimeWarnings: [], suppressedCount: 0,
    jobId: null, receiptSha256: null, renderer: null, codes: [], receiptDocument: null, candidateOverlay: [],
  };
}

/**
 * План съёмки snap. Вьюпорт — canvas-aware, как у geometry/baseline: фиксированные 480x800
 * считали media queries по телефону даже для стикершита. Бюджет проверяется до постановки
 * заданий: превышение лимита ингеста ассетов иначе всплыло бы 413 после съёмки.
 */
export function buildSnapPlan(draft, flags = {}) {
  // §B: подмены общие для всех экранов плана — они описывают ревизию, а не кадр.
  const candidateOverrides = flags.candidate === undefined ? undefined : flags.candidate.map((candidateId) => ({ candidateId }));
  return draft.doc.screens.map((screen) => {
    const viewport = resolveViewport(screen, flags.viewport, screenDevice(draft.doc, screen));
    try {
      assertCaptureSurfaceBudget(captureSurface(screen, screenDevice(draft.doc, screen)), flags.dsf ?? 1);
      assertViewportPixelBudget(viewport, flags.dsf ?? 1);
    } catch (error) {
      throw new Error(`${screen.id}: ${error.message}`);
    }
    return {
      screenId: screen.id, viewport, deviceScaleFactor: flags.dsf, theme: flags.theme, candidateOverrides,
      // §W2: сервисная съёмка просит барьер ресурсов по умолчанию; `--no-barrier` — откат на v1.
      ...(flags.noBarrier ? {} : { readiness: SNAP_READINESS }),
    };
  });
}

/**
 * Запросы импакт-плана по плану съёмки (§W5).
 *
 * Серверная ручка планирует **одну** поверхность на вызов (вьюпорт входит в отпечаток кадра),
 * а драйверный план canvas-aware: стикершит и телефон в одном прототипе дают разные вьюпорты.
 * Поэтому экраны группируются по фактическому вьюпорту, и на каждую группу уходит свой запрос
 * с `screens[]` — иначе план считался бы не по той поверхности, что съёмка, и «доказанный
 * reuse» доказывал бы чужой кадр.
 *
 * Порядок групп и экранов внутри группы — порядок плана съёмки: отчёт обязан читаться сверху вниз
 * так же, как читается прототип.
 */
export function snapPlanRequests(plan, flags = {}) {
  const groups = new Map();
  for (const surface of plan) {
    const key = `${surface.viewport.width}x${surface.viewport.height}`;
    const group = groups.get(key) ?? { viewport: surface.viewport, screens: [] };
    group.screens.push(surface.screenId);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ viewport, screens }) => ({
    viewport,
    screens,
    // Тело — те же значения поверхности, что уедут в саму джобу: dsf и тему сервер дефолтит
    // одинаково в обоих местах (1 / light), а `readiness` — тот же opt-in барьера, что у snap.
    body: {
      viewport,
      ...(flags.dsf === undefined ? {} : { deviceScaleFactor: flags.dsf }),
      ...(flags.theme === undefined ? {} : { theme: flags.theme }),
      ...(flags.noBarrier ? {} : { readiness: SNAP_READINESS }),
      screens,
    },
  }));
}

/**
 * Строка решения плана по одному экрану (§W5). Причина печатается **всегда**: «сняли» и «не
 * сняли» без названной причины одинаково нечитаемы, а `unprovable` дополнительно называет
 * элемент, из-за которого экран недоказуем.
 */
export function snapPlanLine(decision) {
  if (decision.action === "reuse") {
    const receipt = decision.reuseReceipt ?? null;
    return `${decision.screenId}: reuse (${decision.reason}) fingerprint=${decision.screenFrameFingerprint}`
      + (receipt ? ` previousRev=${receipt.previousRev} previousPngSha256=${receipt.previousPngSha256}` : "");
  }
  return `${decision.screenId}: capture (${decision.reason})`
    + (decision.unprovable ? ` unprovable=${decision.unprovable}` : "");
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

/**
 * Возвращает прочитанные capabilities (или `null`) — тем же запросом, которым печатает
 * предупреждение о рендерере: §W5 спрашивает у них `features.impactedSnap`, и второй GET за
 * тем же документом был бы лишним раундом на горячем пути съёмки.
 */
async function warnOnRenderer() {
  let capabilities;
  try {
    const response = await call("GET", "/capabilities");
    if (response.status !== 200) return null;
    capabilities = response.json;
  } catch { return null; }
  const warning = rendererPreflightWarning(capabilities);
  if (warning) console.error(`renderer: ${warning}`);
  return capabilities ?? null;
}

/**
 * Импакт-план съёмки (§W5): что сервер обязывает снять и что доказал как переиспользуемое.
 *
 * Совместимость честная в обе стороны. Сервер волны деплоится **раньше** драйвера, но обратное
 * тоже случается (откат образа, kill-switch `EASYUI_IMPACTED_SNAP_DISABLED`): если фича не
 * объявлена в capabilities или ручки нет вовсе (404 без предметного кода), команда не падает —
 * она возвращает `plan: null` с причиной, и `snap` снимает всё, как снимал до волны. Предметные
 * 404 (`prototype_not_found`, `screen_not_found`, …) — настоящие ошибки и уходят наверх как есть.
 */
async function fetchSnapPlan(id, plan, flags, capabilities) {
  if (capabilities !== null && capabilities.features?.impactedSnap !== true) {
    return { plan: null, fallback: "server does not plan impacted snaps (capabilities.features.impactedSnap is off or the build predates plan W5); capturing every screen" };
  }
  const screens = [];
  let rev = null;
  for (const request of snapPlanRequests(plan, flags)) {
    const response = await call("POST", `/prototypes/${encodeURIComponent(id)}/snap-plan`, request.body);
    if (response.status === 404 && (errorCode(response) === undefined || errorCode(response) === "not_found")) {
      return { plan: null, fallback: `server has no POST /api/prototypes/:id/snap-plan (HTTP 404 ${errorCode(response) ?? "no code"}); capturing every screen` };
    }
    const body = await requireOk("snap-plan", response);
    screens.push(...body.screens);
    rev = body.rev;
  }
  const reuse = screens.filter((screen) => screen.action === "reuse").length;
  return { plan: { rev, screens, summary: { total: screens.length, capture: screens.length - reuse, reuse } }, fallback: null };
}

async function runSnap(args, flags, command = "snap") {
  const [id, outputDir = `author-shots/${id}`] = args;
  const capabilities = await warnOnRenderer();
  const draft = await requireOk("draft", await call("GET", `/prototypes/${encodeURIComponent(id)}/draft`));
  let plan;
  try { plan = buildSnapPlan(draft, flags); }
  catch (error) { throw new CliError(error.message); }
  // §W5: импакт-план — строго opt-in (`--impacted`); `--full` и его отсутствие снимают всё.
  const impacted = flags.impacted === true ? await fetchSnapPlan(id, plan, flags, capabilities) : { plan: null, fallback: null };
  if (impacted.fallback) console.error(`impacted: ${impacted.fallback}`);
  const decisions = impacted.plan === null ? null : new Map(impacted.plan.screens.map((screen) => [screen.screenId, screen]));
  if (impacted.plan) {
    out(`snap plan: rev ${impacted.plan.rev} — ${impacted.plan.summary.capture} capture, ${impacted.plan.summary.reuse} reuse of ${impacted.plan.summary.total}`);
  }
  await mkdir(outputDir, { recursive: true });
  const rows = [];
  const receipts = [];
  const wantReceipt = flags.receipt !== undefined;
  for (const surface of plan) {
    // Решение плана печатается перед кадром — и для съёмки (причина пересъёмки), и для reuse
    // (отпечаток с квитанцией). Экран, которого сервер в плане не назвал, снимается: молчание
    // плана не доказательство.
    const decision = decisions?.get(surface.screenId) ?? null;
    if (decision) out(snapPlanLine(decision));
    if (decision?.action === "reuse") {
      // Строка отчёта, а не кадр: `action: "reuse"` — единственный дискриминатор, у снятых
      // экранов поля нет вовсе (форма их строк не меняется волной).
      rows.push({
        screenId: surface.screenId, action: "reuse", reason: decision.reason, viewport: surface.viewport,
        screenFrameFingerprint: decision.screenFrameFingerprint, reuseReceipt: decision.reuseReceipt ?? null, path: null,
      });
      continue;
    }
    const { receiptDocument, ...captureRow } = await snapScreen(id, surface.screenId, outputDir, surface, wantReceipt);
    // §W5: причина пересъёмки — часть строки отчёта, а не только текста: агент, планирующий
    // бюджет съёмки, читает `items`. Без плана полей нет вовсе — форма строки не меняется.
    const row = decision === null ? captureRow : {
      ...captureRow, reason: decision.reason, screenFrameFingerprint: decision.screenFrameFingerprint,
      ...(decision.unprovable === undefined ? {} : { unprovable: decision.unprovable }),
    };
    rows.push(row);
    receipts.push({ screenId: surface.screenId, jobId: row.jobId, receiptSha256: row.receiptSha256, receipt: receiptDocument?.receipt ?? null });
    if (row.path) out(row.path);
    // §W2/§W10: доказательство барьера и сводка подавленного — добавочные строки; порядок и
    // текст прежних строк не трогаются (`out` молчит в `--json`, отчёт печатает их полями).
    const barrierLine = resourceBarrierLine(surface.screenId, receiptDocument?.receipt);
    if (barrierLine) out(barrierLine);
    const suppressed = suppressedNoiseLine(surface.screenId, row, receiptDocument?.receipt);
    if (suppressed && !jsonMode) console.error(suppressed);
    if (row.failure) console.error(`${surface.screenId}: ${row.failure}`);
    if (row.productErrors.length) console.error(`${surface.screenId} product errors:`, JSON.stringify(row.productErrors));
    if (row.codes.length) console.error(`${surface.screenId} capture codes:`, JSON.stringify(row.codes));
    if (row.infraNoise.length && !jsonMode) console.error(`${surface.screenId} infra noise (ignored):`, JSON.stringify(row.infraNoise));
  }
  if (wantReceipt) {
    // Один файл на команду: `snap` снимает все экраны прототипа, и receipt у каждого свой.
    await writeReceiptFile(flags.receipt, { command, prototypeId: id, rev: draft.rev, receipts });
    out(flags.receipt);
    // §W5: переиспользованные экраны в файл квитанций не попадают (у них нет джобы), поэтому
    // «все квитанции пусты» проверяется только когда хоть один кадр снимался.
    if (receipts.length > 0 && receipts.every((entry) => entry.receipt === null)) {
      console.error(`receipt: server returned no capture receipt (${lastReceiptFailure ?? "receipts disabled, evicted, or a build older than the receipt contract"}); ${flags.receipt} carries nulls`);
    }
  }
  // §W5: код возврата считается по **снятым** экранам. Переиспользованный экран кадра не
  // производил, и трактовать его как «PNG не получен» значило бы уронить успешную съёмку.
  const captured = rows.filter((row) => row.action !== "reuse");
  const exitCode = snapExitCode(captured);
  if (jsonMode) {
    report(null, {
      command, prototypeId: id, outputDir, rev: draft.rev, exitCode,
      // §W5: чем была съёмка — планом или полной пересъёмкой, и почему (`fallback` называет
      // причину отката на полную, `null` — плана не просили или он отработал).
      snapPlan: {
        mode: impacted.plan === null ? "full" : "impacted",
        requested: flags.impacted === true,
        fallback: impacted.fallback,
        rev: impacted.plan?.rev ?? null,
        summary: impacted.plan?.summary ?? null,
      },
      // Применённые значения: сервер по умолчанию снимает dsf 1 в светлой теме.
      dsf: flags.dsf ?? 1, theme: flags.theme ?? "light",
      // §B: подмены кадра — часть provenance отчёта, а не деталь вызова; `null` = обычная съёмка.
      candidateOverrides: flags.candidate ?? null,
      receipt: wantReceipt ? flags.receipt : null, screens: rows,
    }, {
      command, ok: exitCode === EXIT.ok, items: rows,
      artifacts: [...rows.map((row) => row.path).filter(Boolean), ...(wantReceipt ? [flags.receipt] : [])],
      // W6b, контракт §1.4. Счётчики берутся только по **снятым** экранам (кроме `reused`):
      // переиспользованный кадр не производил ни PNG, ни консоли, и складывать его в «чистые»
      // значило бы отчитываться о работе, которой не было.
      summary: {
        captured: captured.length,
        reused: rows.length - captured.length,
        cleanScreens: captured.filter((row) => row.path && !row.failure && row.productErrors.length === 0).length,
        failedScreens: captured.filter((row) => row.failure || !row.path).length,
        suppressedNoise: captured.reduce(
          (total, row) => total + (Number.isInteger(row.suppressedCount) ? row.suppressedCount : (row.infraNoise?.length ?? 0)),
          0,
        ),
      },
      // §W5: откат на полную пересъёмку — предупреждение конверта, а не деталь лога: агент,
      // просивший план, обязан увидеть в квитанции, что плана не было.
      warnings: [...captured.flatMap((row) => row.productErrors), ...(impacted.fallback ? [impacted.fallback] : [])],
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
  const previewBounds = geometryBoundsLine(result);
  if (previewBounds) out(previewBounds);
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
    }, {
      command: "preview", ok: exitCode === EXIT.ok, items: result.rects ?? [],
      artifacts: flags.out === undefined ? [] : [flags.out],
      warnings: [...summary.productErrors, ...summary.runtimeWarnings],
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
  // §W2/§W10: добавочные строки — блок барьера (когда джоба шла под политикой с барьером) и одна
  // сводка подавленного шума. Обе читают уже прочитанный receipt: лишнего раунда здесь нет.
  const previewBarrier = evidence.document?.receipt?.resources?.resourceBarrier ?? null;
  const previewBarrierLine = resourceBarrierLine(`preview ${id}`, evidence.document?.receipt);
  if (previewBarrierLine) out(previewBarrierLine);
  const previewSuppressed = suppressedNoiseLine(`preview ${id}`, summary, evidence.document?.receipt);
  if (previewSuppressed && !jsonMode) console.error(previewSuppressed);
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
      ...(previewBarrier ? { resourceBarrier: previewBarrier, barrierMs: evidence.document?.receipt?.timings?.barrierMs ?? previewBarrier.durationMs } : {}),
      receipt: wantReceipt ? flags.receipt : null,
    }, {
      command: "preview", ok: exitCode === EXIT.ok,
      artifacts: [...(summary.imageProduced ? [outputPath] : []), ...(wantReceipt ? [flags.receipt] : [])],
      warnings: [...summary.productErrors, ...summary.runtimeWarnings],
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
  const broken = rows.filter((row) => !row.renderable).map((row) => row.screenId);
  if (jsonMode) {
    report(null, { command: "status", prototypeId: id, screens: rows }, {
      command: "status", ok: broken.length === 0, items: rows,
      warnings: broken.map((screen) => `screen ${screen} is not renderable`),
      // W6b, контракт §1.4: `blocked` — именно список экранов, а не их число: следующий шаг
      // агента адресуется экрану.
      summary: { screensTotal: rows.length, renderable: rows.filter((row) => row.renderable).length, blocked: broken },
    });
  }
  if (broken.length) throw new CliError(`prototype screen is not renderable: ${broken.join(", ")}`);
}

/**
 * Кадр джобы на диск, независимо от канала доставки (план 2026-08-05 §B2.1).
 *
 * `kind: "image"` — кадр лежит в реестре ассетов, качается по `imageUrl`. `kind: "image-bytes"`
 * — кадра в реестре **нет** и не будет (overlay-джоба и capture'ы приёмки не ингестятся), у
 * результата нет ни `assetId`, ни `imageUrl`: байты читаются ручкой `/bytes`, пока жив результат
 * (10 минут). Молчаливо считать такую джобу «без кадра» нельзя — именно ради этих байтов её и
 * ставили.
 */
async function downloadJobFrame(jobId, result, outputPath) {
  if (result?.kind === "image-bytes") {
    const response = await client.request(`/screenshot-jobs/${encodeURIComponent(jobId)}/bytes`);
    if (!response.ok) throw new CliError(`download bytes of job ${jobId} failed (${response.status}); the job result lives 10 minutes`);
    const bytes = Buffer.from(await response.arrayBuffer());
    // sha кадра объявлен в статусе — сверяем, а не доверяем: тело могло приехать от другой джобы.
    if (typeof result.pngSha256 === "string" && result.pngSha256.length === 64) {
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== result.pngSha256) throw new CliError(`job ${jobId}: downloaded bytes hash ${actual} != declared pngSha256 ${result.pngSha256}`);
    }
    await writeFile(outputPath, bytes);
    return;
  }
  await downloadImage(result.imageUrl, outputPath);
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
    {
      command, ok: false, items: candidates,
      warnings: [`STOP: ${failure.code} while attempting to ${step} ${id}`],
      nextActions: failure.nextSteps ?? [],
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
    report(catalogListLines(result), { command: "catalog list", ...result }, { command: "catalog list", ok: true, items: result.custom ?? [] });
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
      report(catalogSearchLines(result), { command: "catalog search", ...result }, { command: "catalog search", ok: true, items: result.candidates ?? [] });
      return;
    }
    const query = new URLSearchParams({ designSystem: id, intent: flags.intent });
    if (flags.limit !== undefined) query.set("limit", String(flags.limit));
    const result = await requireOk("catalog search", await call("GET", `/catalog/candidates?${query}`));
    report(catalogSearchLines(result), { command: "catalog search", ...result }, { command: "catalog search", ok: true, items: result.candidates ?? [] });
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
    report(catalogGetLines(id, artifacts), { command: "catalog get", designSystem: id, artifacts, ...existenceReport() }, { command: "catalog get", ok: true, items: artifacts });
    return;
  }
  const [id, output] = args;
  const { manifest, system } = await loadCatalog(id);
  const result = flags.full ? fullCatalog(system, manifest) : compactCatalog(system, manifest);
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (output) await writeFile(output, text);
  else report(text.trimEnd(), result, { command: "catalog", ok: true });
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
  report(diffSummary(result), result, { command: "diff", ok: true });
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
  if (jsonMode) {
    report(null, { command: "baseline", prototypeId: id, rev: plan.rev, members: result.members }, {
      command: "baseline", ok: true, items: result.members ?? [],
      artifacts: outputDir ? captures.map((capture) => `${outputDir}/${capture.screenId}.png`) : [],
    });
  }
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
  const failedChecks = rows.filter((row) => row.status !== "pass");
  report(
    ["screenId\tstatus\tdiffPercent\trefRev->candRev\tdiffUrl", ...rows.map((row) => `${row.screenId}\t${row.status}\t${row.diffPercent ?? "-"}\t${row.revisions}\t${row.diffUrl ?? "-"}`)],
    rows,
    {
      command: "check", ok: failedChecks.length === 0, items: rows,
      warnings: failedChecks.map((row) => `${row.screenId}: ${row.status}`),
    },
  );
  if (failedChecks.length) throw new CliError("visual check failed");
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
  report(readinessLines(readiness), { command: "readiness", exitCode, ...readiness }, {
    command: "readiness", ok: exitCode === EXIT.ok, items: readiness.gates ?? [],
    warnings: failingGates(readiness).map((gate) => `${gate.id}: ${gate.summary}`),
  });
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
      {
        command: "publish", ok: false, items: readiness.gates ?? [],
        warnings: failing.map((gate) => `${gate.id}: ${gate.summary}`),
      },
    );
    throw new CliError(`publish refused: failing gates ${failing.map((gate) => gate.id).join(", ")}`, { exitCode: EXIT.productErrors });
  }
  const response = await call("POST", `/prototypes/${encoded}/publish`, { baseRev: readiness.rev, ...(flags.force ? { force: true } : {}) });
  if (response.status === 409 && errorCode(response) === "publish_blocked") {
    const blocked = response.json.error.report ?? readiness;
    report(
      ["publish blocked by readiness gates", ...readinessLines(blocked)],
      { command: "publish", prototypeId: id, published: false, exitCode: EXIT.productErrors, blocking: blocked.blocking ?? [], readiness: blocked },
      { command: "publish", ok: false, items: blocked.gates ?? [], warnings: blocked.blocking ?? [] },
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
    {
      command: "publish", ok: true,
      items: (published.screens ?? []).map((screen) => ({ ...screen, url: `${base}${screen.url}` })),
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
  report(flags.tree ? treeLines(usages) : usageLines(usages), { command: "usages", ...usages }, {
    command: "usages", ok: true, items: usages.currentHeadUsages ?? [],
  });
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
  report(auditLines(flags.designSystem, rows, findings), { command: "audit", designSystem: flags.designSystem, exitCode, components: rows, findings }, {
    command: "audit", ok: exitCode === EXIT.ok, items: rows,
    warnings: findings.deprecatedInUse.map((componentId) => `deprecated component still in use: ${componentId}`),
    // W6b, контракт §1.4: `exitCode` в квитанции — не дубль `ok`, а различение «чисто» (0) и
    // «есть deprecated в использовании» (2) без чтения payload'а.
    summary: { exitCode, deprecatedInUse: findings.deprecatedInUse.length, unused: findings.unused.length },
  });
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
    { command: "provenance", ok: true },
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
    {
      command: "promote", ok: true, warnings: result.warnings ?? [],
      // W6b, контракт §1.4: `runsLinked` — сколько ранов приписано версии (0 — публикация без
      // доказательной базы, законный исход `acceptanceLinkSource: "none"`).
      summary: {
        version: result.version ?? null,
        rev: result.rev ?? null,
        catalogRevision: result.catalogRevision ?? null,
        candidateId,
        runsLinked: acceptanceRunIds.length,
      },
    },
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
  // Боевая форма плана (сервер v29+): `{frame:{all,failed,caseIds}, verdict:{…}}` — два скоупа
  // рядом, а не один режим. Читается первой: именно её отдаёт `refresh_json` рана.
  if (typeof value.frame === "object" || typeof value.verdict === "object") {
    const parts = [];
    for (const scope of ["frame", "verdict"]) {
      const target = value[scope];
      if (target === null || typeof target !== "object") continue;
      if (target.all === true) parts.push(`${scope}:all`);
      else if (target.failed === true) parts.push(`${scope}:failed`);
      if (Array.isArray(target.caseIds) && target.caseIds.length > 0) parts.push(`${scope}:${target.caseIds.length} case(s)`);
    }
    return parts.length ? parts.join(" ") : "none";
  }
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

// ------------------------------------------------- компактная сводка рана (§W8, P1-9)

/**
 * Локальная сводка полного рана — фолбэк для сервера без `?view=summary`.
 *
 * Форма **та же**, что у серверной (`view:"summary"`), потому что её читает агент, а не человек:
 * различаться должен источник (`summarySource`), а не набор полей. Считать её на клиенте всё
 * равно приходится — старая сборка молча игнорирует query и отдаёт полный ран, и деградировать
 * из-за этого в 1800 строк было бы ровно тем, что волна чинит.
 */
export function localRunSummary(run) {
  const { eta: _eta, ...progress } = run.progress ?? {};
  const gates = {};
  for (const [gate, counts] of Object.entries(run.gates ?? {})) {
    gates[gate] = counts !== null && typeof counts === "object" && !Array.isArray(counts)
      ? Object.entries(counts).map(([status, count]) => `${status}:${count}`).join(" ")
      : String(counts);
  }
  const remediationGroups = {};
  for (const group of run.remediationGroups ?? []) {
    if (!group || typeof group.key !== "string") continue;
    const cases = Array.isArray(group.cases) ? group.cases : [];
    remediationGroups[group.key.slice(0, 12)] = `${group.cause?.code ?? "unclassified"} ×${cases.length}: ${cases.join(", ")}`;
  }
  const refresh = run.refresh ?? null;
  return {
    view: "summary",
    summarySource: "client",
    runId: run.runId,
    status: run.status,
    statusReason: run.statusReason ?? null,
    progress,
    gates,
    refresh: refresh === null || typeof refresh !== "object"
      ? null
      : {
        requested: refreshScopeText(refresh.requested) ?? "none",
        impact: refreshScopeText(refresh.impact) ?? "none",
        effective: refreshScopeText(refresh.effective) ?? "none",
      },
    failedCases: (run.failedCases ?? []).map((item) => {
      const gate = (item.failedGates ?? [])[0] ?? null;
      const metrics = gate?.metrics ?? {};
      const cause = (item.causes ?? [])[0] ?? null;
      const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
      return {
        caseId: item.caseId,
        gate: gate?.gate ?? (item.status === "error" ? "error" : "-"),
        raw: number(metrics.rawDiffPct),
        aa: number(metrics.aaDiffPct),
        cause: cause ? `${cause.code}${cause.detail ? `: ${cause.detail}` : ""}` : gate?.detail ?? `verdict ${item.verdict ?? item.status}`,
      };
    }),
    remediationGroups,
    evidenceUrl: `/api/acceptance-runs/${run.runId}/evidence`,
  };
}

/**
 * Сводка рана: серверная, если сервер её умеет, иначе — локальная над уже полученным раном.
 *
 * Два условия, а не одно (C23): capability-флаг **и** маркер `view` в теле. Флаг отвечает на
 * вопрос «сборка умеет», маркер — «этот ответ действительно сводка»: сервер прошлых волн на
 * незнакомый query отвечает полным раном с кодом 200, и доверять одному лишь коду нельзя.
 */
async function acceptanceSummary(run, capabilities) {
  if (capabilities?.features?.acceptanceSummaryView === true) {
    const response = await call("GET", `/acceptance-runs/${encodeURIComponent(run.runId)}?view=summary`);
    if (response.status === 200 && response.json?.view === "summary") {
      return { summarySource: "server", ...response.json };
    }
    progress(`warning: server did not answer ?view=summary with a summary marker (status ${response.status}); summarising locally`);
  }
  return localRunSummary(run);
}

/** Человеческий вид сводки: те же данные, что в `--json`, без повторения метрик по случаям. */
function summaryLines(summary, { componentId, evidencePath }) {
  const done = summary.progress ?? {};
  const lines = [
    `acceptance ${componentId ?? "-"} run ${summary.runId} verdict ${summary.status}${summary.statusReason ? ` (${summary.statusReason})` : ""}`,
    `cases: ${done.completed ?? 0}/${done.total ?? 0} reused=${done.reused ?? 0} frameReused=${done.frameReused ?? 0}`
      + ` recomputed=${done.verdictRecomputed ?? 0} rediffed=${done.rediffed ?? 0} failed=${done.failed ?? 0}`,
    `gates: ${Object.entries(summary.gates ?? {}).map(([gate, text]) => `${gate}[${text}]`).join(" ") || "-"}`,
  ];
  if (summary.refresh) {
    lines.push(`refresh: requested=${summary.refresh.requested} impact=${summary.refresh.impact} effective=${summary.refresh.effective}`);
  }
  if (summary.failedCases?.length) {
    lines.push("failed cases (worst first):");
    for (const item of summary.failedCases) {
      const metrics = item.raw === null && item.aa === null ? "" : ` raw=${item.raw ?? "-"}% aa=${item.aa ?? "-"}%`;
      lines.push(`  ${item.caseId} ${item.gate}${metrics}: ${item.cause}`);
    }
  }
  for (const [key, text] of Object.entries(summary.remediationGroups ?? {})) lines.push(`remediation ${key}: ${text}`);
  lines.push(evidencePath ? `evidence: ${evidencePath}` : `evidence: GET ${summary.evidenceUrl} (pass --evidence <file.zip> to download)`);
  lines.push(`drill down: driver.mjs accept-status ${summary.runId} --case <caseId>`);
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

/**
 * Отчёт о терминальном ране. `summary` (флаг `--summary`) меняет **что печатается**, но не то,
 * что записывается: `cache.link`/`cache.receipt` всегда строятся из **полного** рана (D-E), иначе
 * навигация «кандидат → ран → случаи» осталась бы без вердиктов случаев ровно в том сценарии,
 * ради которого сводка и заводилась.
 */
/**
 * Топ причин провала рана (контракт `summary` §1.4, W6b).
 *
 * Источник — тот же документ, что уехал в payload: у полного рана это `remediationGroups`
 * (сервер уже сгруппировал и отсортировал их по числу случаев — одна правка чинит группу),
 * у сводки групп нет в машинном виде, и причины считаются по `failedCases`. Форма одна
 * (`{code, cases}`) в обоих случаях: читатель квитанции не обязан знать, каким видом рана его
 * снабдили.
 */
export function topCauses(document, limit = 5) {
  const groups = Array.isArray(document?.remediationGroups) ? document.remediationGroups : null;
  if (groups?.length) {
    return groups
      .map((group) => ({
        code: typeof group?.cause?.code === "string" ? group.cause.code : "unclassified",
        cases: Number.isInteger(group?.caseCount) ? group.caseCount : (group?.cases?.length ?? 0),
      }))
      .sort((a, b) => b.cases - a.cases)
      .slice(0, limit);
  }
  const counts = new Map();
  for (const item of document?.failedCases ?? []) {
    // Полный ран несёт классифицированные причины объектами; сводка — строкой `code: detail`;
    // случай без причины называется своим гейтом, а не «unclassified»-затычкой.
    const code = typeof item?.causes?.[0]?.code === "string"
      ? item.causes[0].code
      : typeof item?.cause === "string"
        ? (item.cause.split(":")[0] ?? "").trim() || "unclassified"
        : typeof item?.gate === "string" ? item.gate : "unclassified";
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([code, cases]) => ({ code, cases }))
    .sort((a, b) => b.cases - a.cases)
    .slice(0, limit);
}

/**
 * Контракт `summary` вербов приёмки (§1.4): `runId, verdict, casesTotal, casesFailed,
 * casesReused, topCauses[], revision`.
 *
 * `revision` — ревизия компонента, по которой собран кандидат. Она известна `accept` (кандидат
 * создаётся тут же и несёт `rev`) и **не** известна `accept-status`: вид рана ревизии не
 * содержит вовсе, и подставлять голову компонента было бы враньём — ран мог быть снят по
 * прошлой. Поэтому там честный `null`, а не догадка.
 */
export function acceptanceSummaryFields(document, { revision = null } = {}) {
  const progress = document?.progress ?? {};
  const failedCases = document?.failedCases ?? [];
  const count = (value) => (Number.isInteger(value) ? value : null);
  return {
    runId: document?.runId ?? null,
    verdict: document?.status ?? null,
    casesTotal: count(progress.total),
    casesFailed: count(progress.failed) ?? failedCases.length,
    casesReused: count(progress.reused),
    topCauses: topCauses(document),
    revision,
  };
}

async function reportAcceptance(run, { command, componentId, candidateId, flags, summary = null, revision = null }) {
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
  report(
    summary === null
      ? acceptLines(run, { componentId, evidencePath })
      : summaryLines(summary, { componentId: componentId ?? run.componentId, evidencePath }),
    {
      command, componentId: componentId ?? run.componentId, candidateId: candidateId ?? run.candidateId,
      exitCode, ...(evidencePath ? { evidence: evidencePath } : {}), ...(summary ?? run), ...existenceReport(),
    },
    {
      // Источник `items` — тот же документ, что и payload: под `--summary` в отчёт не должны
      // просачиваться полные метрики гейтов, ради компактности сводка и заводилась (W8).
      command, ok: exitCode === EXIT.ok, items: (summary ?? run).failedCases ?? [],
      // W6b: контракт квитанции считается по **полному** рану — сводка теряет прогресс не
      // всегда, но `casesReused` в ней уже производное, а квитанция обязана быть одинаковой
      // независимо от того, просили ли `--summary`.
      summary: acceptanceSummaryFields(run, { revision }),
      artifacts: evidencePath ? [evidencePath] : [],
      warnings: ((summary ?? run).failedCases ?? []).map((item) => `case ${item.caseId}: ${item.verdict ?? item.status ?? item.gate}`),
    },
  );
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
  maxSlotChildren: 12,
  maxSlotsPerCase: 8,
  // Вложенные слоты (план 2026-08-06 §W6): уровней от корня случая и узлов на случай целиком.
  maxSlotDepth: 3,
  maxSlotNodes: 96,
  // Per-case допуски (план 2026-08-06 §W3): потолки `sizeDeltaPx` и сторон `overflowBudgetPx`.
  maxCaseSizeDeltaPx: 64,
  maxCaseOverflowBudgetPx: 256,
  // Candidate dependency overlay (план 2026-08-07 §W3): узлов неопубликованных зависимостей
  // на манифест. Потолок судит сервер (`422 candidate_overlay_limit`) — здесь его эхо.
  maxOverlayNodes: 8,
});

/** Формат id кандидата (`server/acceptance/ids.ts#CANDIDATE_ID_PATTERN`). */
const CANDIDATE_ID_PATTERN = /^cand_[0-9a-f]{64}$/;

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
    maxSlotChildren: number(limits.caseSetMaxSlotChildren, CASE_SET_LIMITS.maxSlotChildren),
    maxSlotsPerCase: number(limits.caseSetMaxSlotsPerCase, CASE_SET_LIMITS.maxSlotsPerCase),
    maxSlotDepth: number(limits.caseSetMaxSlotDepth, CASE_SET_LIMITS.maxSlotDepth),
    maxSlotNodes: number(limits.caseSetMaxSlotNodes, CASE_SET_LIMITS.maxSlotNodes),
    maxCaseSizeDeltaPx: number(limits.caseSetMaxCaseSizeDeltaPx, CASE_SET_LIMITS.maxCaseSizeDeltaPx),
    maxCaseOverflowBudgetPx: number(limits.caseSetMaxCaseOverflowBudgetPx, CASE_SET_LIMITS.maxCaseOverflowBudgetPx),
    maxOverlayNodes: number(limits.caseSetMaxOverlayNodes, CASE_SET_LIMITS.maxOverlayNodes),
  };
}

/**
 * Локальная проверка `slotBindings` случая (план 2026-08-05 §A1/§A2, вложенность — 2026-08-06 §W6):
 * только форма и потолки, включая глубину дерева и тотал узлов случая. Всё, что требует базы —
 * существование пина, его статус, ДС, схема props ребёнка, — остаётся сервером:
 * `slot_component_not_published`, `slot_props_invalid`, `slot_props_dynamic` и прочие `422`
 * драйвер не предсказывает и не имитирует.
 *
 * Ребёнок бывает двух форм (план 2026-08-07 §W3): **пин** `{type, version}` — опубликованная
 * версия, и **overlay** `{overlay: "<componentId>"}` — узел из карты `candidateOverlay` манифеста,
 * который ещё ни разу не публиковался. Формы различаются по наличию ключа `overlay` (тот же
 * дискриминатор, что у серверной схемы), и смешивать их в одном объекте нельзя: пара
 * «версия + кандидат» не отвечает на вопрос, чем именно набит слот. Найденные ссылки копятся в
 * `overlayRefs` — на них замыкается проверка карты (`candidate_overlay_unused|unknown`).
 */
function slotBindingIssues(bindings, where, limits, overlayRefs = new Set()) {
  const issues = [];
  // Тотал узлов считается по дереву случая целиком (серверный `slot_nodes_exceeded`).
  const state = { nodes: 0 };
  const level = (value, at, depth) => {
    if (!isPlainObject(value)) { issues.push(`${at} must be an object of slot -> children[]`); return; }
    const slots = Object.entries(value);
    if (slots.length === 0) issues.push(`${at} must not be empty (omit the field instead)`);
    if (slots.length > limits.maxSlotsPerCase) issues.push(`${at}: at most ${limits.maxSlotsPerCase} slots (got ${slots.length})`);
    for (const [slot, children] of slots) {
      if (!CASE_SET_SLOT_KEY.test(slot) || slot.length > 32) {
        issues.push(`${at}["${slot}"]: slot key must match ^[a-z0-9]+(?:-[a-z0-9]+)*$ (<=32 chars); "default" binds the implicit children slot`);
      }
      if (!Array.isArray(children) || children.length === 0) { issues.push(`${at}["${slot}"] must be a non-empty array of children`); continue; }
      if (children.length > limits.maxSlotChildren) issues.push(`${at}["${slot}"]: at most ${limits.maxSlotChildren} children (got ${children.length})`);
      for (const [index, child] of children.entries()) {
        const childAt = `${at}["${slot}"][${index}]`;
        state.nodes += 1;
        if (depth > limits.maxSlotDepth) {
          issues.push(`${childAt}: slot trees are limited to ${limits.maxSlotDepth} levels below the case (got ${depth})`);
          continue;
        }
        if (state.nodes > limits.maxSlotNodes) {
          issues.push(`${childAt}: the slot tree of a case holds at most ${limits.maxSlotNodes} children`);
          continue;
        }
        if (!isPlainObject(child)) {
          issues.push(`${childAt} must be an object {type, version, props?, slotBindings?} or {overlay, props?, slotBindings?}`);
          continue;
        }
        // §W3: overlay-форма ребёнка. Дискриминатор — наличие ключа `overlay`; версии у неё нет
        // вовсе (кандидат не опубликован, и сентинел исказил бы `slotsHash`).
        const overlayForm = child.overlay !== undefined;
        const allowed = overlayForm ? ["overlay", "props", "slotBindings"] : ["type", "version", "props", "slotBindings"];
        for (const key of Object.keys(child)) if (!allowed.includes(key)) issues.push(`${childAt}: unknown field "${key}"`);
        if (overlayForm) {
          if (typeof child.overlay !== "string" || child.overlay.length === 0 || child.overlay.length > 64) {
            issues.push(`${childAt}.overlay must be the componentId of a candidateOverlay node (1..64 chars)`);
          } else overlayRefs.add(child.overlay);
        } else {
          if (typeof child.type !== "string" || child.type.length === 0) issues.push(`${childAt}.type must be the published component name`);
          // Точный пин версии — обязателен: набор контентно адресован, и «последняя активная»
          // сделала бы его смысл зависимым от момента прогона.
          if (!Number.isInteger(child.version) || child.version < 1) issues.push(`${childAt}.version must be an exact published version (a positive integer), not "latest"`);
        }
        if (child.props !== undefined && !isPlainObject(child.props)) issues.push(`${childAt}.props must be an object`);
        // Поддерево ребёнка (§W6): та же форма, уровнем ниже.
        if (child.slotBindings !== undefined) level(child.slotBindings, `${childAt}.slotBindings`, depth + 1);
      }
    }
  };
  level(bindings, `${where}.slotBindings`, 1);
  return issues;
}

const CASE_POLICY_KEYS = new Set([
  "maxRawDiffPct", "allowPaintOverflow", "expectedClip",
  // План 2026-08-06 §W3: per-case допуск габаритов и per-side бюджет краски.
  "sizeDeltaPx", "overflowBudgetPx",
]);
const OVERFLOW_BUDGET_SIDES = ["top", "right", "bottom", "left"];

/**
 * Локальная проверка `policy.perCase` (план 2026-08-06 §W3, §1.5).
 *
 * Драйвер обязан **принимать** легальные новые поля (иначе манифест не уедет и до сети) и
 * **отвергать** объявленный конфликт до сети: `allowPaintOverflow` вместе с `overflowBudgetPx` —
 * два разных намерения об одном вердикте, сервер отвечает на них 422 `case_policy_conflict`, и
 * узнавать об этом round-trip'ом незачем. Всё, что требует базы (алиасы, существование случая),
 * остаётся сервером.
 */
export function casePolicyIssues(policy, limits = CASE_SET_LIMITS) {
  const issues = [];
  if (policy === undefined) return issues;
  if (!isPlainObject(policy)) return ["policy must be an object"];
  for (const key of Object.keys(policy)) {
    if (key !== "profile" && key !== "perCase") issues.push(`policy: unknown field "${key}"`);
  }
  if (policy.perCase === undefined) return issues;
  if (!isPlainObject(policy.perCase)) return [...issues, "policy.perCase must be an object of caseId → per-case policy"];
  for (const [caseId, item] of Object.entries(policy.perCase)) {
    const at = `policy.perCase."${caseId}"`;
    if (!isPlainObject(item)) { issues.push(`${at} must be an object`); continue; }
    for (const key of Object.keys(item)) {
      if (!CASE_POLICY_KEYS.has(key)) issues.push(`${at}: unknown field "${key}"`);
    }
    if (item.sizeDeltaPx !== undefined
      && (!Number.isInteger(item.sizeDeltaPx) || item.sizeDeltaPx < 0 || item.sizeDeltaPx > limits.maxCaseSizeDeltaPx)) {
      issues.push(`${at}.sizeDeltaPx must be an integer 0..${limits.maxCaseSizeDeltaPx} (CSS px)`);
    }
    if (item.overflowBudgetPx !== undefined) {
      const budget = item.overflowBudgetPx;
      if (!isPlainObject(budget)) issues.push(`${at}.overflowBudgetPx must be an object of sides`);
      else {
        const sides = Object.keys(budget);
        for (const side of sides) {
          if (!OVERFLOW_BUDGET_SIDES.includes(side)) { issues.push(`${at}.overflowBudgetPx: unknown side "${side}"`); continue; }
          const value = budget[side];
          if (!Number.isInteger(value) || value < 0 || value > limits.maxCaseOverflowBudgetPx) {
            issues.push(`${at}.overflowBudgetPx.${side} must be an integer 0..${limits.maxCaseOverflowBudgetPx} (CSS px)`);
          }
        }
        if (sides.length === 0) {
          issues.push(`${at}.overflowBudgetPx must declare at least one side (an empty budget is a forgotten intent, not "zero")`);
        }
      }
      if (item.allowPaintOverflow !== undefined) {
        issues.push(`${at}: allowPaintOverflow and overflowBudgetPx are mutually exclusive (422 case_policy_conflict):`
          + " keep the blanket allowance or the per-side budget, not both");
      }
    }
  }
  return issues;
}

/**
 * Все `componentId`, которые overlay-дети манифеста связывают — по всем случаям и всем уровням
 * вложенности (зеркало серверного `overlayReferencesOf`). Вход обеих проверок замыкания графа.
 */
export function overlayReferencesOf(manifest) {
  const referenced = new Set();
  const walk = (bindings) => {
    if (!isPlainObject(bindings)) return;
    for (const children of Object.values(bindings)) {
      if (!Array.isArray(children)) continue;
      for (const child of children) {
        if (!isPlainObject(child)) continue;
        if (typeof child.overlay === "string" && child.overlay.length > 0) referenced.add(child.overlay);
        walk(child.slotBindings);
      }
    }
  };
  for (const item of manifest?.cases ?? []) if (isPlainObject(item)) walk(item.slotBindings);
  return referenced;
}

/**
 * Локальная проверка карты `candidateOverlay` (план 2026-08-07 §W3, §1.2) — до сети.
 *
 * Драйвер закрывает ровно те отказы, которые видны по одному манифесту, и называет серверный код,
 * чтобы отказ читался одинаково с обеих сторон:
 * - `candidate_overlay_limit` — узлов больше потолка;
 * - `candidate_overlay_duplicate` — один `candidateId` под двумя `componentId` (кандидат
 *   компонентно-скоупный, и одна сборка не может описывать два компонента);
 * - `candidate_overlay_unused` — узел, до которого дерево случаев не дотягивается, и объявление
 *   **субъекта** приёмки (его голова приезжает кандидатом рана, а не overlay'ем);
 * - `candidate_overlay_unknown` — ребёнок ссылается на необъявленный узел.
 *
 * Всё, что требует базы (существование компонента, его дизайн-система, живость кандидата), —
 * серверное: `candidate_overlay_component_not_found`, `..._design_system_mismatch`,
 * `..._component_mismatch`, `409 ..._expired|evicted` драйвер не предсказывает.
 */
export function candidateOverlayIssues(manifest, limits = CASE_SET_LIMITS, overlayRefs = new Set()) {
  const issues = [];
  const overlay = manifest?.candidateOverlay;
  if (overlay === undefined) {
    for (const node of overlayRefs) {
      issues.push(`a slot child binds overlay "${node}", but the manifest declares no candidateOverlay map`
        + " (422 candidate_overlay_unknown)");
    }
    return issues;
  }
  if (!isPlainObject(overlay)) return ["candidateOverlay must be an object of componentId → candidate id (cand_<sha256>)"];
  const entries = Object.entries(overlay);
  if (entries.length > limits.maxOverlayNodes) {
    issues.push(`candidateOverlay declares ${entries.length} nodes, above the ceiling of ${limits.maxOverlayNodes}`
      + " (422 candidate_overlay_limit): a graph that large is a migration, not a case set");
  }
  const byCandidate = new Map();
  for (const [node, candidateId] of entries) {
    if (node.length === 0 || node.length > 64) issues.push(`candidateOverlay."${node}": a node key is a componentId of 1..64 chars`);
    if (typeof candidateId !== "string" || !CANDIDATE_ID_PATTERN.test(candidateId)) {
      issues.push(`candidateOverlay."${node}" must be a candidate id (cand_<sha256>), got ${JSON.stringify(candidateId)}`);
      continue;
    }
    const first = byCandidate.get(candidateId);
    if (first !== undefined) {
      issues.push(`candidateOverlay maps "${first}" and "${node}" to the same candidate ${candidateId}`
        + " (422 candidate_overlay_duplicate): a candidate describes exactly one component");
    } else byCandidate.set(candidateId, node);
    if (node === manifest.componentId) {
      issues.push(`candidateOverlay declares the subject component "${node}" (422 candidate_overlay_unused):`
        + " the head of the run is its own acceptance candidate");
    } else if (!overlayRefs.has(node)) {
      issues.push(`candidateOverlay declares "${node}", which no slot child of this set binds`
        + " (422 candidate_overlay_unused): an unused node would shift every frame fingerprint without changing a pixel");
    }
  }
  for (const node of overlayRefs) {
    if (!Object.prototype.hasOwnProperty.call(overlay, node)) {
      issues.push(`a slot child binds overlay "${node}", which candidateOverlay does not declare (422 candidate_overlay_unknown)`);
    }
  }
  return issues;
}

/** Пресеты бюджета растрового текста (план 2026-08-06 §1.2): **имена**, числа владеет сервер. */
const TEXT_AA_BUDGETS = ["live-text-v1"];
/** Matte сравнения: `"none"` либо `#RRGGBB` (§W4 T4a). Дефолт — «не матировать», у потребителя. */
const COMPARISON_MATTE = /^#[0-9a-fA-F]{6}$/;

/**
 * Локальная проверка полей сравнения случая (§W4, §1.5).
 *
 * Ошибка здесь дешевле сети на порядок: манифест на 49 состояний с `matte: "white"` иначе уехал бы
 * целиком, чтобы вернуться одним 422. Числа пресета драйвер **не** знает и знать не должен — он
 * проверяет только имя из закрытого списка.
 */
function comparisonIssues(item, where) {
  const issues = [];
  if (item.comparison !== undefined) {
    if (!isPlainObject(item.comparison)) issues.push(`${where}.comparison must be an object`);
    else {
      for (const key of Object.keys(item.comparison)) {
        if (key !== "matte") issues.push(`${where}.comparison: unknown field "${key}"`);
      }
      const matte = item.comparison.matte;
      if (matte !== undefined && matte !== "none" && !(typeof matte === "string" && COMPARISON_MATTE.test(matte))) {
        issues.push(`${where}.comparison.matte must be "none" or a #RRGGBB colour (got ${JSON.stringify(matte)})`);
      }
    }
  }
  if (item.textAaBudget !== undefined && !TEXT_AA_BUDGETS.includes(item.textAaBudget)) {
    issues.push(`${where}.textAaBudget must be one of ${TEXT_AA_BUDGETS.join(", ")}`
      + " (a named server-owned preset, not a number: tuning the thresholds means a new preset)");
  }
  return issues;
}

/**
 * Четыре поверхности геометрии (план 2026-08-07 §W1a). Порядок значим — он же порядок
 * `divergingSurfaces[]` вердикта; здесь он даёт стабильный текст отказа.
 */
const GEOMETRY_SURFACES = ["root", "layoutUnion", "paint", "referenceExport"];
/** Единственное значение `clipExpectation`: вариант «root-clips-layout» снят вместе со сценарием. */
const CLIP_EXPECTATION = "root-does-not-clip-layout";
/** Потолок габарита поверхности в CSS px — тот же `dimensionPx`, что у схемы набора. */
const SURFACE_DIMENSION_MAX = 8192;

const surfaceDimsIssues = (dims, at) => {
  if (!isPlainObject(dims)) return [`${at} must be an object {width, height} in CSS px`];
  const issues = [];
  for (const key of Object.keys(dims)) {
    if (key !== "width" && key !== "height") issues.push(`${at}: unknown field "${key}" (a surface is {width, height} in CSS px)`);
  }
  for (const axis of ["width", "height"]) {
    const value = dims[axis];
    if (!Number.isInteger(value) || value <= 0 || value > SURFACE_DIMENSION_MAX) {
      issues.push(`${at}.${axis} must be an integer 1..${SURFACE_DIMENSION_MAX} (CSS px)`);
    }
  }
  return issues;
};

/**
 * Локальная проверка четырёх поверхностей случая (план 2026-08-07 §W1a, §1.1).
 *
 * Зеркалит `caseSurfaceIssueOf` (`src/acceptance/surfaces.ts`) — те же три несовместимости и те же
 * коды, только до сети: манифест на полсотни состояний иначе уезжает целиком, чтобы вернуться
 * одним `422`. Нормализация здесь та же, что на сервере: `expectedGeometry` читается как
 * `expectedSurfaces.layoutUnion`, поэтому доволновой случай с `comparisonSurface: "layoutUnion"`
 * законен и обязан уехать.
 *
 * Семантические проверки идут **после** формы и возвращают ровно одну причину (как сервер): автор
 * чинит по одной, а список из трёх взаимозависимых претензий читается как три разных бага.
 */
export function caseSurfaceIssues(item, where) {
  const issues = [];
  const declared = item.expectedSurfaces;
  if (declared !== undefined) {
    if (!isPlainObject(declared)) issues.push(`${where}.expectedSurfaces must be an object of surface -> {width, height}`);
    else {
      const names = Object.keys(declared);
      if (names.length === 0) {
        issues.push(`${where}.expectedSurfaces must declare at least one surface`
          + " (an empty object is a forgotten intent, not \"no surfaces\" — omit the field instead)");
      }
      for (const name of names) {
        if (!GEOMETRY_SURFACES.includes(name)) {
          issues.push(`${where}.expectedSurfaces: unknown surface "${name}" (one of ${GEOMETRY_SURFACES.join(", ")})`);
          continue;
        }
        issues.push(...surfaceDimsIssues(declared[name], `${where}.expectedSurfaces.${name}`));
      }
    }
  }
  if (item.expectedGeometry !== undefined) {
    issues.push(...surfaceDimsIssues(item.expectedGeometry, `${where}.expectedGeometry`));
  }
  if (item.comparisonSurface !== undefined && !GEOMETRY_SURFACES.includes(item.comparisonSurface)) {
    issues.push(`${where}.comparisonSurface must be one of ${GEOMETRY_SURFACES.join(", ")}`
      + ` (got ${JSON.stringify(item.comparisonSurface)})`);
  }
  if (item.clipExpectation !== undefined && item.clipExpectation !== CLIP_EXPECTATION) {
    issues.push(`${where}.clipExpectation must be "${CLIP_EXPECTATION}" (the only expectation the contract defines)`);
  }
  if (issues.length > 0) return issues;

  // Нормализация сервера: явная декларация, иначе `expectedGeometry` в роли `layoutUnion`.
  const declaresSurfaces = isPlainObject(declared) && Object.keys(declared).length > 0;
  const surfaces = declaresSurfaces ? declared
    : (isPlainObject(item.expectedGeometry) ? { layoutUnion: item.expectedGeometry } : {});
  if (item.expectedGeometry !== undefined && declaresSurfaces) {
    return [`${where}: expectedGeometry and expectedSurfaces are mutually exclusive (422 case_surface_conflict):`
      + " expectedGeometry is the legacy spelling of expectedSurfaces.layoutUnion — keep one of them"];
  }
  if (item.comparisonSurface !== undefined && surfaces[item.comparisonSurface] === undefined) {
    return [`${where}: comparisonSurface "${item.comparisonSurface}" is never declared`
      + ` (422 case_comparison_surface_undeclared): declare expectedSurfaces.${item.comparisonSurface} (CSS px)`];
  }
  if (item.clipExpectation !== undefined && surfaces.root === undefined) {
    return [`${where}: clipExpectation "${item.clipExpectation}" without expectedSurfaces.root`
      + " (422 case_clip_expectation_requires_root): the expectation is a statement about the root box"
      + " and is unverifiable without it"];
  }
  return [];
}

const CASE_SET_ID_CHARSET = /^[A-Za-z0-9._-]{1,64}$/;
const CASE_SET_TOP_LEVEL_KEYS = new Set([
  "manifestVersion", "componentId", "source", "capture", "dimensions", "requireVisual", "policy", "cases",
  // План 2026-08-07 §W3: карта неопубликованных зависимостей графа (`componentId → cand_…`).
  // Без ключа в allowlist легальный overlay-манифест отвергался бы локально и до сети.
  "candidateOverlay",
]);
/** Блок `capture` строгий на сервере: опечатка в нём — отказ, а не умолчание (W5 добавил `surface`). */
const CASE_SET_CAPTURE_KEYS = new Set(["viewport", "deviceScaleFactor", "theme", "surface"]);
const CASE_SET_SURFACES = ["hug", "viewport"];
const CASE_SET_CASE_KEYS = new Set([
  "id", "props", "referenceAssetId", "expectedGeometry", "cropLineage", "referenceSurface",
  "referencePlacement", "aliasOf", "dims",
  // План 2026-08-06 §W4: контракт сравнения (`comparison.matte`) и именованный пресет растрового
  // текста (`textAaBudget`). Оба — уровень **кейса**, а не `policy.perCase`.
  "comparison", "textAaBudget",
  // План 2026-08-05 §A1: дети слотов случая. Держать ключ в allowlist обязательно — иначе
  // локальная проверка отвергала бы легальный манифест, до сети и без шанса на объяснение.
  "slotBindings",
  // План 2026-08-07 §W1a: четыре поверхности геометрии вместо одного числа `expectedGeometry`,
  // поверхность сравнения и ожидание «корень не режет layout». Все габариты — CSS px.
  "expectedSurfaces", "comparisonSurface", "clipExpectation",
]);
/** Ключ слота — тот же kebab-charset, что и у `definition.slots`; `default` зарезервирован (§A2a). */
const CASE_SET_SLOT_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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
  if (isPlainObject(manifest.capture)) {
    for (const key of Object.keys(manifest.capture)) {
      if (!CASE_SET_CAPTURE_KEYS.has(key)) issues.push(`capture: unknown field "${key}" (the manifest schema is strict)`);
    }
    // План 2026-08-06 §W5: поверхность съёмки. `"viewport"` даёт сцену размера вьюпорта со stage
    // host'ом — единственный способ снять host-примитив `Overlay` в компонентной приёмке.
    if (manifest.capture.surface !== undefined && !CASE_SET_SURFACES.includes(manifest.capture.surface)) {
      issues.push(`capture.surface must be one of ${CASE_SET_SURFACES.join(", ")} (omit it for the default hug surface)`);
    }
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

  issues.push(...casePolicyIssues(manifest.policy, limits));

  const cases = manifest.cases;
  if (!Array.isArray(cases) || cases.length === 0) return [...issues, "cases must be a non-empty array"];
  if (cases.length > limits.maxCases) issues.push(`cases: at most ${limits.maxCases} entries (got ${cases.length})`);
  if (cases.length > limits.maxCasesPerRun) {
    issues.push(`cases: ${cases.length} exceeds the per-run ceiling of ${limits.maxCasesPerRun} (422 case_set_too_large)`);
  }
  const byId = new Map();
  // §W3: ссылки overlay-детей копятся по всему дереву случаев — на них замыкается карта.
  const overlayRefs = new Set();
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
    if (item.slotBindings !== undefined) issues.push(...slotBindingIssues(item.slotBindings, `cases[${index}]`, limits, overlayRefs));
    issues.push(...comparisonIssues(item, `cases[${index}]`));
    issues.push(...caseSurfaceIssues(item, `cases[${index}]`));
  }
  // Карта overlay судится после обхода случаев: её отказы (`unused`/`unknown`) — про замыкание
  // графа, а замыкание известно только когда собраны все ссылки детей.
  issues.push(...candidateOverlayIssues(manifest, limits, overlayRefs));
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
async function runCaseSetValidate(args, flags = {}) {
  const [, manifestPath] = args;
  const manifest = withCandidateOverlay(
    await readJsonArgument(manifestPath, "case-set manifest"),
    flags.overlay === undefined ? undefined : await readOverlayArgument(flags.overlay),
  );
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
    ], { command: "case-set validate", checked: "local", caseSetId, componentId, cases: manifest.cases.length, issues: [] },
    { command: "case-set validate", ok: true, warnings: ["the server is unreachable — server-side checks (assets, props schema, coverage) were not run"] });
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
    ], { command: "case-set validate", checked: "local", caseSetId, componentId, cases: manifest.cases.length, issues: [] },
    { command: "case-set validate", ok: true, warnings: ["this server has no dry-run handle (features.caseSetValidate is off); the server-side checks run only on 'case-set put'"] });
    return;
  }

  const result = await requireOk("case-set validate",
    await call("POST", `/components/${encodeURIComponent(componentId)}/case-sets/validate`, { manifest }));
  report([
    `case-set validate ok for ${result.componentId}: ${result.cases?.count ?? manifest.cases.length} cases,`
    // `frames` — сколько случаев РЕАЛЬНО снимается (не-алиасы, план 2026-08-05 §A5). С момента,
    // когда одинаковые props с разными `slotBindings` перестали схлопываться в один кадр, число
    // случаев больше не отвечает на вопрос «сколько кадров будет» — и `--expected-cases`
    // у promote считается именно по кадрам.
    + (result.frames === undefined ? "" : ` ${result.frames.count} frames,`)
    + ` caseSetId ${result.caseSetId}${result.wouldBeCached ? " (already published: a PUT would be an idempotent repeat)" : " (not published yet)"}`,
    ...(result.caseSetId !== caseSetId
      ? [`warning: the server computed a different caseSetId (${result.caseSetId}) than this client (${caseSetId})`]
      : []),
    ...coverageLines(result.coverage ?? {}, { caseSetId: result.caseSetId }),
    ...(result.warnings ?? []).map((warning) => `warning: ${warning}`),
  ], { command: "case-set validate", checked: "server", localCaseSetId: caseSetId, ...result },
  { command: "case-set validate", ok: true, warnings: result.warnings ?? [] });
}

async function runCaseSet(args, flags) {
  const [subcommand] = args;
  // `validate` — единственная подкоманда, которая начинает работу локально: гейт матрицы
  // проверяется внутри неё, после структурного разбора манифеста.
  if (subcommand === "validate") return runCaseSetValidate(args, flags);
  await requireAcceptanceMatrix();
  if (subcommand === "put") {
    const [, componentId, manifestPath] = args;
    const manifest = withCandidateOverlay(
      await readJsonArgument(manifestPath, "case-set manifest"),
      flags.overlay === undefined ? undefined : await readOverlayArgument(flags.overlay),
    );
    // §W3: overlay-манифест обязан отвергаться **до** мутации — round-trip за
    // `candidate_overlay_unused` стоит дороже, чем локальная проверка замыкания графа. Скоуп
    // проверки ровно overlay'ный: полный структурный разбор у `put` и раньше был за сервером
    // (`case-set validate` — отдельная команда), и менять это здесь не за чем.
    if (manifest.candidateOverlay !== undefined) {
      const local = candidateOverlayIssues(manifest, CASE_SET_LIMITS, overlayReferencesOf(manifest));
      if (local.length > 0) {
        throw new CliError([`case-set put refused locally (${local.length} overlay issue(s)); nothing was sent to the server:`,
          ...local.map((issue) => `  ${issue}`)].join("\n"));
      }
    }
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
    ], { command: "case-set put", ...result, ...existenceReport() },
    { command: "case-set put", ok: true, warnings: result.warnings ?? [] });
    return;
  }
  const [, caseSetId] = args;
  const encoded = encodeURIComponent(caseSetId);
  if (subcommand === "coverage") {
    const coverage = await requireOk("case-set coverage", await call("GET", `/case-sets/${encoded}/coverage`));
    report(coverageLines(coverage, coverage), { command: "case-set coverage", ...coverage }, { command: "case-set coverage", ok: true });
    return;
  }
  const result = await requireOk("case-set get", await call("GET", `/case-sets/${encoded}`));
  report([
    `case-set ${result.caseSetId} for ${result.componentId} (${result.designSystem}): ${result.caseCount} cases, created ${result.createdAt}`,
    `source: ${result.source ? `${result.source.fileKey}${result.source.componentSetNodeId ? `#${result.source.componentSetNodeId}` : ""}` : "-"}`,
  ], { command: "case-set get", ...result }, { command: "case-set get", ok: true });
}

async function runAccept(args, flags) {
  const [id] = args;
  const encoded = encodeURIComponent(id);
  const capabilities = await requireAcceptanceMatrix();
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
    ...(flags.recapture ? { recapture: true } : {}),
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
  // Полный ран уже получен опросом — он и уезжает в link/receipt; `--summary` меняет только вывод.
  const summary = flags.summary ? await acceptanceSummary(run, capabilities) : null;
  await reportAcceptance(run, {
    command: "accept", componentId: id, candidateId: candidate.candidateId, flags, summary,
    // Ревизия кандидата известна ровно здесь (ответ `POST /components/:id/candidates`).
    revision: Number.isInteger(candidate.rev) ? candidate.rev : null,
  });
}

/**
 * `accept-resume <runId>` (BR-06, план 2026-08-08 §6) — продолжение остановленного рана.
 *
 * **Это новый ран, а не воскрешение**: терминальный ран неизменяем (на него ссылаются receipts
 * публикаций и promote-инварианты), поэтому сервер ставит свежий ран поверх того же кандидата,
 * набора и профиля, а lineage (`resumedFromRunId`/`attempt`) связывает их. Драйвер печатает эту
 * связь и **прежнюю** причину остановки: без неё «продолжили» неотличимо от «начали заново».
 *
 * Отказы отдаются как продуктовые (exit 2), а не как сбой инструмента: `run_not_resumable` значит
 * «ран дал вердикт — продолжать нечего, пересними `accept --refresh`», `run_already_resumed` —
 * «продолжение уже есть, вот оно».
 */
async function runAcceptResume(args, flags) {
  const [sourceRunId] = args;
  const capabilities = await requireAcceptanceMatrix();
  if (capabilities.features?.acceptanceResumeV1 !== true) {
    throw new CliError("server does not support resumable acceptance (features.acceptanceResumeV1 is off; needs EASYUI_ACCEPTANCE_RESUME_DISABLED unset); re-run the matrix with 'driver.mjs accept <componentId>'");
  }
  const response = await call("POST", `/acceptance-runs/${encodeURIComponent(sourceRunId)}/resume`, {});
  const code = errorCode(response);
  if (response.status === 409 && (code === "run_not_resumable" || code === "run_already_resumed" || code === "acceptance_resume_disabled" || code === "acceptance_run_in_flight")) {
    const other = response.json?.error?.runId;
    throw new CliError(`${code}: ${response.json?.error?.message ?? `run ${sourceRunId} cannot be resumed`}`
      + (other && other !== sourceRunId ? `; see 'driver.mjs accept-status ${other}'` : ""), { exitCode: EXIT.productErrors });
  }
  const queued = await requireOk("acceptance resume", response, [202]);
  const previous = queued.resumedFrom ?? null;
  progress(`resume ${queued.runId} attempt ${queued.attempt} of ${queued.resumedFromRunId ?? sourceRunId} with ${queued.cases} cases`);
  if (previous) {
    progress(`previous stop: ${previous.statusReason ?? previous.status ?? "-"}`
      + `${previous.phase ? ` at phase ${previous.phase}` : ""}`
      + `${previous.lastCompletedPhase ? ` (last completed ${previous.lastCompletedPhase})` : ""}`);
  }
  const run = await pollAcceptanceRun(queued.runId, { deadlineMs: (flags.timeoutSec ?? ACCEPT_DEFAULT_TIMEOUT_SEC) * 1000 });
  const summary = flags.summary ? await acceptanceSummary(run, capabilities) : null;
  await reportAcceptance(run, { command: "accept-resume", componentId: run.componentId, flags, summary });
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
  report(impactLines(impact, id), { command: "impact", componentId: id, ...impact }, {
    command: "impact", ok: true, items: impact.affectedCases ?? [],
    nextActions: [`driver.mjs accept ${id} --baseline-run ${impact.baselineRunId}`],
  });
}

/**
 * Drill-down одного случая (`accept-status <runId> --case <caseId>`, §W8): полные гейты, причины,
 * квитанция reuse и артефакты ровно одного случая. Ничего не пишет в кэш-навигацию: это чтение
 * поверх уже записанного раном, а не отдельная приёмка.
 */
async function reportAcceptanceCase(runId, caseId) {
  const path = `/acceptance-runs/${encodeURIComponent(runId)}/cases?case=${encodeURIComponent(caseId)}`;
  const response = await call("GET", path);
  if (response.status === 404) {
    throw new CliError(`acceptance run ${runId} has no case ${caseId}; list them with 'driver.mjs accept-status ${runId}'`, { exitCode: EXIT.productErrors });
  }
  const body = await requireOk(`acceptance case ${caseId}`, response);
  // Старый сервер фильтра не знает и отдаёт все случаи — сужаем сами, чтобы вывод не врал.
  const item = (body.cases ?? []).find((row) => row.caseId === caseId);
  if (!item) throw new CliError(`acceptance run ${runId} has no case ${caseId}`, { exitCode: EXIT.productErrors });
  const receipt = item.reuseReceipt ?? null;
  const lines = [
    `case ${item.caseId} of run ${runId}: ${item.verdict ?? item.status}${item.aliasOfCaseId ? ` (alias of ${item.aliasOfCaseId})` : ""}`,
    `gates: ${(item.gates ?? []).map((gate) => `${gate.gate}=${gate.status}`).join(" ") || "-"}`,
    ...(item.gates ?? []).filter((gate) => gate.detail).map((gate) => `  ${gate.gate}: ${gate.detail}`),
    ...(item.causes ?? []).map((cause) => `  cause ${cause.code} (${cause.confidence}): ${cause.detail}`),
    `reuse: ${receipt ? Object.entries(receipt.reuse ?? {}).map(([level, value]) => `${level}=${value ? "hit" : "miss"}`).join(" ") : `reason ${item.reuseReason ?? "-"}`}`,
    `artifacts: ${(item.artifacts ?? []).map((artifact) => artifact.name).join(", ") || "-"}`,
  ];
  const exitCode = item.verdict === "fail" || item.verdict === "indeterminate" || item.status === "error"
    ? EXIT.productErrors
    : EXIT.ok;
  report(lines, { command: "accept-status --case", runId, exitCode, ...item }, {
    command: "accept-status", ok: exitCode === EXIT.ok, items: item.gates ?? [],
    artifacts: (item.artifacts ?? []).map((artifact) => artifact.name),
    warnings: (item.causes ?? []).map((cause) => `${cause.code} (${cause.confidence}): ${cause.detail}`),
    // W6b: drill-down — тот же набор ключей контракта плюс `caseId`. Счётчики рана здесь
    // недоступны по построению (ручка отдаёт один случай), и вместо выдуманных единиц стоит
    // честный `null`: `casesFailed` — про этот случай, `casesTotal` — про ран, которого не читали.
    summary: {
      runId, caseId, verdict: item.verdict ?? item.status ?? null,
      casesTotal: null, casesFailed: exitCode === EXIT.ok ? 0 : 1, casesReused: null,
      topCauses: (item.causes ?? [])
        .filter((cause) => typeof cause?.code === "string")
        .slice(0, 5)
        .map((cause) => ({ code: cause.code, cases: 1 })),
      revision: null,
    },
  });
  if (exitCode !== EXIT.ok) throw new CliError(`case ${caseId} of run ${runId} is ${item.verdict ?? item.status}`, { exitCode });
}

/**
 * Родословная и точка остановки рана (BR-06). Печатается **до** отчёта: «этот ран — вторая
 * попытка» и «предыдущая встала на allocate-renderer» меняют чтение всего остального, поэтому
 * не могут быть строчкой в конце. Поля опциональны — сервер доволновой сборки их не шлёт, и
 * тогда вывод остаётся прежним байт-в-байт.
 */
export function lineageLines(run) {
  const lines = [];
  const attempt = Number.isInteger(run?.attempt) ? run.attempt : 1;
  if (run?.resumedFromRunId || attempt > 1) {
    lines.push(`lineage: attempt ${attempt}${run.resumedFromRunId ? ` resumed from ${run.resumedFromRunId}` : ""}`);
  }
  const resume = run?.resume ?? null;
  if (resume && typeof resume === "object") {
    const previous = resume.resumedFrom ?? null;
    if (previous) {
      lines.push(`previous stop: ${previous.statusReason ?? previous.status ?? "-"}`
        + `${previous.phase ? ` at phase ${previous.phase}` : ""}`
        + `${previous.lastCompletedPhase ? ` (last completed ${previous.lastCompletedPhase})` : ""}`);
    }
    if (resume.phase || resume.lastCompletedPhase) {
      lines.push(`stopped at phase ${resume.phase ?? "-"} (last completed ${resume.lastCompletedPhase ?? "-"})`
        + `${resume.resumable === true ? `; resume with 'driver.mjs accept-resume ${run.runId}'` : ""}`);
    }
  }
  return lines;
}

async function runAcceptStatus(args, flags) {
  const [runId] = args;
  const capabilities = await requireAcceptanceMatrix();
  if (flags.case !== undefined) {
    await reportAcceptanceCase(runId, flags.case);
    return;
  }
  // Полный ран берётся всегда: он — источник link/receipt и терминальной проверки. `--summary`
  // добавляет к нему компактный отчёт, а не заменяет источник (D-E).
  const run = await requireOk("acceptance run", await call("GET", `/acceptance-runs/${encodeURIComponent(runId)}`));
  for (const line of lineageLines(run)) out(line);
  const summary = flags.summary ? await acceptanceSummary(run, capabilities) : null;
  if (!ACCEPT_TERMINAL.has(run.status)) {
    report(
      summary === null
        ? [`acceptance run ${run.runId} is ${run.status} ${run.progress?.completed ?? 0}/${run.progress?.total ?? 0} reused=${run.progress?.reused ?? 0}`]
        : summaryLines(summary, { componentId: run.componentId, evidencePath: null }),
      { command: "accept-status", exitCode: EXIT.ok, ...(summary ?? run) },
      // W6b: у бегущего рана та же форма квитанции — `verdict` называет нетерминальный статус
      // (`queued`/`running`), а не притворяется вердиктом.
      { command: "accept-status", ok: true, summary: acceptanceSummaryFields(run) },
    );
    return;
  }
  await reportAcceptance(run, { command: "accept-status", flags, summary });
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
  ], { command: "reject", ...rejected }, { command: "reject", ok: true });
}

// --- migration-commit: poller серверной саги миграционного коммита (§W4/§W6b) ---

/**
 * Позитивный список **активных** фаз саги — зеркало `MIGRATION_COMMIT_PHASES` сервера
 * (`server/migration/commit.ts`). Драйвер поллит ровно по нему: всё, что не активная фаза, —
 * это `complete`, `cancelled` или `needs-<фаза>`, то есть состояние, в котором ждать нечего.
 */
export const MIGRATION_COMMIT_PHASES = Object.freeze([
  "preflight", "promote", "gallery-save", "verify", "impacted-regression", "audit",
]);
const MIGRATION_COMMIT_POLL_INTERVAL_MS = 5_000;
export const MIGRATION_COMMIT_DEFAULT_TIMEOUT_SEC = 1800;

const migrationCommitActive = (phase) => MIGRATION_COMMIT_PHASES.includes(phase);
export const migrationCommitNeeds = (phase) => typeof phase === "string" && phase.startsWith("needs-");

/**
 * Exit-код саги. `complete` — ноль; `needs-*` и `cancelled` — **продуктовый** отказ (2): работа
 * встала на конкретной фазе, и это состояние предметной области, а не сбой транспорта. Активная
 * фаза после исчерпания клиентского таймаута — тоже 2: сага на сервере продолжает идти, её
 * добирают `--status`.
 */
export const migrationCommitExitCode = (phase) => (phase === "complete" ? EXIT.ok : EXIT.productErrors);

/** Человекочитаемая квитанция саги: где стоит, что уже сделано и чем это доказано. */
export function migrationCommitLines(receipt) {
  const lines = [
    `migration-commit ${receipt.commitId} ${receipt.componentId} phase=${receipt.phase} regression=${receipt.regressionMode}`
      + (receipt.idempotentReplay ? " (idempotent replay: nothing was mutated)" : ""),
    `phases done: ${receipt.phasesDone?.length ? receipt.phasesDone.join(", ") : "-"}`,
  ];
  for (const entry of receipt.phases ?? []) {
    lines.push(`  ${entry.phase}: ${entry.status}${entry.idempotentReplay ? " (replay)" : ""}`
      + (entry.error ? ` — ${entry.error.code}: ${entry.error.message}` : ""));
  }
  const result = receipt.result ?? {};
  if (result.promote) {
    lines.push(`promote: version ${result.promote.version} (rev ${result.promote.rev}) catalogRevision=${result.promote.catalogRevision}`
      + (result.promote.superseded?.length ? ` superseded=${result.promote.superseded.map((version) => `v${version}`).join(",")}` : ""));
  }
  if (result.gallery) {
    lines.push(`gallery: ${result.gallery.prototypeId} rev ${result.gallery.beforeRev} → ${result.gallery.afterRev}${result.gallery.changed ? "" : " (unchanged)"}`);
  }
  if (result.verify) {
    const screens = result.verify.screens ?? [];
    lines.push(`verify: ${screens.filter((screen) => screen.renderable).length}/${screens.length} screens renderable, readiness publishable=${result.verify.readiness?.publishable}`
      + (result.verify.readiness?.blocking?.length ? ` blocking=${result.verify.readiness.blocking.join(",")}` : ""));
  }
  if (result.regression) {
    const plan = result.regression.plan;
    lines.push(`regression: mode ${result.regression.mode}`
      + (plan ? ` — ${plan.summary.capture} capture, ${plan.summary.reuse} reuse of ${plan.summary.total}` : " — no plan (capture every screen)"));
  }
  if (result.audit) lines.push(`audit: ${result.audit.designSystem} artifacts=${result.audit.artifacts} duplicateGroups=${result.audit.duplicateGroups}`);
  if (receipt.error) lines.push(`error: ${receipt.error.code}: ${receipt.error.message}`);
  if (migrationCommitNeeds(receipt.phase)) {
    lines.push(`stopped at ${receipt.phase}: fix the cause, then 'driver.mjs migration-commit --advance ${receipt.commitId}' (or --cancel ${receipt.commitId})`);
  }
  return lines;
}

/** Строки dry-run: список фаз и **список мутаций**, которые сага бы сделала. Это предмет ревью. */
function migrationCommitPlanLines(plan) {
  const lines = [
    `migration-commit dry-run ${plan.componentId} (${plan.designSystem}) regression=${plan.regressionMode} gallery=${plan.galleryPrototypeId ?? "-"}`,
    `phases: ${plan.phases.join(" → ")}`,
    `preflight: ${plan.preflight.ok ? "ok" : `FAILED ${plan.preflight.error?.code}: ${plan.preflight.error?.message}`}`,
  ];
  for (const mutation of plan.mutations ?? []) lines.push(`  would ${mutation.kind} ${mutation.target}: ${mutation.description}`);
  const preview = plan.regressionPreview;
  lines.push(preview
    ? `regression preview: rev ${preview.rev} — ${preview.summary.capture} capture, ${preview.summary.reuse} reuse of ${preview.summary.total}`
    : "regression preview: none (no gallery, impacted snap disabled, or preflight failed)");
  return lines;
}

const migrationCommitPath = (id, tail = "") => `/migration-commits/${encodeURIComponent(id)}${tail}`;

/**
 * Poll до состояния, в котором ждать больше нечего. Сервер доводит сагу сам (POST/advance
 * возвращают уже терминальное состояние), но фаза может остаться активной — её двигает другой
 * процесс, — и тогда poller обязан дождаться, а не отчитаться об «идущей» саге как о результате.
 */
async function pollMigrationCommit(receipt, { deadlineMs }) {
  const deadline = Date.now() + deadlineMs;
  let current = receipt;
  let last = null;
  while (migrationCommitActive(current.phase)) {
    const line = `commit ${current.commitId} ${current.phase}`;
    if (line !== last) { progress(line); last = line; }
    if (Date.now() >= deadline) {
      progress(`commit ${current.commitId} is still in phase ${current.phase} after the client timeout; the saga keeps running on the server — poll it with 'driver.mjs migration-commit --status ${current.commitId}'`);
      return current;
    }
    await delay(Math.min(MIGRATION_COMMIT_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    current = await requireOk("migration commit", await call("GET", migrationCommitPath(current.commitId)));
  }
  return current;
}

/** Отчёт по квитанции саги: одна форма на `start`/`--status`/`--advance`/`--cancel`. */
async function reportMigrationCommit(receipt, flags, command) {
  const exitCode = migrationCommitExitCode(receipt.phase);
  const lines = migrationCommitLines(receipt);
  const artifacts = [];
  if (flags.receipt !== undefined) {
    // «1 агентская запись» KPI §1.3: единственный файл, который харнес пишет сам. Формат — из
    // расширения (W6b): `.json` — квитанция сервера как есть, `.txt` — те же строки, что видит
    // человек.
    if (receiptFileFormat(flags.receipt) === "json") {
      await writeReceiptFile(flags.receipt, { command: "migration-commit", exitCode, receipt });
    } else await writeTextReceiptFile(flags.receipt, lines);
    artifacts.push(flags.receipt);
    lines.push(flags.receipt);
  }
  report(lines, { command: "migration-commit", exitCode, ...receipt }, {
    command: "migration-commit", ok: exitCode === EXIT.ok, items: receipt.phases ?? [], artifacts,
    warnings: receipt.error ? [`${receipt.error.code}: ${receipt.error.message}`] : [],
    nextActions: migrationCommitNeeds(receipt.phase)
      ? [`driver.mjs migration-commit --advance ${receipt.commitId}`, `driver.mjs migration-commit --cancel ${receipt.commitId} --reason <text>`]
      : [],
    // W6b, контракт §1.4.
    summary: {
      commitId: receipt.commitId,
      phase: receipt.phase,
      phasesDone: receipt.phasesDone ?? [],
      regressionMode: receipt.regressionMode ?? null,
    },
  });
  if (exitCode !== EXIT.ok) {
    throw new CliError(`migration commit ${receipt.commitId} is ${receipt.phase}${receipt.error ? `: ${receipt.error.code}` : ""} (${command})`, { exitCode });
  }
}

/**
 * `migration-commit` (план 2026-08-07 §W4/§W6b) — poller серверной саги: `start` создаёт её
 * идемпотентно и доводит до `complete` или до первого `needs-*`, `--status`/`--advance`/`--cancel`
 * читают и двигают существующую. Состоянием владеет сервер: драйвер ничего не компенсирует и
 * ничего не переигрывает сам.
 */
async function runMigrationCommit(args, flags) {
  const capabilities = await requireOk("capabilities", await call("GET", "/capabilities"));
  if (capabilities.features?.migrationCommit !== true) {
    throw new CliError("server does not support the migration commit saga (features.migrationCommit is off; needs EASYUI_ACCEPTANCE_MATRIX=1 and no EASYUI_MIGRATION_COMMIT_DISABLED); drive promote/prototype/snap/audit by hand instead");
  }
  const deadlineMs = (flags.timeoutSec ?? MIGRATION_COMMIT_DEFAULT_TIMEOUT_SEC) * 1000;
  if (flags.status !== undefined) {
    const receipt = await requireOk("migration commit", await call("GET", migrationCommitPath(flags.status)));
    await reportMigrationCommit(receipt, flags, "status");
    return;
  }
  if (flags.cancel !== undefined) {
    const cancelled = await requireOk("migration commit cancel", await call("POST", migrationCommitPath(flags.cancel, "/cancel"), {
      ...(flags.reason === undefined ? {} : { reason: flags.reason }),
    }));
    await reportMigrationCommit(cancelled, flags, "cancel");
    return;
  }
  if (flags.advance !== undefined) {
    const advanced = await requireOk("migration commit advance", await call("POST", migrationCommitPath(flags.advance, "/advance"), {}));
    await reportMigrationCommit(await pollMigrationCommit(advanced, { deadlineMs }), flags, "advance");
    return;
  }

  const id = args[1];
  const encoded = encodeURIComponent(id);
  const meta = await getMeta("components", id, { mutating: true });
  if (!meta) throw new CliError(`components/${id} not found; hint: run 'driver.mjs get components'`);
  // `sourceHash` головы — из того же validate-префлайта, что у promote: сага сверяет им, что
  // публикует ровно ту сборку, которую видел агент.
  const validated = await requireOk("validate", await call("POST", `/components/${encoded}/validate`));
  for (const warning of validated.warnings ?? []) out(`warning: ${warning}`);
  // Ключ идемпотентности **детерминирован** по (компонент, ревизия, исходник): повтор той же
  // команды после обрыва обязан вернуть ту же сагу, а не начать вторую. Явный ключ — для
  // координатора, который ведёт собственную нумерацию.
  const idempotencyKey = flags.idempotencyKey ?? `driver-${id}-r${meta.headRev}-${validated.sourceHash.slice(0, 12)}`;
  const gallery = flags.gallery === undefined ? undefined : {
    prototypeId: flags.gallery,
    ...(flags.screen === undefined ? {} : { screenFragment: JSON.parse(await readFile(flags.screen, "utf8")) }),
    ...(flags.message === undefined ? {} : { message: flags.message }),
    ...(flags.viewport === undefined ? {} : { viewport: flags.viewport }),
    ...(flags.dsf === undefined ? {} : { deviceScaleFactor: flags.dsf }),
    ...(flags.theme === undefined ? {} : { theme: flags.theme }),
    // Тот же opt-in барьера, что у `snap`: план регрессии обязан считаться по той поверхности,
    // которой галерею потом снимут.
    ...(flags.noBarrier ? {} : { readiness: SNAP_READINESS }),
  };
  const body = {
    idempotencyKey, componentId: id, baseRev: meta.headRev, sourceHash: validated.sourceHash,
    ...(flags.candidate === undefined ? {} : { candidateId: flags.candidate }),
    ...(flags.acceptanceRun === undefined ? {} : { acceptanceRunIds: flags.acceptanceRun }),
    ...(flags.expectedCases === undefined ? {} : { expectedCases: flags.expectedCases }),
    ...(flags.supersede === undefined ? {} : { supersede: flags.supersede }),
    ...(flags.message === undefined ? {} : { message: flags.message }),
    ...(gallery === undefined ? {} : { gallery }),
    ...(flags.auditDesignSystem === undefined ? {} : { auditDesignSystem: flags.auditDesignSystem }),
    ...(flags.dryRun ? { dryRun: true } : {}),
  };
  const response = await call("POST", "/migration-commits", body);
  if (response.status === 409 && errorCode(response) === "migration_commit_in_flight") {
    const commitId = response.json?.error?.commitId;
    throw new CliError(`component ${id} already has a migration commit in an active phase${commitId ? ` (${commitId}); poll it with 'driver.mjs migration-commit --status ${commitId}'` : ""}`, { exitCode: EXIT.productErrors });
  }
  const created = await requireOk("migration commit", response, [200, 201]);
  if (flags.dryRun) {
    // Dry-run — план, а не квитанция: у него нет ни `commitId`, ни фаз в журнале. Единственное
    // поле контракта, которое у плана есть по-настоящему, — `regressionMode`.
    report(migrationCommitPlanLines(created), { command: "migration-commit", dryRun: true, ...created }, {
      command: "migration-commit", ok: created.preflight?.ok === true, items: created.mutations ?? [],
      warnings: created.preflight?.ok === true ? [] : [`preflight ${created.preflight?.error?.code}: ${created.preflight?.error?.message}`],
      summary: {
        commitId: null, phase: "dry-run", phasesDone: [], regressionMode: created.regressionMode ?? null,
      },
    });
    if (created.preflight?.ok !== true) throw new CliError(`migration commit dry-run refused at preflight: ${created.preflight?.error?.message}`, { exitCode: EXIT.productErrors });
    return;
  }
  await reportMigrationCommit(await pollMigrationCommit(created, { deadlineMs }), flags, "start");
}

// ───────────────────── Figma Source Package (§W8) ─────────────────────

/**
 * Потолки манифеста пакета — те же числа, что публикует сервер (`server/figma/sourcePackage.ts`).
 * Локальные значения нужны, чтобы отказ формы случился **до** сети даже там, где capabilities
 * прочитать не удалось: пакет на 300 экспортов — это мегабайты, отправленные ради 422.
 */
export const SOURCE_PACKAGE_LIMITS = Object.freeze({ maxExports: 256, maxNodes: 1024, maxRefs: 1024, maxNotes: 256 });

/** Потолки этого сервера: сборка могла поднять `limits.sourcePackageMaxExports` (или опустить). */
export function sourcePackageLimits(capabilities) {
  const limits = capabilities?.limits ?? {};
  const number = (value, fallback) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
  return { ...SOURCE_PACKAGE_LIMITS, maxExports: number(limits.sourcePackageMaxExports, SOURCE_PACKAGE_LIMITS.maxExports) };
}

const SOURCE_PACKAGE_MISSING_ROLES = Object.freeze([
  "exact-reference", "instance-override", "runtime-leaf", "raw-reference", "text-run", "other",
]);
const SOURCE_PACKAGE_NODE_KINDS = Object.freeze(["component", "componentSet", "instance", "frame", "text", "vector", "other"]);
export const SOURCE_PACKAGE_ID_PATTERN = /^fsp_[0-9a-f]{64}$/;

/**
 * Структурная проверка манифеста пакета **до** сети — зеркало `sourcePackageManifestSchema` +
 * `validateSourcePackage` в той их части, которую клиент может проверить сам (форма, потолки,
 * замкнутость ссылок на `nodes[]`). Байтовые инварианты (SHA/dims против реестра ассетов,
 * существование `assetId`, владение дизайн-системой) остаются за сервером: их клиенту не из чего
 * вывести, и притворяться, что он их проверил, было бы враньём.
 *
 * Возвращает список строк-претензий; пустой список не обещает 201, он обещает лишь, что запрос
 * стоит отправлять.
 */
export function sourcePackageManifestIssues(manifest, limits = SOURCE_PACKAGE_LIMITS) {
  const issues = [];
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["manifest must be a JSON object"];
  }
  const known = new Set(["designSystem", "fileKey", "sourceRevision", "nodes", "exports",
    "instanceProperties", "textRuns", "effects", "usageContexts", "missing", "anomalies"]);
  for (const key of Object.keys(manifest)) if (!known.has(key)) issues.push(`unknown field: ${key}`);
  const text = (value, field, max) => {
    if (typeof value !== "string" || value.length === 0) { issues.push(`${field} is required (non-empty string)`); return false; }
    if (value.length > max) { issues.push(`${field} is longer than ${max} characters`); return false; }
    return true;
  };
  text(manifest.designSystem, "designSystem", 64);
  if (text(manifest.fileKey, "fileKey", 128) && !/^[A-Za-z0-9_-]+$/.test(manifest.fileKey)) {
    issues.push("fileKey must be url-safe ([A-Za-z0-9_-])");
  }
  text(manifest.sourceRevision, "sourceRevision", 128);

  const nodes = manifest.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    issues.push("nodes[] is required and must list at least one node");
    return issues;
  }
  if (nodes.length > limits.maxNodes) issues.push(`nodes[] has ${nodes.length} entries; this server allows ${limits.maxNodes}`);
  const declared = new Set();
  const componentKeys = new Set();
  const isNodeId = (value) => typeof value === "string" && value.length > 0 && value.length <= 64 && /^[A-Za-z0-9:._-]+$/.test(value);
  nodes.forEach((node, index) => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) { issues.push(`nodes[${index}] must be an object`); return; }
    if (!isNodeId(node.nodeId)) { issues.push(`nodes[${index}].nodeId must be a safe id ([A-Za-z0-9:._-], 1..64)`); return; }
    if (declared.has(node.nodeId)) issues.push(`nodes[${index}].nodeId is declared twice: ${node.nodeId}`);
    declared.add(node.nodeId);
    if (node.componentKey !== undefined) {
      if (typeof node.componentKey !== "string" || !/^[A-Za-z0-9:._-]{1,128}$/.test(node.componentKey)) {
        issues.push(`nodes[${index}].componentKey must be a safe key ([A-Za-z0-9:._-], 1..128)`);
      } else if (componentKeys.has(node.componentKey)) {
        issues.push(`nodes[${index}].componentKey is declared twice: ${node.componentKey}`);
      } else componentKeys.add(node.componentKey);
    }
    if (node.role !== undefined && (typeof node.role !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(node.role))) {
      issues.push(`nodes[${index}].role must be a slug ([a-z0-9][a-z0-9._-]*, 1..64)`);
    }
    if (node.kind !== undefined && !SOURCE_PACKAGE_NODE_KINDS.includes(node.kind)) {
      issues.push(`nodes[${index}].kind must be one of: ${SOURCE_PACKAGE_NODE_KINDS.join(", ")}`);
    }
  });

  const exports = manifest.exports ?? [];
  if (!Array.isArray(exports)) issues.push("exports must be an array");
  else {
    if (exports.length > limits.maxExports) {
      issues.push(`exports[] has ${exports.length} entries; this server allows ${limits.maxExports} (limits.sourcePackageMaxExports)`);
    }
    const exported = new Set();
    exports.forEach((entry, index) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) { issues.push(`exports[${index}] must be an object`); return; }
      if (!isNodeId(entry.nodeId)) issues.push(`exports[${index}].nodeId must be a safe id`);
      else if (!declared.has(entry.nodeId)) issues.push(`exports[${index}].nodeId is not declared in nodes[]: ${entry.nodeId}`);
      else if (exported.has(entry.nodeId)) issues.push(`exports[${index}].nodeId is exported twice: ${entry.nodeId}`);
      else exported.add(entry.nodeId);
      if (typeof entry.assetId !== "string" || !/^asset_[0-9a-f]{64}$/.test(entry.assetId)) {
        issues.push(`exports[${index}].assetId must be an asset id (asset_<64 hex>); upload the PNG with POST /api/assets first`);
      }
      if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) issues.push(`exports[${index}].sha256 must be a sha256 hex digest`);
      for (const side of ["width", "height"]) {
        const value = entry[side];
        if (!Number.isInteger(value) || value < 1 || value > 16384) issues.push(`exports[${index}].${side} must be an integer from 1 to 16384`);
      }
      if (entry.scale !== undefined && ![1, 2, 3].includes(entry.scale)) issues.push(`exports[${index}].scale must be 1, 2 or 3`);
    });
  }

  // Ссылочные секции: любой упомянутый узел обязан быть объявлен — тот же инвариант, что сервер
  // проверяет в `validateSourcePackage`, и ровно тот, из-за которого пакет вообще имеет смысл.
  for (const field of ["instanceProperties", "textRuns", "effects", "usageContexts"]) {
    const rows = manifest[field];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) { issues.push(`${field} must be an array`); continue; }
    if (rows.length > limits.maxRefs) issues.push(`${field}[] has ${rows.length} entries; the server allows ${limits.maxRefs}`);
    rows.forEach((entry, index) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) { issues.push(`${field}[${index}] must be an object`); return; }
      if (!isNodeId(entry.nodeId)) issues.push(`${field}[${index}].nodeId must be a safe id`);
      else if (!declared.has(entry.nodeId)) issues.push(`${field}[${index}].nodeId is not declared in nodes[]: ${entry.nodeId}`);
    });
  }
  for (const field of ["missing", "anomalies"]) {
    const rows = manifest[field];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) { issues.push(`${field} must be an array`); continue; }
    if (rows.length > limits.maxNotes) issues.push(`${field}[] has ${rows.length} entries; the server allows ${limits.maxNotes}`);
    rows.forEach((entry, index) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) { issues.push(`${field}[${index}] must be an object`); return; }
      if (entry.nodeId !== undefined) {
        if (!isNodeId(entry.nodeId)) issues.push(`${field}[${index}].nodeId must be a safe id`);
        else if (!declared.has(entry.nodeId)) issues.push(`${field}[${index}].nodeId is not declared in nodes[]: ${entry.nodeId}`);
      }
      if (field === "missing") {
        if (!SOURCE_PACKAGE_MISSING_ROLES.includes(entry.role)) issues.push(`missing[${index}].role must be one of: ${SOURCE_PACKAGE_MISSING_ROLES.join(", ")}`);
        if (entry.componentKey !== undefined && !componentKeys.has(entry.componentKey)) {
          issues.push(`missing[${index}].componentKey is not declared in nodes[]: ${entry.componentKey}`);
        }
      } else if (typeof entry.code !== "string" || entry.code.length === 0) issues.push(`anomalies[${index}].code is required`);
    });
  }
  return issues;
}

/**
 * Совместимость со старым сервером: набор `/api/figma-source-packages` появился волной W8, и на
 * образе до неё (или с `EASYUI_SOURCE_PACKAGE_DISABLED=1`) диспетчер отвечает общим `404 not_found`
 * — без предметного кода. Это не «пакет не найден», и печатать так было бы враньём: отказ обязан
 * называть причину и действие. Предметные 404 (`source_package_not_found`) уходят наверх как есть.
 */
function sourcePackageRouteMissing(response) {
  return response.status === 404 && (errorCode(response) === undefined || errorCode(response) === "not_found");
}

const sourcePackageAbsent = (step) => new CliError(
  `${step}: server has no figma-source-packages (deploy newer server); this build predates plan 2026-08-07 §W8 or runs with EASYUI_SOURCE_PACKAGE_DISABLED=1`,
);

/** Общий вход всех подкоманд: 404 набора переводится в объяснимый отказ, остальное — как обычно. */
async function sourcePackageCall(step, method, path, body) {
  const response = await call(method, path, body);
  if (sourcePackageRouteMissing(response)) throw sourcePackageAbsent(step);
  return requireOk(step, response, method === "POST" && path === "/figma-source-packages" ? [200, 201] : [200]);
}

async function runSourcePackageUpload(args, flags) {
  const [, manifestPath] = args;
  const manifest = await readJsonArgument(manifestPath, "source package manifest");
  // `--design-system` **дополняет** манифест, но не переписывает его: пакет, у которого поле уже
  // стоит, и флаг, называющий другую систему, — это два разных намерения, и молчаливый выбор
  // одного из них стоил бы пакета, приписанного чужому каталогу.
  if (flags.designSystem !== undefined && manifest !== null && typeof manifest === "object" && !Array.isArray(manifest)) {
    if (manifest.designSystem === undefined) manifest.designSystem = flags.designSystem;
    else if (manifest.designSystem !== flags.designSystem) {
      throw new CliError(`--design-system ${flags.designSystem} contradicts the manifest (designSystem: ${JSON.stringify(manifest.designSystem)}); drop the flag or fix the file`);
    }
  }
  // Порядок как у `case-set validate`: сначала структура по локальным потолкам — при битой форме
  // сети не касаемся вовсе, — и только потом уточнение потолков у сервера (сборка могла поднять
  // `limits.sourcePackageMaxExports` или опустить). Недоступность capabilities не отменяет отказ:
  // локальные дефолты — тот же контракт, просто без уточнения этой сборки.
  const refuse = (issues) => {
    if (issues.length === 0) return;
    throw new CliError([`source-package upload refused locally (${issues.length} issue(s)); the manifest was not sent to the server:`,
      ...issues.map((issue) => `  ${issue}`)].join("\n"));
  };
  refuse(sourcePackageManifestIssues(manifest, SOURCE_PACKAGE_LIMITS));
  let capabilities = null;
  try {
    const response = await call("GET", "/capabilities");
    if (response.status === 200) capabilities = response.json;
  } catch { capabilities = null; }
  refuse(sourcePackageManifestIssues(manifest, sourcePackageLimits(capabilities)));
  const result = await sourcePackageCall("source-package upload", "POST", "/figma-source-packages", { manifest });
  const deduplicated = result.deduplicated === true;
  const missing = (manifest.missing ?? []).length;
  await cache.receipt("source-package", result.packageId, {
    packageId: result.packageId, designSystem: result.designSystem, fileKey: result.fileKey,
    sourceRevision: result.sourceRevision, exportCount: result.exportCount, deduplicated,
  });
  report([
    `source package ${result.packageId} for ${result.designSystem} (${result.fileKey} @ ${result.sourceRevision}):`
    + ` ${result.exportCount} exports, ${manifest.nodes.length} nodes${deduplicated ? " (deduplicated: an identical manifest was already uploaded)" : ""}`,
    ...(missing === 0 ? [] : [`missing: ${missing} declared gap(s) in the source — acceptance of those nodes compares against an approximate reference`]),
  ], { command: "source-package upload", deduplicated, ...result }, {
    command: "source-package upload", ok: true,
    items: manifest.exports ?? [],
    warnings: (manifest.missing ?? []).map((entry) => `missing ${entry.role}: ${entry.nodeId ?? entry.componentKey ?? "?"}${entry.note ? ` (${entry.note})` : ""}`),
    nextActions: [`driver.mjs source-package skeleton ${result.packageId} --component <componentId>`],
    summary: { packageId: result.packageId, deduplicated, exports: result.exportCount, missing },
  });
}

async function runSourcePackageList(flags) {
  const query = new URLSearchParams({ designSystem: flags.designSystem });
  if (flags.fileKey !== undefined) query.set("fileKey", flags.fileKey);
  if (flags.limit !== undefined) query.set("limit", String(flags.limit));
  const result = await sourcePackageCall("source-package list", "GET", `/figma-source-packages?${query.toString()}`);
  const packages = result.packages ?? [];
  report([
    `source packages in ${result.designSystem}: ${packages.length}`,
    ...packages.map((row) => `  ${row.packageId} ${row.fileKey} @ ${row.sourceRevision}: ${row.exportCount} exports, by ${row.createdBy} on ${row.createdAt}`),
  ], { command: "source-package list", ...result }, {
    command: "source-package list", ok: true, items: packages,
    // Список не тащит манифесты (сервер их снимает), поэтому `exports`/`missing` этого документа
    // не знает: честный `null` вместо суммы, которую пришлось бы выдумать из `exportCount`.
    summary: { packageId: null, deduplicated: null, exports: null, missing: null, packages: packages.length },
  });
}

async function runSourcePackageShow(args) {
  const [, packageId] = args;
  const result = await sourcePackageCall("source-package show", "GET", `/figma-source-packages/${encodeURIComponent(packageId)}`);
  const manifest = result.manifest ?? {};
  const missing = (manifest.missing ?? []).length;
  report([
    `source package ${result.packageId} for ${result.designSystem} (${result.fileKey} @ ${result.sourceRevision}):`
    + ` ${result.exportCount} exports, ${(manifest.nodes ?? []).length} nodes, by ${result.createdBy} on ${result.createdAt}`,
    ...(manifest.missing ?? []).map((entry) => `  missing ${entry.role}: ${entry.nodeId ?? entry.componentKey ?? "?"}${entry.note ? ` (${entry.note})` : ""}`),
  ], { command: "source-package show", ...result }, {
    command: "source-package show", ok: true, items: manifest.exports ?? [],
    // `deduplicated` — свойство загрузки, а не пакета: у чтения его нет по построению.
    summary: { packageId: result.packageId, deduplicated: null, exports: result.exportCount, missing },
  });
}

async function runSourcePackageSkeleton(args, flags) {
  const [, packageId] = args;
  const result = await sourcePackageCall("source-package skeleton", "POST",
    `/figma-source-packages/${encodeURIComponent(packageId)}/case-set-skeleton`, {
      componentId: flags.component,
      ...(flags.nodes === undefined ? {} : { nodeIds: flags.nodes }),
    });
  const manifest = result.manifest ?? {};
  const cases = (manifest.cases ?? []).length;
  if (flags.out !== undefined) {
    await mkdir(dirname(flags.out), { recursive: true });
    await writeFile(flags.out, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  report([
    `case-set skeleton for ${result.componentId} from ${result.packageId}: ${cases} case(s), saved: ${result.saved === true}`,
    `capture: ${manifest.capture?.viewport?.width ?? "?"}x${manifest.capture?.viewport?.height ?? "?"}`,
    ...(manifest.cases ?? []).map((entry) => `  ${entry.id}: reference ${entry.referenceAssetId} ${entry.expectedSurfaces?.referenceExport?.width ?? "?"}x${entry.expectedSurfaces?.referenceExport?.height ?? "?"} css px`),
    ...(flags.out === undefined
      ? ["draft only: props are empty and expectedGeometry is not invented — fill them in before 'case-set put'"]
      : [`wrote ${flags.out}`]),
  ], { command: "source-package skeleton", path: flags.out ?? null, ...result }, {
    command: "source-package skeleton", ok: true, items: manifest.cases ?? [],
    artifacts: flags.out === undefined ? [] : [flags.out],
    nextActions: [`driver.mjs case-set put ${result.componentId} ${flags.out ?? "<manifest.json>"}`],
    // Скелет ничего не загружает и о дырах источника не отчитывается: `missing` принадлежит
    // пакету, и его печатает `show`.
    summary: { packageId: result.packageId, deduplicated: null, exports: cases, missing: null, componentId: result.componentId },
  });
}

/**
 * `source-package` (§W8) — пакет исходников Figma как единица переноса. Подкоманда в первом
 * позиционале (канон `catalog list|search|get`, `case-set put|get`).
 */
async function runSourcePackage(args, flags) {
  const [subcommand] = args;
  if (subcommand === "upload") return runSourcePackageUpload(args, flags);
  if (subcommand === "list") return runSourcePackageList(flags);
  if (subcommand === "show") return runSourcePackageShow(args);
  return runSourcePackageSkeleton(args, flags);
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
  report(versionAuditLines(scope, rows, findings), { command: "audit versions", ...(flags.designSystem === undefined ? {} : { designSystem: flags.designSystem }), exitCode, components: rows, findings }, {
    command: "audit versions", ok: exitCode === EXIT.ok, items: rows,
    warnings: findings.noActiveVersion.map((componentId) => `component without an active version: ${componentId}`),
    // W6b: KPI-срез — не каталожный sweep, `deprecatedInUse`/`unused` он не считает вовсе.
    // Общий с ним ключ ровно один — `exitCode`; остальное — метрика самого среза.
    summary: {
      exitCode, components: findings.components, published: findings.published,
      versionsPerComponent: findings.versionsPerComponent, noActiveVersion: findings.noActiveVersion.length,
    },
  });
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
  report(reuseAuditLines(audit), { command: "audit reuse", ...audit }, { command: "audit reuse", ok: true, items: audit.forceNew ?? [] });
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
      { command: "composition publish", ok: true },
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
    { command: "composition", ok: true },
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
  // W6b: `--summary-json` — тот же json-режим (stdout принадлежит документу), другой документ.
  summaryJsonMode = flags.summaryJson === true;
  jsonMode = flags.json === true || summaryJsonMode;
  // Верб квитанции — как его набрали (§1.4): общий обработчик отказа не знает контекста команды.
  currentCommand = cmd ?? null;
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
    }, { command: "component", ok: true, warnings: published.warnings ?? [] });
  } else if (cmd === "component-move") {
    const [id] = args;
    const meta = await getMeta("components", id, { mutating: true });
    if (!meta) throw new CliError(`components/${id} not found`);
    const saved = await call("PUT", `/components/${encodeURIComponent(id)}`, { designSystem: flags.designSystem, message: "driver move", baseRev: meta.headRev });
    if (saved.status !== 200) await failRevisionConflict("move", saved, "components", id);
    const savedMeta = await getMeta("components", id, { mutating: true });
    out(`saved ${id} rev ${saved.json.rev} in ${savedMeta.designSystem}`);
    const published = await publishComponent(id, saved.json.rev, undefined, "component-move");
    if (jsonMode) report(null, { command: "component-move", id, rev: saved.json.rev, ...published, ...existenceReport() }, { command: "component-move", ok: true, warnings: published.warnings ?? [] });
  } else if (cmd === "composition") {
    await runComposition(args, flags);
  } else if (cmd === "design-system") {
    const [id, name, description] = args;
    const created = await call("POST", "/design-systems", { id, name, description });
    // W6a: верб больше не пишет в stdout мимо `report()` — человекочитаемый текст тот же
    // (дамп системы), но `--json` получает общую квитанцию.
    if (created.status === 201) report(JSON.stringify(created.json, null, 2), created.json, { command: "design-system", ok: true });
    else if (created.status === 409) {
      const existing = await requireOk("design-system", await call("GET", `/design-systems/${encodeURIComponent(id)}`));
      report(JSON.stringify(existing, null, 2), existing, { command: "design-system", ok: true });
    } else requestFailed("design-system", created);
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
      }, {
        command: "prototype", ok: true, warnings: result.warnings ?? [],
        items: (result.screens ?? []).map((screen) => ({ ...screen, url: `${base}${screen.url}` })),
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
    const fetched = await requireOk("get", await call("GET", path));
    // W6a: тот же дамп в stdout (текстовый режим байт-в-байт), но через `report()` — иначе у
    // верба нет квитанции. Ответ едет под `result`: коллекции — массив, и спред превратил бы
    // его в объект с числовыми ключами.
    report(JSON.stringify(fetched, null, 2), { command: "get", kind, id: id ?? null, result: fetched }, {
      command: "get", ok: true, items: Array.isArray(fetched) ? fetched : [],
    });
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
    report(`${spec.verb} ${kind}/${id}`, { command: "delete", kind, id, deleted: true, ...existenceReport() }, { command: "delete", ok: true });
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
  else if (cmd === "accept-resume") await runAcceptResume(args, flags);
  else if (cmd === "reject") await runReject(args, flags);
  else if (cmd === "impact") await runImpact(args, flags);
  else if (cmd === "migration-commit") await runMigrationCommit(args, flags);
  else if (cmd === "case-set") await runCaseSet(args, flags);
  else if (cmd === "source-package") await runSourcePackage(args, flags);
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
