import type { Database } from "bun:sqlite";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Principal } from "../auth";
import { writeAuditEvent } from "../audit";
import { ApiError, noStore } from "../http";

/**
 * Консистентный физический снимок БД для бэкапа. База работает в WAL, поэтому копировать файл
 * на живом сервере нельзя: снимок снимается движком через `VACUUM INTO` во временный файл внутри
 * DATA_DIR и отдаётся целиком, а временный файл удаляется в `finally`.
 *
 * Путь строится сервером (DATA_DIR + timestamp + uuid), одинарных кавычек в нём быть не может;
 * проверка ниже — страховка на случай экзотического DATA_DIR, а не санитизация ввода.
 */
const timestamp = (at: Date): string => {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
};

export async function routeAdminSnapshot(
  request: Request,
  db: Database,
  segments: string[],
  principal: Principal,
  dataDir: string,
): Promise<Response | null> {
  if (segments[0] !== "admin" || segments[1] !== "db-snapshot" || segments.length !== 2) return null;
  if (principal.kind !== "user") throw new ApiError(401, "unauthorized", "Authentication required");
  if (!principal.isAdmin) throw new ApiError(403, "forbidden", "Administrator access required");
  if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");

  const at = new Date();
  const stamp = timestamp(at);
  const tmpDir = resolve(dataDir, "tmp");
  await mkdir(tmpDir, { recursive: true });
  const target = resolve(tmpDir, `db-snapshot-${stamp}-${crypto.randomUUID()}.sqlite`);
  if (target.includes("'")) throw new Error("DATA_DIR path must not contain a single quote");
  try {
    db.exec(`VACUUM INTO '${target}'`);
    const bytes = await Bun.file(target).bytes();
    writeAuditEvent(db, {
      actorId: principal.userId,
      action: "admin.db_snapshot",
      subjectType: "database",
      subjectId: "easy-ui.db",
      detail: { bytes: bytes.byteLength, at: at.toISOString() },
    });
    return new Response(bytes as unknown as BodyInit, {
      headers: {
        ...noStore,
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="easy-ui-db-snapshot-${stamp}.sqlite"`,
      },
    });
  } finally {
    await rm(target, { force: true });
  }
}
