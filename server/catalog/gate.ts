/**
 * Гейт переиспользования (план 2026-07-31 §3.5, спека §4/§9) — общая функция для **всех**
 * путей создания активного компонента. Потребители: `POST /api/components`
 * (`server/routes/components.ts`) и импортёр бандла (`server/bundle/importer.ts`, T11).
 *
 * Здесь нет ни одной HTTP-специфики (`Request`/`Response`/маршрутизации): отказ выражается
 * исключением `ReuseGateRejection`, а вызывающий сам решает, во что его превратить.
 *
 * **Разделение на два шага обязательно.**
 *
 * 1. `stageAndExtract()` — **async**: одноразовый staging-модуль + извлечение определения.
 *    Результат извлечения возвращается наружу целиком, чтобы вызывающий мог переиспользовать
 *    его дальше: импортёр иначе платит второй subprocess-спавн (таймаут 10 с) на каждый
 *    компонент бандла и удваивает время импорта сотни компонентов (план §3.7, A7).
 * 2. `matchAndDecide()` — **строго синхронная**: сборка корпуса → матчинг → решение → создание
 *    и аудит одной `db.transaction`. Внутри не должно быть **ни одного** `await`: при
 *    async-callback bun:sqlite молча коммитит транзакцию на первом await, и отката не
 *    происходит (план §1.2, замер ревьюера; регресс-тест — `server/reuse-gate.test.ts`).
 *    Именно поэтому и `collectCorpus`, и `ReuseDecisionRepo.record`, и
 *    `ComponentFingerprintRepo` синхронны по построению.
 *
 * Пересчёт кандидатов происходит **внутри** той же транзакции, что и вставка компонента:
 * это закрывает TOCTOU между конкурентными POST (план §1.1, B4) и делает невозможным доверие
 * к присланным вызывающим кандидатам — сервер их не читает вовсе (спека §4).
 */

import type { Database } from "bun:sqlite";
import { z } from "zod";
import { withStagedSource } from "../components/pipeline";
import type { DefinitionMeta } from "../components/types";
import { ComponentFingerprintRepo, sourceSha256 } from "../repos/componentFingerprints";
import {
  ReuseDecisionRepo,
  type ReuseArtifactKind,
  type ReuseDecisionCandidate,
  type ReuseDecisionKind,
  type ReuseGateMode,
} from "../repos/reuseDecisions";
import { collectCorpus } from "./corpus";
import { sourceShingles } from "./fingerprint";
import { matchCandidates, type CorpusCandidate, type MatchCandidate, type ProposedArtifact } from "./matcher";
import { CALIBRATED_POLICY, type MatchPolicy } from "./policy";

export type { ReuseGateMode } from "../repos/reuseDecisions";

// ───────────────────────────── режим гейта ─────────────────────────────

/**
 * Дефолт — `enforce` **в коде**. `REUSE_GATE` читается ровно один раз, на входе процесса
 * (`startServer`), и дальше едет параметром: иначе тесты, живущие в одном процессе `bun test`,
 * мутировали бы глобальный env друг другу (план §3.5).
 */
export const DEFAULT_REUSE_GATE_MODE: ReuseGateMode = "enforce";

export function resolveReuseGateMode(value: string | undefined): ReuseGateMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "shadow") return "shadow";
  if (normalized === undefined || normalized === "" || normalized === "enforce") return DEFAULT_REUSE_GATE_MODE;
  throw new Error(`REUSE_GATE must be "enforce" or "shadow" (received ${JSON.stringify(value)})`);
}

// ───────────────────────────── override ─────────────────────────────

/**
 * Ключ кандидата в `overrideTemplate`/`candidateKeys`. Идентичность каталога — пара
 * `(designSystem, id)`, поэтому голого id недостаточно: один и тот же id живёт в разных
 * системах.
 */
export const candidateKey = (candidate: { designSystem: string; id: string }): string =>
  `component:${candidate.designSystem}:${candidate.id}`;

/**
 * Спека §4. `reason` — 20..500 **после** trim; `catalogRevision` обязан совпасть с текущей
 * ревизией; `candidateKeys` обязаны покрыть **все** сегодняшние blocking-ключи, пересчитанные
 * сервером. Присланные вызывающим score/кандидаты сервер игнорирует по построению — их просто
 * негде передать.
 */
export const reuseOverrideSchema = z.strictObject({
  catalogRevision: z.string().min(1).max(128),
  candidateKeys: z.array(z.string().min(1).max(256)).min(1).max(64),
  reason: z.string().trim().min(20).max(500),
});
export type ReuseOverride = z.infer<typeof reuseOverrideSchema>;

// ───────────────────────────── отказы гейта ─────────────────────────────

export type ReuseRejectionCode = "component_reuse_required" | "catalog_changed" | "canonical_role_conflict";

/** Всё, что нужно, чтобы записать `blocked`-аудит **снаружи** транзакции (best-effort). */
export interface BlockedAttempt {
  actorId: string;
  artifactKind: ReuseArtifactKind;
  artifactId: string;
  designSystem: string;
  sourceOrDocHash: string;
  catalogRevision: string;
  policyVersion: number;
  gateMode: ReuseGateMode;
  intent: string | null;
  candidates: ReuseDecisionCandidate[];
  /** Почему заблокировано: код отказа плюс, для роли, перечень конфликтующих слагов. */
  reason: string;
}

/**
 * Терминальный отказ гейта. Бросается **изнутри** `db.transaction`, поэтому откат гарантирован:
 * ни строки компонента, ни ревизии, ни durable-модуля не остаётся. Аудит `blocked` пишет
 * вызывающий, в `catch` снаружи (спека §5: «best-effort outside the failed create transaction»).
 */
export class ReuseGateRejection extends Error {
  constructor(
    readonly code: ReuseRejectionCode,
    message: string,
    /** Тело 409 без `decisionId`/`repeatedAttempts` — их знает только внешний аудит. */
    readonly payload: ReuseRejectionPayload,
    readonly attempt: BlockedAttempt,
  ) { super(message); this.name = "ReuseGateRejection"; }
}

export interface ReuseRejectionPayload {
  catalogRevision: string;
  policyVersion: number;
  candidates: RejectionCandidate[];
  retryable: false;
  resolution: "reuse" | "escalate";
  nextSteps: string[];
  overrideTemplate: { catalogRevision: string; candidateKeys: string[] };
  /** Только у `canonical_role_conflict`: занятые слаги ролей. */
  conflictingRoles?: string[];
}

export interface RejectionCandidate {
  kind: "component";
  key: string;
  id: string;
  name: string;
  designSystem: string;
  version: number;
  draft: boolean;
  description: string;
  atomicLevel?: string;
  scope?: string;
  canonicalFor: string[];
  replacement?: string;
  deprecated: boolean;
  recommendable: boolean;
  headUsageCount: number;
  score: number;
  blocking: boolean;
  reasons: string[];
  /** Имена пропов, без схем и без значений (§3.6). */
  propsDelta?: { added: string[]; removed: string[]; typeChanged: string[] };
}

// ───────────────────────────── шаг 1: staging + извлечение ─────────────────────────────

/**
 * Извлечение над одноразовым staging-модулем `<dataDir>/.staging/<uuid>/<name>.tsx`.
 * Каталог удаляется во всех ветках — успех, отказ, исключение, таймаут (`withStagedSource`).
 *
 * Результат `extract` возвращается **как есть**: он обязан быть переиспользуемым (см. шапку).
 * Ошибка извлечения пролетает наружу и остаётся 422 — матчинг на частичной мете не
 * запускается вовсе (спека §9).
 */
export function stageAndExtract<T>(dataDir: string, name: string, source: string, extract: (path: string) => Promise<T>): Promise<T> {
  return withStagedSource(dataDir, name, source, extract);
}

// ───────────────────────────── шаг 2: матчинг и решение ─────────────────────────────

export interface GateActor { userId: string; isAdmin: boolean }

export interface GateInput {
  mode: ReuseGateMode;
  actor: GateActor;
  /** Идентификация вызывателя для `intent_missing`: без неё непонятно, кого чинить (§3.5.2). */
  userAgent?: string | null;
  designSystem: string;
  /** Предложенный id: для `blocked` компонента с таким id в базе нет и не будет. */
  artifactId: string;
  name: string;
  source: string;
  /** Мета из `stageAndExtract` — матчинг на частичной мете запрещён. */
  meta: DefinitionMeta;
  /** Действующий intent: в shadow может быть синтезирован из имени. */
  intent: string;
  /** Прислал ли intent сам вызывающий (иначе — `intent_missing`). */
  intentProvided: boolean;
  override?: ReuseOverride;
  /** Инъекция политики; по умолчанию — калиброванная прод-политика. */
  policy?: MatchPolicy;
  /** Размер выдачи кандидатов в теле отказа. На blocking-набор не влияет. */
  limit?: number;
}

export interface GateOutcome<T> {
  created: T;
  decision: Extract<ReuseDecisionKind, "accepted_no_match" | "would_block" | "force_new">;
  decisionId: string;
  catalogRevision: string;
  policyVersion: number;
  /** Предупреждения для ответа: shadow-блокировка и отсутствующий intent. */
  warnings: string[];
}

const auditCandidate = (candidate: MatchCandidate): ReuseDecisionCandidate => ({
  id: candidate.id,
  score: candidate.score,
  blocking: candidate.blocking,
  reasons: candidate.reasons,
  ...(candidate.propsDelta === undefined ? {} : { propsDelta: candidate.propsDelta }),
});

const rejectionCandidate = (candidate: MatchCandidate): RejectionCandidate => ({
  kind: candidate.kind,
  key: candidateKey(candidate),
  id: candidate.id,
  name: candidate.name,
  designSystem: candidate.designSystem,
  version: candidate.version,
  draft: candidate.draft,
  description: candidate.description,
  ...(candidate.atomicLevel === undefined ? {} : { atomicLevel: candidate.atomicLevel }),
  ...(candidate.scope === undefined ? {} : { scope: candidate.scope }),
  canonicalFor: candidate.canonicalFor,
  ...(candidate.replacement === undefined ? {} : { replacement: candidate.replacement }),
  deprecated: candidate.deprecated,
  recommendable: candidate.recommendable,
  headUsageCount: candidate.headUsageCount,
  score: candidate.score,
  blocking: candidate.blocking,
  reasons: candidate.reasons,
  ...(candidate.propsDelta === undefined ? {} : { propsDelta: candidate.propsDelta }),
});

/**
 * Правило `resolution` (план §3.5, A10) — детерминированное и считается **сервером**:
 * `"reuse"`, если хотя бы один blocking-кандидат ничего не теряет по пропам (пустые `removed`
 * и `typeChanged`), то есть способен выразить всё, что нужно вызывающему. Иначе — `"escalate"`:
 * ни один кандидат не покрывает предложение, и решение уходит админу.
 */
function resolutionFor(blocking: readonly MatchCandidate[]): "reuse" | "escalate" {
  return blocking.some((candidate) =>
    (candidate.propsDelta?.removed.length ?? 0) === 0 && (candidate.propsDelta?.typeChanged.length ?? 0) === 0)
    ? "reuse" : "escalate";
}

/** Терминальные инструкции: агент обязан выйти из 409, а не ретраить (план §6, риск «залипает»). */
function nextStepsFor(resolution: "reuse" | "escalate", blocking: readonly MatchCandidate[], decisionHint: string): string[] {
  const best = blocking[0];
  const steps: string[] = [];
  if (resolution === "reuse" && best !== undefined) {
    steps.push(`Reuse ${best.id} (${best.name}) from design system ${best.designSystem} instead of creating a duplicate`);
    steps.push(`Fetch its exact definition: GET /api/components/${best.id}${best.draft ? "/draft" : `/versions/${best.version}`}`);
    steps.push(`If the existing component lacks behaviour you need, extend it with a new revision: PUT /api/components/${best.id}`);
  } else {
    steps.push("No listed candidate can express the proposal; do not create a near-duplicate silently");
    steps.push(`Escalate to an administrator with ${decisionHint} and the candidate keys above`);
  }
  steps.push("Do not retry this request: the decision is deterministic (retryable: false)");
  return steps;
}

/** Предложение для матчера. Собирается **только** из извлечённой меты, не из тела запроса. */
type ProposalInput = { designSystem: string; artifactId: string; name: string; intent: string; source: string; meta: DefinitionMeta };
function proposedFrom(input: ProposalInput): ProposedArtifact {
  const meta = input.meta;
  return {
    kind: "component",
    designSystem: input.designSystem,
    id: input.artifactId,
    name: input.name,
    intent: input.intent,
    description: meta.description,
    ...(meta.atomicLevel === undefined ? {} : { atomicLevel: meta.atomicLevel }),
    ...(meta.scope === undefined ? {} : { scope: meta.scope }),
    canonicalFor: meta.canonicalFor ?? [],
    meta: { propsJsonSchema: meta.propsJsonSchema, events: meta.events, slots: meta.slots },
    source: input.source,
  };
}

/**
 * Занятые канонические роли внутри системы (спека §4, план §3.5). Считается по **корпусу**, а
 * не по blocking-набору: deprecated-кандидат с активной заменой blocking не даёт, но роль всё
 * ещё занимает — забрать её молча нельзя.
 */
export function canonicalRoleConflicts(
  corpus: readonly CorpusCandidate[],
  designSystem: string,
  roles: readonly string[],
  exclude: { designSystem: string; id: string },
): { candidate: CorpusCandidate; roles: string[] }[] {
  if (roles.length === 0) return [];
  const wanted = new Set(roles);
  const conflicts: { candidate: CorpusCandidate; roles: string[] }[] = [];
  for (const candidate of corpus) {
    if (candidate.designSystem !== designSystem) continue;
    if (candidate.designSystem === exclude.designSystem && candidate.id === exclude.id) continue;
    const overlap = [...new Set(candidate.canonicalFor ?? [])].filter((role) => wanted.has(role)).sort();
    if (overlap.length) conflicts.push({ candidate, roles: overlap });
  }
  return conflicts;
}

/**
 * Write-through кэша шинглов для только что записанной ревизии (план §3.6, пункт 5 T5b).
 * Кэш content-addressed, поэтому корректность от него не зависит — но без записи на create и
 * на PUT-save первый матчинг против свежего драфта платил бы за пересчёт, а сам факт
 * «драфт участвует в корпусе» проверялся бы только косвенно.
 */
export function cacheSourceShingles(db: Database, componentId: string, rev: number, source: string): void {
  new ComponentFingerprintRepo(db).put(componentId, rev, sourceSha256(source), [...sourceShingles(source)]);
}

/**
 * Синтез intent из имени для shadow-фазы: обязательный `intent` не может приехать в прод
 * раньше, чем клиенты его научатся слать (план §1.1, B3′). Это **сигнал**, а не контракт:
 * `reuseIntentSchema` к нему не применяется.
 */
export const synthesizeIntent = (name: string): string =>
  name.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2").replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2").replace(/[-_]+/g, " ").trim().toLowerCase();

/**
 * **Строго синхронная** функция. Ни одного `await` — см. шапку модуля.
 *
 * `create` вызывается внутри той же транзакции, что и матчинг с аудитом: «create + аудит
 * атомарны» (спека §5) и TOCTOU закрыт. Любое исключение — включая `ReuseGateRejection` и
 * падение самого матчера — откатывает транзакцию целиком, поэтому гейт физически не может
 * «fail open» (спека §9).
 */
export function matchAndDecide<T>(db: Database, input: GateInput, create: () => T): GateOutcome<T> {
  const policy = input.policy ?? CALIBRATED_POLICY;
  const decisions = new ReuseDecisionRepo(db);
  const sourceHash = sourceSha256(input.source);
  const exclude = { designSystem: input.designSystem, id: input.artifactId };

  return db.transaction((): GateOutcome<T> => {
    const corpus = collectCorpus(db, input.designSystem);
    const matched = matchCandidates(corpus.candidates, proposedFrom(input), policy, {
      limit: input.limit ?? 8,
      // D4: сам оцениваемый артефакт из корпуса исключается — иначе повторное создание под тем
      // же id (после отката) блокировалось бы собственной осиротевшей ревизией.
      exclude,
    });
    const blocking = matched.blocking;
    const roleConflicts = canonicalRoleConflicts(corpus.candidates, input.designSystem, input.meta.canonicalFor ?? [], exclude);

    const overrideKeys = new Set(input.override?.candidateKeys ?? []);
    const requiredKeys = [...new Set([
      ...blocking.map(candidateKey),
      ...roleConflicts.map((conflict) => candidateKey(conflict.candidate)),
    ])].sort();

    const attempt = (reason: string): BlockedAttempt => ({
      actorId: input.actor.userId,
      artifactKind: "component",
      artifactId: input.artifactId,
      designSystem: input.designSystem,
      sourceOrDocHash: sourceHash,
      catalogRevision: corpus.catalogRevision,
      policyVersion: matched.policyVersion,
      gateMode: input.mode,
      intent: input.intentProvided ? input.intent : null,
      candidates: matched.candidates.map(auditCandidate),
      reason,
    });
    const payload = (extra: Partial<ReuseRejectionPayload> = {}): ReuseRejectionPayload => {
      const resolution = resolutionFor(blocking);
      return {
        catalogRevision: corpus.catalogRevision,
        policyVersion: matched.policyVersion,
        candidates: matched.candidates.map(rejectionCandidate),
        retryable: false,
        resolution,
        nextSteps: nextStepsFor(resolution, blocking, "the decisionId of this response"),
        overrideTemplate: { catalogRevision: corpus.catalogRevision, candidateKeys: requiredKeys },
        ...extra,
      };
    };

    // Override валидируется только когда есть что перекрывать: иначе безобидный лишний
    // `reuseOverride` превращал бы обычное создание в 409 на чужой публикации.
    const contested = blocking.length > 0 || roleConflicts.length > 0;
    let overrideAccepted = false;
    if (contested && input.override !== undefined) {
      if (input.override.catalogRevision !== corpus.catalogRevision) {
        throw new ReuseGateRejection("catalog_changed", "Catalog revision changed since the override was prepared", payload(), attempt("catalog_changed"));
      }
      overrideAccepted = requiredKeys.every((key) => overrideKeys.has(key));
    }

    // Роль проверяется до общего blocking: «эта роль уже занята» — более точный ответ, чем
    // «похоже на существующий компонент», и обходится тем же админским override.
    if (roleConflicts.length > 0 && !overrideAccepted) {
      const roles = [...new Set(roleConflicts.flatMap((conflict) => conflict.roles))].sort();
      const owners = roleConflicts.map((conflict) => `${conflict.candidate.id}`).sort();
      throw new ReuseGateRejection(
        "canonical_role_conflict",
        `Canonical role(s) ${roles.join(", ")} are already owned in ${input.designSystem} by ${owners.join(", ")}`,
        payload({ conflictingRoles: roles }),
        attempt(`canonical_role_conflict:${roles.join(",")}`),
      );
    }

    if (blocking.length > 0 && !overrideAccepted && input.mode === "enforce") {
      throw new ReuseGateRejection(
        "component_reuse_required",
        "An existing component already covers this proposal; reuse it or request an administrator override",
        payload(),
        attempt("component_reuse_required"),
      );
    }

    // Дальше — только ветки создания. Компонент создаётся **в этой же транзакции**, и вместе с
    // ним ложится аудит-строка: «accepted create and audit row are atomic» (спека §10).
    const created = create();
    const warnings: string[] = [];

    // `intent_missing` — отдельная строка, а не подмена решения: иначе shadow-создание с
    // совпадением потеряло бы `would_block`, то есть ключевой выход shadow-фазы (§1.2, A3).
    if (!input.intentProvided) {
      decisions.record({
        ...attempt("intent_missing"),
        decision: "intent_missing",
        intent: null,
        reason: `intent_missing actor=${input.actor.userId} user-agent=${(input.userAgent ?? "").slice(0, 200) || "unknown"}`,
      });
      warnings.push("intent is missing and was synthesized from the component name; it becomes mandatory when the reuse gate is enforced");
    }

    let decision: GateOutcome<T>["decision"];
    let reason: string | null = null;
    if (overrideAccepted) {
      decision = "force_new";
      reason = input.override!.reason.trim();
    } else if (blocking.length > 0) {
      // enforce с blocking сюда не доходит (выброшен выше) — это shadow.
      decision = "would_block";
      reason = "shadow: created despite blocking candidates";
      warnings.push(`Reuse gate is in shadow mode: ${blocking.length} blocking candidate(s) would have rejected this create in enforce mode (${blocking.map((candidate) => candidate.id).join(", ")})`);
    } else {
      decision = "accepted_no_match";
    }

    const record = decisions.record({ ...attempt(decision), decision, reason });
    return {
      created,
      decision,
      decisionId: record.id,
      catalogRevision: corpus.catalogRevision,
      policyVersion: matched.policyVersion,
      warnings,
    };
  })();
}

/**
 * `blocked`-аудит: **снаружи** транзакции и best-effort (спека §5). Отказ записи не должен
 * превращать корректный 409 в 500, поэтому исключение гасится, а `repeatedAttempts` уходит
 * `null` — именно `null`, а не `0`: «ноль попыток» и «счётчик недоступен» — разные факты
 * (план §3.5).
 */
export function recordBlockedAttempt(db: Database, attempt: BlockedAttempt): { decisionId: string; repeatedAttempts: number } | null {
  try {
    const repo = new ReuseDecisionRepo(db);
    const record = repo.record({ ...attempt, decision: "blocked", reason: attempt.reason });
    // Считается **после** вставки: текущая попытка входит в счётчик.
    return { decisionId: record.id, repeatedAttempts: repo.repeatedAttempts(attempt.actorId, attempt.artifactId) };
  } catch (error) {
    console.error("reuse gate: blocked-decision audit write failed", error);
    return null;
  }
}

/**
 * Warn-only проверка дубликата на публикации (отступление D4). Она **не блокирует** ничего:
 * publish — это update, а гейт стоит на create. Смысл — закрыть наблюдаемость обхода
 * «PUT → publish».
 *
 * Исключение самого артефакта `(designSystem, id)` из корпуса обязательно: без него каждая
 * обычная перепубликация печатала бы «дубликат самого себя» и утопила бы бэкфилл проекта 3 на
 * 115 компонентах.
 */
export function duplicateWarnings(db: Database, input: { designSystem: string; id: string; name: string; source: string; meta: DefinitionMeta; policy?: MatchPolicy }): string[] {
  const policy = input.policy ?? CALIBRATED_POLICY;
  const corpus = collectCorpus(db, input.designSystem);
  const matched = matchCandidates(corpus.candidates, proposedFrom({
    designSystem: input.designSystem, artifactId: input.id, name: input.name,
    source: input.source, meta: input.meta, intent: input.meta.description,
  }), policy, { limit: 3, exclude: { designSystem: input.designSystem, id: input.id } });
  if (matched.blocking.length === 0) return [];
  return [`Published component looks like a duplicate of ${matched.blocking.map((candidate) => `${candidate.id} (score ${candidate.score})`).join(", ")}; reuse the existing component or document why this one differs`];
}

/** Кандидат-конфликт роли на публикации: score здесь не считается — блокирует сама роль. */
const corpusRejectionCandidate = (candidate: CorpusCandidate): RejectionCandidate => ({
  kind: "component",
  key: candidateKey(candidate),
  id: candidate.id,
  name: candidate.name,
  designSystem: candidate.designSystem,
  version: candidate.version,
  draft: candidate.draft,
  description: candidate.description,
  ...(candidate.atomicLevel === undefined ? {} : { atomicLevel: candidate.atomicLevel }),
  ...(candidate.scope === undefined ? {} : { scope: candidate.scope }),
  canonicalFor: [...(candidate.canonicalFor ?? [])].sort(),
  ...(candidate.replacement === undefined ? {} : { replacement: candidate.replacement }),
  deprecated: candidate.deprecated,
  recommendable: !candidate.deprecated,
  headUsageCount: candidate.headUsageCount,
  score: 1,
  blocking: true,
  reasons: [`same canonical role: ${[...(candidate.canonicalFor ?? [])].sort().join(", ")}`],
});

/**
 * Уникальность канонической роли на публикации (план §3.5: проверяется на create **и** на
 * publish). Publish — это update, и общий гейт создания на нём не стоит (D4), но роль обязана
 * оставаться уникальной: иначе смена `canonicalFor` в новой ревизии тихо забирала бы чужую роль.
 *
 * Синхронная и не создаёт ничего сама, поэтому вызывается **до** `repo.stage`: после 409 не
 * должно оставаться ни staging-публикации, ни материализованного модуля.
 */
export function assertPublishRoleAvailable(db: Database, input: {
  designSystem: string; id: string; canonicalFor: readonly string[];
  actor: GateActor; mode: ReuseGateMode; sourceHash: string; intent?: string | null;
  override?: ReuseOverride;
}): void {
  if (input.canonicalFor.length === 0) return;
  const corpus = collectCorpus(db, input.designSystem);
  const conflicts = canonicalRoleConflicts(corpus.candidates, input.designSystem, input.canonicalFor, { designSystem: input.designSystem, id: input.id });
  if (conflicts.length === 0) return;

  const requiredKeys = [...new Set(conflicts.map((conflict) => candidateKey(conflict.candidate)))].sort();
  if (input.override !== undefined && input.actor.isAdmin) {
    if (input.override.catalogRevision !== corpus.catalogRevision) {
      throw new ReuseGateRejection("catalog_changed", "Catalog revision changed since the override was prepared", {
        catalogRevision: corpus.catalogRevision, policyVersion: CALIBRATED_POLICY.policyVersion,
        candidates: conflicts.map((conflict) => corpusRejectionCandidate(conflict.candidate)),
        retryable: false, resolution: "escalate",
        nextSteps: ["Re-read the current catalogRevision and prepare the override again"],
        overrideTemplate: { catalogRevision: corpus.catalogRevision, candidateKeys: requiredKeys },
      }, {
        actorId: input.actor.userId, artifactKind: "component", artifactId: input.id,
        designSystem: input.designSystem, sourceOrDocHash: input.sourceHash,
        catalogRevision: corpus.catalogRevision, policyVersion: CALIBRATED_POLICY.policyVersion,
        gateMode: input.mode, intent: input.intent ?? null,
        candidates: conflicts.map((conflict) => ({ id: conflict.candidate.id, score: 1, blocking: true, reasons: [`same canonical role: ${conflict.roles.join(", ")}`] })),
        reason: "catalog_changed",
      });
    }
    const acknowledged = new Set(input.override.candidateKeys);
    if (requiredKeys.every((key) => acknowledged.has(key))) return;
  }

  const roles = [...new Set(conflicts.flatMap((conflict) => conflict.roles))].sort();
  throw new ReuseGateRejection(
    "canonical_role_conflict",
    `Canonical role(s) ${roles.join(", ")} are already owned in ${input.designSystem} by ${conflicts.map((conflict) => conflict.candidate.id).sort().join(", ")}`,
    {
      catalogRevision: corpus.catalogRevision, policyVersion: CALIBRATED_POLICY.policyVersion,
      candidates: conflicts.map((conflict) => corpusRejectionCandidate(conflict.candidate)),
      retryable: false, resolution: "escalate",
      nextSteps: [
        `Canonical roles are unique per design system: ${roles.join(", ")} already belong to ${conflicts.map((conflict) => conflict.candidate.id).sort().join(", ")}`,
        "Drop canonicalFor from this component, or ask an administrator for a reuseOverride",
        "Do not retry this request: the decision is deterministic (retryable: false)",
      ],
      overrideTemplate: { catalogRevision: corpus.catalogRevision, candidateKeys: requiredKeys },
      conflictingRoles: roles,
    },
    {
      actorId: input.actor.userId, artifactKind: "component", artifactId: input.id,
      designSystem: input.designSystem, sourceOrDocHash: input.sourceHash,
      catalogRevision: corpus.catalogRevision, policyVersion: CALIBRATED_POLICY.policyVersion,
      gateMode: input.mode, intent: input.intent ?? null,
      candidates: conflicts.map((conflict) => ({ id: conflict.candidate.id, score: 1, blocking: true, reasons: [`same canonical role: ${conflict.roles.join(", ")}`] })),
      reason: `canonical_role_conflict:${roles.join(",")}`,
    },
  );
}
