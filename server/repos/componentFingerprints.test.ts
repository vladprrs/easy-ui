import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../migrations";
import { ComponentFingerprintRepo, sourceSha256 } from "./componentFingerprints";

const dbForRepo = () => { const db = new Database(":memory:"); migrate(db); return db; };
const shingles = ["a b c d e", "b c d e f"];

test("a cache miss is not an error: get on an empty table returns undefined", () => {
  const db = dbForRepo(); const repo = new ComponentFingerprintRepo(db);
  expect(repo.get("yp-badge", 1, sourceSha256("source"))).toBeUndefined();
  expect(repo.count()).toBe(0);
  db.close();
});

test("the key is content-addressed: another source hash or rev is a miss, never a stale hit", () => {
  const db = dbForRepo(); const repo = new ComponentFingerprintRepo(db);
  const sha = sourceSha256("export const A = () => null");
  repo.put("yp-badge", 1, sha, shingles);
  expect(repo.get("yp-badge", 1, sha)).toEqual(shingles);
  expect(repo.get("yp-badge", 1, sourceSha256("export const B = () => null"))).toBeUndefined();
  expect(repo.get("yp-badge", 2, sha)).toBeUndefined();
  expect(repo.get("yp-other", 1, sha)).toBeUndefined();
  db.close();
});

test("put is idempotent by key", () => {
  const db = dbForRepo(); const repo = new ComponentFingerprintRepo(db);
  const sha = sourceSha256("source");
  repo.put("yp-badge", 1, sha, shingles);
  repo.put("yp-badge", 1, sha, shingles);
  repo.put("yp-badge", 1, sha, ["recomputed"]);
  expect(repo.count()).toBe(1);
  expect(repo.get("yp-badge", 1, sha)).toEqual(["recomputed"]);
  db.close();
});

test("a corrupted cache row degrades to a miss instead of poisoning the corpus", () => {
  const db = dbForRepo(); const repo = new ComponentFingerprintRepo(db);
  const sha = sourceSha256("source");
  db.query("INSERT INTO component_fingerprints (component_id,rev,source_sha256,shingles_json,updated_at) VALUES (?,?,?,?,?)")
    .run("yp-badge", 1, sha, "{not json", "now");
  expect(repo.get("yp-badge", 1, sha)).toBeUndefined();
  db.query("UPDATE component_fingerprints SET shingles_json='[1,2]'").run();
  expect(repo.get("yp-badge", 1, sha)).toBeUndefined();
  db.close();
});

test("getOrCompute writes through, and a cold cache yields the same shingles as a warm one", () => {
  const db = dbForRepo(); const repo = new ComponentFingerprintRepo(db);
  const sha = sourceSha256("source");
  let computed = 0;
  const compute = () => { computed += 1; return shingles; };

  const cold = repo.getOrCompute("yp-badge", 1, sha, compute);
  const warm = repo.getOrCompute("yp-badge", 1, sha, compute);
  expect(cold).toEqual(warm);
  expect(computed).toBe(1);

  // Полный сброс кэша обязан быть неотличим по результату — иначе кэш стал источником истины.
  expect(repo.deleteForComponent("yp-badge")).toBe(1);
  expect(repo.get("yp-badge", 1, sha)).toBeUndefined();
  expect(repo.getOrCompute("yp-badge", 1, sha, compute)).toEqual(cold);
  expect(computed).toBe(2);
  db.close();
});

test("cache writes are safe inside a synchronous transaction and roll back with it", () => {
  const db = dbForRepo(); const repo = new ComponentFingerprintRepo(db);
  const sha = sourceSha256("source");
  expect(() => db.transaction(() => { repo.put("yp-badge", 1, sha, shingles); throw new Error("gate rejected"); })()).toThrow("gate rejected");
  expect(repo.count()).toBe(0);
  db.close();
});
