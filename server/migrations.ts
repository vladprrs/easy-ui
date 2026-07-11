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
] as const;

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
  assertBuiltinNamesDoNotCollide(db);
}
