/**
 * Migration commit transaction — серверная сага миграционного коммита (план
 * `docs/plans/2026-08-07-migration-feedback-wave.md` §1.3/§W4, ретроспектива P0.4, миграция v35).
 *
 * Что она решает. Перевод одного компонента миграции из «кандидат принят» в «в галерее лежит
 * сохранённый экран, регрессия спланирована, каталог отревизован» — это шесть чужих мутаций
 * подряд, и до этой волны координатор исполнял их руками, теряя половину прогресса на любом
 * обрыве. Сага делает последовательность **durable и resumable**: состояние живёт в строке
 * `migration_commits`, а драйвер к ней — poller, а не владелец.
 *
 * Границы, которые здесь держатся сознательно:
 *
 * 1. **Оркестрация поверх существующих мутаций.** `promoteComponent`, `updatePrototypeFromDoc`,
 *    `screenRenderStatus`/`computeReadiness`, `buildSnapPlan`, `auditCatalog` вызываются как есть.
 *    Ни одна из них в этой волне не менялась: сага, которая переписывает то, что оркестрирует,
 *    не была бы обратимой. Слоя инвалидации волна не вводит.
 * 2. **Честная граница KPI** (триаж S-M2). Сага закрывает **серверный хвост**. Агентские
 *    контрольные документы координатора (`WORKFLOW_STATE.md`, `BUILD_ORDER.md`) сервер не пишет и
 *    писать не будет: у него нет ни рабочего пространства агента, ни права в него писать.
 *    Формулировка KPI — «1 resumable server workflow + 1 агентская запись receipt», не «ноль
 *    ручных действий».
 * 3. **Компенсаций нет.** Провал фазы не откатывает предыдущие: promote необратим по построению
 *    (версия опубликована и уже видна каталогу), и «откат» означал бы депубликацию живой версии.
 *    Вместо отката — типизованное `needs-<фаза>`: сага ждёт человека и продолжается с той же фазы
 *    через `advance`.
 * 4. **`needs-*` не держит компонент.** Позитивный список активных фаз в partial unique index
 *    (v35) намеренно не включает `needs-*`: пока одна сага ждёт человека, новую миграцию того же
 *    компонента начать можно. Блокируется только по-настоящему исполняющаяся сага (409
 *    `migration_commit_in_flight`).
 * 5. **Watchdog без таймеров.** Периодических таймеров в сервере нет (канон
 *    `sweepNonTerminalRuns`/`gcCandidates`/`sweepStagingModules`), поэтому зависшие фазы
 *    подметаются на старте процесса и на каждом запросе к `/api/migration-commits*`.
 */
import type { Database } from "bun:sqlite";
import { ApiError } from "../http";
import { ComponentRepo } from "../repos/components";
import { PrototypeRepo } from "../repos/prototypes";
import { requireActiveDesignSystem } from "../designSystems";
import { promoteComponent } from "../components/promote";
import { updatePrototypeFromDoc, surfacesWriteEnabled } from "../routes/prototypes";
import { inputPrototypeDocSchema, type PrototypeDoc } from "../../src/prototype/schema";
import { buildSnapPlan, impactedSnapEnabled, SNAP_PLAN_MAX_SCREENS, type SnapPlan } from "../prototypes/screenFrames";
import { barrierAwareReadinessPolicy } from "../capture/resourceBarrier";
import { computeReadiness } from "../readiness";
import { auditCatalog } from "../catalog/audit";
import type { AcceptanceRepo } from "../acceptance/repo";
import type { ReuseGateMode } from "../catalog/gate";
import { writeAuditEvent } from "../audit";

// ---------------------------------------------------------------- фазы и типы

/**
 * Позитивный список **активных** фаз (раунд 2, N10). Ровно он живёт в `WHERE` partial unique
 * index'а v35 и ровно он определяет, что такое «сага в полёте». Порядок массива — порядок
 * исполнения; `advance` продолжает с элемента, соответствующего текущему `needs-*`.
 */
export const MIGRATION_COMMIT_PHASES = [
  "preflight", "promote", "gallery-save", "verify", "impacted-regression", "audit",
] as const;
export type MigrationCommitPhase = (typeof MIGRATION_COMMIT_PHASES)[number];

/** Терминальные состояния: `complete` — сага прошла все фазы, `cancelled` — человек её закрыл. */
export const MIGRATION_COMMIT_TERMINAL = ["complete", "cancelled"] as const;
export type MigrationCommitTerminal = (typeof MIGRATION_COMMIT_TERMINAL)[number];

/** `needs-<фаза>`: фаза провалилась или зависла; сага ждёт человека и resumable через `advance`. */
export type MigrationCommitNeeds = `needs-${MigrationCommitPhase}`;
export type MigrationCommitState = MigrationCommitPhase | MigrationCommitNeeds | MigrationCommitTerminal;

const PHASE_SET = new Set<string>(MIGRATION_COMMIT_PHASES);
export const isActivePhase = (value: string): value is MigrationCommitPhase => PHASE_SET.has(value);
export const needsOf = (phase: MigrationCommitPhase): MigrationCommitNeeds => `needs-${phase}`;
export const phaseOfNeeds = (state: string): MigrationCommitPhase | null => {
  if (!state.startsWith("needs-")) return null;
  const phase = state.slice("needs-".length);
  return isActivePhase(phase) ? phase : null;
};

/**
 * Потолок жизни одной фазы (`limits.migrationCommitPhaseTimeoutMs`) — 10 минут.
 *
 * Выведен из самой длинной фазы, а не из круглого числа: фазы исполняются **синхронно внутри
 * запроса**, и дольше всех живёт `promote` (typecheck+compile холодного кандидата — единицы
 * минут в худшем случае, см. таймауты promote-тестов 120 с) и `audit` (полный матчер каталога).
 * Десять минут — примерно четырёхкратный запас к худшей наблюдаемой фазе и одновременно срок,
 * который человек согласен ждать, прежде чем считать сагу зависшей. Строка, простоявшая в
 * активной фазе дольше, означает ровно одно: процесс, который её двигал, умер (redeploy, SIGKILL).
 */
export const MIGRATION_COMMIT_PHASE_TIMEOUT_MS = 10 * 60_000;

/**
 * Kill-switch волны: `EASYUI_MIGRATION_COMMIT_DISABLED=1` гасит весь набор ручек (404) и
 * `features.migrationCommit=false`. Env читается по месту — прецедент `impactedSnapEnabled`
 * (`prototypes/screenFrames.ts`), параметр `raw` существует ради тестов.
 *
 * Гейт волны **шире** этого переключателя: роуты живут только при `EASYUI_ACCEPTANCE_MATRIX=1`
 * (как остальная приёмка — триаж O-m13); резолвится он в `main.ts` наличием оркестратора.
 */
export const migrationCommitEnabled = (raw: string | undefined = process.env.EASYUI_MIGRATION_COMMIT_DISABLED): boolean =>
  raw !== "1";

export interface MigrationCommitRow {
  commit_id: string;
  component_id: string;
  candidate_id: string | null;
  design_system: string;
  gallery_prototype_id: string | null;
  phase: string;
  phases_json: string;
  request_json: string;
  receipt_json: string | null;
  idempotency_key: string;
  owner_id: string;
  phase_started_at: string;
  created_at: string;
  updated_at: string;
}

/** Журнальная запись одной попытки фазы. `timeout` пишет watchdog, остальное — сама сага. */
export interface MigrationCommitPhaseEntry {
  phase: MigrationCommitPhase;
  startedAt: string;
  endedAt: string | null;
  status: "done" | "failed" | "timeout" | "skipped";
  /** true — фаза не исполнялась повторно, результат взят из квитанции (идемпотентный повтор). */
  idempotentReplay?: boolean;
  detail?: unknown;
  error?: { code: string; message: string };
}

export interface MigrationCommitGalleryRequest {
  prototypeId: string;
  /** CAS галереи: если задан — обязан совпасть с головой на префлайте (`409 rev_mismatch`). */
  baseRev?: number;
  /** Экран (или экраны) галереи: вставляются по `id`, существующий с тем же id заменяется. */
  screenFragment?: unknown;
  message?: string;
  viewport?: { width: number; height: number };
  deviceScaleFactor?: number;
  theme?: "light" | "dark";
  /** `barrier` — тот же галерейный opt-in readiness, что у `snap-plan` (§W2/§O-M4). */
  readiness?: "barrier";
}

export interface MigrationCommitRequest {
  idempotencyKey: string;
  componentId: string;
  baseRev: number;
  sourceHash: string;
  candidateId?: string;
  acceptanceRunIds?: string[];
  expectedCases?: number;
  supersede?: "auto" | "none";
  message?: string;
  gallery?: MigrationCommitGalleryRequest;
  /** Дизайн-система аудит-фазы; по умолчанию — система самого компонента. */
  auditDesignSystem?: string;
}

/** Накопленная квитанция саги: по одному ключу на фазу, дописывается по мере прохождения. */
export interface MigrationCommitResult {
  promote?: {
    version: number; rev: number; catalogRevision: string; superseded: number[];
    candidateId: string | null; acceptanceRunIds: string[]; cached: boolean; warnings: string[];
  };
  gallery?: { prototypeId: string; beforeRev: number; afterRev: number; changed: boolean; warnings: unknown[] };
  verify?: {
    screens: { screenId: string; renderable: boolean; errors: string[] }[];
    readiness: { rev: number; publishable: boolean; blocking: string[] };
  };
  regression?: { mode: RegressionMode; plan: SnapPlan | null; warnings: string[] };
  audit?: { catalogRevision: string; dataFingerprint: string; designSystem: string; artifacts: number; duplicateGroups: number; planEntries: number };
}

/**
 * Режим фазы регрессии (§1.3, триаж S-M3). `impacted` — план W5 доказал, какие экраны можно не
 * снимать; `full` — план недоступен (kill-switch `EASYUI_IMPACTED_SNAP_DISABLED=1` или галереи в
 * запросе нет), и координатор обязан считать затронутыми **все** экраны. Квитанция несёт режим
 * всегда, чтобы «regression прошла» нельзя было прочитать двусмысленно.
 */
export type RegressionMode = "impacted" | "full";

export interface MigrationCommitReceipt {
  commitId: string;
  componentId: string;
  designSystem: string;
  candidateId: string | null;
  galleryPrototypeId: string | null;
  phase: MigrationCommitState;
  phasesDone: MigrationCommitPhase[];
  regressionMode: RegressionMode;
  createdAt: string;
  updatedAt: string;
  phaseStartedAt: string;
  request: MigrationCommitRequest;
  phases: MigrationCommitPhaseEntry[];
  result: MigrationCommitResult;
  error?: { code: string; message: string };
}

// ------------------------------------------------------------------ хранилище

const now = (): string => new Date().toISOString();
const parse = <T>(raw: string | null, fallback: T): T => {
  if (raw === null) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
};

export const commitId = (): string => `mig_${crypto.randomUUID()}`;
const COMMIT_ID_PATTERN = /^mig_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isCommitId = (value: string): boolean => COMMIT_ID_PATTERN.test(value);

export function commitRow(db: Database, id: string): MigrationCommitRow | undefined {
  return (db.query("SELECT * FROM migration_commits WHERE commit_id=?").get(id) as MigrationCommitRow | null) ?? undefined;
}

export function requireCommitRow(db: Database, id: string): MigrationCommitRow {
  const row = commitRow(db, id);
  if (!row) throw new ApiError(404, "not_found", "Migration commit not found");
  return row;
}

/**
 * Гонка двух процессов на partial unique index'е: предпроверка прошла у обоих, индекс отсеял
 * второго.
 *
 * SQLite называет в сообщении **колонки**, а не индекс, поэтому оба ограничения начинаются с
 * `migration_commits.component_id`; отличает их присутствие второй колонки ключа идемпотентности
 * (тот же приём, что у `isInFlightConstraint` в `acceptance/repo.ts`).
 */
const isInFlightConstraint = (error: unknown): boolean =>
  error instanceof Error && error.message.includes("migration_commits.component_id") && !error.message.includes("idempotency_key");

const isIdempotencyConstraint = (error: unknown): boolean =>
  error instanceof Error && error.message.includes("migration_commits.idempotency_key");

const inFlightError = (row?: MigrationCommitRow): ApiError => new ApiError(
  409, "migration_commit_in_flight", "Component already has a migration commit in an active phase",
  row ? { commitId: row.commit_id } : {},
);

export function inFlightCommit(db: Database, componentId: string): MigrationCommitRow | undefined {
  const placeholders = MIGRATION_COMMIT_PHASES.map(() => "?").join(",");
  return (db.query(`SELECT * FROM migration_commits WHERE component_id=? AND phase IN (${placeholders}) LIMIT 1`)
    .get(componentId, ...MIGRATION_COMMIT_PHASES) as MigrationCommitRow | null) ?? undefined;
}

export function receiptOf(row: MigrationCommitRow): MigrationCommitReceipt {
  const phases = parse<MigrationCommitPhaseEntry[]>(row.phases_json, []);
  const stored = parse<{ result?: MigrationCommitResult; error?: { code: string; message: string } }>(row.receipt_json, {});
  const result = stored.result ?? {};
  return {
    commitId: row.commit_id,
    componentId: row.component_id,
    designSystem: row.design_system,
    candidateId: row.candidate_id,
    galleryPrototypeId: row.gallery_prototype_id,
    phase: row.phase as MigrationCommitState,
    phasesDone: phases.filter((entry) => entry.status === "done" || entry.status === "skipped").map((entry) => entry.phase),
    regressionMode: result.regression?.mode ?? regressionModeOf(parse<MigrationCommitRequest>(row.request_json, {} as MigrationCommitRequest)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    phaseStartedAt: row.phase_started_at,
    request: parse<MigrationCommitRequest>(row.request_json, {} as MigrationCommitRequest),
    phases,
    result,
    ...(stored.error === undefined ? {} : { error: stored.error }),
  };
}

/**
 * Ожидаемый режим регрессии **до** её исполнения: галереи нет — считать нечего, план выключен —
 * `full`. Квитанция после фазы несёт фактический режим (он может отличаться только в сторону
 * `full`, никогда наоборот).
 */
const regressionModeOf = (request: MigrationCommitRequest): RegressionMode =>
  request.gallery && impactedSnapEnabled() ? "impacted" : "full";

// -------------------------------------------------------------------- watchdog

/**
 * Watchdog (R7, триаж O-M7): активные фазы, простоявшие дольше `MIGRATION_COMMIT_PHASE_TIMEOUT_MS`,
 * переводятся в `needs-<фаза>` с журнальной записью `timeout`.
 *
 * Исполняется **на старте процесса** (`main.ts`, рядом с `failStagingPublishes`/`gcCandidates`) и
 * **на каждом запросе** к `/api/migration-commits*`: периодических таймеров в сервере нет, а
 * зависшая фаза иначе держала бы компонент partial-индексом вечно.
 *
 * Возвращает число подметённых саг.
 */
export function sweepStaleMigrationCommits(db: Database, at = Date.now(), timeoutMs = MIGRATION_COMMIT_PHASE_TIMEOUT_MS): number {
  const placeholders = MIGRATION_COMMIT_PHASES.map(() => "?").join(",");
  const cutoff = new Date(at - timeoutMs).toISOString();
  let rows: MigrationCommitRow[];
  try {
    rows = db.query(`SELECT * FROM migration_commits WHERE phase IN (${placeholders}) AND phase_started_at<? ORDER BY phase_started_at`)
      .all(...MIGRATION_COMMIT_PHASES, cutoff) as MigrationCommitRow[];
  } catch { return 0; /* таблицы ещё нет (старт до миграции) — подметать нечего */ }
  const stamp = new Date(at).toISOString();
  let swept = 0;
  for (const row of rows) {
    const phase = row.phase as MigrationCommitPhase;
    const phases = parse<MigrationCommitPhaseEntry[]>(row.phases_json, []);
    const open = [...phases].reverse().find((entry) => entry.phase === phase && entry.endedAt === null);
    if (open) { open.endedAt = stamp; open.status = "timeout"; open.error = { code: "phase_timeout", message: `Phase ${phase} exceeded ${timeoutMs} ms and was swept` }; }
    else phases.push({ phase, startedAt: row.phase_started_at, endedAt: stamp, status: "timeout", error: { code: "phase_timeout", message: `Phase ${phase} exceeded ${timeoutMs} ms and was swept` } });
    const stored = parse<{ result?: MigrationCommitResult }>(row.receipt_json, {});
    db.query("UPDATE migration_commits SET phase=?, phases_json=?, receipt_json=?, updated_at=? WHERE commit_id=? AND phase=?")
      .run(needsOf(phase), JSON.stringify(phases), JSON.stringify({ ...stored, error: { code: "phase_timeout", message: `Phase ${phase} exceeded ${timeoutMs} ms and was swept` } }), stamp, row.commit_id, phase);
    swept += 1;
  }
  return swept;
}

// ------------------------------------------------------------------- контекст

export interface MigrationCommitContext {
  db: Database;
  dataDir: string;
  actor: { userId: string; isAdmin: boolean };
  mode: ReuseGateMode;
  /** Репозиторий матричной приёмки: нужен только для `candidateId`/`acceptanceRunIds` в promote. */
  acceptanceRepo?: AcceptanceRepo;
  serveDist?: string;
}

/** Экраны, которых касается коммит: id из `screenFragment` (или все экраны головы, если его нет). */
function affectedScreenIds(request: MigrationCommitRequest, doc: PrototypeDoc): string[] {
  const fragment = normalizeFragment(request.gallery?.screenFragment);
  if (fragment.length === 0) return doc.screens.map((screen) => screen.id);
  return fragment.map((screen) => screen.id);
}

/** `screenFragment` → массив экранов. Принимается один экран или массив; форма проверяется здесь. */
function normalizeFragment(value: unknown): { id: string; [key: string]: unknown }[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  const out: { id: string; [key: string]: unknown }[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ApiError(422, "validation_failed", "gallery.screenFragment must be a screen object or an array of screen objects");
    }
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) {
      throw new ApiError(422, "validation_failed", "gallery.screenFragment entries must carry a string id");
    }
    out.push(item as { id: string });
  }
  return out;
}

/** Слияние фрагмента в документ головы: экран с тем же id заменяется, новый — дописывается в конец. */
export function mergeScreenFragment(doc: PrototypeDoc, fragment: unknown): { doc: PrototypeDoc; changed: boolean } {
  const screens = normalizeFragment(fragment);
  if (screens.length === 0) return { doc, changed: false };
  const next = [...doc.screens] as unknown[];
  for (const screen of screens) {
    const at = next.findIndex((existing) => (existing as { id: string }).id === screen.id);
    if (at === -1) next.push(screen); else next[at] = screen;
  }
  const merged = { ...doc, screens: next };
  const changed = JSON.stringify(merged.screens) !== JSON.stringify(doc.screens);
  const parsed = inputPrototypeDocSchema.safeParse(merged);
  if (!parsed.success) throw new ApiError(422, "validation_failed", "Merged gallery document is invalid", { issues: parsed.error.issues });
  // Тот же kill-switch, что и на PUT (`surfacesWriteEnabled`): сага не имеет права записать
  // мульти-поверхностный документ там, где ручка бы отказала.
  if (parsed.data.surfaces && !surfacesWriteEnabled()) {
    throw new ApiError(422, "surfaces_disabled", "Multi-surface documents are disabled on this server (EASYUI_SURFACES)");
  }
  return { doc: parsed.data, changed };
}

// ------------------------------------------------------------------- фазы саги

type PhaseOutcome = { detail?: unknown; idempotentReplay?: boolean; skipped?: boolean };

async function runPreflight(context: MigrationCommitContext, request: MigrationCommitRequest, result: MigrationCommitResult): Promise<PhaseOutcome> {
  const { db } = context;
  const component = new ComponentRepo(db).row(request.componentId);
  requireActiveDesignSystem(db, component.design_system, ["componentId"]);
  if (component.head_rev !== request.baseRev) {
    throw new ApiError(409, "rev_mismatch", `Component head is rev ${component.head_rev}, request declares ${request.baseRev}`, { currentRev: component.head_rev });
  }
  // Кандидат: мягкая ссылка. Его отсутствие — типизованный отказ **фазы**, а не 500 на чтении:
  // кандидаты вымываются GC, и сага обязана называть причину.
  if (request.candidateId !== undefined) {
    if (!context.acceptanceRepo) throw new ApiError(422, "acceptance_matrix_disabled", "candidateId requires EASYUI_ACCEPTANCE_MATRIX=1");
    const candidate = context.acceptanceRepo.candidate(request.candidateId);
    if (!candidate || candidate.component_id !== request.componentId) throw new ApiError(404, "not_found", "Candidate not found");
  }
  let gallery: { prototypeId: string; rev: number; screens: string[] } | undefined;
  if (request.gallery) {
    const head = new PrototypeRepo(db).draft(request.gallery.prototypeId);
    if (request.gallery.baseRev !== undefined && request.gallery.baseRev !== head.rev) {
      throw new ApiError(409, "rev_mismatch", `Gallery head is rev ${head.rev}, request declares ${request.gallery.baseRev}`, { currentRev: head.rev });
    }
    // Слияние проверяется **на префлайте**, до всякой мутации: невалидный фрагмент обязан
    // остановить сагу до promote, а не после него.
    const merged = mergeScreenFragment(head.doc, request.gallery.screenFragment);
    if (merged.doc.screens.length > SNAP_PLAN_MAX_SCREENS) {
      throw new ApiError(422, "snap_plan_too_many_screens", `Gallery would carry ${merged.doc.screens.length} screens; the ceiling is ${SNAP_PLAN_MAX_SCREENS}`);
    }
    gallery = { prototypeId: request.gallery.prototypeId, rev: head.rev, screens: affectedScreenIds(request, merged.doc) };
  }
  void result;
  return { detail: { componentRev: component.head_rev, designSystem: component.design_system, ...(gallery ? { gallery } : {}) } };
}

async function runPromote(context: MigrationCommitContext, request: MigrationCommitRequest, result: MigrationCommitResult): Promise<PhaseOutcome> {
  // Идемпотентный повтор: версия уже записана в квитанции — второй `promoteComponent` создал бы
  // **новую** версию (расширенный `already_published`-чек его пропускает), то есть удвоил бы
  // каталог на ровном месте.
  if (result.promote) return { idempotentReplay: true, detail: { version: result.promote.version } };
  const promoted = await promoteComponent(context.db, context.dataDir, {
    id: request.componentId,
    baseRev: request.baseRev,
    sourceHash: request.sourceHash,
    supersede: request.supersede ?? "auto",
    actor: context.actor,
    mode: context.mode,
    ...(request.message === undefined ? {} : { message: request.message }),
    ...(context.acceptanceRepo && (request.candidateId !== undefined || request.acceptanceRunIds !== undefined)
      ? { acceptance: {
          repo: context.acceptanceRepo,
          ...(request.candidateId === undefined ? {} : { candidateId: request.candidateId }),
          ...(request.acceptanceRunIds === undefined ? {} : { acceptanceRunIds: request.acceptanceRunIds }),
          ...(request.expectedCases === undefined ? {} : { expectedCases: request.expectedCases }),
        } }
      : {}),
  });
  result.promote = {
    version: promoted.version, rev: promoted.rev, catalogRevision: promoted.catalogRevision,
    superseded: promoted.superseded, candidateId: promoted.candidateId, acceptanceRunIds: promoted.acceptanceRunIds,
    cached: promoted.cached, warnings: promoted.warnings,
  };
  writeAuditEvent(context.db, {
    actorId: context.actor.userId, action: "component.promoted", subjectType: "component", subjectId: request.componentId,
    detail: { version: promoted.version, rev: promoted.rev, sourceHash: promoted.sourceHash, bundleHash: promoted.bundleHash, catalogRevision: promoted.catalogRevision, superseded: promoted.superseded, migrationCommit: true },
  });
  return { detail: { version: promoted.version, catalogRevision: promoted.catalogRevision } };
}

async function runGallerySave(context: MigrationCommitContext, request: MigrationCommitRequest, result: MigrationCommitResult): Promise<PhaseOutcome> {
  if (!request.gallery) return { skipped: true, detail: { reason: "no_gallery_in_request" } };
  if (result.gallery) return { idempotentReplay: true, detail: { rev: result.gallery.afterRev } };
  const db = context.db;
  const repo = new PrototypeRepo(db);
  const head = repo.draft(request.gallery.prototypeId);
  const merged = mergeScreenFragment(head.doc, request.gallery.screenFragment);
  if (!merged.changed) {
    // Документ уже несёт этот экран (повтор после обрыва между записью и апдейтом строки саги):
    // новая ревизия ради байт-идентичного документа — ложный след в истории галереи.
    result.gallery = { prototypeId: request.gallery.prototypeId, beforeRev: head.rev, afterRev: head.rev, changed: false, warnings: [] };
    return { idempotentReplay: true, detail: { rev: head.rev, changed: false } };
  }
  const saved = await updatePrototypeFromDoc(db, repo, request.gallery.prototypeId, merged.doc, head.rev, context.dataDir, context.actor.userId,
    { ...(request.gallery.message === undefined ? {} : { message: request.gallery.message }) });
  result.gallery = { prototypeId: request.gallery.prototypeId, beforeRev: head.rev, afterRev: saved.rev, changed: true, warnings: saved.warnings };
  return { detail: { rev: saved.rev } };
}

async function runVerify(context: MigrationCommitContext, request: MigrationCommitRequest, result: MigrationCommitResult): Promise<PhaseOutcome> {
  if (!request.gallery) return { skipped: true, detail: { reason: "no_gallery_in_request" } };
  const db = context.db;
  const repo = new PrototypeRepo(db);
  const head = repo.draft(request.gallery.prototypeId);
  const ids = affectedScreenIds(request, head.doc);
  const screens = ids.map((screenId) => {
    const status = repo.screenRenderStatus(request.gallery!.prototypeId, screenId, {});
    return { screenId, renderable: status.document && status.bundles, errors: status.errors.map((entry) => entry.code) };
  });
  // Геометрия затронутых экранов (триаж S-M2) читается тем же readiness-отчётом, что и галерейная
  // публикация: гейты `screens`/`pins`/`capture` — единственное, что сервер знает о геометрии, не
  // запуская съёмку. Блокирует фазу только `blocking` (конфиг `EASYUI_PUBLISH_GATES`), а не
  // произвольный `warn`: сага не имеет права быть строже ручки публикации.
  const readiness = await computeReadiness(db, request.gallery.prototypeId, { dataDir: context.dataDir, ...(context.serveDist === undefined ? {} : { serveDist: context.serveDist }) });
  result.verify = { screens, readiness: { rev: readiness.rev, publishable: readiness.publishable, blocking: [...readiness.blocking] } };
  const broken = screens.filter((screen) => !screen.renderable);
  if (broken.length) {
    throw new ApiError(422, "screens_not_renderable", `Gallery screens are not renderable: ${broken.map((screen) => screen.screenId).join(", ")}`);
  }
  if (readiness.blocking.length) {
    throw new ApiError(422, "readiness_blocked", `Gallery readiness gates block the commit: ${readiness.blocking.join(", ")}`);
  }
  return { detail: { screens: screens.length, blocking: readiness.blocking.length } };
}

async function runRegression(context: MigrationCommitContext, request: MigrationCommitRequest, result: MigrationCommitResult): Promise<PhaseOutcome> {
  if (!request.gallery) {
    result.regression = { mode: "full", plan: null, warnings: ["no_gallery_in_request"] };
    return { skipped: true, detail: { mode: "full" } };
  }
  if (!impactedSnapEnabled()) {
    // Деградация в full-regression с предупреждением (§W4): плана нет, значит затронутыми
    // считаются все экраны — молчаливое «регрессия прошла» здесь было бы ложью.
    result.regression = { mode: "full", plan: null, warnings: ["impacted_snap_disabled"] };
    return { detail: { mode: "full" } };
  }
  const gallery = request.gallery;
  const plan = buildSnapPlan(context.db, {
    prototypeId: gallery.prototypeId,
    viewport: gallery.viewport ?? { width: 390, height: 844 },
    dsf: gallery.deviceScaleFactor ?? 1,
    theme: gallery.theme ?? "light",
    ...(gallery.readiness === "barrier" ? { readinessPolicy: barrierAwareReadinessPolicy("gallery") } : {}),
  });
  result.regression = { mode: "impacted", plan, warnings: [] };
  return { detail: { mode: "impacted", summary: plan.summary } };
}

async function runAudit(context: MigrationCommitContext, request: MigrationCommitRequest, result: MigrationCommitResult): Promise<PhaseOutcome> {
  const designSystem = request.auditDesignSystem ?? new ComponentRepo(context.db).row(request.componentId).design_system;
  const report = auditCatalog(context.db);
  const artifacts = report.artifacts.filter((artifact) => artifact.artifact.designSystem === designSystem);
  const duplicateGroups = report.duplicateGroups.filter((group) =>
    group.canonical.designSystem === designSystem || group.retired.some((key) => key.designSystem === designSystem));
  result.audit = {
    catalogRevision: report.catalogRevision, dataFingerprint: report.dataFingerprint, designSystem,
    artifacts: artifacts.length, duplicateGroups: duplicateGroups.length, planEntries: report.plan.groups.length,
  };
  return { detail: result.audit };
}

const PHASE_RUNNERS: Record<MigrationCommitPhase, (context: MigrationCommitContext, request: MigrationCommitRequest, result: MigrationCommitResult) => Promise<PhaseOutcome>> = {
  "preflight": runPreflight,
  "promote": runPromote,
  "gallery-save": runGallerySave,
  "verify": runVerify,
  "impacted-regression": runRegression,
  "audit": runAudit,
};

// ------------------------------------------------------------------- драйвер

/**
 * Перевод строки в активную фазу. **Единственная** точка, где сага заходит под partial unique
 * index: конфликт здесь = «другая сага того же компонента уже в полёте» (409), и ловить его надо
 * на уровне UPDATE, а не предпроверкой — предпроверка гоночная.
 */
function enterPhase(db: Database, id: string, phase: MigrationCommitPhase, from: string, phases: MigrationCommitPhaseEntry[], at: string): void {
  phases.push({ phase, startedAt: at, endedAt: null, status: "done" });
  try {
    const changed = db.query("UPDATE migration_commits SET phase=?, phase_started_at=?, phases_json=?, updated_at=? WHERE commit_id=? AND phase=?")
      .run(phase, at, JSON.stringify(phases), at, id, from).changes;
    if (changed === 0) throw new ApiError(409, "migration_commit_conflict", "Migration commit moved to another phase concurrently");
  } catch (error) {
    if (isInFlightConstraint(error)) throw inFlightError();
    throw error;
  }
}

function persist(db: Database, id: string, phase: string, phases: MigrationCommitPhaseEntry[], result: MigrationCommitResult, error: { code: string; message: string } | undefined, at: string): void {
  db.query("UPDATE migration_commits SET phase=?, phases_json=?, receipt_json=?, updated_at=? WHERE commit_id=?")
    .run(phase, JSON.stringify(phases), JSON.stringify({ result, ...(error === undefined ? {} : { error }) }), at, id);
}

/**
 * Прогон саги с фазы `from` до `complete` или до первого отказа.
 *
 * Отказ фазы **не откатывает** предыдущие: строка встаёт в `needs-<фаза>`, причина уезжает в
 * журнал и в квитанцию, ответ ручки остаётся `200`/`201` (провал фазы — это состояние саги, а не
 * ошибка HTTP-запроса; иначе координатор не смог бы прочитать, где именно она встала).
 */
export async function driveCommit(context: MigrationCommitContext, id: string, from: MigrationCommitPhase): Promise<MigrationCommitRow> {
  const db = context.db;
  let row = requireCommitRow(db, id);
  const request = parse<MigrationCommitRequest>(row.request_json, {} as MigrationCommitRequest);
  const phases = parse<MigrationCommitPhaseEntry[]>(row.phases_json, []);
  const stored = parse<{ result?: MigrationCommitResult }>(row.receipt_json, {});
  const result: MigrationCommitResult = stored.result ?? {};
  const start = MIGRATION_COMMIT_PHASES.indexOf(from);
  let previous = row.phase;
  for (let index = start; index < MIGRATION_COMMIT_PHASES.length; index += 1) {
    const phase = MIGRATION_COMMIT_PHASES[index]!;
    const at = now();
    enterPhase(db, id, phase, previous, phases, at);
    previous = phase;
    const entry = phases[phases.length - 1]!;
    try {
      const outcome = await PHASE_RUNNERS[phase](context, request, result);
      entry.endedAt = now();
      entry.status = outcome.skipped ? "skipped" : "done";
      if (outcome.idempotentReplay) entry.idempotentReplay = true;
      if (outcome.detail !== undefined) entry.detail = outcome.detail;
      persist(db, id, phase, phases, result, undefined, entry.endedAt);
    } catch (error) {
      const failure = error instanceof ApiError
        ? { code: error.code, message: error.message }
        : { code: "phase_failed", message: error instanceof Error ? error.message : String(error) };
      entry.endedAt = now();
      entry.status = "failed";
      entry.error = failure;
      persist(db, id, needsOf(phase), phases, result, failure, entry.endedAt);
      return requireCommitRow(db, id);
    }
  }
  persist(db, id, "complete", phases, result, undefined, now());
  row = requireCommitRow(db, id);
  writeAuditEvent(db, {
    actorId: context.actor.userId, action: "migration.commit.completed", subjectType: "component", subjectId: row.component_id,
    detail: { commitId: row.commit_id, ...(result.promote ? { version: result.promote.version } : {}), ...(result.gallery ? { galleryRev: result.gallery.afterRev } : {}), regressionMode: result.regression?.mode ?? "full" },
  });
  return row;
}

/**
 * Создание саги. Идемпотентность — по `(component_id, idempotency_key)`: повтор с тем же ключом
 * возвращает **существующую** строку, не двигая её (`cached: true`), и никаких мутаций не делает.
 */
export function createCommit(db: Database, request: MigrationCommitRequest, meta: { designSystem: string; ownerId: string }): { row: MigrationCommitRow; cached: boolean } {
  const existing = db.query("SELECT * FROM migration_commits WHERE component_id=? AND idempotency_key=?")
    .get(request.componentId, request.idempotencyKey) as MigrationCommitRow | null;
  if (existing) return { row: existing, cached: true };
  const id = commitId();
  const at = now();
  try {
    db.query(`INSERT INTO migration_commits
      (commit_id,component_id,candidate_id,design_system,gallery_prototype_id,phase,phases_json,request_json,receipt_json,
       idempotency_key,owner_id,phase_started_at,created_at,updated_at)
      VALUES (?,?,?,?,?,'preflight','[]',?,NULL,?,?,?,?,?)`)
      .run(id, request.componentId, request.candidateId ?? null, meta.designSystem, request.gallery?.prototypeId ?? null,
        JSON.stringify(request), request.idempotencyKey, meta.ownerId, at, at, at);
  } catch (error) {
    if (isInFlightConstraint(error)) throw inFlightError(inFlightCommit(db, request.componentId));
    // Гонка двух одинаковых ключей: второй проиграл `UNIQUE (component_id, idempotency_key)` —
    // это тот же идемпотентный повтор, просто увиденный позже.
    if (isIdempotencyConstraint(error)) {
      const row = db.query("SELECT * FROM migration_commits WHERE component_id=? AND idempotency_key=?")
        .get(request.componentId, request.idempotencyKey) as MigrationCommitRow | null;
      if (row) return { row, cached: true };
    }
    throw error;
  }
  return { row: requireCommitRow(db, id), cached: false };
}

/** `advance`: продолжение саги из `needs-<фаза>` с той же фазы. Из активной фазы — 409. */
export async function advanceCommit(context: MigrationCommitContext, id: string): Promise<MigrationCommitRow> {
  const row = requireCommitRow(context.db, id);
  const phase = phaseOfNeeds(row.phase);
  if (phase === null) {
    if (isActivePhase(row.phase)) throw inFlightError(row);
    throw new ApiError(409, "migration_commit_not_resumable", `Migration commit is ${row.phase}; only needs-* states can be advanced`);
  }
  const other = inFlightCommit(context.db, row.component_id);
  if (other) throw inFlightError(other);
  return driveCommit(context, id, phase);
}

/** `cancel`: выход из любого `needs-*` в терминальный `cancelled` (§1.3, раунд 2 N10). */
export function cancelCommit(db: Database, id: string, reason?: string): MigrationCommitRow {
  const row = requireCommitRow(db, id);
  if (row.phase === "cancelled") return row;
  if (phaseOfNeeds(row.phase) === null) {
    if (isActivePhase(row.phase)) throw inFlightError(row);
    throw new ApiError(409, "migration_commit_not_cancellable", `Migration commit is ${row.phase}; only needs-* states can be cancelled`);
  }
  const at = now();
  const phases = parse<MigrationCommitPhaseEntry[]>(row.phases_json, []);
  const stored = parse<{ result?: MigrationCommitResult; error?: { code: string; message: string } }>(row.receipt_json, {});
  db.query("UPDATE migration_commits SET phase='cancelled', phases_json=?, receipt_json=?, updated_at=? WHERE commit_id=? AND phase=?")
    .run(JSON.stringify(phases), JSON.stringify({ ...stored, error: { code: "cancelled", message: reason ?? `Cancelled from ${row.phase}` } }), at, id, row.phase);
  return requireCommitRow(db, id);
}

// -------------------------------------------------------------------- dry-run

export interface MigrationCommitPlan {
  dryRun: true;
  componentId: string;
  designSystem: string;
  galleryPrototypeId: string | null;
  phases: MigrationCommitPhase[];
  regressionMode: RegressionMode;
  /** Что бы записала сага, если бы её запустили. Ровно этот список — предмет ревью человеком. */
  mutations: { phase: MigrationCommitPhase; kind: string; target: string; description: string }[];
  preflight: { ok: boolean; detail?: unknown; error?: { code: string; message: string } };
  /** План импакт-съёмки на **текущей** голове галереи (после сохранения он пересчитывается). */
  regressionPreview: SnapPlan | null;
}

/**
 * Dry-run (§W4): ничего не пишет и ничего не ставит в очередь. Префлайт исполняется по-настоящему
 * (он read-only), остальные фазы описываются намерениями — исполнить их «понарошку» нельзя:
 * `gallery-save` без promote смотрел бы на несуществующую версию.
 */
export async function planCommit(context: MigrationCommitContext, request: MigrationCommitRequest, designSystem: string): Promise<MigrationCommitPlan> {
  const result: MigrationCommitResult = {};
  let preflight: MigrationCommitPlan["preflight"];
  try { preflight = { ok: true, detail: (await runPreflight(context, request, result)).detail }; }
  catch (error) {
    preflight = error instanceof ApiError
      ? { ok: false, error: { code: error.code, message: error.message } }
      : { ok: false, error: { code: "phase_failed", message: error instanceof Error ? error.message : String(error) } };
  }
  const mutations: MigrationCommitPlan["mutations"] = [
    { phase: "promote", kind: "component.promote", target: request.componentId, description: `Promote head rev ${request.baseRev} to a new active version` },
  ];
  if (request.gallery) {
    mutations.push({ phase: "gallery-save", kind: "prototype.save", target: request.gallery.prototypeId, description: "Save a new gallery head revision with the merged screen fragment" });
  }
  let regressionPreview: SnapPlan | null = null;
  if (request.gallery && impactedSnapEnabled() && preflight.ok) {
    try {
      regressionPreview = buildSnapPlan(context.db, {
        prototypeId: request.gallery.prototypeId,
        viewport: request.gallery.viewport ?? { width: 390, height: 844 },
        dsf: request.gallery.deviceScaleFactor ?? 1,
        theme: request.gallery.theme ?? "light",
        ...(request.gallery.readiness === "barrier" ? { readinessPolicy: barrierAwareReadinessPolicy("gallery") } : {}),
      });
    } catch { regressionPreview = null; }
  }
  return {
    dryRun: true,
    componentId: request.componentId,
    designSystem,
    galleryPrototypeId: request.gallery?.prototypeId ?? null,
    phases: [...MIGRATION_COMMIT_PHASES],
    regressionMode: regressionModeOf(request),
    mutations,
    preflight,
    regressionPreview,
  };
}
