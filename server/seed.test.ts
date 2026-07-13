import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import { openDatabase } from "./db";
import { canonicalPrototypeDocHash, seedPrototypes } from "./seed";
import { PrototypeRepo } from "./repos/prototypes";
import { prototypeDocSchema, type PrototypeDoc } from "../src/prototype/schema";

const CHECKOUT_ASSET_ID = "asset_379aa3e6404e22be93965ec20ea97fbc3f51b2206c6200b302cf27159173419b";
const V1_HASH = "74215a13ba09ebd7031ae62e732428b150c660b91719c53eace1e372c908eb73";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

async function scratch(): Promise<{ seedDir: string; dataDir: string }> {
  const root = await mkdtemp(resolve(tmpdir(), "easy-ui-seed-w01-"));
  dirs.push(root);
  const seedDir = resolve(root, "prototypes");
  await mkdir(resolve(seedDir, "assets"), { recursive: true });
  await cp(resolve("prototypes/checkout.json"), resolve(seedDir, "checkout.json"));
  await cp(resolve("prototypes/assets/sneakers.svg"), resolve(seedDir, "assets", "sneakers.svg"));
  return { seedDir, dataDir: resolve(root, "data") };
}

const v1Doc = async (): Promise<PrototypeDoc> =>
  prototypeDocSchema.parse(await Bun.file(resolve("server/fixtures/checkout-v1.seed.json")).json());

const revisionCount = (db: Database): number =>
  (db.query("SELECT COUNT(*) count FROM prototype_revisions WHERE prototype_id='checkout'").get() as { count: number }).count;
const seedLogIds = (db: Database): string[] =>
  (db.query("SELECT file_id FROM seed_log ORDER BY file_id").all() as { file_id: string }[]).map((r) => r.file_id);

// Simulates a database seeded before the checkout@2 upgrade existed: v1 document + base seed marker only.
async function seedV1Legacy(db: Database, figmaJson: string | null = null): Promise<void> {
  new PrototypeRepo(db).create(await v1Doc(), "Initial seed", [], [], figmaJson);
  db.query("INSERT INTO seed_log (file_id,seeded_at) VALUES (?,?)").run("checkout.json", new Date().toISOString());
}

describe("seed checkout@2 (W0-1)", () => {
  test("v1 fixture still matches the pinned canonical hash", async () => {
    expect(canonicalPrototypeDocHash(await v1Doc())).toBe(V1_HASH);
  });

  test("fresh DB seeds v2 content as exactly one revision with a pinned asset", async () => {
    const { seedDir, dataDir } = await scratch();
    const db = openDatabase(":memory:");
    await seedPrototypes(db, seedDir, dataDir);
    expect(revisionCount(db)).toBe(1);
    expect(seedLogIds(db)).toEqual(["checkout.json", "checkout.json@2"]);
    expect(db.query("SELECT 1 ok FROM assets WHERE id=?").get(CHECKOUT_ASSET_ID)).toBeTruthy();
    expect(db.query("SELECT 1 ok FROM prototype_revision_assets WHERE prototype_id='checkout' AND rev=1 AND asset_id=?").get(CHECKOUT_ASSET_ID)).toBeTruthy();
    const stored = (db.query("SELECT doc FROM prototype_revisions WHERE prototype_id='checkout' AND rev=1").get() as { doc: string }).doc;
    expect(stored).toContain(CHECKOUT_ASSET_ID);
    expect(stored).not.toContain("/images/sneakers.jpg");
    expect(await Bun.file(resolve(dataDir, "assets", CHECKOUT_ASSET_ID.slice("asset_".length))).exists()).toBe(true);
    // Restart: nothing new is written.
    await seedPrototypes(db, seedDir, dataDir);
    expect(revisionCount(db)).toBe(1);
    expect(seedLogIds(db)).toEqual(["checkout.json", "checkout.json@2"]);
    db.close();
  });

  test("populated DB with the pristine v1 snapshot is upgraded in place, preserving figma provenance", async () => {
    const { seedDir, dataDir } = await scratch();
    const db = openDatabase(":memory:");
    const figma = JSON.stringify({ fileKey: "abc123", nodeId: "1:2" });
    await seedV1Legacy(db, figma);
    await seedPrototypes(db, seedDir, dataDir);
    expect(revisionCount(db)).toBe(2);
    expect(db.query("SELECT head_rev FROM prototypes WHERE id='checkout'").get()).toEqual({ head_rev: 2 });
    const rev2 = db.query("SELECT doc,message,figma_json FROM prototype_revisions WHERE prototype_id='checkout' AND rev=2").get() as { doc: string; message: string; figma_json: string | null };
    expect(rev2.message).toBe("Seed upgrade: checkout@2");
    expect(rev2.doc).toContain(CHECKOUT_ASSET_ID);
    expect(rev2.figma_json).toBe(figma);
    expect(db.query("SELECT 1 ok FROM prototype_revision_assets WHERE prototype_id='checkout' AND rev=2 AND asset_id=?").get(CHECKOUT_ASSET_ID)).toBeTruthy();
    expect(seedLogIds(db)).toEqual(["checkout.json", "checkout.json@2"]);
    // Restart: idempotent.
    await seedPrototypes(db, seedDir, dataDir);
    expect(revisionCount(db)).toBe(2);
    db.close();
  });

  test("populated DB with user edits is not overwritten; skip is recorded exactly once", async () => {
    const { seedDir, dataDir } = await scratch();
    const db = openDatabase(":memory:");
    await seedV1Legacy(db);
    const edited = { ...(await v1Doc()), name: "Мой изменённый чекаут" };
    new PrototypeRepo(db).save("checkout", edited, 1, "user edit");
    await seedPrototypes(db, seedDir, dataDir);
    expect(revisionCount(db)).toBe(2);
    expect(db.query("SELECT head_rev FROM prototypes WHERE id='checkout'").get()).toEqual({ head_rev: 2 });
    const head = (db.query("SELECT doc FROM prototype_revisions WHERE prototype_id='checkout' AND rev=2").get() as { doc: string }).doc;
    expect(head).toContain("Мой изменённый чекаут");
    expect(head).not.toContain(CHECKOUT_ASSET_ID);
    expect(seedLogIds(db)).toEqual(["checkout.json", "checkout.json@2:skipped"]);
    // Repeated restarts: still one skip marker, no new revisions, no re-application.
    await seedPrototypes(db, seedDir, dataDir);
    await seedPrototypes(db, seedDir, dataDir);
    expect(revisionCount(db)).toBe(2);
    expect(seedLogIds(db)).toEqual(["checkout.json", "checkout.json@2:skipped"]);
    db.close();
  });

  test("deleted checkout prototype records a skip instead of resurrecting the document", async () => {
    const { seedDir, dataDir } = await scratch();
    const db = openDatabase(":memory:");
    await seedV1Legacy(db);
    new PrototypeRepo(db).delete("checkout", 1);
    await seedPrototypes(db, seedDir, dataDir);
    expect(db.query("SELECT 1 ok FROM prototypes WHERE id='checkout'").get()).toBeNull();
    expect(seedLogIds(db)).toEqual(["checkout.json", "checkout.json@2:skipped"]);
    db.close();
  });
});
