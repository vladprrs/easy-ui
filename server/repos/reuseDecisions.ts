import type { Database } from "bun:sqlite";
import { writeAuditEvent } from "../audit";

/**
 * Репозиторий аудита решений гейта переиспользования (миграция v20, план 2026-07-31 §3.6).
 *
 * Таблица append-only и это enforced триггерами в БД: UPDATE и DELETE выбрасывают
 * `RAISE(ABORT)`. Репозиторий не предоставляет ни update, ни delete — единственный путь,
 * снимающий триггер, это `prune()` ниже (ретенция), и он логирует себя в `audit_events`.
 *
 * Все методы синхронные: `record()` вызывается изнутри `db.transaction(() => …)` гейта, где
 * любой `await` молча коммитит транзакцию bun:sqlite и ломает откат.
 */

export const REUSE_DECISION_TRIGGERS = [
  "catalog_reuse_decisions_no_update",
  "catalog_reuse_decisions_no_delete",
] as const;

export type ReuseGateMode = "shadow" | "enforce";
export type ReuseArtifactKind = "component" | "composition" | "prototype";
/**
 * `would_block` — shadow-режим: совпадение было, но компонент создан. Без него shadow-фаза
 * ненаблюдаема (см. комментарий миграции v20).
 */
export type ReuseDecisionKind =
  | "accepted_no_match" | "blocked" | "would_block" | "force_new" | "intent_missing";

/** Компактная строка кандидата. Имена пропов допустимы, значения/исходники/токены — нет. */
export type ReuseDecisionCandidate = {
  id: string;
  score: number;
  blocking: boolean;
  reasons: string[];
  propsDelta?: { added?: string[]; removed?: string[]; typeChanged?: string[] };
};

export type ReuseDecisionInput = {
  actorId: string;
  artifactKind: ReuseArtifactKind;
  /** Предложенный id — для `blocked`/`would_block` компонента с таким id в базе нет. */
  artifactId: string;
  designSystem: string;
  sourceOrDocHash: string;
  catalogRevision: string;
  /** Без него score невоспроизводим задним числом (§3.3). */
  policyVersion: number;
  gateMode: ReuseGateMode;
  intent?: string | null;
  candidates: ReuseDecisionCandidate[];
  decision: ReuseDecisionKind;
  reason?: string | null;
};

export type ReuseDecision = {
  id: string;
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
  decision: ReuseDecisionKind;
  reason: string | null;
  createdAt: string;
};

type Row = {
  id: string; actor_id: string; artifact_kind: ReuseArtifactKind; artifact_id: string;
  design_system: string; source_or_doc_hash: string; catalog_revision: string;
  policy_version: number; gate_mode: ReuseGateMode; intent: string | null;
  candidates_json: string; decision: ReuseDecisionKind; reason: string | null; created_at: string;
};

/** Повреждённый JSON кандидатов не роняет чтение аудита: запись важнее её деталей. */
function parseCandidates(json: string): ReuseDecisionCandidate[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as ReuseDecisionCandidate[]) : [];
  } catch { return []; }
}

const toDto = (row: Row): ReuseDecision => ({
  id: row.id,
  actorId: row.actor_id,
  artifactKind: row.artifact_kind,
  artifactId: row.artifact_id,
  designSystem: row.design_system,
  sourceOrDocHash: row.source_or_doc_hash,
  catalogRevision: row.catalog_revision,
  policyVersion: row.policy_version,
  gateMode: row.gate_mode,
  intent: row.intent,
  candidates: parseCandidates(row.candidates_json),
  decision: row.decision,
  reason: row.reason,
  createdAt: row.created_at,
});

/** Решения, означающие «совпадение найдено» — база для `repeatedAttempts` (§3.5). */
const ATTEMPT_DECISIONS = ["blocked", "would_block"] as const;

export type ReuseDecisionFilter = {
  actorId?: string;
  artifactId?: string;
  decision?: ReuseDecisionKind | ReuseDecisionKind[];
  gateMode?: ReuseGateMode;
  /** ISO-строка; отдаются записи строго новее. */
  since?: string;
  limit?: number;
};

/** Префикс `reason`, которым гейт помечает конфликт канонической роли (`catalog/gate.ts`). */
export const ROLE_CONFLICT_PREFIX = "canonical_role_conflict:";

/** Общий фильтр окна для всех выборок аудита. */
export type ReuseAuditFilter = {
  /** ISO-строка; отдаются записи строго новее. */
  since?: string;
  designSystem?: string;
  actorId?: string;
  limit?: number;
};

export type ReuseAuditSummary = {
  decisions: number;
  actors: number;
  byDecision: Record<string, number>;
  byGateMode: Record<string, number>;
};

export type ReuseRepeatedAttempt = {
  actorId: string;
  artifactKind: ReuseArtifactKind;
  artifactId: string;
  designSystem: string;
  attempts: number;
  blocked: number;
  wouldBlock: number;
  firstAt: string;
  lastAt: string;
  lastDecisionId: string | null;
  lastReason: string | null;
  candidateIds: string[];
};

export type ReuseRoleConflict = ReuseDecision & { roles: string[] };

export type ReuseWouldBlockReport = {
  total: number;
  actors: number;
  byActor: { actorId: string; count: number }[];
  decisions: ReuseDecision[];
};

export type ReuseUnreviewedArtifact = {
  kind: ReuseArtifactKind;
  id: string;
  name: string;
  designSystem: string;
  createdAt: string;
  /** false означает «создан уже при работающем гейте, но решения нет» — это путь в обход. */
  createdBeforeGate: boolean;
};

export type ReuseUnreviewedReport = { total: number; artifacts: ReuseUnreviewedArtifact[] };

/** Тот же потолок, что у `list()`: аудит читают админ-UI и CLI, а не выгрузка всей таблицы. */
const boundedLimit = (limit?: number): number => Math.max(1, Math.min(limit ?? 100, 1000));

/**
 * Условия окна аудита. Фиксированные условия вызывающего идут первыми — вместе со своими
 * аргументами, поэтому порядок плейсхолдеров совпадает с порядком `args`.
 */
function auditWhere(
  filter: ReuseAuditFilter,
  fixed: string[] = [],
  fixedArgs: (string | number)[] = [],
): { clause: string; args: (string | number)[] } {
  const where = [...fixed];
  const args = [...fixedArgs];
  if (filter.actorId !== undefined) { where.push("actor_id=?"); args.push(filter.actorId); }
  if (filter.designSystem !== undefined) { where.push("design_system=?"); args.push(filter.designSystem); }
  if (filter.since !== undefined) { where.push("created_at>?"); args.push(filter.since); }
  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", args };
}

export class ReuseDecisionRepo {
  constructor(private db: Database) {}

  /** Синхронная вставка: безопасна внутри `db.transaction`. Возвращает id записи для 409. */
  record(input: ReuseDecisionInput): ReuseDecision {
    const id = `reuse_${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    this.db.query(`INSERT INTO catalog_reuse_decisions
      (id,actor_id,artifact_kind,artifact_id,design_system,source_or_doc_hash,catalog_revision,
       policy_version,gate_mode,intent,candidates_json,decision,reason,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, input.actorId, input.artifactKind, input.artifactId, input.designSystem,
      input.sourceOrDocHash, input.catalogRevision, input.policyVersion, input.gateMode,
      input.intent ?? null, JSON.stringify(input.candidates), input.decision,
      input.reason ?? null, createdAt,
    );
    return {
      id, actorId: input.actorId, artifactKind: input.artifactKind, artifactId: input.artifactId,
      designSystem: input.designSystem, sourceOrDocHash: input.sourceOrDocHash,
      catalogRevision: input.catalogRevision, policyVersion: input.policyVersion,
      gateMode: input.gateMode, intent: input.intent ?? null, candidates: input.candidates,
      decision: input.decision, reason: input.reason ?? null, createdAt,
    };
  }

  get(id: string): ReuseDecision | undefined {
    const row = this.db.query("SELECT * FROM catalog_reuse_decisions WHERE id=?").get(id) as Row | null;
    return row ? toDto(row) : undefined;
  }

  list(filter: ReuseDecisionFilter = {}): ReuseDecision[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.actorId !== undefined) { where.push("actor_id=?"); args.push(filter.actorId); }
    if (filter.artifactId !== undefined) { where.push("artifact_id=?"); args.push(filter.artifactId); }
    if (filter.gateMode !== undefined) { where.push("gate_mode=?"); args.push(filter.gateMode); }
    if (filter.since !== undefined) { where.push("created_at>?"); args.push(filter.since); }
    if (filter.decision !== undefined) {
      const kinds = Array.isArray(filter.decision) ? filter.decision : [filter.decision];
      where.push(`decision IN (${kinds.map(() => "?").join(",")})`);
      args.push(...kinds);
    }
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 1000));
    const rows = this.db.query(`SELECT * FROM catalog_reuse_decisions
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC, id DESC LIMIT ?`).all(...args, limit) as Row[];
    return rows.map(toDto);
  }

  /**
   * Сколько раз этот актор уже упирался в blocking по этому артефакту (§3.5, поле
   * `repeatedAttempts` тела 409). Текущее решение считается вызывающим кодом отдельно —
   * метод отвечает ровно на «что уже лежит в таблице».
   */
  repeatedAttempts(actorId: string, artifactId: string): number {
    const row = this.db.query(`SELECT COUNT(*) count FROM catalog_reuse_decisions
      WHERE actor_id=? AND artifact_id=? AND decision IN (${ATTEMPT_DECISIONS.map(() => "?").join(",")})`)
      .get(actorId, artifactId, ...ATTEMPT_DECISIONS) as { count: number };
    return row.count;
  }

  countByDecision(): Record<string, number> {
    const rows = this.db.query("SELECT decision, COUNT(*) count FROM catalog_reuse_decisions GROUP BY decision")
      .all() as { decision: string; count: number }[];
    return Object.fromEntries(rows.map(row => [row.decision, row.count]));
  }

  // --- Выборки админского аудита (§5 спеки, план §4 T10). Только чтение. ---

  /**
   * Общие счётчики окна. Отдельный метод, а не расширение `countByDecision()`: тот вызывается
   * без фильтров из наблюдаемости гейта, и менять его сигнатуру значило бы ломать контракт записи.
   */
  summary(filter: ReuseAuditFilter = {}): ReuseAuditSummary {
    const { clause, args } = auditWhere(filter);
    const byDecision = this.db.query(`SELECT decision, COUNT(*) count FROM catalog_reuse_decisions ${clause} GROUP BY decision`)
      .all(...args) as { decision: string; count: number }[];
    const byGateMode = this.db.query(`SELECT gate_mode gateMode, COUNT(*) count FROM catalog_reuse_decisions ${clause} GROUP BY gate_mode`)
      .all(...args) as { gateMode: string; count: number }[];
    const totals = this.db.query(`SELECT COUNT(*) decisions, COUNT(DISTINCT actor_id) actors FROM catalog_reuse_decisions ${clause}`)
      .get(...args) as { decisions: number; actors: number };
    return {
      decisions: totals.decisions,
      actors: totals.actors,
      byDecision: Object.fromEntries(byDecision.map(row => [row.decision, row.count])),
      byGateMode: Object.fromEntries(byGateMode.map(row => [row.gateMode, row.count])),
    };
  }

  /** Момент, с которого гейт вообще что-то писал: всё, что создано раньше, ревью не проходило. */
  gateActiveSince(): string | null {
    const row = this.db.query("SELECT MIN(created_at) since FROM catalog_reuse_decisions").get() as { since: string | null };
    return row.since;
  }

  /** §5 (a): админские `force_new` — каждая обязана быть атрибутируемой и разобранной. */
  forceNew(filter: ReuseAuditFilter = {}): ReuseDecision[] {
    return this.filtered("force_new", filter);
  }

  /**
   * §5 (b): **повторяющиеся** попытки одного актора по одному артефакту, агрегированные.
   * Одиночная блокировка — норма гейта; сигнал даёт именно повтор (`minAttempts`, по умолчанию 2).
   * Идёт по индексу `(actor_id, created_at)`.
   */
  repeatedBlocked(filter: ReuseAuditFilter & { minAttempts?: number } = {}): ReuseRepeatedAttempt[] {
    const { clause, args } = auditWhere(filter, [`decision IN (${ATTEMPT_DECISIONS.map(() => "?").join(",")})`], [...ATTEMPT_DECISIONS]);
    const minAttempts = Math.max(2, Math.trunc(filter.minAttempts ?? 2));
    const rows = this.db.query(`SELECT actor_id actorId, artifact_id artifactId, artifact_kind artifactKind,
        design_system designSystem, COUNT(*) attempts,
        SUM(CASE WHEN decision='blocked' THEN 1 ELSE 0 END) blocked,
        SUM(CASE WHEN decision='would_block' THEN 1 ELSE 0 END) wouldBlock,
        MIN(created_at) firstAt, MAX(created_at) lastAt
      FROM catalog_reuse_decisions ${clause}
      GROUP BY actor_id, artifact_id, artifact_kind, design_system
      HAVING COUNT(*) >= ?
      ORDER BY attempts DESC, lastAt DESC LIMIT ?`)
      .all(...args, minAttempts, boundedLimit(filter.limit)) as Omit<ReuseRepeatedAttempt, "lastReason" | "lastDecisionId" | "candidateIds">[];
    // Последняя запись группы читается точечно по индексу `(artifact_id)`: агрегат без неё
    // не даёт админу ни причины, ни id решения, на которое ссылается эскалация 409.
    return rows.map((row) => {
      const last = this.db.query(`SELECT id, reason, candidates_json FROM catalog_reuse_decisions
        WHERE artifact_id=? AND actor_id=? AND decision IN (${ATTEMPT_DECISIONS.map(() => "?").join(",")})
        ORDER BY created_at DESC, id DESC LIMIT 1`)
        .get(row.artifactId, row.actorId, ...ATTEMPT_DECISIONS) as { id: string; reason: string | null; candidates_json: string } | null;
      return {
        ...row,
        lastDecisionId: last?.id ?? null,
        lastReason: last?.reason ?? null,
        candidateIds: last ? parseCandidates(last.candidates_json).map(candidate => candidate.id) : [],
      };
    });
  }

  /**
   * §5 (c): конфликты канонической роли. Отдельного значения `decision` для них нет (enum
   * миграции v20 его не знает) — гейт пишет их как `blocked` с префиксом в `reason`
   * (`server/catalog/gate.ts`: `canonical_role_conflict:<роли>`), поэтому выборка идёт по
   * индексу `(decision)` и уточняется префиксом.
   */
  canonicalRoleConflicts(filter: ReuseAuditFilter = {}): ReuseRoleConflict[] {
    const { clause, args } = auditWhere(filter, ["decision='blocked'", "reason LIKE ?"], [`${ROLE_CONFLICT_PREFIX}%`]);
    const rows = this.db.query(`SELECT * FROM catalog_reuse_decisions ${clause}
      ORDER BY created_at DESC, id DESC LIMIT ?`).all(...args, boundedLimit(filter.limit)) as Row[];
    return rows.map((row) => {
      const decision = toDto(row);
      const roles = (decision.reason ?? "").slice(ROLE_CONFLICT_PREFIX.length).split(",").map(role => role.trim()).filter(Boolean);
      return { ...decision, roles };
    });
  }

  /** §5 shadow-фаза: сколько раз enforce заблокировал бы создание и сколько разных акторов. */
  wouldBlock(filter: ReuseAuditFilter = {}): ReuseWouldBlockReport {
    const { clause, args } = auditWhere(filter, ["decision='would_block'"]);
    const totals = this.db.query(`SELECT COUNT(*) total, COUNT(DISTINCT actor_id) actors FROM catalog_reuse_decisions ${clause}`)
      .get(...args) as { total: number; actors: number };
    const byActor = this.db.query(`SELECT actor_id actorId, COUNT(*) count FROM catalog_reuse_decisions ${clause}
      GROUP BY actor_id ORDER BY count DESC, actorId ASC`).all(...args) as { actorId: string; count: number }[];
    return { ...totals, byActor, decisions: this.filtered("would_block", filter) };
  }

  /**
   * §5 (d): артефакты каталога, ни разу не прошедшие reuse-review. Анти-джойн по индексу
   * `(artifact_id)`; удалённые не считаются. `createdBeforeGate` отделяет «создан до гейта»
   * (ожидаемо) от «создан после, но записи нет» (это уже дефект — путь в обход гейта).
   */
  unreviewedArtifacts(filter: { designSystem?: string; limit?: number } = {}): ReuseUnreviewedReport {
    const since = this.gateActiveSince();
    const scope = filter.designSystem === undefined ? "" : " AND t.design_system=?";
    const args = filter.designSystem === undefined ? [] : [filter.designSystem];
    const query = (table: "components" | "compositions", kind: ReuseArtifactKind) => `
      SELECT '${kind}' kind, t.id id, t.name name, t.design_system designSystem, t.created_at createdAt
      FROM ${table} t LEFT JOIN catalog_reuse_decisions d ON d.artifact_id = t.id
      WHERE t.deleted_at IS NULL AND d.artifact_id IS NULL${scope}`;
    const sql = `${query("components", "component")} UNION ALL ${query("compositions", "composition")}`;
    const total = this.db.query(`SELECT COUNT(*) total FROM (${sql})`).get(...args, ...args) as { total: number };
    const rows = this.db.query(`SELECT * FROM (${sql}) ORDER BY createdAt ASC, id ASC LIMIT ?`)
      .all(...args, ...args, boundedLimit(filter.limit)) as Omit<ReuseUnreviewedArtifact, "createdBeforeGate">[];
    return {
      total: total.total,
      artifacts: rows.map(row => ({ ...row, createdBeforeGate: since === null || row.createdAt < since })),
    };
  }

  private filtered(decision: ReuseDecisionKind, filter: ReuseAuditFilter): ReuseDecision[] {
    const { clause, args } = auditWhere(filter, ["decision=?"], [decision]);
    const rows = this.db.query(`SELECT * FROM catalog_reuse_decisions ${clause}
      ORDER BY created_at DESC, id DESC LIMIT ?`).all(...args, boundedLimit(filter.limit)) as Row[];
    return rows.map(toDto);
  }

  /**
   * Ретенция — единственный путь удаления. Append-only триггер снимается только здесь,
   * внутри одной транзакции, и восстанавливается **побайтово тем же DDL**, прочитанным из
   * `sqlite_master`: дублировать текст триггера в двух местах значит однажды их разойти.
   * Любая ошибка внутри транзакции откатывает и удаление, и снятие триггера (DDL в SQLite
   * транзакционен), поэтому таблица не может остаться без защиты.
   *
   * Без этого пути таблица растёт в проде бесконечно: гейт пишет строку на каждое создание
   * компонента, а приложение удалять их не имеет права.
   */
  prune(olderThan: string, options: { actorId?: string } = {}): number {
    const trigger = this.db.query("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?")
      .get("catalog_reuse_decisions_no_delete") as { sql: string } | null;
    if (!trigger?.sql) throw new Error("catalog_reuse_decisions_no_delete trigger is missing: refusing to prune an unprotected audit table");
    const removed = this.db.transaction(() => {
      this.db.run("DROP TRIGGER catalog_reuse_decisions_no_delete");
      const result = this.db.query("DELETE FROM catalog_reuse_decisions WHERE created_at < ?").run(olderThan);
      this.db.run(trigger.sql);
      return result.changes;
    })();
    // Явное логирование: удаление из append-only таблицы обязано оставлять след в другом месте.
    writeAuditEvent(this.db, {
      actorId: options.actorId ?? "system",
      action: "reuse.decisions.pruned",
      subjectType: "catalog_reuse_decisions",
      subjectId: olderThan,
      detail: { removed },
    });
    return removed;
  }
}
