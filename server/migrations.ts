import type { Database } from "bun:sqlite";
import { designSystems } from "../src/designSystems";
import { migrationV15Report } from "./classify";

export const RETIRED_DESIGN_SYSTEM_TRIGGER_NAMES = [
  "prototypes_reject_retired_design_system_insert",
  "prototypes_reject_retired_design_system_update",
  "components_reject_retired_design_system_insert",
  "components_reject_retired_design_system_update",
  "component_revisions_reject_retired_design_system_insert",
  "component_revisions_reject_retired_design_system_update",
  "prototype_revisions_reject_retired_design_system_insert",
  "prototype_revisions_reject_retired_design_system_update",
  "compositions_reject_retired_design_system_insert",
  "compositions_reject_retired_design_system_update",
  "composition_revisions_reject_retired_design_system_insert",
  "composition_revisions_reject_retired_design_system_update",
] as const;

/** Экспортируется ради тестов миграций (backfill R3a прогоняется на «старой» БД до v27). */
export const migrations = [
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
    // Именно этот инвариант — причина, по которой шаг v25 добавил `candidate_id`/`acceptance_run_id`
    // плоскими TEXT-колонками БЕЗ FK на `component_candidates`/`acceptance_runs` (амендмент A9
    // плана family-acceptance): любой новый FK-ребёнок расширял бы контракт этой перестройки,
    // а `ON DELETE SET NULL` + TTL-GC ранов молча терял бы provenance опубликованной версии.
    // Колонки-свидетельства сами по себе перестройку не затрагивают: они на родителе, а
    // `INSERT INTO component_publishes (...) SELECT ...` выше перечисляет столбцы явно.
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
  (db: Database) => {
    // v13: immutable prototype incarnation + atomic visual baseline sets. SQLite cannot
    // add NOT NULL to an existing column, so populated databases follow the required
    // nullable -> per-row UUID -> table rebuild sequence.
    db.run("ALTER TABLE prototypes ADD COLUMN instance_id TEXT");
    const rows = db.query("SELECT id FROM prototypes WHERE instance_id IS NULL ORDER BY id").all() as { id: string }[];
    const backfill = db.query("UPDATE prototypes SET instance_id=? WHERE id=?");
    for (const row of rows) backfill.run(crypto.randomUUID(), row.id);
    db.run("PRAGMA legacy_alter_table = ON");
    db.run("ALTER TABLE prototypes RENAME TO _prototypes_v12");
    db.run(`CREATE TABLE prototypes (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
      device TEXT NOT NULL, screen_count INTEGER NOT NULL,
      head_rev INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      design_system TEXT NOT NULL DEFAULT 'shadcn', instance_id TEXT NOT NULL)`);
    db.run(`INSERT INTO prototypes
      (id,name,description,device,screen_count,head_rev,created_at,updated_at,design_system,instance_id)
      SELECT id,name,description,device,screen_count,head_rev,created_at,updated_at,design_system,instance_id
      FROM _prototypes_v12`);
    db.run("DROP TABLE _prototypes_v12");
    db.run("PRAGMA legacy_alter_table = OFF");
    db.run(`CREATE TABLE visual_baseline_sets (
      id TEXT PRIMARY KEY,
      prototype_id TEXT NOT NULL,
      prototype_instance_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      rev INTEGER NOT NULL,
      members_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(prototype_id, generation))`);
  },
  (db: Database) => {
    // v14: named users, hashed cookie sessions, resource ownership/visibility and audit trail.
    db.run(`CREATE TABLE users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0 CHECK(is_admin IN (0,1)),
      created_at TEXT NOT NULL)`);
    db.run(`CREATE TABLE user_sessions (
      id TEXT PRIMARY KEY, session_hash TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`);
    db.run("CREATE INDEX user_sessions_user ON user_sessions(user_id, expires_at)");
    db.run("ALTER TABLE prototypes ADD COLUMN owner_id TEXT REFERENCES users(id)");
    db.run(`ALTER TABLE prototypes ADD COLUMN status TEXT NOT NULL DEFAULT 'private'
      CHECK(status IN ('private','published','archived'))`);
    db.run("UPDATE prototypes SET status='published'");
    db.run("ALTER TABLE components ADD COLUMN owner_id TEXT REFERENCES users(id)");
    db.run("ALTER TABLE design_systems ADD COLUMN owner_id TEXT REFERENCES users(id)");
    db.run(`CREATE TABLE audit_events (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, actor_id TEXT NOT NULL,
      action TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
      detail TEXT)`);
    db.query(`INSERT INTO audit_events (id,at,actor_id,action,subject_type,subject_id,detail)
      VALUES (?,?,?,?,?,?,?)`).run(`audit_${crypto.randomUUID()}`, new Date().toISOString(), "system", "migration.applied", "migration", "v14", null);
  },
  (db:Database) => {
    // v15: built-in design systems remain readable for immutable history but leave every
    // selection/write model. Renderability is evaluated per exact revision, including grants.
    db.run("ALTER TABLE design_systems ADD COLUMN retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0,1))");
    db.run("UPDATE design_systems SET retired=1 WHERE builtin_provider IS NOT NULL");

    for(const table of ["prototypes","components","component_revisions"] as const) {
      db.run(`CREATE TRIGGER ${table}_reject_retired_design_system_insert
        BEFORE INSERT ON ${table}
        WHEN EXISTS (SELECT 1 FROM design_systems WHERE id=NEW.design_system AND retired=1)
        BEGIN SELECT RAISE(ABORT,'retired design system reference'); END`);
      db.run(`CREATE TRIGGER ${table}_reject_retired_design_system_update
        BEFORE UPDATE OF design_system ON ${table}
        WHEN EXISTS (SELECT 1 FROM design_systems WHERE id=NEW.design_system AND retired=1)
        BEGIN SELECT RAISE(ABORT,'retired design system reference'); END`);
    }
    db.run(`CREATE TRIGGER prototype_revisions_reject_retired_design_system_insert
      BEFORE INSERT ON prototype_revisions
      WHEN EXISTS (
        SELECT 1 FROM prototypes p JOIN design_systems ds
          ON ds.id=COALESCE(json_extract(NEW.doc,'$.designSystem'),p.design_system)
        WHERE p.id=NEW.prototype_id AND ds.retired=1)
      BEGIN SELECT RAISE(ABORT,'retired design system reference'); END`);
    db.run(`CREATE TRIGGER prototype_revisions_reject_retired_design_system_update
      BEFORE UPDATE OF prototype_id,doc ON prototype_revisions
      WHEN EXISTS (
        SELECT 1 FROM prototypes p JOIN design_systems ds
          ON ds.id=COALESCE(json_extract(NEW.doc,'$.designSystem'),p.design_system)
        WHERE p.id=NEW.prototype_id AND ds.retired=1)
      BEGIN SELECT RAISE(ABORT,'retired design system reference'); END`);

    const impact=migrationV15Report(db);
    const at=new Date().toISOString();
    const archive=db.query("UPDATE prototypes SET status='archived',updated_at=? WHERE id=?");
    for(const id of impact.prototypesToArchive) archive.run(at,id);
    const revoke=db.query("UPDATE share_grants SET revoked_at=? WHERE id=? AND revoked_at IS NULL");
    const deleteSessions=db.query("DELETE FROM share_sessions WHERE grant_id=?");
    for(const id of impact.shareGrantsToRevoke) { revoke.run(at,id); deleteSessions.run(id); }
  },
  (db:Database) => {
    // v16: prototype lifecycle metadata (волна 0). Три плоских ADD COLUMN, без перестройки
    // таблицы — существующие строки становятся 'product-flow', и галерея не пустеет.
    // `kind` намеренно без CHECK: SQLite принял бы column-level CHECK в ADD COLUMN, но тогда
    // расширение таксономии потребовало бы полной перестройки таблицы. Допустимые значения
    // живут в одном месте — `PROTOTYPE_KINDS` (src/api/client.ts) — и проверяются zod-контрактом
    // на входе API (server/contracts.ts).
    db.run("ALTER TABLE prototypes ADD COLUMN kind TEXT NOT NULL DEFAULT 'product-flow'");
    // JSON-массив slug-тегов (NULL == тегов нет). Валидация формата — в zod-контракте.
    db.run("ALTER TABLE prototypes ADD COLUMN tags TEXT");
    // Идентификатор прототипа-источника. Без FK: линия происхождения переживает удаление источника.
    db.run("ALTER TABLE prototypes ADD COLUMN derived_from TEXT");
  },
  (db:Database) => {
    // v17: tombstone-метаданные мягко удалённых компонентов (волна 3 §3.2). Два плоских
    // ADD COLUMN: `components` не имеет FK-детей с RESTRICT на себя (пины ссылаются на
    // component_publishes), поэтому перестройка таблицы по паттерну v8 здесь не нужна.
    // Причина удаления — свободный текст автора DELETE.
    db.run("ALTER TABLE components ADD COLUMN delete_reason TEXT");
    // Идентификатор компонента-замены. Без FK: замена может быть удалена позже, и
    // надгробие обязано пережить это, как и `prototypes.derived_from` в v16.
    db.run("ALTER TABLE components ADD COLUMN replacement_component_id TEXT");
  },
  (db:Database) => {
    // v18: версионированные композиции (волна 5, план 2026-07-27 §5.1). Четыре новые таблицы,
    // зеркало компонентных: head_rev + ревизии + публикации + пины ревизии прототипа.
    // Перестройка существующих таблиц не требуется (только CREATE TABLE), поэтому
    // child-snapshot порядок из комментария v8 здесь неприменим.
    db.run(`CREATE TABLE compositions (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, head_rev INTEGER NOT NULL,
      design_system TEXT NOT NULL REFERENCES design_systems(id),
      owner_id TEXT REFERENCES users(id),
      deleted_at TEXT, delete_reason TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    db.run(`CREATE TABLE composition_revisions (
      composition_id TEXT NOT NULL REFERENCES compositions(id), rev INTEGER NOT NULL,
      doc TEXT NOT NULL, design_system TEXT NOT NULL,
      message TEXT, author TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY (composition_id, rev))`);
    // Публикация композиции неизменяема: `source_hash` — sha256 канонического JSON документа.
    // Статусы зеркалят компонентные (K.2/K.3) минус staging/failed: сборки у композиции нет.
    db.run(`CREATE TABLE composition_publishes (
      composition_id TEXT NOT NULL REFERENCES compositions(id), version INTEGER NOT NULL,
      rev INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','deprecated','superseded','archived')),
      status_reason TEXT, superseded_by INTEGER, status_rev INTEGER NOT NULL DEFAULT 1,
      source_hash TEXT NOT NULL, message TEXT, published_at TEXT NOT NULL,
      PRIMARY KEY (composition_id, version), UNIQUE (composition_id, rev),
      FOREIGN KEY (composition_id, rev) REFERENCES composition_revisions(composition_id, rev))`);
    // Пины композиций ревизии прототипа. FK RESTRICT — тот же инвариант, что у компонентов:
    // опубликованная версия прототипа не может ссылаться на удаляемую публикацию композиции.
    db.run(`CREATE TABLE prototype_revision_compositions (
      prototype_id TEXT NOT NULL, rev INTEGER NOT NULL, composition_id TEXT NOT NULL,
      composition_version INTEGER NOT NULL, PRIMARY KEY (prototype_id, rev, composition_id),
      FOREIGN KEY (prototype_id, rev) REFERENCES prototype_revisions(prototype_id, rev) ON DELETE CASCADE,
      FOREIGN KEY (composition_id, composition_version)
        REFERENCES composition_publishes(composition_id, version) ON DELETE RESTRICT)`);
  },
  (db:Database) => {
    // v19: сценарии взаимодействия прототипа (волна 6, план 2026-07-27 §«Волна 6»).
    // Сценарий принадлежит прототипу и умирает вместе с ним — ON DELETE CASCADE, как у
    // `prototype_revisions`/`prototype_publishes`. Составной PK (prototype_id, id): id
    // уникален в пределах прототипа, а не глобально. Шаги хранятся JSON-массивом —
    // схема живёт в `src/prototype/scenario.ts` и валидируется на границе API.
    // Таблицы прогонов нет сознательно: раннер клиентский (триаж ревью).
    db.run(`CREATE TABLE prototype_scenarios (
      prototype_id TEXT NOT NULL REFERENCES prototypes(id) ON DELETE CASCADE,
      id TEXT NOT NULL, name TEXT NOT NULL, steps_json TEXT NOT NULL,
      author TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (prototype_id, id))`);
  },
  (db:Database) => {
    // v20: гейт переиспользования компонентов (план 2026-07-31 §3.6).
    //
    // `catalog_reuse_decisions` — append-only аудит каждого решения гейта.
    // Намеренно БЕЗ FK на `components(id)`: решения `blocked`/`would_block` ссылаются на
    // *предложенный* id компонента, которого в базе нет и не будет (создание отклонено), а
    // `migrate()` гоняет `PRAGMA foreign_key_check` после всех миграций — FK сделал бы такую
    // запись невозможной. По той же причине нет FK на `actor_id`: аудит обязан пережить
    // удаление пользователя. Целостность здесь слабее сознательно: запись аудита не должна
    // уметь провалиться из-за чужого состояния.
    //
    // `decision`:
    //   accepted_no_match — совпадений нет, компонент создан;
    //   blocked           — enforce, создание отклонено (409);
    //   would_block       — shadow, совпадение было, компонент всё равно создан. Без этого
    //                       значения shadow-фаза ненаблюдаема: `accepted_no_match` соврал бы
    //                       про отсутствие совпадения, `blocked` — про отсутствие компонента;
    //   force_new         — админский override поверх blocking-кандидатов;
    //   intent_missing    — intent не задан (в shadow синтезирован из имени).
    //
    // `candidates_json` — компактные строки (id/score/blocking/reasons/propsDelta): имена
    // пропов допустимы, значения props, исходники и токены — нет.
    db.run(`CREATE TABLE catalog_reuse_decisions (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      artifact_kind TEXT NOT NULL CHECK(artifact_kind IN ('component','composition','prototype')),
      artifact_id TEXT NOT NULL,
      design_system TEXT NOT NULL,
      source_or_doc_hash TEXT NOT NULL,
      catalog_revision TEXT NOT NULL,
      policy_version INTEGER NOT NULL,
      gate_mode TEXT NOT NULL CHECK(gate_mode IN ('shadow','enforce')),
      intent TEXT,
      candidates_json TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('accepted_no_match','blocked','would_block','force_new','intent_missing')),
      reason TEXT,
      created_at TEXT NOT NULL)`);
    // Append-only enforced в самой БД, а не соглашением в репозитории: аудит гейта, который
    // можно переписать тем же процессом, что гейт обходит, аудитом не является.
    db.run(`CREATE TRIGGER catalog_reuse_decisions_no_update BEFORE UPDATE ON catalog_reuse_decisions
      BEGIN SELECT RAISE(ABORT, 'catalog_reuse_decisions is append-only'); END`);
    db.run(`CREATE TRIGGER catalog_reuse_decisions_no_delete BEFORE DELETE ON catalog_reuse_decisions
      BEGIN SELECT RAISE(ABORT, 'catalog_reuse_decisions is append-only'); END`);
    // (actor_id, created_at) — «повторяющиеся попытки актора» и агрегаты §5;
    // (artifact_id) — история конкретного предложенного id; (decision) — выборки по типу.
    db.run("CREATE INDEX catalog_reuse_decisions_actor ON catalog_reuse_decisions (actor_id, created_at)");
    db.run("CREATE INDEX catalog_reuse_decisions_artifact ON catalog_reuse_decisions (artifact_id)");
    db.run("CREATE INDEX catalog_reuse_decisions_decision ON catalog_reuse_decisions (decision)");

    // `component_fingerprints` — строго content-addressed КЭШ шинглов исходника, не источник
    // истины. Ключ (component_id, rev, source_sha256): при любом расхождении содержимого ключ
    // не совпадает, промах пересчитывается на лету и пишется write-through — restore без
    // checkSource, импортёр и прямые скрипты самозалечиваются. Props/io/структурные подписи и
    // описание здесь НЕ хранятся: они читаются из `definition_meta` активной публикации,
    // поэтому двух источников истины (и их расхождения) не возникает по построению.
    // Без FK на `components(id)`: кэш считается и для *предложенного* компонента до вставки.
    db.run(`CREATE TABLE component_fingerprints (
      component_id TEXT NOT NULL,
      rev INTEGER NOT NULL,
      source_sha256 TEXT NOT NULL,
      shingles_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (component_id, rev, source_sha256))`);
  },
  (db: Database) => {
    // v21: Composition v2 closure metadata and the production migration ledger.
    // Existing v1 publications remain byte-for-byte compatible: their document and
    // source_hash are untouched; the new manifest columns are filled for new v2
    // publications and default to an empty closure for historical rows.
    db.run("ALTER TABLE composition_publishes ADD COLUMN dependency_manifest_json TEXT NOT NULL DEFAULT '[]'");
    db.run("ALTER TABLE composition_publishes ADD COLUMN dependency_manifest_hash TEXT NOT NULL DEFAULT ''");

    db.run(`CREATE TRIGGER compositions_reject_retired_design_system_insert
      BEFORE INSERT ON compositions
      WHEN EXISTS (SELECT 1 FROM design_systems WHERE id=NEW.design_system AND retired=1)
      BEGIN SELECT RAISE(ABORT,'retired design system reference'); END`);
    db.run(`CREATE TRIGGER compositions_reject_retired_design_system_update
      BEFORE UPDATE OF design_system ON compositions
      WHEN EXISTS (SELECT 1 FROM design_systems WHERE id=NEW.design_system AND retired=1)
      BEGIN SELECT RAISE(ABORT,'retired design system reference'); END`);
    db.run(`CREATE TRIGGER composition_revisions_reject_retired_design_system_insert
      BEFORE INSERT ON composition_revisions
      WHEN EXISTS (SELECT 1 FROM design_systems WHERE id=NEW.design_system AND retired=1)
      BEGIN SELECT RAISE(ABORT,'retired design system reference'); END`);
    db.run(`CREATE TRIGGER composition_revisions_reject_retired_design_system_update
      BEFORE UPDATE OF design_system ON composition_revisions
      WHEN EXISTS (SELECT 1 FROM design_systems WHERE id=NEW.design_system AND retired=1)
      BEGIN SELECT RAISE(ABORT,'retired design system reference'); END`);

    // Cross-artifact replacement identity deliberately has no FK to the source
    // artifact: the source is soft-deleted after cutover and the mapping must stay
    // queryable. The destination design system is kept as a reference for readable
    // audit data, while ids remain historical coordinates rather than live FKs.
    db.run(`CREATE TABLE catalog_replacements (
      from_kind TEXT NOT NULL CHECK(from_kind IN ('component','composition')),
      from_id TEXT NOT NULL,
      from_design_system TEXT NOT NULL REFERENCES design_systems(id),
      to_kind TEXT NOT NULL CHECK(to_kind IN ('component','composition')),
      to_id TEXT NOT NULL,
      to_design_system TEXT NOT NULL REFERENCES design_systems(id),
      migration_run_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (from_kind, from_id, from_design_system))`);
    db.run("CREATE INDEX catalog_replacements_target ON catalog_replacements (to_kind, to_id, to_design_system)");
    db.run("CREATE INDEX catalog_replacements_run ON catalog_replacements (migration_run_id)");

    db.run(`CREATE TABLE catalog_migration_runs (
      id TEXT PRIMARY KEY,
      plan_hash TEXT NOT NULL UNIQUE,
      catalog_revision TEXT NOT NULL,
      data_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('prepared','applying','applied','aborted','rolled_back')),
      generated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      backup_id TEXT,
      reason TEXT)
    `);
    db.run(`CREATE TABLE catalog_migration_staging (
      run_id TEXT NOT NULL REFERENCES catalog_migration_runs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('component','composition','prototype')),
      artifact_id TEXT NOT NULL,
      design_system TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('staged','activated','aborted')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, kind, artifact_id, design_system))`);
    db.run("CREATE INDEX catalog_migration_staging_status ON catalog_migration_staging (run_id, status)");

    // A single-row policy activation timestamp distinguishes legacy TSX artifacts
    // from newly authored ones. It is persisted in the database so a restore or a
    // second process cannot silently choose a different rollout boundary.
    db.run(`CREATE TABLE atomic_policy (
      id INTEGER PRIMARY KEY CHECK(id=1),
      activated_at TEXT NOT NULL,
      policy_version INTEGER NOT NULL DEFAULT 1,
      activated_by TEXT NOT NULL)
    `);
    db.query("INSERT INTO atomic_policy (id,activated_at,policy_version,activated_by) VALUES (1,?,?,?)")
      .run(new Date().toISOString(), 1, "system");

    // Application-level write lock used by the protected cutover. Reads remain
    // available; the HTTP layer rejects unrelated unsafe operations while active.
    db.run(`CREATE TABLE maintenance_locks (
      id INTEGER PRIMARY KEY CHECK(id=1),
      run_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      acquired_at TEXT NOT NULL)
    `);
  },
  (db: Database) => {
    // v22: head-tracking служебных прототипов (план 2026-08-02, P2). Плоский ADD COLUMN
    // по прецеденту v16: существующие строки становятся 'pinned' (сегодняшнее поведение —
    // пины ревизии), 'head' разрешает read-пути резолвить компонентные пины на последние
    // active-публикации. Намеренно БЕЗ CHECK — точка контроля, как у `kind`, zod-контракт
    // (`prototypeTrackSchema`), иначе расширение значений потребует перестройки таблицы.
    // Формат документа не трогается (z.strictObject на stored-документе), поэтому откат
    // образа безопасен: старый код игнорирует колонку, а 'pinned' — его собственная семантика.
    db.run("ALTER TABLE prototypes ADD COLUMN track TEXT NOT NULL DEFAULT 'pinned'");
  },
  (db: Database) => {
    // v23: версионирование резолвера spacing-шкалы (план 2026-08-02, P6.3б). `resolveSpacingScale`
    // стоит на read-пути (сводка DS, capabilities, пины ревизий, съёмка), поэтому «починить мердж
    // на базу DS» и «не переехать существующим версиям» одновременно достижимо только через явную
    // версию алгоритма на строке версии темы. Плоский ADD COLUMN по прецеденту v16/v22: все
    // существующие строки бэкфилятся дефолтом `1` (legacy-поведение байт-в-байт), новые версии
    // пишутся с `2` (см. CURRENT_SPACING_RESOLVER; kill-switch EASYUI_THEME_RESOLVER_V2_DISABLED
    // возвращает запись `1`). Намеренно без CHECK — точка контроля контрактная, как у `kind`/`track`.
    // Откат образа безопасен: старый код колонку не читает и резолвит всё legacy-путём.
    db.run("ALTER TABLE design_system_versions ADD COLUMN spacing_resolver INTEGER NOT NULL DEFAULT 1");
  },
  (db: Database) => {
    // v24: мульти-поверхностные документы (план 2026-08-02 multi-surface-flows, W3).
    //
    // 1. Пин темы становится картой «дизайн-система → версия темы». Колонка
    //    `prototype_revisions.design_system_meta_version` **остаётся** значением primary-ДС
    //    (совместимость: её читают старый образ, диффы и capture-handshake). Бэкфила нет
    //    by design: ревизия без строк читается как `{primary: колонка}` — см. `themePinsOf`
    //    в `server/repos/prototypes.ts` и `docs/server-api.md`.
    // 2. Триггеры ретайрнутых ДС на `prototype_revisions` пересоздаются (DROP+CREATE тех же
    //    двух имён — список `RETIRED_DESIGN_SYSTEM_TRIGGER_NAMES` не меняется): тела шага v15
    //    forward-only и задним числом не переигрываются. Новое условие смотрит ещё и в
    //    `doc.surfaces[].designSystem`. `json_each` по документу без `surfaces` даёт 0 строк,
    //    поэтому обычные ревизии ведут себя ровно как раньше.
    db.run(`CREATE TABLE prototype_revision_theme_pins (
      prototype_id TEXT NOT NULL, rev INTEGER NOT NULL,
      design_system TEXT NOT NULL, meta_version INTEGER,
      PRIMARY KEY (prototype_id, rev, design_system),
      FOREIGN KEY (prototype_id, rev) REFERENCES prototype_revisions(prototype_id, rev) ON DELETE CASCADE)`);

    for (const suffix of ["insert", "update"] as const) {
      db.run(`DROP TRIGGER IF EXISTS prototype_revisions_reject_retired_design_system_${suffix}`);
      db.run(`CREATE TRIGGER prototype_revisions_reject_retired_design_system_${suffix}
        BEFORE ${suffix === "insert" ? "INSERT" : "UPDATE OF prototype_id,doc"} ON prototype_revisions
        WHEN EXISTS (
          SELECT 1 FROM prototypes p JOIN design_systems ds
            ON ds.id=COALESCE(json_extract(NEW.doc,'$.designSystem'),p.design_system)
          WHERE p.id=NEW.prototype_id AND ds.retired=1)
        OR EXISTS (
          SELECT 1 FROM json_each(json_extract(NEW.doc,'$.surfaces'))
          WHERE json_extract(value,'$.designSystem') IN (SELECT id FROM design_systems WHERE retired=1))
        BEGIN SELECT RAISE(ABORT,'retired design system reference'); END`);
    }
  },
  (db: Database) => {
    // v25: durable-слой candidate acceptance (RFC 2026-08-02 §3.2–3.3 с амендментами A1/A4/A9,
    // план 2026-08-03 family-acceptance §5 W1a). Схема вводится целиком одной миграцией, потому
    // что четыре таблицы связаны одним жизненным циклом (кандидат → run → случаи → CAS-результаты)
    // и половинчатое состояние никому не полезно.
    //
    // 1. `component_candidates` — идентичность **component-scoped** (RFC §5/триаж E1): PK уже
    //    содержит componentId+designSystem+rev+buildFingerprint, поэтому один `source_hash`,
    //    принадлежащий нескольким компонентам, не коллидирует и не даёт cross-owner disclosure.
    //    `build_fingerprint` — обычный индекс, НЕ unique (несколько компонентов/ревизий законно
    //    делят сборочный отпечаток). `observed_catalog_revision` — справка, вне идентичности.
    //    Строка иммутабельна кроме status/status_reason/acceptance_run_id/promoted_version.
    // 2. `acceptance_runs` — иммутабелен после терминализации (D2). FK на `component_candidates`
    //    допустим: обе таблицы создаются этим же шагом, ребёнок находится в acceptance-подсистеме
    //    и не участвует в v8-перестройке `component_publishes`. Partial unique index —
    //    «≤1 нетерминальный run на кандидата» (триаж E4): `SQLITE_CONSTRAINT` маппится
    //    репозиторием в доменный `acceptance_run_in_flight` → 409. Это первый partial index
    //    в проекте.
    // 3. `acceptance_cases` — единственная мутируемая часть рана (D2); поля качества капчура
    //    (D11) и severity живут здесь, run несёт только агрегат.
    // 4. `acceptance_case_results` — cross-run кэш по `case_fingerprint` (D1) для reuse/дедупа;
    //    `component_id` денормализован, потому что reuse обязан проверять владение. Ссылок FK
    //    на раны нет намеренно: GC ранов не должен каскадом рушить кэш результатов.
    // 4a. `component_candidates.policy_profile_hash` — **информационный штамп**: хэш профиля,
    //    действовавшего на момент заморозки кандидата (всегда `default-v1`, политику кандидат не
    //    выбирает — RFC-инвариант «policy вне идентичности кандидата»). В promote-предикате он
    //    **не участвует** с волны W3 плана 2026-08-04: сверка с ним делала любой
    //    `pixel-strict-v1`-ран непромоутабельным (P0-2). Промоутабельность решает профиль **рана**
    //    (`acceptance_runs.policy_profile_id` ∈ `PROMOTION_POLICY_PROFILES`).
    // 5. `component_publishes.candidate_id`/`acceptance_run_id` — плоские TEXT без FK (A9,
    //    см. комментарий-инвариант v8 выше). `design_systems.acceptance` — с обязательным
    //    DEFAULT 'off': старый код (`routes/designSystems.ts`, `bundle/importer.ts`) INSERT'ит
    //    без этой колонки, поэтому откат образа обязан оставаться безопасным. CHECK намеренно
    //    нет — точка контроля контрактная, как у `kind`/`track`.
    db.run(`CREATE TABLE component_candidates (
      candidate_id TEXT PRIMARY KEY,
      component_id TEXT NOT NULL, design_system TEXT NOT NULL, rev INTEGER NOT NULL,
      source_hash TEXT NOT NULL, bundle_hash TEXT NOT NULL, host_abi_version INTEGER NOT NULL,
      theme_version INTEGER,
      build_fingerprint TEXT NOT NULL,
      observed_catalog_revision TEXT NOT NULL,
      policy_profile_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('validated','promoted')),
      status_reason TEXT,
      acceptance_run_id TEXT,
      promoted_version INTEGER,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`);
    db.run("CREATE INDEX component_candidates_build_fingerprint ON component_candidates (build_fingerprint)");
    db.run("CREATE INDEX component_candidates_component ON component_candidates (component_id, created_at)");
    db.run("CREATE INDEX component_candidates_expires ON component_candidates (expires_at)");

    db.run(`CREATE TABLE acceptance_runs (
      run_id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL REFERENCES component_candidates(candidate_id),
      component_id TEXT NOT NULL,
      idempotency_key TEXT,
      status TEXT NOT NULL CHECK(status IN ('queued','running','pass','pass_with_exceptions','fail','error','cancelled')),
      policy_profile_hash TEXT NOT NULL,
      case_set_id TEXT,
      policy_profile_id TEXT NOT NULL,
      progress_json TEXT NOT NULL,
      impact_json TEXT,
      gates_json TEXT NOT NULL,
      evidence_manifest_hash TEXT,
      started_at TEXT, finished_at TEXT,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE (candidate_id, idempotency_key))`);
    db.run(`CREATE UNIQUE INDEX acceptance_runs_one_in_flight
      ON acceptance_runs (candidate_id) WHERE status IN ('queued','running')`);
    db.run("CREATE INDEX acceptance_runs_component ON acceptance_runs (component_id, created_at)");
    db.run("CREATE INDEX acceptance_runs_status ON acceptance_runs (status, started_at)");

    db.run(`CREATE TABLE acceptance_cases (
      run_id TEXT NOT NULL REFERENCES acceptance_runs(run_id) ON DELETE CASCADE,
      case_id TEXT NOT NULL,
      case_key TEXT NOT NULL,
      props_hash TEXT NOT NULL,
      case_fingerprint TEXT NOT NULL,
      case_policy_hash TEXT NOT NULL,
      reference_asset_id TEXT,
      expected_geometry_json TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending','running','done','error','skipped')),
      verdict TEXT,
      gates_json TEXT,
      severity_json TEXT,
      capture_quality_json TEXT,
      alias_of_case_id TEXT,
      reuse_reason TEXT,
      started_at TEXT, finished_at TEXT,
      PRIMARY KEY (run_id, case_id))`);
    db.run("CREATE INDEX acceptance_cases_fingerprint ON acceptance_cases (case_fingerprint)");

    db.run(`CREATE TABLE acceptance_case_results (
      case_fingerprint TEXT PRIMARY KEY,
      component_id TEXT NOT NULL,
      artifacts_json TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      verdict TEXT NOT NULL,
      produced_run_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL)`);
    db.run("CREATE INDEX acceptance_case_results_last_used ON acceptance_case_results (last_used_at)");

    db.run("ALTER TABLE component_publishes ADD COLUMN candidate_id TEXT DEFAULT NULL");
    db.run("ALTER TABLE component_publishes ADD COLUMN acceptance_run_id TEXT DEFAULT NULL");
    db.run("ALTER TABLE design_systems ADD COLUMN acceptance TEXT NOT NULL DEFAULT 'off'");
  },
  (db: Database) => {
    // v26: case-set-манифесты (план 2026-08-03 family-acceptance §5 W2, амендмент A2; RFC §3.3).
    //
    // Манифест — сущность продукта, а не ассет: сервер обязан валидировать полноту tuples,
    // ссылки на эталоны, дубли props и crop lineage, поэтому набор случаев живёт своей таблицей,
    // а не JSON-блобом в asset-store (у которого нет ни схемы, ни владельца, ни GC).
    //
    // `case_set_id` — контентный адрес (`cset_` + sha256 канонизованного манифеста): повторная
    // публикация того же манифеста идемпотентна и возвращает ту же строку, а изменённый манифест
    // **никогда** не переписывает старый — раны, сославшиеся на прежний `case_set_id`, обязаны
    // оставаться воспроизводимыми (`acceptance_runs.case_set_id` — плоский TEXT без FK, канон A9).
    //
    // FK на `components` нет по той же причине: удаление компонента не должно рвать провенанс
    // уже проведённых приёмок; владение проверяется по денормализованному `component_id`.
    db.run(`CREATE TABLE component_case_sets (
      case_set_id TEXT PRIMARY KEY,
      component_id TEXT NOT NULL,
      design_system TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      case_count INTEGER NOT NULL,
      source_file_key TEXT,
      source_node_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL)`);
    db.run("CREATE INDEX component_case_sets_component ON component_case_sets (component_id, created_at)");
  },
  (db: Database) => {
    // v27: provenance-слой компонентов + надгробия решений по кандидатам
    // (RFC candidate-acceptance §3.2а/§6/§8, волна R3a). Номер — следующий свободный на момент
    // посадки (§8, триаж раунд2-m2); обе таблицы и backfill — **одна** миграция, потому что они
    // садятся одной волной и должны быть атомарны относительно отката образа.
    //
    // 1. `component_provenance` — append-only история ссылок на Figma, отвязанная от ревизий и
    //    версий: правка provenance больше не требует ни новой ревизии, ни metadata-only версии
    //    (§3.5 improvements: ButtonGroup v2↔v3, Timer v2↔v3). Резолв — cross-revision, последняя
    //    запись по `(rev, seq)` среди `rev' ≤ rev` (`server/figma.ts:resolveProvenanceRaw`).
    //    Строка с `figma_json IS NULL` — **tombstone** (явная очистка), а не «нет записи».
    //    Колонка `component_revisions.figma_json` продолжает заполняться write-путями и остаётся
    //    фолбэком для исторических ревизий, у которых seq-записей нет.
    // 2. `candidate_decisions` — append-only надгробия отклонений кандидатов (§3.2а). Таблица
    //    заводится здесь, чтобы не расширять CHECK-enum `component_candidates.status`
    //    (в SQLite это перестройка таблицы, которую §8 обещает не делать). Ручка reject,
    //    предикат promote и правка свипера — **волна R3b**, эта миграция только даёт им схему.
    //    FK `ON DELETE CASCADE` держит целостность на путях удаления кандидата; partial unique
    //    index — арбитр гонки двойного reject (`SQLITE_CONSTRAINT` → `409 candidate_already_rejected`).
    // 3. Backfill (§6, триаж раунд2-B2): наследования provenance в `repo.save` нет вовсе
    //    (`figma_json` по умолчанию `null`), поэтому у компонентов без seq-записей первый же
    //    source-PUT без `figma` обнулил бы provenance головы — резолвер провалился бы на пустую
    //    колонку новой ревизии. Один `INSERT … SELECT` по head-ревизиям с непустым `figma_json`
    //    закрывает это forward-only и идемпотентно относительно PK.
    db.run(`CREATE TABLE component_provenance (
      component_id TEXT NOT NULL,
      rev INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      figma_json TEXT,
      author TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (component_id, rev, seq))`);
    db.run("CREATE INDEX component_provenance_lookup ON component_provenance (component_id, rev DESC, seq DESC)");

    db.run(`CREATE TABLE candidate_decisions (
      candidate_id TEXT NOT NULL REFERENCES component_candidates(candidate_id) ON DELETE CASCADE,
      decision TEXT NOT NULL CHECK(decision IN ('rejected')),
      reason TEXT,
      actor TEXT,
      created_at TEXT NOT NULL)`);
    db.run("CREATE UNIQUE INDEX candidate_decisions_one_rejected ON candidate_decisions (candidate_id) WHERE decision='rejected'");
    db.run("CREATE INDEX candidate_decisions_candidate ON candidate_decisions (candidate_id)");

    db.query(`INSERT INTO component_provenance (component_id,rev,seq,figma_json,author,created_at)
      SELECT r.component_id, r.rev, 1, r.figma_json, ?, ?
      FROM component_revisions r
      JOIN components c ON c.id=r.component_id AND c.head_rev=r.rev
      WHERE r.figma_json IS NOT NULL`).run("migration:component_provenance", new Date().toISOString());
  },
  (db: Database) => {
    // v28: cross-renderer guard на визуальных эталонах
    // (план `docs/plans/2026-08-03-renderer-contract-2.md` §5 **R6**, N6/N7). Единственная
    // миграция пакета renderer-contract-2; номер — следующий свободный (v27 занят волной R3a RFC).
    //
    // Три инварианта, из которых следует форма этой миграции — **только `ADD COLUMN`, без FK,
    // без CHECK, без перестройки таблиц**:
    //
    // 1. `visual_references.fingerprint_json` **не расширяется** (N6). `vref_sha256(...)` — это
    //    PK/UNIQUE эталона, он записан в `visual_baseline_sets.members_json`, а
    //    `fingerprintSchema` — `z.strictObject`: новое поле внутри отпечатка сменило бы id всех
    //    эталонов и дало бы 422 на каждом PUT. Поэтому рендерер — **аддитивные атрибуты рядом**
    //    с identity, а не её часть.
    // 2. `visual_runs.status` **не расширяется новым значением** (N7): колонка под
    //    `CHECK(status IN ('pass','fail','error','reference_missing'))`, и добавление значения в
    //    SQLite — перестройка таблицы. Cross-renderer исход выражается парой
    //    `status='error'` + `outcome_code` ('renderer_mismatch' | 'stale_renderer').
    // 3. **Откат образа переживается**: обе таблицы читаются `SELECT *`, но ни один потребитель
    //    не сериализует row наружу (`runReport`/`referencePublic` собирают ответ по полям),
    //    поэтому старый образ на БД v28 стартует и отдаёт эталоны, просто не видя новых колонок.
    //    Инвариант закреплён тестом (`server/visual-renderer-guard.test.ts`).
    //
    // Носитель истины о рендерере эталона — инлайновый `renderer_json` (переживает TTL/LRU
    // receipt-стора); `receipt_sha256` — evidence-ссылка, поддержанная пином свипера
    // (`server/main.ts`, канон `candidatePins`). NULL во всех пяти колонках значит ровно одно:
    // «происхождение кадра неизвестно» — это `unknown` guard'а, а не «совпало».
    for (const column of [
      "renderer_fingerprint TEXT",
      "renderer_json TEXT",
      "font_manifest_hash TEXT",
      "receipt_sha256 TEXT",
      "renderer_recorded_at TEXT",
    ]) db.run(`ALTER TABLE visual_references ADD COLUMN ${column}`);
    for (const column of [
      "renderer_guard TEXT",
      "outcome_code TEXT",
      "candidate_receipt_sha256 TEXT",
      "reference_receipt_sha256 TEXT",
    ]) db.run(`ALTER TABLE visual_runs ADD COLUMN ${column}`);
  },
  (db: Database) => {
    // v29: расслоение отпечатка случая приёмки на три слоя
    // (план `docs/plans/2026-08-04-acceptance-pipeline-feedback.md`, решение D-B, волна W1).
    //
    // Форма миграции — **только `ADD COLUMN` + один индекс, всё nullable, без backfill**, и это
    // не осторожность ради осторожности, а требование семантики:
    //
    // 1. **NULL-слой = «неизвестно» = recapture.** Строка, записанная до этой миграции, знает
    //    только плоский `case_fingerprint`; из чего он сложился — из какого кадра, какого эталона
    //    и какой политики — не знает никто. Вычислить слои задним числом нельзя (для этого нужны
    //    и профиль рана, и манифест набора на момент съёмки), а угадать — значит переиспользовать
    //    вердикт, посчитанный по неизвестной политике. Поэтому backfill'а нет, а lookup'ы по
    //    слоям (`frame_fingerprint=?`) NULL-строку просто не находят: SQL-сравнение с NULL
    //    ложно, и legacy-строка честно уводит в пересъёмку (D17).
    // 2. **`verdict_policy_json` — снимок, `verdict_policy_hash` — его валидатор** (D0/D14).
    //    Дельта старой и новой политики вычислима только по значениям; хэш отвечает на вопрос
    //    «этот ли снимок относится к этой строке». Снимка нет или хэш не сошёлся ⇒ recapture,
    //    никогда перенос.
    // 3. **ALGO 5→6 обнуляет старый кэш и без миграции.** Строки v28 не удаляются: они остаются
    //    материалом GC (`unreferencedCaseResults`) и refcount'а артефактов, просто перестают
    //    быть кандидатами на reuse.
    //
    // Откат образа переживается: v28-код читает эти таблицы `SELECT *` и собирает ответы по
    // именованным полям, поэтому лишние колонки ему не мешают (тот же инвариант, что у v28).
    for (const column of [
      "frame_fingerprint TEXT",
      "comparison_fingerprint TEXT",
      "verdict_policy_hash TEXT",
      "verdict_policy_json TEXT",
    ]) db.run(`ALTER TABLE acceptance_case_results ADD COLUMN ${column}`);
    // Индекс покрывает оба новых lookup'а: re-diff/`forceOf` ищут по (component_id, frame),
    // recompute — по (component_id, frame, comparison) и доотсеивает comparison строкой-фильтром.
    db.run("CREATE INDEX IF NOT EXISTS acceptance_case_results_frame ON acceptance_case_results (component_id, frame_fingerprint)");
    for (const column of [
      "frame_fingerprint TEXT",
      "comparison_fingerprint TEXT",
      "verdict_policy_hash TEXT",
      // Форма квитанции reuse (W8): `{reuse:{…}, fingerprints:{frame,comparison,verdictPolicy,case}}`.
      // Пишется уже сейчас — выдача в evidence приезжает волной W8, но данные, которых не собрали,
      // задним числом не появятся.
      "reuse_receipt_json TEXT",
    ]) db.run(`ALTER TABLE acceptance_cases ADD COLUMN ${column}`);
    // Алгебра refresh (C1): `{requested, impact, effective}` со скоупами, посчитанная на старте и
    // персистентная — иначе «почему этот ран ничего не переснял» невосстановимо после рестарта.
    db.run("ALTER TABLE acceptance_runs ADD COLUMN refresh_json TEXT");
    // Терминальный статус `error` требует названной причины: `refresh_scope_empty` (D2) —
    // не 422 на асинхронной постановке, а исход рана, видимый в run-view и в CLI.
    db.run("ALTER TABLE acceptance_runs ADD COLUMN status_reason TEXT");
  },
  (db: Database) => {
    // v30: multi-run provenance публикации
    // (план `docs/plans/2026-08-04-acceptance-pipeline-feedback.md`, решение D-D, волна W7).
    //
    // Семья, не влезающая в один ран (шардирование по props или по поверхности light/dark),
    // публикуется набором ранов. Форма хранения — **плоская TEXT-колонка с JSON-массивом, без FK**
    // (инвариант A9: receipts приёмки на строке версии ссылаются на раны, которые GC вправе
    // унести; FK превратил бы TTL приёмки в отказ удаления, а не в потерю провенанса):
    //
    // 1. `component_publishes.acceptance_run_ids` — отсортированный (`created_at, run_id`) массив
    //    ранов, которыми подтверждена версия. NULL — строка до этой миграции ИЛИ publish без
    //    приёмки; читатель обязан трактовать NULL как `[acceptance_run_id]` (пусто, если и он
    //    NULL). Backfill'а нет намеренно: он переписал бы историю значением, которое и так
    //    вычислимо чтением.
    // 2. **`acceptance_run_id` остаётся первым элементом отсортированного массива** (C7) — все
    //    старые читатели (Library `accepted`, `audit --versions`, DTO версии) продолжают видеть
    //    ровно один id, и он детерминирован, а не «какой пришёл первым в теле запроса».
    // 3. `acceptance_runs.renderer_fingerprint` — объявленный рендерер рана (nullable; пишется
    //    новыми ранами на постановке). Multi-run promote требует равенства у всех ранов набора:
    //    склеивать покрытие, снятое разными рендерерами, значит выдавать за одну доказательную
    //    базу кадры, несравнимые между собой. Для до-миграционных ранов с NULL проверка
    //    пропускается с warning — «неизвестно» здесь не равно «разошлось».
    //
    // Откат образа переживается: v29-код читает обе таблицы `SELECT *` и собирает ответы по
    // именованным полям, поэтому лишние колонки ему не мешают (тот же инвариант, что у v28/v29).
    db.run("ALTER TABLE component_publishes ADD COLUMN acceptance_run_ids TEXT");
    db.run("ALTER TABLE acceptance_runs ADD COLUMN renderer_fingerprint TEXT");
  },
  (db: Database) => {
    // v31: слоты случая приёмки — `acceptance_cases.slots_hash`
    // (план `docs/plans/2026-08-05-slot-acceptance.md`, §A3/§A8, волна W2).
    //
    // Форма — **одна аддитивная nullable-колонка, без backfill и без индекса**:
    //
    // 1. **Хранение, а не реконструкция.** `slotsHash` — sha256 разрешённого списка
    //    `[{slot,index,componentId,version,bundleHash,propsHash}]`. Восстановить его из манифеста
    //    набора задним числом можно только повторив резолв пинов, а он зависит от текущего
    //    состояния публикаций: пин, отмеченный `superseded` после съёмки, дал бы другой ответ,
    //    и вырожденная реконструкция молча выдала бы «слоты не менялись». Покрытие promote (A8) и
    //    guard переноса эталона (A5a) обязаны читать зафиксированное значение, а не догадку.
    // 2. **NULL = «случай без слотов».** До этой миграции слотов не существовало вовсе, поэтому
    //    здесь, в отличие от v29, NULL не «неизвестно»: ключ покрытия подставляет `"-"`, а guard
    //    переноса сравнивает `?? null` с `?? null` — легаси-строка совпадает с бесслотовым
    //    случаем и переносится, как переносилась. Backfill'а нет, потому что backfill'ить нечего.
    // 3. **Индекса нет намеренно.** Колонка не участвует ни в одном lookup'е: ключи покрытия
    //    строятся в памяти по строкам одного рана (`runCoverage`), а reuse ищется по слоям
    //    отпечатка (`frame_fingerprint`), куда слоты уже входят по значению (`FIELD_LAYERS`).
    //
    // Откат образа переживается: v30-код читает `acceptance_cases` через `SELECT *` и собирает
    // ответы по именованным полям, поэтому лишняя колонка ему не мешает (тот же инвариант, что у
    // v28/v29/v30). Обратная сторона отката — манифесты со `slotBindings` (см. план, «Rollback
    // policy»); это свойство хранилища манифестов, а не этой колонки.
    db.run("ALTER TABLE acceptance_cases ADD COLUMN slots_hash TEXT");
  },
  (db: Database) => {
    // v32: четыре поверхности геометрии случая — `acceptance_cases.expected_surfaces_json`
    // (план `docs/plans/2026-08-07-migration-feedback-wave.md` §W1a, точка 8).
    //
    // Форма — **одна аддитивная nullable-колонка, без backfill и без индекса**, ровно как v31:
    //
    // 1. **NULL = «случай поверхностей не объявлял»**, а не «неизвестно». Потребитель нормализует
    //    их из `expected_geometry_json` (`expectedSurfacesOf`: `expectedGeometry → {layoutUnion}`),
    //    и backfill'ить нечего: он записал бы в БД именно ту производную, которую инвариант N3
    //    плана запрещает персистить. Персистированная нормализация означала бы, что доволновой
    //    случай сменил `verdict_policy_hash`, то есть вердиктный каскад по всему корпусу.
    // 2. **Колонка отчётная.** Набор случаев рана строится из манифеста (`casesOfRun`), а не из
    //    этих строк, — как и соседний `expected_geometry_json`. Она нужна, чтобы по сохранённому
    //    рану было видно, против каких поверхностей его судили.
    // 3. **Индекса нет:** колонка не участвует ни в одном lookup'е (reuse ищется по слоям
    //    отпечатка, куда поверхности входят по значению — `FIELD_LAYERS`).
    //
    // Откат образа переживается: v31-код читает `acceptance_cases` через `SELECT *` и собирает
    // ответы по именованным полям. Обратная сторона отката — манифесты с `expectedSurfaces`
    // (`strictObject` при повторном разборе даёт `422 case_set_manifest_unreadable`), поэтому
    // rollback-window правило волны: в окне отката такие манифесты не публиковать (§3.6).
    db.run("ALTER TABLE acceptance_cases ADD COLUMN expected_surfaces_json TEXT");
  },
  (db: Database) => {
    // v33: candidate dependency overlay рана — `acceptance_runs.overlay_manifest_json`/`overlay_hash`
    // (план `docs/plans/2026-08-07-migration-feedback-wave.md` §1.2/§W3, ретроспектива P0.3).
    //
    // Две аддитивные nullable-колонки на **ране**, а не на случае, и без backfill:
    //
    // 1. **Граф — свойство рана.** Overlay объявляется top-level полем манифеста набора и входит в
    //    кадровый слой каждого случая целиком (принятая цена, триаж C-m10). Хранить его построчно
    //    значило бы держать N копий одного факта и получить рассинхрон между случаями одного рана.
    // 2. **Durable, потому что это пин GC.** `AcceptanceRepo.pinnedSourceHashes` джойнит эту
    //    колонку `json_each`-ом: бандл кандидата, от которого зависит нетерминальный ран, нельзя
    //    вытеснять, и in-memory лизы для этого непригодны — они не переживают рестарт (триаж C-M2).
    //    Отсюда же требование к форме: массив объектов `{componentId,candidateId,rev,sourceHash,
    //    bundleHash}`, где `sourceHash` адресует файловый кэш кандидатов.
    // 3. **`overlay_hash` отдельной колонкой**, а не производной на чтении: мультиран-promote
    //    сверяет графы шардов семьи (`422 overlay_hash_mismatch`) до всякого разбора кадров, и
    //    считать хэш заново по чужому JSON'у означало бы зависеть от порядка ключей в строке.
    // 4. **NULL = «ран без overlay»**, а не «неизвестно»: до этой миграции overlay-ранов не
    //    существовало вовсе, поэтому backfill'ить нечего.
    //
    // Rollback-window (§1.2/§3.6): пока откат образа возможен, overlay-раны создавать нельзя —
    // старый образ прочитает такой ран (`SELECT *` + именованные поля) и промоутит его **без**
    // верификации графа зависимостей. После первого overlay-рана откат образа делается только
    // вместе с восстановлением бэкапа тома (канон `docs/server-api.md#deployment`).
    db.run("ALTER TABLE acceptance_runs ADD COLUMN overlay_manifest_json TEXT");
    db.run("ALTER TABLE acceptance_runs ADD COLUMN overlay_hash TEXT");
  },
  (db: Database) => {
    // v34: кадры экранов галереи — `prototype_screen_frames` (план
    // `docs/plans/2026-08-07-migration-feedback-wave.md` §1.7/§W5, ретроспектива P1.1).
    //
    // Таблица отвечает на один вопрос: «снимался ли уже кадр этого экрана ровно в этих условиях».
    // Решения формы:
    //
    // 1. **Отпечаток в первичном ключе.** Одна ревизия экрана законно снимается в нескольких
    //    условиях (light/dark, два вьюпорта), и ключ без `screen_frame_fingerprint` затирал бы
    //    один кадр другим — reuse тёмной темы после светлой съёмки перестал бы доказываться.
    //    Рост ограничен retention'ом по ревизиям (5 последних, sweep на записи).
    // 2. **FK на ревизию, а не на прототип.** Кадр относится к паре `(prototype_id, rev)`, и
    //    удаление ревизии обязано уносить его кадры тем же каскадом, что и пины.
    // 3. **`receipt_json` nullable и потолочный (64 КБ).** В квитанции лежит разложенный кортеж
    //    отпечатка — по нему план называет причину пересъёмки (renderer/theme/impacted). Строка
    //    без квитанции остаётся валидным доказательством самого кадра: причина деградирует до
    //    `impacted`, но reuse по совпавшему отпечатку продолжает работать.
    // 4. **Индекс по отпечатку** — единственный горячий lookup плана («есть ли где-то кадр с этим
    //    отпечатком»); он же покрывает выборку по прототипу.
    //
    // Rollback-window (§3.6): миграция **безопасна к откату образа** — таблица ничему не мешает,
    // а старый код о ней не знает и квитанции игнорирует. Единственное последствие отката —
    // накопленные кадры перестают доказывать reuse (обратно — тоже: план после отката-возврата
    // просто увидит меньше строк и снимет больше кадров).
    db.run(`CREATE TABLE prototype_screen_frames (
      prototype_id TEXT NOT NULL, rev INTEGER NOT NULL, screen_id TEXT NOT NULL,
      screen_frame_fingerprint TEXT NOT NULL, png_sha256 TEXT NOT NULL,
      receipt_json TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY (prototype_id, rev, screen_id, screen_frame_fingerprint),
      FOREIGN KEY (prototype_id, rev) REFERENCES prototype_revisions(prototype_id, rev) ON DELETE CASCADE)`);
    db.run("CREATE INDEX prototype_screen_frames_fingerprint ON prototype_screen_frames (prototype_id, screen_frame_fingerprint)");
  },
  (db: Database) => {
    // v35: сага миграционного коммита — `migration_commits` (план
    // `docs/plans/2026-08-07-migration-feedback-wave.md` §1.3/§W4, ретроспектива P0.4).
    //
    // Строка — **всё** состояние саги: фаза, журнал фаз, исходный запрос и накопленная квитанция.
    // Драйвер к ней poller, а не владелец состояния. Решения формы:
    //
    // 1. **`idempotency_key NOT NULL` + `UNIQUE (component_id, idempotency_key)`** (триаж O-M8).
    //    Nullable-ключ в SQLite ничего не ограничивает (NULL≠NULL), поэтому ключ обязателен в API
    //    и в схеме. Скоуп — компонент, а не глобальный: прецедент
    //    `UNIQUE (candidate_id, idempotency_key)` у `acceptance_runs`; повтор запроса с тем же
    //    ключом обязан вернуть **ту же** сагу, а не столкнуться с чужим ключом.
    // 2. **Partial unique index по позитивному списку активных фаз** (раунд 2, N10; прецедент
    //    `acceptance_runs_one_in_flight … WHERE status IN ('queued','running')`). Именно позитивный
    //    список, а не `NOT IN (терминальные)`: новая `needs-*`-фаза, добавленная будущей волной,
    //    не должна автоматически начать блокировать новые саги. Состояния `needs-*` **вне** списка
    //    намеренно — сага в них resumable через `advance`, но она не держит компонент: миграцию
    //    можно начать заново, пока предыдущая ждёт человека.
    // 3. **Per-component lock, а не `maintenance_locks`** (триаж O-M7): у той таблицы одна
    //    глобальная строка, и параллельная миграция *другого* компонента была бы запрещена.
    // 4. **Мягкие ссылки без FK** на `component_id`/`candidate_id`/`gallery_prototype_id`:
    //    кандидаты вымываются GC, а прототип может быть удалён — сага обязана честно отвечать
    //    отказом *в фазе*, а не падать на чтении строки или каскадно исчезать.
    // 5. **`phase_started_at` отдельной колонкой** — вход watchdog'а (`limits.migrationCommitPhaseTimeoutMs`).
    //    Периодических таймеров в сервере нет, поэтому sweep зависших фаз исполняется на старте и
    //    на каждом запросе к `/api/migration-commits*`; без этой колонки «висит ли фаза» пришлось
    //    бы выводить из журнала фаз, то есть парсить JSON на каждом запросе.
    //
    // Rollback-window (§3.6): пока откат образа возможен без восстановления тома — **саги не
    // запускать**. Старый образ о таблице не знает и незавершённую сагу никем не продвинет:
    // компонент останется промоученным, а галерея — несохранённой, и разбирать это придётся
    // руками. Уже завершённые (`complete`/`cancelled`) строки откату не мешают.
    db.run(`CREATE TABLE migration_commits (
      commit_id TEXT PRIMARY KEY,
      component_id TEXT NOT NULL,
      candidate_id TEXT,
      design_system TEXT NOT NULL,
      gallery_prototype_id TEXT,
      phase TEXT NOT NULL,
      phases_json TEXT NOT NULL,
      request_json TEXT NOT NULL,
      receipt_json TEXT,
      idempotency_key TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      phase_started_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (component_id, idempotency_key))`);
    db.run(`CREATE UNIQUE INDEX migration_commits_one_in_flight ON migration_commits (component_id)
      WHERE phase IN ('preflight','promote','gallery-save','verify','impacted-regression','audit')`);
    db.run("CREATE INDEX migration_commits_component ON migration_commits (component_id, created_at)");
  },
  (db: Database) => {
    // v36: пакет исходников Figma — `figma_source_packages` (план
    // `docs/plans/2026-08-07-migration-feedback-wave.md` §W8, ретроспектива P1.4).
    //
    // Строка хранит **манифест**, а не байты: экспорты ссылаются на реестр ассетов
    // (`asset_<sha256>`), где дедупликация уже решена контентным адресом. Решения формы:
    //
    // 1. **`package_id` — контентный адрес** (`fsp_<sha256(манифест)>`), а не суррогат: повторная
    //    загрузка того же пакета обязана быть идемпотентной, а не плодить строки. Смена
    //    `source_revision` — это **другой** манифест, то есть другой пакет; инвалидация зависимых
    //    кейсов идёт через новые `referenceAssetId` (слой `comparison`), а не через эту таблицу.
    // 2. **`design_system REFERENCES design_systems(id)`** (триаж O-m11) + запись в
    //    `assertRegistryIntegrity`: пакет — источник конкретной ДС, и висячая ссылка здесь так же
    //    недопустима, как у компонента. FK на `assets` осознанно нет: экспорты живут внутри JSON,
    //    а DELETE-роута у ассетов не существует (та же граница, что у provenance-ссылок).
    // 3. **`export_count` отдельной колонкой** — единственная агрегатная величина, которую
    //    спрашивает список; без неё каждая строка выдачи парсила бы манифест на 256 экспортов.
    // 4. **Индекс `(design_system, file_key)`** — единственный горячий lookup: «какие пакеты этого
    //    файла у этой системы».
    //
    // Rollback-window (§3.6): пока откат образа возможен без восстановления тома — **пакеты не
    // загружать и `figma.sourcePackageId` не проставлять**. Старый образ о таблице не знает, и
    // ссылка на несуществующую строку пережила бы откат немой (kill-switch
    // `EASYUI_SOURCE_PACKAGE_DISABLED=1` запрещает ровно эти две операции). Уже записанные пакеты
    // откату не мешают: ссылка metadata-only и ни в один отпечаток не входит.
    db.run(`CREATE TABLE figma_source_packages (
      package_id TEXT PRIMARY KEY,
      design_system TEXT NOT NULL REFERENCES design_systems(id),
      file_key TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      export_count INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL)`);
    db.run("CREATE INDEX figma_source_packages_source ON figma_source_packages (design_system, file_key)");
  },
] as const;

function assertRegistryIntegrity(db:Database):void {
  // `figma_source_packages` (v36, триаж O-m11) — в том же списке, что каталожные таблицы: пакет
  // исходников принадлежит дизайн-системе так же, как компонент, и висячая ссылка означала бы
  // источник без продукта.
  for(const table of ["components","component_revisions","prototypes","compositions","composition_revisions","figma_source_packages"] as const) {
    const row=db.query(`SELECT design_system FROM ${table} WHERE design_system NOT IN (SELECT id FROM design_systems) LIMIT 1`).get() as {design_system:string}|null;
    if(row) throw new Error(`Dangling design system reference in ${table}: ${row.design_system}`);
  }
  const component=db.query(`SELECT c.id,c.design_system head_system,r.design_system revision_system FROM components c
    LEFT JOIN component_revisions r ON r.component_id=c.id AND r.rev=c.head_rev
    WHERE r.component_id IS NULL OR c.design_system<>r.design_system LIMIT 1`).get() as {id:string;head_system:string;revision_system:string|null}|null;
  if(component) throw new Error(`Component head design system mismatch: ${component.id}`);
  const composition=db.query(`SELECT c.id,c.design_system head_system,r.design_system revision_system FROM compositions c
    LEFT JOIN composition_revisions r ON r.composition_id=c.id AND r.rev=c.head_rev
    WHERE r.composition_id IS NULL OR c.design_system<>r.design_system LIMIT 1`).get() as {id:string;head_system:string;revision_system:string|null}|null;
  if(composition) throw new Error(`Composition head design system mismatch: ${composition.id}`);
  const heads=db.query(`SELECT p.id,p.design_system,r.doc FROM prototypes p
    LEFT JOIN prototype_revisions r ON r.prototype_id=p.id AND r.rev=p.head_rev`).all() as {id:string;design_system:string;doc:string|null}[];
  // Множество зарегистрированных ДС читается один раз: surface-скан ниже проверяет по нему
  // ссылки `doc.surfaces[].designSystem` (плана multi-surface-flows §4, R3-M2).
  const registeredSystems=new Set((db.query("SELECT id FROM design_systems").all() as {id:string}[]).map(row=>row.id));
  for(const head of heads) {
    let doc:unknown; try { doc=JSON.parse(head.doc??""); } catch { throw new Error(`Invalid prototype head document: ${head.id}`); }
    const system=(doc&&typeof doc==="object"&&(doc as {designSystem?:unknown}).designSystem)??"shadcn";
    if(system!==head.design_system) throw new Error(`Prototype head design system mismatch: ${head.id}`);
    // Документ читается сырым `JSON.parse` (старт сервера не должен падать на документе,
    // записанном более новой версией формата), поэтому surfaces проверяются оборонительно.
    const surfaces=doc&&typeof doc==="object"?(doc as {surfaces?:unknown}).surfaces:undefined;
    if(!Array.isArray(surfaces)) continue;
    for(const surface of surfaces) {
      const surfaceSystem=surface&&typeof surface==="object"?(surface as {designSystem?:unknown}).designSystem:undefined;
      if(typeof surfaceSystem!=="string") continue;
      if(!registeredSystems.has(surfaceSystem)) throw new Error(`Dangling design system reference in prototype surfaces: ${head.id} (${surfaceSystem})`);
    }
  }
  const providers=db.query("SELECT id,builtin_provider FROM design_systems WHERE builtin_provider IS NOT NULL AND retired=0").all() as {id:string;builtin_provider:string}[];
  for(const row of providers) if(!(row.builtin_provider in designSystems)) throw new Error(`Unknown builtin provider for design system ${row.id}: ${row.builtin_provider}`);
  const installed=new Set((db.query("SELECT name FROM sqlite_master WHERE type='trigger'").all() as {name:string}[]).map(row=>row.name));
  const missing=RETIRED_DESIGN_SYSTEM_TRIGGER_NAMES.filter(name=>!installed.has(name));
  if(missing.length) throw new Error(`Missing retired design-system triggers: ${missing.join(", ")}`);
}

export function migrate(db: Database): void {
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA journal_mode = WAL");
  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let index = current; index < migrations.length; index += 1) {
    // The v13 prototypes rebuild must temporarily disable FK rewriting/cascades. PRAGMA
    // foreign_keys is a no-op inside a transaction, so only this migration gets the special
    // connection setup. Every registered migration still owns one atomic transaction that
    // advances user_version only after the migration (and its FK audit) succeeds.
    const isV13 = index === 12;
    if (isV13) {
      db.run("PRAGMA foreign_keys = OFF");
      try {
        db.transaction(() => {
          migrations[index](db);
          const violations = db.query("PRAGMA foreign_key_check").all();
          if (violations.length) throw new Error(`v13 rebuild left foreign-key violations: ${JSON.stringify(violations)}`);
          db.run(`PRAGMA user_version = ${index + 1}`);
        })();
      } finally {
        db.run("PRAGMA foreign_keys = ON");
      }
    } else {
      db.transaction(() => {
        migrations[index](db);
        db.run(`PRAGMA user_version = ${index + 1}`);
      })();
    }
  }
  const violations = db.query("PRAGMA foreign_key_check").all();
  if (violations.length) throw new Error(`Migrations left foreign-key violations: ${JSON.stringify(violations)}`);
  assertRegistryIntegrity(db);
}
