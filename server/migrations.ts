import type { Database } from "bun:sqlite";
import { designSystems } from "../src/designSystems";

const migrations = [
  (db: Database) => {
    db.run(`CREATE TABLE prototypes (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
      device TEXT NOT NULL, screen_count INTEGER NOT NULL,
      head_rev INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    db.run(`CREATE TABLE prototype_revisions (
      prototype_id TEXT NOT NULL REFERENCES prototypes(id) ON DELETE CASCADE,
      rev INTEGER NOT NULL, doc TEXT NOT NULL, builtin_catalog_hash TEXT NOT NULL,
      message TEXT, author TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY (prototype_id, rev))`);
    db.run(`CREATE TABLE components (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, head_rev INTEGER NOT NULL,
      deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    db.run(`CREATE TABLE component_revisions (
      component_id TEXT NOT NULL REFERENCES components(id), rev INTEGER NOT NULL,
      source TEXT NOT NULL, message TEXT, author TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY (component_id, rev))`);
    db.run(`CREATE TABLE component_publishes (
      component_id TEXT NOT NULL REFERENCES components(id), version INTEGER NOT NULL,
      rev INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'staging'
        CHECK(status IN ('staging','active','failed')),
      compiled_js TEXT NOT NULL, definition_meta TEXT NOT NULL,
      source_hash TEXT NOT NULL, bundle_hash TEXT NOT NULL, host_abi_version INTEGER NOT NULL,
      message TEXT, published_at TEXT NOT NULL,
      PRIMARY KEY (component_id, version), UNIQUE (component_id, rev),
      FOREIGN KEY (component_id, rev) REFERENCES component_revisions(component_id, rev))`);
    db.run(`CREATE TABLE prototype_revision_components (
      prototype_id TEXT NOT NULL, rev INTEGER NOT NULL, component_id TEXT NOT NULL,
      component_version INTEGER NOT NULL, PRIMARY KEY (prototype_id, rev, component_id),
      FOREIGN KEY (prototype_id, rev) REFERENCES prototype_revisions(prototype_id, rev) ON DELETE CASCADE,
      FOREIGN KEY (component_id, component_version)
        REFERENCES component_publishes(component_id, version) ON DELETE RESTRICT)`);
    db.run(`CREATE TABLE prototype_publishes (
      prototype_id TEXT NOT NULL REFERENCES prototypes(id) ON DELETE CASCADE,
      version INTEGER NOT NULL, rev INTEGER NOT NULL, message TEXT, published_at TEXT NOT NULL,
      PRIMARY KEY (prototype_id, version), UNIQUE (prototype_id, rev),
      FOREIGN KEY (prototype_id, rev) REFERENCES prototype_revisions(prototype_id, rev))`);
    db.run("CREATE TABLE seed_log (file_id TEXT PRIMARY KEY, seeded_at TEXT NOT NULL)");
  },
  (db: Database) => {
    db.run("ALTER TABLE prototypes ADD COLUMN design_system TEXT NOT NULL DEFAULT 'shadcn'");
    db.run("ALTER TABLE components ADD COLUMN design_system TEXT NOT NULL DEFAULT 'shadcn'");
  },
  (db: Database) => {
    const now=new Date().toISOString();
    db.run(`CREATE TABLE design_systems (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
      builtin_provider TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    const insert=db.query("INSERT INTO design_systems (id,name,description,builtin_provider,created_at,updated_at) VALUES (?,?,?,?,?,?)");
    insert.run("shadcn","Shadcn","Accessible shadcn/ui components for polished product interfaces.","shadcn",now,now);
    insert.run("wireframe","Wireframe","Schematic low-fidelity components for rapidly mapping interface structure.","wireframe",now,now);
    insert.run("yandex-pay","Yandex Pay Design System","Production-like Yandex Pay WebView components for interactive prototypes.",null,now,now);
    db.run("ALTER TABLE component_revisions ADD COLUMN design_system TEXT NOT NULL DEFAULT 'shadcn'");
    db.run(`UPDATE component_revisions SET design_system=(SELECT c.design_system FROM components c WHERE c.id=component_id)`);
  },
  (db: Database) => {
    db.run(`CREATE TABLE validation_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resource_type TEXT NOT NULL CHECK(resource_type IN ('prototype','component')),
      resource_id TEXT NOT NULL,
      rev INTEGER NOT NULL,
      validator_version TEXT NOT NULL,
      catalog_hash TEXT NOT NULL,
      ok INTEGER NOT NULL CHECK(ok IN (0,1)),
      issues_json TEXT NOT NULL,
      created_at TEXT NOT NULL)`);
    db.run(`CREATE INDEX validation_records_resource
      ON validation_records (resource_type, resource_id, rev, id)`);
  },
  (db: Database) => {
    // v5: content-addressed asset registry with FK-RESTRICT pins so pinned bytes cannot be pruned.
    db.run(`CREATE TABLE assets (
      id TEXT PRIMARY KEY,
      sha256 TEXT UNIQUE NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      original_name TEXT,
      created_at TEXT NOT NULL)`);
    db.run(`CREATE TABLE prototype_revision_assets (
      prototype_id TEXT NOT NULL, rev INTEGER NOT NULL, asset_id TEXT NOT NULL,
      PRIMARY KEY (prototype_id, rev, asset_id),
      FOREIGN KEY (prototype_id, rev) REFERENCES prototype_revisions(prototype_id, rev) ON DELETE CASCADE,
      FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT)`);
    db.run(`CREATE TABLE component_publish_assets (
      component_id TEXT NOT NULL, version INTEGER NOT NULL, asset_id TEXT NOT NULL,
      PRIMARY KEY (component_id, version, asset_id),
      FOREIGN KEY (component_id, version) REFERENCES component_publishes(component_id, version) ON DELETE CASCADE,
      FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT)`);
  },
  (db: Database) => {
    // v6: visual regression references + runs. A reference pins a PNG asset (FK RESTRICT so a
    // referenced baseline cannot be pruned) to a canonical surface fingerprint (UNIQUE). Each run
    // captures a candidate through the screenshot pipeline and records an honest evidence report.
    db.run(`CREATE TABLE visual_references (
      id TEXT PRIMARY KEY,
      fingerprint_json TEXT UNIQUE NOT NULL,
      asset_id TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT)`);
    db.run(`CREATE TABLE visual_runs (
      id TEXT PRIMARY KEY,
      reference_id TEXT NOT NULL,
      candidate_asset_id TEXT,
      diff_asset_id TEXT,
      metric TEXT,
      metric_options_json TEXT,
      diff_pixels INTEGER,
      total_pixels INTEGER,
      diff_percent REAL,
      status TEXT NOT NULL CHECK(status IN ('pass','fail','error','reference_missing')),
      candidate_meta_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (reference_id) REFERENCES visual_references(id) ON DELETE CASCADE,
      FOREIGN KEY (candidate_asset_id) REFERENCES assets(id) ON DELETE RESTRICT,
      FOREIGN KEY (diff_asset_id) REFERENCES assets(id) ON DELETE RESTRICT)`);
    db.run(`CREATE INDEX visual_runs_reference ON visual_runs (reference_id, created_at, id)`);
  },
  (db: Database) => {
    // v7: immutable design-system theme versions (tokens/fonts/icons) + a diagnostic pin of the
    // latest theme version onto each prototype revision. Versions are append-only snapshots; the
    // pin is additive (NULL when the system has no versions or is a builtin without a theme).
    db.run(`CREATE TABLE design_system_versions (
      system_id TEXT NOT NULL REFERENCES design_systems(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      tokens_json TEXT NOT NULL,
      fonts_json TEXT NOT NULL,
      icons_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (system_id, version))`);
    db.run("ALTER TABLE prototype_revisions ADD COLUMN design_system_meta_version INTEGER");
  },
  (db: Database) => {
    // v8: component publish lifecycle statuses. Widen the CHECK to
    // staging|active|failed|rejected|deprecated|superseded|archived and add status_reason,
    // superseded_by, status_rev (CAS token). `component_publishes` has FK-children with RESTRICT
    // (prototype_revision_components) and CASCADE (component_publish_assets from v5); PRAGMA
    // foreign_keys is a no-op inside this transaction, so we rebuild with a strict order: snapshot
    // every FK-child into a temp table, drop the children, rebuild the parent, recreate the children
    // (with their FKs + PKs), restore the child rows, then PRAGMA foreign_key_check before bumping
    // user_version. Any new FK-child of component_publishes must be added to this list.
    db.run("CREATE TABLE _prc_backup AS SELECT * FROM prototype_revision_components");
    db.run("CREATE TABLE _cpa_backup AS SELECT * FROM component_publish_assets");
    db.run("DROP TABLE prototype_revision_components");
    db.run("DROP TABLE component_publish_assets");
    db.run("ALTER TABLE component_publishes RENAME TO _cp_old");
    db.run(`CREATE TABLE component_publishes (
      component_id TEXT NOT NULL REFERENCES components(id), version INTEGER NOT NULL,
      rev INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'staging'
        CHECK(status IN ('staging','active','failed','rejected','deprecated','superseded','archived')),
      status_reason TEXT, superseded_by INTEGER, status_rev INTEGER NOT NULL DEFAULT 1,
      compiled_js TEXT NOT NULL, definition_meta TEXT NOT NULL,
      source_hash TEXT NOT NULL, bundle_hash TEXT NOT NULL, host_abi_version INTEGER NOT NULL,
      message TEXT, published_at TEXT NOT NULL,
      PRIMARY KEY (component_id, version), UNIQUE (component_id, rev),
      FOREIGN KEY (component_id, rev) REFERENCES component_revisions(component_id, rev))`);
    db.run(`INSERT INTO component_publishes
      (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,message,published_at)
      SELECT component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,message,published_at FROM _cp_old`);
    db.run("DROP TABLE _cp_old");
    db.run(`CREATE TABLE prototype_revision_components (
      prototype_id TEXT NOT NULL, rev INTEGER NOT NULL, component_id TEXT NOT NULL,
      component_version INTEGER NOT NULL, PRIMARY KEY (prototype_id, rev, component_id),
      FOREIGN KEY (prototype_id, rev) REFERENCES prototype_revisions(prototype_id, rev) ON DELETE CASCADE,
      FOREIGN KEY (component_id, component_version)
        REFERENCES component_publishes(component_id, version) ON DELETE RESTRICT)`);
    db.run(`CREATE TABLE component_publish_assets (
      component_id TEXT NOT NULL, version INTEGER NOT NULL, asset_id TEXT NOT NULL,
      PRIMARY KEY (component_id, version, asset_id),
      FOREIGN KEY (component_id, version) REFERENCES component_publishes(component_id, version) ON DELETE CASCADE,
      FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT)`);
    db.run("INSERT INTO prototype_revision_components SELECT * FROM _prc_backup");
    db.run("INSERT INTO component_publish_assets SELECT * FROM _cpa_backup");
    db.run("DROP TABLE _prc_backup");
    db.run("DROP TABLE _cpa_backup");
    const violations = db.query("PRAGMA foreign_key_check").all();
    if (violations.length) throw new Error(`v8 rebuild left foreign-key violations: ${JSON.stringify(violations)}`);
  },
  (db: Database) => {
    // v9: Figma provenance on revisions (plan §J). Additive, immutable-per-revision JSON blob
    // {fileKey,nodeIds,referenceScreenshots?,lastSyncedAt?}; NULL when a revision has no link.
    db.run("ALTER TABLE prototype_revisions ADD COLUMN figma_json TEXT");
    db.run("ALTER TABLE component_revisions ADD COLUMN figma_json TEXT");
  },
  (db: Database) => {
    // v10 (W3-3): scoped public shares. Raw grant/session credentials are never persisted;
    // only SHA-256 digests are stored. A grant pins one immutable prototype publication and
    // its complete non-static dependency closure. Renderer static files deliberately stay out
    // of these tables and are resolved from the current deploy on every authorized request.
    db.run(`CREATE TABLE share_grants (
      id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      prototype_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      rev INTEGER NOT NULL,
      dependencies_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY (prototype_id, version)
        REFERENCES prototype_publishes(prototype_id, version) ON DELETE CASCADE)`);
    db.run(`CREATE INDEX share_grants_prototype_active
      ON share_grants (prototype_id, revoked_at, expires_at, created_at)`);
    db.run(`CREATE TABLE share_sessions (
      id TEXT PRIMARY KEY,
      session_hash TEXT UNIQUE NOT NULL,
      grant_id TEXT NOT NULL REFERENCES share_grants(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL)`);
    db.run(`CREATE INDEX share_sessions_grant ON share_sessions (grant_id, expires_at)`);
  },
  (db: Database) => {
    // v11 (W5-4): preserve the exact baseline used by every new visual run and retain run
    // history when an active reference is removed. Existing runs deliberately receive NULL:
    // the current reference asset may have changed since they ran, so backfilling it would
    // manufacture evidence. References are tombstoned via deleted_at; the rebuilt FK is
    // RESTRICT as a second guard against accidentally deleting their historical runs.
    db.run("ALTER TABLE visual_references ADD COLUMN deleted_at TEXT");
    db.run("DROP INDEX visual_runs_reference");
    db.run("ALTER TABLE visual_runs RENAME TO _visual_runs_v10");
    db.run(`CREATE TABLE visual_runs (
      id TEXT PRIMARY KEY,
      reference_id TEXT NOT NULL,
      reference_asset_id TEXT,
      candidate_asset_id TEXT,
      diff_asset_id TEXT,
      metric TEXT,
      metric_options_json TEXT,
      diff_pixels INTEGER,
      total_pixels INTEGER,
      diff_percent REAL,
      status TEXT NOT NULL CHECK(status IN ('pass','fail','error','reference_missing')),
      candidate_meta_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (reference_id) REFERENCES visual_references(id) ON DELETE RESTRICT,
      FOREIGN KEY (reference_asset_id) REFERENCES assets(id) ON DELETE RESTRICT,
      FOREIGN KEY (candidate_asset_id) REFERENCES assets(id) ON DELETE RESTRICT,
      FOREIGN KEY (diff_asset_id) REFERENCES assets(id) ON DELETE RESTRICT)`);
    db.run(`INSERT INTO visual_runs
      (id,reference_id,reference_asset_id,candidate_asset_id,diff_asset_id,metric,metric_options_json,
       diff_pixels,total_pixels,diff_percent,status,candidate_meta_json,created_at)
      SELECT id,reference_id,NULL,candidate_asset_id,diff_asset_id,metric,metric_options_json,
       diff_pixels,total_pixels,diff_percent,status,candidate_meta_json,created_at
      FROM _visual_runs_v10`);
    db.run("DROP TABLE _visual_runs_v10");
    db.run(`CREATE INDEX visual_runs_reference ON visual_runs (reference_id, created_at, id)`);
    const violations = db.query("PRAGMA foreign_key_check").all();
    if (violations.length) throw new Error(`v11 rebuild left foreign-key violations: ${JSON.stringify(violations)}`);
  },
  (db: Database) => {
    // v12: reverse hard-pin lookups and stable keyset pagination for the asset registry.
    db.run("CREATE INDEX assets_created_id ON assets (created_at DESC, id DESC)");
    db.run("CREATE INDEX prototype_revision_assets_asset ON prototype_revision_assets (asset_id)");
    db.run("CREATE INDEX component_publish_assets_asset ON component_publish_assets (asset_id)");
    db.run("CREATE INDEX visual_references_asset ON visual_references (asset_id)");
    db.run("CREATE INDEX visual_runs_reference_asset ON visual_runs (reference_asset_id)");
    db.run("CREATE INDEX visual_runs_candidate_asset ON visual_runs (candidate_asset_id)");
    db.run("CREATE INDEX visual_runs_diff_asset ON visual_runs (diff_asset_id)");
  },
] as const;

function assertRegistryIntegrity(db:Database):void {
  for(const table of ["components","component_revisions","prototypes"] as const) {
    const row=db.query(`SELECT design_system FROM ${table} WHERE design_system NOT IN (SELECT id FROM design_systems) LIMIT 1`).get() as {design_system:string}|null;
    if(row) throw new Error(`Dangling design system reference in ${table}: ${row.design_system}`);
  }
  const component=db.query(`SELECT c.id,c.design_system head_system,r.design_system revision_system FROM components c
    LEFT JOIN component_revisions r ON r.component_id=c.id AND r.rev=c.head_rev
    WHERE r.component_id IS NULL OR c.design_system<>r.design_system LIMIT 1`).get() as {id:string;head_system:string;revision_system:string|null}|null;
  if(component) throw new Error(`Component head design system mismatch: ${component.id}`);
  const heads=db.query(`SELECT p.id,p.design_system,r.doc FROM prototypes p
    LEFT JOIN prototype_revisions r ON r.prototype_id=p.id AND r.rev=p.head_rev`).all() as {id:string;design_system:string;doc:string|null}[];
  for(const head of heads) {
    let doc:unknown; try { doc=JSON.parse(head.doc??""); } catch { throw new Error(`Invalid prototype head document: ${head.id}`); }
    const system=(doc&&typeof doc==="object"&&(doc as {designSystem?:unknown}).designSystem)??"shadcn";
    if(system!==head.design_system) throw new Error(`Prototype head design system mismatch: ${head.id}`);
  }
  const providers=db.query("SELECT id,builtin_provider FROM design_systems WHERE builtin_provider IS NOT NULL").all() as {id:string;builtin_provider:string}[];
  for(const row of providers) if(!(row.builtin_provider in designSystems)) throw new Error(`Unknown builtin provider for design system ${row.id}: ${row.builtin_provider}`);
}

function assertBuiltinNamesDoNotCollide(db: Database): void {
  const builtinNames = new Set(Object.values(designSystems).flatMap(system => Object.keys(system.definitions)));
  const collisions = (db.query("SELECT name FROM components ORDER BY name").all() as { name: string }[])
    .map(row => row.name)
    .filter(name => builtinNames.has(name));
  if (collisions.length) {
    throw new Error(`Custom component names collide with registered builtin components: ${collisions.join(", ")}`);
  }
}

export function migrate(db: Database): void {
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA journal_mode = WAL");
  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (current < migrations.length) {
    db.transaction(() => {
      for (let index = current; index < migrations.length; index += 1) migrations[index](db);
      db.run(`PRAGMA user_version = ${migrations.length}`);
    })();
  }
  assertRegistryIntegrity(db);
  assertBuiltinNamesDoNotCollide(db);
}
