import type { Database } from "bun:sqlite";
import { ApiError } from "./http";
import { parseStoredPrototypeDoc, PrototypeRepo } from "./repos/prototypes";
import { classifyRevision } from "./classify";
import { collectAssetIds, snapshotDefinitions } from "./validation";
import { validatePrototype } from "../src/prototype/validate";
import type { ArchitectureExemptedIssue, ValidationIssue } from "../src/prototype/types";
import type { PrototypeDoc } from "../src/prototype/schema";
import type { ComponentDefinition } from "../src/catalog/definitions";

/**
 * Ready-to-publish report (план 2026-07-27, волна 4).
 *
 * Жёсткие инварианты, заданные адверсариальными ревью плана:
 *
 * 1. **Report-only по умолчанию.** Гейты включаются единственной глобальной переменной
 *    окружения `EASYUI_PUBLISH_GATES` (CSV). Пусто → `blocking: []` → `publishable: true`.
 *    Причина: publish сегодня не валидирует документ вовсе, а 96 из 124 прод-экранов —
 *    один custom-компонент в корне; включённый по умолчанию гейт сломал бы републикацию
 *    большей части прода.
 * 2. **`unknown` никогда не блокирует.** Отсутствие данных (не запускали capture,
 *    нет сценариев) — не повод отказать в публикации.
 * 3. **Гейт `screens` считается из `classifyRevision`** (документ + бандлы), а не из
 *    флага `route` в `routes/renderStatus.ts`: тот равен `Boolean(options.serveDist)` и
 *    в dev/тестах/e2e всегда false. Route-готовность выносится в информационное подполе.
 * 4. **GET ничего не запускает**: ни screenshot-job'ов, ни visual-прогонов.
 */

export const READINESS_GATE_IDS = [
  "architecture",
  "schema",
  "screens",
  "assets",
  "pins",
  "deprecated",
  "visual",
  "capture",
  "interactions",
  "publishDiff",
] as const;
export type ReadinessGateId = (typeof READINESS_GATE_IDS)[number];
const GATE_ID_SET = new Set<string>(READINESS_GATE_IDS);

export type GateStatus = "pass" | "warn" | "fail" | "unknown";

/** Ссылка на проблемное место: UI редактора/галереи умеет открыть экран и выделить элемент. */
export interface ReadinessLocation { path: string; message: string; screenId?: string; elementKey?: string }

export interface ReadinessGate {
  id: ReadinessGateId;
  status: GateStatus;
  /** Человекочитаемый однострочник (RU-строки живут в UI; здесь — стабильный машинный ключ). */
  summary: string;
  [detail: string]: unknown;
}

export interface ReadinessReport {
  prototypeId: string;
  rev: number;
  generatedAt: string;
  gates: ReadinessGate[];
  /** Идентификаторы включённых гейтов, чей статус превысил порог. Пусто → публикация свободна. */
  blocking: ReadinessGateId[];
  publishable: boolean;
  /** Эффективная конфигурация: `{gateId: "fail"|"warn"}` — порог блокировки. */
  enabledGates: Record<string, "fail" | "warn">;
}

// --- Конфигурация -----------------------------------------------------------

export type GateThreshold = "fail" | "warn";

/**
 * `EASYUI_PUBLISH_GATES` — CSV идентификаторов гейтов. Запись `id` блокирует публикацию
 * при статусе `fail`; запись `id:warn` — уже при `warn`. Неизвестные идентификаторы
 * молча игнорируются (конфиг не должен ронять сервер).
 */
export function parsePublishGates(raw: string | undefined = process.env.EASYUI_PUBLISH_GATES): Record<string, GateThreshold> {
  const enabled: Record<string, GateThreshold> = {};
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [id, level] = trimmed.split(":").map((part) => part.trim());
    if (!id || !GATE_ID_SET.has(id)) continue;
    enabled[id] = level === "warn" ? "warn" : "fail";
  }
  return enabled;
}

const blocks = (status: GateStatus, threshold: GateThreshold): boolean =>
  status === "fail" || (threshold === "warn" && status === "warn");

// --- Помощники --------------------------------------------------------------

const unescapePointer = (part: string): string => part.replaceAll("~1", "/").replaceAll("~0", "~");

/**
 * `/screens/{index}/spec/elements/{key}/...` → `{screenId, elementKey}`. Индекс экрана
 * переводится в идентификатор по документу, чтобы ссылка пережила переупорядочивание.
 */
export function locate(doc: PrototypeDoc, path: string, message: string): ReadinessLocation {
  const parts = path.split("/").slice(1).map(unescapePointer);
  const location: ReadinessLocation = { path, message };
  if (parts[0] !== "screens") return location;
  const index = Number(parts[1]);
  const screen = Number.isInteger(index) ? doc.screens[index] : undefined;
  if (!screen) return location;
  location.screenId = screen.id;
  if (parts[2] === "spec" && parts[3] === "elements" && parts[4]) location.elementKey = parts[4];
  return location;
}

const gate = (id: ReadinessGateId, status: GateStatus, summary: string, detail: Record<string, unknown> = {}): ReadinessGate =>
  ({ id, status, summary, ...detail });

const isArchIssue = (issue: ValidationIssue): boolean => typeof issue.code === "string" && issue.code.startsWith("arch/");

const countBy = <T,>(items: readonly T[], key: (item: T) => string): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const item of items) { const k = key(item); counts[k] = (counts[k] ?? 0) + 1; }
  return counts;
};

// --- Порты ------------------------------------------------------------------

export interface CaptureEvidence { screenId: string; status: "done" | "error"; imageProduced?: boolean; captureClean?: boolean; at?: string }
/**
 * Источник последнего screenshot-job'а. Сегодня очередь `ScreenshotService` живёт только
 * в памяти процесса и ничего не пишет в БД, поэтому роут порт не передаёт и гейт `capture`
 * честно отвечает `unknown`. Когда результаты станут персистентными, достаточно передать
 * реализацию — идентификатор гейта и форма отчёта не меняются.
 */
export interface CaptureLookup { lastJobs(prototypeId: string, rev: number): CaptureEvidence[] }

export interface ReadinessOptions {
  dataDir: string;
  /** Ревизия отчёта; по умолчанию — head. */
  rev?: number;
  /** `serveDist` сервера — только для информационного подполя `route` гейта `screens`. */
  serveDist?: string;
  /** Переопределение конфига гейтов (тесты, dry-run). */
  gates?: Record<string, GateThreshold>;
  capture?: CaptureLookup;
}

// --- Отчёт ------------------------------------------------------------------

export async function computeReadiness(db: Database, prototypeId: string, options: ReadinessOptions): Promise<ReadinessReport> {
  const row = db.query("SELECT id,head_rev,kind FROM prototypes WHERE id=?").get(prototypeId) as { id: string; head_rev: number; kind: string | null } | null;
  if (!row) throw new ApiError(404, "prototype_not_found", "Prototype not found");
  const rev = options.rev ?? row.head_rev;
  const docRow = db.query("SELECT doc FROM prototype_revisions WHERE prototype_id=? AND rev=?").get(prototypeId, rev) as { doc: string } | null;
  if (!docRow) throw new ApiError(404, "revision_not_found", "Prototype revision not found");
  const doc = parseStoredPrototypeDoc(docRow.doc, prototypeId, rev);

  // Определения берутся тем же путём, что и save (последняя active-публикация каждого типа).
  // Ошибка резолва — не исключение отчёта: она становится fail гейта `schema`.
  let definitions: Record<string, ComponentDefinition> | null = null;
  let snapshotError: { code: string; message: string } | null = null;
  try {
    definitions = (await snapshotDefinitions(db, doc, options.dataDir)).definitions;
  } catch (error) {
    snapshotError = error instanceof ApiError ? { code: error.code, message: error.message } : { code: "definitions_unavailable", message: error instanceof Error ? error.message : String(error) };
  }

  const validation = definitions
    ? validatePrototype(doc, { definitions, kind: row.kind ?? undefined })
    : null;

  const gates: ReadinessGate[] = [
    architectureGate(doc, validation),
    schemaGate(doc, validation, snapshotError),
    screensGate(db, doc, prototypeId, rev, options.serveDist),
    assetsGate(db, doc, prototypeId, rev),
    pinsGate(db, prototypeId, rev),
    deprecatedGate(db, prototypeId, rev),
    visualGate(db, prototypeId, rev),
    captureGate(prototypeId, rev, options.capture),
    interactionsGate(),
    publishDiffGate(db, prototypeId, rev),
  ];

  const enabledGates = options.gates ?? parsePublishGates();
  const blocking = gates
    .filter((item) => enabledGates[item.id] !== undefined && blocks(item.status, enabledGates[item.id]!))
    .map((item) => item.id);

  return { prototypeId, rev, generatedAt: new Date().toISOString(), gates, blocking, publishable: blocking.length === 0, enabledGates };
}

// --- Гейты ------------------------------------------------------------------

/** `architecture` — arch/*-предупреждения `validatePrototype` плюс снятые исключениями issue'ы. */
function architectureGate(doc: PrototypeDoc, validation: ReturnType<typeof validatePrototype> | null): ReadinessGate {
  if (!validation) return gate("architecture", "unknown", "definitions_unavailable", { issues: [], exempted: [], counts: {} });
  const issues = validation.warnings.filter(isArchIssue);
  const exempted: ArchitectureExemptedIssue[] = validation.architecture?.exempted ?? [];
  return gate("architecture", issues.length ? "warn" : "pass", issues.length ? "architecture_warnings" : "clean", {
    issues: issues.map((issue) => ({ code: issue.code, ...locate(doc, issue.path, issue.message) })),
    counts: countBy(issues, (issue) => issue.code ?? "arch/unknown"),
    exempted,
    exemptedCount: exempted.length,
  });
}

/** `schema` — ошибки и не-архитектурные предупреждения `validatePrototype`. */
function schemaGate(doc: PrototypeDoc, validation: ReturnType<typeof validatePrototype> | null, snapshotError: { code: string; message: string } | null): ReadinessGate {
  if (!validation) {
    return gate("schema", "fail", snapshotError?.code ?? "definitions_unavailable", {
      errors: [{ path: "/screens", message: snapshotError?.message ?? "Component definitions could not be resolved" }],
      warnings: [],
    });
  }
  const errors = validation.errors.map((issue) => locate(doc, issue.path, issue.message));
  const warnings = validation.warnings.filter((issue) => !isArchIssue(issue)).map((issue) => locate(doc, issue.path, issue.message));
  const status: GateStatus = errors.length ? "fail" : warnings.length ? "warn" : "pass";
  return gate("schema", status, errors.length ? "schema_errors" : warnings.length ? "schema_warnings" : "clean", { errors, warnings });
}

/**
 * `screens` — рендерабельность ревизии по `classifyRevision` (документ + бандлы каждого
 * экрана). Флаг `route` из renderStatus сознательно не используется: он равен
 * `Boolean(serveDist)` и в dev/тестах всегда false. Route-готовность — информационная.
 */
function screensGate(db: Database, doc: PrototypeDoc, prototypeId: string, rev: number, serveDist?: string): ReadinessGate {
  const classification = classifyRevision(db, prototypeId, rev);
  const issues = classification.renderable ? [] : classification.error.issues.map((issue) => locate(doc, issue.path, issue.message));
  const bad = new Set(issues.map((issue) => issue.screenId).filter((id): id is string => id !== undefined));
  const screens = doc.screens.map((screen) => ({ screenId: screen.id, document: true, bundles: !bad.has(screen.id) }));
  return gate("screens", classification.renderable ? "pass" : "fail", classification.renderable ? "renderable" : "not_renderable", {
    screens,
    issues,
    screenCount: screens.length,
    // Информационное подполе: SPA-маршруты обслуживаются только когда сервер отдаёт билд.
    route: { served: Boolean(serveDist), informational: true },
  });
}

/** `assets` — ассеты, на которые ссылается документ, должны быть в реестре и приколоты к ревизии. */
function assetsGate(db: Database, doc: PrototypeDoc, prototypeId: string, rev: number): ReadinessGate {
  const referenced = collectAssetIds(doc);
  const pinned = new Set((db.query("SELECT asset_id id FROM prototype_revision_assets WHERE prototype_id=? AND rev=?").all(prototypeId, rev) as { id: string }[]).map((r) => r.id));
  const missing = referenced.filter((id) => !db.query("SELECT 1 ok FROM assets WHERE id=?").get(id));
  const unpinned = referenced.filter((id) => !missing.includes(id) && !pinned.has(id));
  const status: GateStatus = missing.length ? "fail" : unpinned.length ? "warn" : "pass";
  return gate("assets", status, missing.length ? "assets_missing" : unpinned.length ? "assets_unpinned" : "clean", {
    referenced: referenced.length,
    pinned: pinned.size,
    missing,
    unpinned,
  });
}

/** `pins` — `bundleReadiness` ревизии: статусы публикаций закреплённых компонентов. */
function pinsGate(db: Database, prototypeId: string, rev: number): ReadinessGate {
  const readiness = new PrototypeRepo(db).bundleReadiness(prototypeId, rev);
  const status: GateStatus = readiness.errors.length ? "fail" : readiness.warnings.length ? "warn" : "pass";
  return gate("pins", status, readiness.errors.length ? "pins_unrenderable" : readiness.warnings.length ? "pins_degraded" : "clean", {
    pins: readiness.resolvedPins.map((pin) => ({ id: pin.id, name: pin.name, version: pin.version, status: pin.status })),
    errors: readiness.errors,
    warnings: readiness.warnings,
    bundles: readiness.bundles,
  });
}

type PinMetaRow = { id: string; name: string; version: number; status: string; definition_meta: string };

/** `deprecated` — пины со статусом `deprecated`/`superseded` и объявленная замена компонента. */
function deprecatedGate(db: Database, prototypeId: string, rev: number): ReadinessGate {
  const rows = db.query(`SELECT c.id, c.name, prc.component_version version, cp.status, cp.definition_meta
    FROM prototype_revision_components prc
    JOIN components c ON c.id=prc.component_id
    JOIN component_publishes cp ON cp.component_id=prc.component_id AND cp.version=prc.component_version
    WHERE prc.prototype_id=? AND prc.rev=? ORDER BY c.id`).all(prototypeId, rev) as PinMetaRow[];
  const stale = rows.filter((row) => row.status === "deprecated" || row.status === "superseded");
  const components = stale.map((row) => {
    let replacement: string | undefined;
    try { replacement = (JSON.parse(row.definition_meta) as { replacement?: string }).replacement; }
    catch { /* повреждённая meta не должна ронять отчёт */ }
    // Метаданные могли появиться позже закреплённой версии — добираем из последней active-публикации.
    if (replacement === undefined) {
      const latest = db.query("SELECT definition_meta FROM component_publishes WHERE component_id=? AND status='active' ORDER BY version DESC LIMIT 1").get(row.id) as { definition_meta: string } | null;
      if (latest) { try { replacement = (JSON.parse(latest.definition_meta) as { replacement?: string }).replacement; } catch { /* ignore */ } }
    }
    return { id: row.id, name: row.name, version: row.version, status: row.status, ...(replacement ? { replacement } : {}) };
  });
  return gate("deprecated", components.length ? "warn" : "pass", components.length ? "deprecated_pins" : "clean", {
    components,
    withReplacement: components.filter((item) => item.replacement !== undefined).length,
  });
}

type BaselineMemberRow = { screenId: string; referenceId: string };

/** `visual` — последний коммит `visual_baseline_sets` и последние прогоны по его эталонам. Ничего не запускает. */
function visualGate(db: Database, prototypeId: string, rev: number): ReadinessGate {
  const set = db.query("SELECT generation,rev,members_json,created_at FROM visual_baseline_sets WHERE prototype_id=? ORDER BY generation DESC LIMIT 1")
    .get(prototypeId) as { generation: number; rev: number; members_json: string; created_at: string } | null;
  if (!set) return gate("visual", "unknown", "no_baseline", { baseline: null, runs: [] });
  let members: BaselineMemberRow[] = [];
  try { members = JSON.parse(set.members_json) as BaselineMemberRow[]; } catch { members = []; }
  const runs = members.map((member) => {
    const run = db.query("SELECT status,diff_percent,created_at FROM visual_runs WHERE reference_id=? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(member.referenceId) as { status: string; diff_percent: number | null; created_at: string } | null;
    return { screenId: member.screenId, referenceId: member.referenceId, status: run?.status ?? null, diffPercent: run?.diff_percent ?? null, at: run?.created_at ?? null };
  });
  const baseline = { generation: set.generation, rev: set.rev, createdAt: set.created_at, stale: set.rev !== rev, members: members.length };
  const failed = runs.filter((run) => run.status === "fail" || run.status === "error" || run.status === "reference_missing");
  const unrun = runs.filter((run) => run.status === null);
  const status: GateStatus = failed.length ? "fail" : baseline.stale || unrun.length ? "warn" : "pass";
  const summary = failed.length ? "visual_diff" : baseline.stale ? "baseline_stale" : unrun.length ? "runs_missing" : "clean";
  return gate("visual", status, summary, { baseline, runs });
}

/**
 * `capture` — последний screenshot-job. Очередь `ScreenshotService` целиком in-memory и
 * не пишет в БД, поэтому без переданного порта гейт отвечает `unknown` (и не блокирует).
 */
function captureGate(prototypeId: string, rev: number, capture?: CaptureLookup): ReadinessGate {
  const jobs = capture?.lastJobs(prototypeId, rev) ?? [];
  if (!jobs.length) return gate("capture", "unknown", "no_capture_evidence", { screens: [], persisted: false });
  const bad = jobs.filter((job) => job.status === "error" || job.imageProduced === false);
  const dirty = jobs.filter((job) => job.captureClean === false);
  const status: GateStatus = bad.length ? "fail" : dirty.length ? "warn" : "pass";
  return gate("capture", status, bad.length ? "capture_failed" : dirty.length ? "capture_noisy" : "clean", { screens: jobs, persisted: true });
}

/** `interactions` — заполняется волной 6 (сценарии). Идентификатор гейта стабилен уже сейчас. */
function interactionsGate(): ReadinessGate {
  return gate("interactions", "unknown", "no_scenarios", { scenarios: 0, wave: 6 });
}

/** `publishDiff` — доступен ли diff головной ревизии против последней опубликованной версии. */
function publishDiffGate(db: Database, prototypeId: string, rev: number): ReadinessGate {
  const latest = db.query("SELECT version,rev FROM prototype_publishes WHERE prototype_id=? ORDER BY version DESC LIMIT 1")
    .get(prototypeId) as { version: number; rev: number } | null;
  if (!latest) return gate("publishDiff", "unknown", "never_published", { available: false, latestVersion: null });
  if (latest.rev === rev) {
    return gate("publishDiff", "warn", "already_published", { available: false, latestVersion: latest.version, latestRev: latest.rev });
  }
  return gate("publishDiff", "pass", "diff_available", {
    available: true,
    latestVersion: latest.version,
    latestRev: latest.rev,
    diffUrl: `/api/prototypes/${encodeURIComponent(prototypeId)}/revisions/${rev}/diff?against=${latest.rev}`,
  });
}
