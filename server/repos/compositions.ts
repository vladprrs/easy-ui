import type { Database } from "bun:sqlite";
import { compositionDocSchema, type CompositionDoc } from "../../src/prototype/composition";
import { ApiError } from "../http";

/**
 * Репозиторий версионированных композиций (волна 5, миграция v18).
 * Зеркалит `ComponentRepo`: head_rev + ревизии + неизменяемые публикации + мягкое удаление.
 * Отличие — публиковать нечего компилировать: артефакт публикации это сам документ,
 * его `source_hash` считается по каноническому JSON.
 */

const now = () => new Date().toISOString();
const TRANSITIONS: Record<string, string[]> = {
  active: ["deprecated", "superseded", "archived"],
  deprecated: ["archived", "active"],
  superseded: ["archived", "active"],
  archived: [],
};

export const compositionSourceHash = (doc: CompositionDoc): string =>
  new Bun.CryptoHasher("sha256").update(canonicalJson(doc)).digest("hex");

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export type CompositionRow = {
  id: string; name: string; head_rev: number; design_system: string; owner_id: string | null;
  deleted_at: string | null; delete_reason: string | null; created_at: string; updated_at: string;
};

export const parseStoredCompositionDoc = (json: string, id: string, rev: number): CompositionDoc => {
  try { return compositionDocSchema.parse(JSON.parse(json)); }
  catch { throw new ApiError(422, "invalid_stored_revision", `Stored composition revision is invalid: ${id} rev ${rev}`); }
};

export class CompositionRepo {
  constructor(private db: Database) {}

  row(id: string, includeDeleted = false): CompositionRow {
    const row = this.db.query(`SELECT * FROM compositions WHERE id=? ${includeDeleted ? "" : "AND deleted_at IS NULL"}`).get(id) as CompositionRow | null;
    if (!row) throw new ApiError(404, "not_found", "Composition not found");
    return row;
  }
  cas(id: string, baseRev: number): CompositionRow {
    const row = this.row(id);
    if (row.head_rev !== baseRev) throw new ApiError(409, "revision_conflict", "Composition revision has changed", { currentRev: row.head_rev });
    return row;
  }
  create(id: string, doc: CompositionDoc, designSystem: string, message?: string, ownerId: string | null = null) {
    return this.db.transaction(() => {
      if (this.db.query("SELECT 1 ok FROM compositions WHERE id=? OR name=?").get(id, doc.name)) throw new ApiError(409, "already_exists", "Composition id or name already exists");
      const at = now();
      this.db.query("INSERT INTO compositions (id,name,head_rev,design_system,owner_id,deleted_at,created_at,updated_at) VALUES (?,?,1,?,?,NULL,?,?)")
        .run(id, doc.name, designSystem, ownerId, at, at);
      this.db.query("INSERT INTO composition_revisions (composition_id,rev,doc,design_system,message,author,created_at) VALUES (?,1,?,?,?,?,?)")
        .run(id, JSON.stringify(doc), designSystem, message ?? null, ownerId, at);
      return { id, rev: 1 as const };
    })();
  }
  save(id: string, doc: CompositionDoc, baseRev: number, message?: string, actorId: string | null = null) {
    return this.db.transaction(() => {
      const row = this.cas(id, baseRev);
      const clash = this.db.query("SELECT 1 ok FROM compositions WHERE name=? AND id<>?").get(doc.name, id);
      if (clash) throw new ApiError(409, "already_exists", "Composition name already exists");
      const rev = row.head_rev + 1, at = now();
      this.db.query("INSERT INTO composition_revisions (composition_id,rev,doc,design_system,message,author,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(id, rev, JSON.stringify(doc), row.design_system, message ?? null, actorId, at);
      this.db.query("UPDATE compositions SET name=?,head_rev=?,updated_at=? WHERE id=? AND deleted_at IS NULL").run(doc.name, rev, at, id);
      return { rev };
    })();
  }
  /**
   * Мягкое удаление. Композиция, закреплённая пинами, остаётся читаемой по версии:
   * FK RESTRICT на `composition_publishes` защищает неизменяемые публикации прототипов.
   */
  delete(id: string, baseRev: number, reason?: string) {
    this.db.transaction(() => {
      this.cas(id, baseRev);
      const at = now();
      this.db.query("UPDATE compositions SET deleted_at=?,delete_reason=?,updated_at=? WHERE id=? AND deleted_at IS NULL").run(at, reason?.trim() || null, at, id);
    })();
  }
  list(includeDeleted = false) {
    const rows = this.db.query(`SELECT c.*, (SELECT MAX(version) FROM composition_publishes p WHERE p.composition_id=c.id AND p.status='active') latest
      FROM compositions c ${includeDeleted ? "" : "WHERE c.deleted_at IS NULL"} ORDER BY c.updated_at DESC`).all() as (CompositionRow & { latest: number | null })[];
    return rows.map((row) => {
      const doc = this.docAt(row.id, row.head_rev);
      return {
        id: row.id, name: row.name, designSystem: row.design_system, headRev: row.head_rev,
        latestVersion: row.latest, updatedAt: row.updated_at,
        description: doc.description, params: Object.keys(doc.params), slots: doc.slots,
        ...(row.deleted_at === null ? {} : { deleted: true as const, deletedAt: row.deleted_at, reason: row.delete_reason }),
      };
    });
  }
  private docAt(id: string, rev: number): CompositionDoc {
    const row = this.db.query("SELECT doc FROM composition_revisions WHERE composition_id=? AND rev=?").get(id, rev) as { doc: string } | null;
    if (!row) throw new ApiError(404, "revision_not_found", "Composition revision not found");
    return parseStoredCompositionDoc(row.doc, id, rev);
  }
  meta(id: string, includeDeleted = false) {
    const row = this.row(id, includeDeleted);
    const versions = this.versions(id, includeDeleted);
    const active = versions.filter((version) => version.status === "active");
    return {
      id: row.id, name: row.name, designSystem: row.design_system, headRev: row.head_rev,
      versions, updatedAt: row.updated_at, publishedVersion: active.at(-1)?.version ?? null,
      doc: this.docAt(id, row.head_rev),
      ...(row.deleted_at === null ? {} : { deleted: true as const, deletedAt: row.deleted_at, reason: row.delete_reason }),
    };
  }
  revisions(id: string) {
    this.row(id);
    return (this.db.query("SELECT rev,message,created_at FROM composition_revisions WHERE composition_id=? ORDER BY rev DESC").all(id) as { rev: number; message: string | null; created_at: string }[])
      .map((row) => ({ rev: row.rev, message: row.message, createdAt: row.created_at }));
  }
  revision(id: string, rev?: number) {
    const row = this.row(id);
    const at = rev ?? row.head_rev;
    const stored = this.db.query("SELECT rev,doc,design_system,message,created_at FROM composition_revisions WHERE composition_id=? AND rev=?").get(id, at) as { rev: number; doc: string; design_system: string; message: string | null; created_at: string } | null;
    if (!stored) throw new ApiError(404, "revision_not_found", "Composition revision not found");
    return { rev: stored.rev, doc: parseStoredCompositionDoc(stored.doc, id, stored.rev), designSystem: stored.design_system, message: stored.message, createdAt: stored.created_at };
  }
  publish(id: string, baseRev: number, message?: string) {
    return this.db.transaction(() => {
      const row = this.cas(id, baseRev);
      if (this.db.query("SELECT 1 ok FROM composition_publishes WHERE composition_id=? AND rev=?").get(id, row.head_rev)) {
        throw new ApiError(409, "already_published", "This revision is already published", { currentRev: row.head_rev });
      }
      const doc = this.docAt(id, row.head_rev);
      const max = this.db.query("SELECT MAX(version) v FROM composition_publishes WHERE composition_id=?").get(id) as { v: number | null };
      const version = (max.v ?? 0) + 1;
      this.db.query("INSERT INTO composition_publishes (composition_id,version,rev,status,source_hash,message,published_at) VALUES (?,?,?,'active',?,?,?)")
        .run(id, version, row.head_rev, compositionSourceHash(doc), message ?? null, now());
      return { version, rev: row.head_rev };
    })();
  }
  versions(id: string, includeDeleted = false) {
    this.row(id, includeDeleted);
    return (this.db.query("SELECT version,rev,status,status_reason,superseded_by,status_rev,source_hash,published_at FROM composition_publishes WHERE composition_id=? ORDER BY version").all(id) as {
      version: number; rev: number; status: string; status_reason: string | null; superseded_by: number | null; status_rev: number; source_hash: string; published_at: string;
    }[]).map((row) => ({ version: row.version, rev: row.rev, status: row.status, statusReason: row.status_reason, supersededBy: row.superseded_by, statusRev: row.status_rev, sourceHash: row.source_hash, publishedAt: row.published_at }));
  }
  version(id: string, version: number) {
    const row = this.db.query(`SELECT p.version,p.rev,p.status,p.status_reason,p.superseded_by,p.status_rev,p.source_hash,p.published_at,r.doc,r.design_system
      FROM composition_publishes p JOIN composition_revisions r ON r.composition_id=p.composition_id AND r.rev=p.rev
      WHERE p.composition_id=? AND p.version=?`).get(id, version) as {
      version: number; rev: number; status: string; status_reason: string | null; superseded_by: number | null; status_rev: number; source_hash: string; published_at: string; doc: string; design_system: string;
    } | null;
    if (!row) throw new ApiError(404, "version_not_found", "Composition version not found");
    return {
      version: row.version, rev: row.rev, status: row.status, statusReason: row.status_reason, supersededBy: row.superseded_by,
      statusRev: row.status_rev, sourceHash: row.source_hash, designSystem: row.design_system,
      doc: parseStoredCompositionDoc(row.doc, id, row.rev), publishedAt: row.published_at,
    };
  }
  /**
   * Ручной переход статуса версии. Валидация зеркалит компонентную (`ComponentRepo.setStatus`):
   * `superseded` требует `supersededBy` на существующую версию, не на себя и без цикла по цепочке.
   */
  setStatus(id: string, version: number, change: { status: string; reason?: string; supersededBy?: number; baseStatusRev: number }) {
    return this.db.transaction(() => {
      this.row(id);
      const current = this.db.query("SELECT status,status_rev FROM composition_publishes WHERE composition_id=? AND version=?").get(id, version) as { status: string; status_rev: number } | null;
      if (!current) throw new ApiError(404, "version_not_found", "Composition version not found");
      if (current.status_rev !== change.baseStatusRev) throw new ApiError(409, "status_conflict", "Composition version status has changed", { currentStatusRev: current.status_rev });
      if (!(TRANSITIONS[current.status] ?? []).includes(change.status)) throw new ApiError(422, "invalid_transition", `Cannot transition ${current.status} → ${change.status}`, { issues: [{ path: ["status"], message: `invalid transition from ${current.status}` }] });
      let supersededBy: number | null = null;
      if (change.status === "superseded") {
        const target = change.supersededBy;
        if (typeof target !== "number" || !Number.isInteger(target) || target < 1) throw new ApiError(422, "validation_failed", "supersededBy is required to supersede a version", { issues: [{ path: ["supersededBy"], message: "supersededBy must reference a version" }] });
        if (target === version) throw new ApiError(422, "validation_failed", "A version cannot supersede itself", { issues: [{ path: ["supersededBy"], message: "cannot supersede self" }] });
        if (!this.db.query("SELECT 1 ok FROM composition_publishes WHERE composition_id=? AND version=?").get(id, target)) throw new ApiError(422, "validation_failed", "supersededBy references a version that does not exist", { issues: [{ path: ["supersededBy"], message: `unknown version ${target}` }] });
        // Идём по цепочке superseded_by от цели: возврат к `version` означал бы цикл.
        let cursor: number | null = target; const seen = new Set<number>([version]);
        while (cursor !== null) {
          if (seen.has(cursor)) throw new ApiError(422, "validation_failed", "supersededBy would create a cycle", { issues: [{ path: ["supersededBy"], message: "cycle detected" }] });
          seen.add(cursor);
          cursor = (this.db.query("SELECT superseded_by n FROM composition_publishes WHERE composition_id=? AND version=?").get(id, cursor) as { n: number | null } | null)?.n ?? null;
        }
        supersededBy = target;
      }
      const nextRev = current.status_rev + 1;
      this.db.query("UPDATE composition_publishes SET status=?,status_reason=?,superseded_by=?,status_rev=? WHERE composition_id=? AND version=?")
        .run(change.status, change.reason?.trim() || null, supersededBy, nextRev, id, version);
      return { status: change.status, statusRev: nextRev };
    })();
  }
  /** Где композиция используется: головные ревизии прототипов (по пинам). */
  usages(id: string) {
    this.row(id, true);
    const rows = this.db.query(`SELECT p.id prototypeId,p.name,p.kind,prc.rev,prc.composition_version version
      FROM prototype_revision_compositions prc JOIN prototypes p ON p.id=prc.prototype_id AND p.head_rev=prc.rev
      WHERE prc.composition_id=? ORDER BY p.id`).all(id) as { prototypeId: string; name: string; kind: string; rev: number; version: number }[];
    const immutable = this.db.query(`SELECT pp.prototype_id prototypeId,pp.version,prc.composition_version compositionVersion
      FROM prototype_revision_compositions prc JOIN prototype_publishes pp ON pp.prototype_id=prc.prototype_id AND pp.rev=prc.rev
      WHERE prc.composition_id=? ORDER BY pp.prototype_id,pp.version`).all(id) as { prototypeId: string; version: number; compositionVersion: number }[];
    return { currentHeadUsages: rows, immutableUsages: immutable, safeToRemove: rows.length === 0 && immutable.length === 0 };
  }
}

/**
 * Разрешает композиции по их id к **последней active-публикации** — ровно как
 * `snapshotDefinitions` разрешает компоненты. Возвращает документы и пины ревизии.
 * Единственный резолвер: и save-путь, и чтение draft'а ходят сюда.
 */
export function resolveCompositionPins(db: Database, ids: readonly string[], designSystem: string): {
  docs: Record<string, CompositionDoc>;
  pins: { id: string; name: string; version: number; sourceHash: string }[];
  missing: { id: string; reason: string }[];
} {
  const docs: Record<string, CompositionDoc> = {};
  const pins: { id: string; name: string; version: number; sourceHash: string }[] = [];
  const missing: { id: string; reason: string }[] = [];
  for (const id of [...new Set(ids)].sort()) {
    const row = db.query(`SELECT c.id,c.name,c.design_system designSystem,p.version,p.rev,p.source_hash sourceHash,r.doc
      FROM compositions c JOIN composition_publishes p ON p.composition_id=c.id AND p.status='active'
      JOIN composition_revisions r ON r.composition_id=p.composition_id AND r.rev=p.rev
      WHERE c.id=? AND c.deleted_at IS NULL ORDER BY p.version DESC LIMIT 1`).get(id) as {
      id: string; name: string; designSystem: string; version: number; rev: number; sourceHash: string; doc: string;
    } | null;
    if (!row) { missing.push({ id, reason: `unknown or unpublished composition: ${id}` }); continue; }
    if (row.designSystem !== designSystem) { missing.push({ id, reason: `composition belongs to a different design system: ${id} (${row.designSystem})` }); continue; }
    docs[id] = parseStoredCompositionDoc(row.doc, id, row.rev);
    pins.push({ id: row.id, name: row.name, version: row.version, sourceHash: row.sourceHash });
  }
  return { docs, pins, missing };
}

/** Документы композиций конкретной ревизии прототипа (по её пинам). */
export function pinnedCompositionDocs(db: Database, prototypeId: string, rev: number): {
  docs: Record<string, CompositionDoc>;
  pins: { id: string; name: string; version: number; sourceHash: string }[];
} {
  const rows = db.query(`SELECT c.id,c.name,prc.composition_version version,p.source_hash sourceHash,r.doc,p.rev
    FROM prototype_revision_compositions prc
    JOIN compositions c ON c.id=prc.composition_id
    JOIN composition_publishes p ON p.composition_id=prc.composition_id AND p.version=prc.composition_version
    JOIN composition_revisions r ON r.composition_id=p.composition_id AND r.rev=p.rev
    WHERE prc.prototype_id=? AND prc.rev=? ORDER BY c.id`).all(prototypeId, rev) as {
    id: string; name: string; version: number; sourceHash: string; doc: string; rev: number;
  }[];
  const docs: Record<string, CompositionDoc> = {};
  for (const row of rows) docs[row.id] = parseStoredCompositionDoc(row.doc, row.id, row.rev);
  return { docs, pins: rows.map((row) => ({ id: row.id, name: row.name, version: row.version, sourceHash: row.sourceHash })) };
}
