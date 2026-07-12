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
