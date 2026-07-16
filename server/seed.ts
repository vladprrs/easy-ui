import type { Database } from "bun:sqlite";
import { basename, extname, resolve } from "node:path";
import { readdir } from "node:fs/promises";
import { prototypeDocSchema, type PrototypeDoc } from "../src/prototype/schema";
import { validatePrototypeForSave } from "./routes/prototypes";
import { PrototypeRepo } from "./repos/prototypes";
import { AssetRepo } from "./repos/assets";
import { collectAssetIds } from "./validation";

// --- checkout@2 upgrade (W0-1): the seed snapshot of checkout.json moved from a broken
// /images/sneakers.jpg reference + hardcoded totals (v1) to an ingested $asset fixture and
// $cond-driven cart totals (v2). Existing databases seeded from the v1 snapshot are upgraded
// in place; databases where the user edited checkout are left untouched (one-off skip marker).
const CHECKOUT_FILE_ID = "checkout.json";
const CHECKOUT_UPGRADE_ID = "checkout.json@2";
const CHECKOUT_UPGRADE_SKIPPED_ID = "checkout.json@2:skipped";
// Canonical hash of the v1 seed snapshot of prototypes/checkout.json (schema-parsed, sorted-key
// JSON, sha256). Recompute with canonicalPrototypeDocHash if the v1 snapshot ever needs re-pinning.
const CHECKOUT_V1_CANONICAL_HASH = "74215a13ba09ebd7031ae62e732428b150c660b91719c53eace1e372c908eb73";

const ASSET_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
};

// Key-order-independent document hash: schema-parsed doc, recursively sorted object keys, sha256.
// Both sides of the upgrade comparison (stored head revision and the pinned v1 constant) go through
// the same prototypeDocSchema parse, so schema defaults cannot skew the comparison.
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
export const canonicalPrototypeDocHash = (doc: PrototypeDoc): string =>
  new Bun.CryptoHasher("sha256").update(canonicalJson(doc)).digest("hex");

const seedLogged = (db: Database, fileId: string): boolean =>
  Boolean(db.query("SELECT 1 ok FROM seed_log WHERE file_id=?").get(fileId));
const logSeed = (db: Database, fileId: string): void => {
  db.query("INSERT INTO seed_log (file_id,seeded_at) VALUES (?,?)").run(fileId, new Date().toISOString());
};

// Ingests deterministic fixture files from <dir>/assets so the seed document's $asset references
// resolve before the document transaction. Content-addressed: re-running is a no-op dedup.
async function ingestSeedAssets(db: Database, dir: string, dataDir: string): Promise<void> {
  const assetsDir = resolve(dir, "assets");
  let files: string[];
  try { files = (await readdir(assetsDir)).sort(); } catch { return; }
  const repo = new AssetRepo(db, dataDir);
  for (const file of files) {
    const mime = ASSET_MIME_BY_EXTENSION[extname(file).toLowerCase()];
    if (!mime) { console.warn(`Skipping seed asset with unknown extension: ${file}`); continue; }
    const bytes = new Uint8Array(await Bun.file(resolve(assetsDir, file)).arrayBuffer());
    try { await repo.ingest(bytes, mime, file); }
    catch (error) { console.error(`Failed to ingest seed asset ${file}`, error); }
  }
}

// Upgrades an existing database seeded from the v1 checkout snapshot to the v2 document. When the
// head revision no longer matches the pristine v1 snapshot (user edits, deletion), the upgrade is
// skipped and recorded once so restarts stay silent. Figma provenance of the head revision is
// carried over onto the upgrade revision.
function upgradeCheckout(db: Database, doc: PrototypeDoc, assetIds: string[]): void {
  const skip = (reason: string): void => {
    console.warn(`Seed upgrade ${CHECKOUT_UPGRADE_ID} skipped: ${reason}`);
    logSeed(db, CHECKOUT_UPGRADE_SKIPPED_ID);
  };
  const proto = db.query("SELECT head_rev FROM prototypes WHERE id=?").get(doc.id) as { head_rev: number } | null;
  if (!proto) { skip("prototype was deleted"); return; }
  const head = db.query("SELECT doc,figma_json FROM prototype_revisions WHERE prototype_id=? AND rev=?")
    .get(doc.id, proto.head_rev) as { doc: string; figma_json: string | null } | null;
  if (!head) { skip("head revision is missing"); return; }
  let headDoc: PrototypeDoc;
  try { headDoc = prototypeDocSchema.parse(JSON.parse(head.doc)); }
  catch { skip("head revision does not parse against the current schema"); return; }
  if (canonicalPrototypeDocHash(headDoc) !== CHECKOUT_V1_CANONICAL_HASH) { skip("head revision differs from the v1 seed snapshot (user edits preserved)"); return; }
  db.transaction(() => {
    new PrototypeRepo(db).save(doc.id, doc, proto.head_rev, "Seed upgrade: checkout@2", [], assetIds, head.figma_json);
    logSeed(db, CHECKOUT_UPGRADE_ID);
  })();
}

export async function seedPrototypes(db: Database, dir = resolve("prototypes"), dataDir = process.env.DATA_DIR ?? "data", ownerId: string | null = null): Promise<void> {
  // Seed documents may use builtins from their own design system; custom components are not supported in seeds.
  let files: string[];
  try { files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort(); }
  catch (error) { console.warn("Seed directory unavailable", error); return; }
  let assetsIngested = false;
  for (const file of files) {
    const fileId = basename(file);
    const baseSeeded = seedLogged(db, fileId);
    const needsUpgrade = fileId === CHECKOUT_FILE_ID && baseSeeded
      && !seedLogged(db, CHECKOUT_UPGRADE_ID) && !seedLogged(db, CHECKOUT_UPGRADE_SKIPPED_ID);
    if (baseSeeded && !needsUpgrade) continue;
    let doc: PrototypeDoc;
    try { const parsed = prototypeDocSchema.parse(await Bun.file(resolve(dir, file)).json()); validatePrototypeForSave(parsed); doc = parsed; }
    catch (error) { console.error(`Skipping invalid seed file ${fileId}`, error); continue; }
    // Fixture assets must exist before create/save pins them ($asset references are hard 422s).
    if (!assetsIngested) { await ingestSeedAssets(db, dir, dataDir); assetsIngested = true; }
    const assetIds = collectAssetIds(doc);
    try {
      if (needsUpgrade) { upgradeCheckout(db, doc, assetIds); continue; }
      db.transaction(() => {
        new PrototypeRepo(db).create(doc, "Initial seed", [], assetIds, null, ownerId);
        logSeed(db, fileId);
        // Fresh databases get the v2 checkout content directly: mark base seed and upgrade
        // atomically so restarts never save a second revision.
        if (fileId === CHECKOUT_FILE_ID) logSeed(db, CHECKOUT_UPGRADE_ID);
      })();
    } catch (error) { console.error(`Failed to seed ${fileId}`, error); }
  }
}
