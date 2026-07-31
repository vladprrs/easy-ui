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
