import type { Database } from "bun:sqlite";
import { createHandler, type HandlerOptions } from "./main";
import { BOOTSTRAP_ADMIN_ID, UserRepo } from "./users";

/**
 * Shared auth harness for route tests. It creates one trusted operator session and
 * transparently attaches its cookie plus the browser Origin header to each request.
 */
export function createTestHandler(db: Database, options: HandlerOptions = {}): ReturnType<typeof createHandler> {
  if (!db.query("SELECT 1 ok FROM users WHERE id=?").get(BOOTSTRAP_ADMIN_ID)) {
    db.query("INSERT INTO users (id,name,password_hash,is_admin,created_at) VALUES (?,?,?,?,?)")
      .run(BOOTSTRAP_ADMIN_ID, "Test Admin", "test-only-unusable-password-hash", 1, new Date().toISOString());
  }
  const session = new UserRepo(db).createSession(BOOTSTRAP_ADMIN_ID);
  const secure = new URL(options.publicOrigin?.toString() ?? "http://localhost").protocol === "https:";
  const cookieName = secure ? "__Host-easyui_session" : "easyui_session";
  const base = createHandler(db, options);
  return async (request, server) => {
    const headers = new Headers(request.headers);
    const cookies = headers.get("cookie");
    headers.set("cookie", cookies ? `${cookies}; ${cookieName}=${session.token}` : `${cookieName}=${session.token}`);
    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS" && !headers.has("origin")) headers.set("origin", new URL(request.url).origin);
    return base(new Request(request, { headers }), server);
  };
}
