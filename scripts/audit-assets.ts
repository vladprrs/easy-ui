/**
 * Asset registry audit (manual / deploy-time — intentionally NOT part of `npm run verify`,
 * because it needs a live database + DATA_DIR).
 *
 * Run with Bun:  DATA_DIR=data ~/.bun/bin/bun scripts/audit-assets.ts
 *
 * Reports:
 *  - missing bytes: an `assets` row whose DATA_DIR/assets/<sha256> file is absent;
 *  - size mismatch: a file whose byte length differs from the recorded size;
 *  - orphan files:  a file under DATA_DIR/assets with no corresponding `assets` row;
 *  - unpinned assets: rows referenced by neither a prototype revision nor a component publish.
 * Exits non-zero when any integrity problem (missing bytes / size mismatch) is found.
 */
import { Database } from "bun:sqlite";
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

const dataDir = process.env.DATA_DIR || "data";
const dbPath = process.argv[2] ?? resolve(dataDir, "easy-ui.db");
const assetsDir = resolve(dataDir, "assets");

type Row = { id: string; sha256: string; size: number };

const db = new Database(dbPath, { readonly: true, strict: true });
const rows = db.query("SELECT id,sha256,size FROM assets").all() as Row[];
const known = new Map(rows.map((r) => [r.sha256, r]));

const missingBytes: string[] = [];
const sizeMismatch: string[] = [];
for (const row of rows) {
  const path = resolve(assetsDir, row.sha256);
  try {
    const info = await stat(path);
    if (info.size !== row.size) sizeMismatch.push(`${row.id}: db size ${row.size} != file size ${info.size}`);
  } catch { missingBytes.push(`${row.id} (${row.sha256})`); }
}

let files: string[] = [];
try { files = await readdir(assetsDir); } catch { /* no assets dir yet */ }
const orphanFiles = files.filter((name) => /^[0-9a-f]{64}$/.test(name) && !known.has(name));

const unpinned = (db.query(`SELECT id FROM assets a
  WHERE NOT EXISTS (SELECT 1 FROM prototype_revision_assets p WHERE p.asset_id=a.id)
    AND NOT EXISTS (SELECT 1 FROM component_publish_assets c WHERE c.asset_id=a.id)
  ORDER BY id`).all() as { id: string }[]).map((r) => r.id);

const report = (label: string, items: string[]) => {
  console.log(`\n${label}: ${items.length}`);
  for (const item of items) console.log(`  - ${item}`);
};

console.log(`Asset audit for ${dbPath}`);
console.log(`Registered assets: ${rows.length}, files on disk: ${files.filter((n) => /^[0-9a-f]{64}$/.test(n)).length}`);
report("Missing bytes", missingBytes);
report("Size mismatch", sizeMismatch);
report("Orphan files (no db row)", orphanFiles);
report("Unpinned assets (safe to prune once policy allows)", unpinned);

db.close();
if (missingBytes.length || sizeMismatch.length) { console.error("\nIntegrity problems found."); process.exit(1); }
console.log("\nNo integrity problems found.");
