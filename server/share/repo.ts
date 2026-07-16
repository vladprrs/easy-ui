import { randomBytes, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { ABI_V1 } from "../shims/abi-v1";
import { EASY_UI_RUNTIME_FILE } from "../shims/abi-v2";
import { EASY_UI_RUNTIME_V3_FILE } from "../shims/abi-v3";
import { getDesignSystemVersion } from "../designSystems";
import { ApiError } from "../http";
import { PrototypeRepo } from "../repos/prototypes";
import { buildShareStaticAllowedUrls } from "../screenshot/allowedUrls";
import { matchAllowed } from "../screenshot/sessions";

export const SHARE_COOKIE = "easy_ui_share";
export const MIN_SHARE_TTL_SECONDS = 5 * 60;
export const MAX_SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;

interface ShareDependencies {
  prototypeId: string;
  version: number;
  rev: number;
  startScreen: string;
  routes: string[];
  resources: string[];
}

interface GrantRow {
  id: string;
  prototype_id: string;
  version: number;
  rev: number;
  dependencies_json: string;
  created_at: string;
  expires_at: string;
}

export interface ShareAuthorizationScope {
  grantId: string;
  prototypeId: string;
  version: number;
  allowedUrls: string[];
}

export interface ShareGrantPublic {
  id: string;
  prototypeId: string;
  version: number;
  createdAt: string;
  expiresAt: string;
  activeSessions: number;
}

const nowIso = (now: number) => new Date(now).toISOString();
const digest = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const credential = () => randomBytes(32).toString("base64url");

function themeAssetIds(content: ReturnType<typeof getDesignSystemVersion>): string[] {
  if (!content) return [];
  const ids = new Set<string>();
  for (const font of content.fonts) ids.add(font.src);
  for (const icon of content.icons) {
    ids.add(icon.assetId);
    if (icon.themes?.light) ids.add(icon.themes.light);
    if (icon.themes?.dark) ids.add(icon.themes.dark);
  }
  return [...ids];
}

function parseDependencies(row: Pick<GrantRow, "id" | "dependencies_json">): ShareDependencies {
  try {
    const value = JSON.parse(row.dependencies_json) as ShareDependencies;
    if (!value || !Array.isArray(value.routes) || !Array.isArray(value.resources)) throw new Error("invalid shape");
    return value;
  } catch {
    throw new Error(`Invalid dependency snapshot for share grant ${row.id}`);
  }
}

export function readShareCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== SHARE_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
  }
  return null;
}

export class ShareRepo {
  constructor(
    private readonly db: Database,
    private readonly options: { publicOrigin: URL; serveDist?: string; now?: () => number },
  ) {}

  private now(): number { return (this.options.now ?? Date.now)(); }

  private dependencySnapshot(prototypeId: string, version: number): ShareDependencies {
    const repo = new PrototypeRepo(this.db);
    const published = repo.version(prototypeId, version);
    if (!repo.renderableForRev(prototypeId, published.rev)) {
      throw new ApiError(422, "version_not_renderable", "Prototype version is not renderable");
    }

    const resources = new Set<string>();
    resources.add(`/api/prototypes/${prototypeId}/versions/${version}`);
    const assetIds = new Set(published.assets.map((asset) => asset.id));
    const abiVersions = new Set<number>();
    for (const pin of published.components) {
      resources.add(`/api/components/${pin.id}/versions/${pin.version}/bundle.js`);
      const component = this.db.query(`SELECT host_abi_version FROM component_publishes
        WHERE component_id=? AND version=?`).get(pin.id, pin.version) as { host_abi_version: number } | null;
      if (!component) throw new Error(`Missing component publication ${pin.id} v${pin.version}`);
      abiVersions.add(component.host_abi_version);
      const assets = this.db.query(`SELECT asset_id FROM component_publish_assets
        WHERE component_id=? AND version=?`).all(pin.id, pin.version) as { asset_id: string }[];
      for (const asset of assets) assetIds.add(asset.asset_id);
    }
    for (const abi of abiVersions) {
      for (const name of Object.keys(ABI_V1)) resources.add(`/api/shims/v${abi}/${name}.js`);
      if (abi === 2) resources.add(`/api/shims/v2/${EASY_UI_RUNTIME_FILE}`);
      if (abi === 3) resources.add(`/api/shims/v3/${EASY_UI_RUNTIME_V3_FILE}`);
    }

    const metaVersion = published.designSystemMetaVersion;
    if (metaVersion != null) {
      resources.add(`/api/design-systems/${published.doc.designSystem}/versions/${metaVersion}`);
      for (const id of themeAssetIds(getDesignSystemVersion(this.db, published.doc.designSystem, metaVersion))) assetIds.add(id);
    }
    for (const id of assetIds) resources.add(`/api/assets/${id}`);

    const base = `/share/p/${prototypeId}/v/${version}/present`;
    const routes = [base, ...published.doc.screens.map((screen) => `${base}/s/${screen.id}`)];
    return {
      prototypeId,
      version,
      rev: published.rev,
      startScreen: published.doc.startScreen,
      routes,
      resources: [...resources],
    };
  }

  create(prototypeId: string, version: number, ttlSeconds: number): ShareGrantPublic & { url: string } {
    const dependencies = this.dependencySnapshot(prototypeId, version);
    const token = credential();
    const created = this.now();
    const createdAt = nowIso(created);
    const expiresAt = nowIso(created + ttlSeconds * 1000);
    const id = `share_${randomUUID()}`;
    this.db.query(`INSERT INTO share_grants
      (id,token_hash,prototype_id,version,rev,dependencies_json,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
        id, digest(token), prototypeId, version, dependencies.rev,
        JSON.stringify(dependencies), createdAt, expiresAt,
      );
    const url = new URL(`/share/${token}`, this.options.publicOrigin).toString();
    return { id, prototypeId, version, url, createdAt, expiresAt, activeSessions: 0 };
  }

  list(prototypeId: string): ShareGrantPublic[] {
    // Preserve revoked rows for audit, but never expose them as active links.
    const at = nowIso(this.now());
    return (this.db.query(`SELECT g.id,g.prototype_id,g.version,g.created_at,g.expires_at,
      (SELECT COUNT(*) FROM share_sessions s WHERE s.grant_id=g.id AND s.expires_at>?) active_sessions
      FROM share_grants g
      WHERE g.prototype_id=? AND g.revoked_at IS NULL AND g.expires_at>?
      ORDER BY g.created_at DESC,g.id`).all(at, prototypeId, at) as (GrantRow & { active_sessions: number })[])
      .map((row) => ({
        id: row.id,
        prototypeId: row.prototype_id,
        version: row.version,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        activeSessions: row.active_sessions,
      }));
  }

  revoke(prototypeId: string, grantId: string): void {
    const at = nowIso(this.now());
    this.db.transaction(() => {
      const changed = this.db.query(`UPDATE share_grants SET revoked_at=?
        WHERE id=? AND prototype_id=? AND revoked_at IS NULL`).run(at, grantId, prototypeId);
      if (changed.changes === 0) throw new ApiError(404, "share_not_found", "Share grant not found");
      // Active cookies stop authorizing immediately, even before their own TTL.
      this.db.query("DELETE FROM share_sessions WHERE grant_id=?").run(grantId);
    })();
  }

  exchange(token: string): { session: string; location: string; expiresAt: string } {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiError(404, "share_not_found", "Share link not found");
    const at = nowIso(this.now());
    const row = this.db.query(`SELECT id,prototype_id,version,rev,dependencies_json,created_at,expires_at
      FROM share_grants WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?`).get(digest(token), at) as GrantRow | null;
    if (!row) throw new ApiError(404, "share_not_found", "Share link not found");
    const dependencies = parseDependencies(row);
    const session = credential();
    this.db.query(`INSERT INTO share_sessions (id,session_hash,grant_id,created_at,expires_at)
      VALUES (?,?,?,?,?)`).run(`session_${randomUUID()}`, digest(session), row.id, at, row.expires_at);
    const path = `/share/p/${encodeURIComponent(dependencies.prototypeId)}/v/${dependencies.version}/present/s/${encodeURIComponent(dependencies.startScreen)}`;
    return { session, location: new URL(path, this.options.publicOrigin).toString(), expiresAt: row.expires_at };
  }

  authorizeScope(request: Request, decodedPath: string): ShareAuthorizationScope | null {
    if (request.method !== "GET" && request.method !== "HEAD") return null;
    const session = readShareCookie(request);
    if (!session) return null;
    const at = nowIso(this.now());
    const row = this.db.query(`SELECT g.id,g.prototype_id,g.version,g.rev,g.dependencies_json,g.created_at,g.expires_at
      FROM share_sessions s JOIN share_grants g ON g.id=s.grant_id
      WHERE s.session_hash=? AND s.expires_at>? AND g.expires_at>? AND g.revoked_at IS NULL`).get(digest(session), at, at) as GrantRow | null;
    if (!row) return null;
    const dependencies = parseDependencies(row);
    const allowedUrls = [...dependencies.routes, ...dependencies.resources, ...buildShareStaticAllowedUrls(this.options.serveDist)];
    if (matchAllowed(decodedPath, allowedUrls)) return { grantId: row.id, prototypeId: row.prototype_id, version: row.version, allowedUrls };
    // Deliberately recomputed for every request: an existing cookie follows the current deploy's
    // Vite hashes/public files after a redeploy instead of retaining build-A filenames.
    return null;
  }

  authorize(request: Request, decodedPath: string): boolean { return this.authorizeScope(request, decodedPath) !== null; }
}
