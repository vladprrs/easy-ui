import { randomBytes, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { ApiError } from "./http";
import { writeAuditEvent } from "./audit";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_SESSIONS_PER_USER = 10;
export const DEV_SESSION_COOKIE = "easyui_session";
export const PROD_SESSION_COOKIE = "__Host-easyui_session";
export const BOOTSTRAP_ADMIN_ID = "user_admin";

export type UserRecord = { id: string; name: string; isAdmin: boolean; createdAt: string };
type UserRow = { id: string; name: string; password_hash: string; is_admin: number; created_at: string };
type SessionUserRow = UserRow & { expires_at: string };

const digest = (value: string): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const token = (): string => randomBytes(32).toString("base64url");
const asUser = (row: UserRow): UserRecord => ({ id: row.id, name: row.name, isAdmin: row.is_admin === 1, createdAt: row.created_at });

export function sessionCookieName(secure: boolean): string {
  return secure ? PROD_SESSION_COOKIE : DEV_SESSION_COOKIE;
}

export function serializeSessionCookie(value: string, secure: boolean, maxAge = Math.floor(SESSION_TTL_MS / 1000)): string {
  return `${sessionCookieName(secure)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${sessionCookieName(secure)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function readSessionCookie(request: Request, secure: boolean): string | null {
  const name = sessionCookieName(secure);
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 0 || part.slice(0, at).trim() !== name) continue;
    const value = part.slice(at + 1).trim();
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
  }
  return null;
}

export class UserRepo {
  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {}

  private nowIso(): string { return new Date(this.now()).toISOString(); }

  list(): UserRecord[] {
    return (this.db.query("SELECT id,name,password_hash,is_admin,created_at FROM users ORDER BY name COLLATE NOCASE,id").all() as UserRow[]).map(asUser);
  }

  byName(name: string): UserRow | null {
    return this.db.query("SELECT id,name,password_hash,is_admin,created_at FROM users WHERE name=? COLLATE NOCASE").get(name) as UserRow | null;
  }

  async create(input: { name: string; password: string; isAdmin?: boolean; actorId: string }): Promise<UserRecord> {
    const passwordHash = await Bun.password.hash(input.password, "argon2id");
    const row: UserRow = { id: `user_${randomUUID()}`, name: input.name, password_hash: passwordHash, is_admin: input.isAdmin ? 1 : 0, created_at: this.nowIso() };
    try {
      this.db.transaction(() => {
        this.db.query("INSERT INTO users (id,name,password_hash,is_admin,created_at) VALUES (?,?,?,?,?)")
          .run(row.id, row.name, row.password_hash, row.is_admin, row.created_at);
        writeAuditEvent(this.db, { actorId: input.actorId, action: "user.created", subjectType: "user", subjectId: row.id, detail: { name: row.name, isAdmin: row.is_admin === 1 } });
      })();
    } catch (error) {
      if (String(error).includes("UNIQUE")) throw new ApiError(409, "already_exists", "User name already exists");
      throw error;
    }
    return asUser(row);
  }

  async verify(name: string, password: string, dummyHash: string): Promise<UserRecord | null> {
    const row = this.byName(name);
    let valid = false;
    try { valid = await Bun.password.verify(password, row?.password_hash ?? dummyHash, "argon2id"); }
    catch { valid = false; }
    return row && valid ? asUser(row) : null;
  }

  createSession(userId: string): { token: string; expiresAt: string } {
    const raw = token();
    const createdAt = this.nowIso();
    const expiresAt = new Date(this.now() + SESSION_TTL_MS).toISOString();
    this.db.transaction(() => {
      this.db.query("DELETE FROM user_sessions WHERE expires_at<=?").run(createdAt);
      this.db.query("INSERT INTO user_sessions (id,session_hash,user_id,created_at,expires_at) VALUES (?,?,?,?,?)")
        .run(`session_${randomUUID()}`, digest(raw), userId, createdAt, expiresAt);
      this.db.query(`DELETE FROM user_sessions WHERE user_id=? AND id IN (
        SELECT id FROM user_sessions WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET ?
      )`).run(userId, userId, MAX_SESSIONS_PER_USER);
    })();
    return { token: raw, expiresAt };
  }

  resolveSession(raw: string): UserRecord | null {
    const at = this.nowIso();
    this.db.query("DELETE FROM user_sessions WHERE expires_at<=?").run(at);
    const row = this.db.query(`SELECT u.id,u.name,u.password_hash,u.is_admin,u.created_at,s.expires_at
      FROM user_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.session_hash=? AND s.expires_at>?`).get(digest(raw), at) as SessionUserRow | null;
    return row ? asUser(row) : null;
  }

  revokeSession(raw: string): void { this.db.query("DELETE FROM user_sessions WHERE session_hash=?").run(digest(raw)); }
  revokeUserSessions(userId: string): void { this.db.query("DELETE FROM user_sessions WHERE user_id=?").run(userId); }
}

export async function ensureBootstrapAdmin(
  db: Database,
  env: { name?: string; password?: string } = { name: process.env.ADMIN_NAME, password: process.env.ADMIN_PASSWORD },
): Promise<UserRecord | null> {
  if (Boolean(env.name) !== Boolean(env.password)) throw new Error("ADMIN_NAME and ADMIN_PASSWORD must be set together");
  const repo = new UserRepo(db);
  let admin: UserRecord | null = null;
  let passwordHash: string | null = null;
  let passwordChanged = false;
  if (env.name && env.password) {
    const existing = db.query("SELECT id,name,password_hash,is_admin,created_at FROM users WHERE id=?").get(BOOTSTRAP_ADMIN_ID) as UserRow | null;
    if (existing) {
      try { passwordChanged = !(await Bun.password.verify(env.password, existing.password_hash, "argon2id")); }
      catch { passwordChanged = true; }
      if (passwordChanged) passwordHash = await Bun.password.hash(env.password, "argon2id");
    } else passwordHash = await Bun.password.hash(env.password, "argon2id");

    db.transaction(() => {
      const at = new Date().toISOString();
      if (existing) {
        db.query("UPDATE users SET name=?,password_hash=?,is_admin=1 WHERE id=?")
          .run(env.name!, passwordHash ?? existing.password_hash, BOOTSTRAP_ADMIN_ID);
        if (passwordChanged) repo.revokeUserSessions(BOOTSTRAP_ADMIN_ID);
      } else {
        db.query("INSERT INTO users (id,name,password_hash,is_admin,created_at) VALUES (?,?,?,?,?)")
          .run(BOOTSTRAP_ADMIN_ID, env.name!, passwordHash!, 1, at);
        writeAuditEvent(db, { actorId: "system", action: "user.bootstrap_created", subjectType: "user", subjectId: BOOTSTRAP_ADMIN_ID, detail: { name: env.name } });
      }
      for (const table of ["prototypes", "components", "design_systems"] as const) db.query(`UPDATE ${table} SET owner_id=? WHERE owner_id IS NULL`).run(BOOTSTRAP_ADMIN_ID);
    })();
    admin = { id: BOOTSTRAP_ADMIN_ID, name: env.name, isAdmin: true, createdAt: existing?.created_at ?? new Date().toISOString() };
  } else {
    const row = db.query("SELECT id,name,password_hash,is_admin,created_at FROM users WHERE is_admin=1 ORDER BY CASE id WHEN 'user_admin' THEN 0 ELSE 1 END,id LIMIT 1").get() as UserRow | null;
    if (row) {
      admin = asUser(row);
      db.transaction(() => {
        for (const table of ["prototypes", "components", "design_systems"] as const) db.query(`UPDATE ${table} SET owner_id=? WHERE owner_id IS NULL`).run(row.id);
      })();
    }
  }
  return admin;
}

export function assertOwnersPresent(db: Database): void {
  for (const table of ["prototypes", "components", "design_systems"] as const) {
    if (db.query(`SELECT 1 ok FROM ${table} WHERE owner_id IS NULL LIMIT 1`).get()) throw new Error(`Missing owner_id in ${table}`);
  }
}
