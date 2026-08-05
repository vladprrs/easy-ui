import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { migrate } from "../migrations";
import { AcceptanceRepo } from "./repo";
import { policyProfileHash, ACCEPTANCE_POLICIES } from "./policies";
import { runId as newRunId } from "./ids";
import {
  artifactPresent, casPath, casRoot, evidenceManifestHash, evidenceSlotsOf, gcEvidence, putArtifact,
  readRunManifest, runEvidenceDir, sanitizeEvidenceName, sha256Sums, writeRunManifest,
  type RunManifest,
} from "./evidence";
import type { ResolvedSlotBinding } from "./cases";

// W1a (план 2026-08-03 §2 A4): CAS, per-run манифест и GC evidence.

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const tmpDir = async (): Promise<string> => {
  const dir = await mkdtemp(resolve(process.cwd(), ".acc-evidence-test-"));
  dirs.push(dir);
  return dir;
};

const profile = ACCEPTANCE_POLICIES["default-v1"];

function seed(): { db: Database; repo: AcceptanceRepo } {
  const db = new Database(":memory:");
  migrate(db);
  return { db, repo: new AcceptanceRepo(db) };
}

function seedRun(repo: AcceptanceRepo, options: { caseFingerprint: string; status?: "fail" | "pass" }): { runId: string } {
  const { candidate } = repo.createCandidate({
    componentId: "yp-badge", designSystem: "yandex-pay", rev: 1, sourceHash: `src-${options.caseFingerprint}`,
    bundleHash: "bundle", hostAbiVersion: 4, themeVersion: 1, observedCatalogRevision: "cat",
    policyProfileHash: policyProfileHash(profile), createdBy: "user_a",
  });
  const { run } = repo.createRun({
    candidateId: candidate.candidate_id, componentId: candidate.component_id,
    policyProfileId: profile.id, policyProfileHash: policyProfileHash(profile), createdBy: "user_a",
    cases: [{ caseId: "full", caseKey: "full", propsHash: "ph", caseFingerprint: options.caseFingerprint, casePolicyHash: "case-policy-v0" }],
  });
  repo.terminalizeRun(run.run_id, { status: options.status ?? "fail" });
  return { runId: run.run_id };
}

const manifestOf = (runId: string, artifacts: { name: string; sha256: string; bytes: number }[]): RunManifest => ({
  version: 1, runId, candidateId: "cand_x", componentId: "yp-badge",
  policyProfileId: profile.id, policyProfileHash: policyProfileHash(profile),
  verdict: "pass", createdAt: "2026-08-03T00:00:00.000Z", finishedAt: "2026-08-03T00:01:00.000Z",
  cases: [{ caseId: "full", caseKey: "full", verdict: "pass", status: "done", reused: false, aliasOfCaseId: null, artifacts }],
});

/**
 * **Golden slot-free манифеста** (план 2026-08-05 §A7, test-first): зафиксирован на неизменённом
 * коде ДО добавления `slotBindings`/`slotsHash`. Слот-поля опциональны и пишутся условным спредом,
 * поэтому манифест рана без слотов обязан остаться побайтово прежним — иначе `evidence_manifest_hash`
 * поехал бы у всех уже принятых ранов, а он связан промоутом (`promote.ts:239`).
 */
const GOLDEN_SLOT_FREE_MANIFEST_HASH = "9217c6c82949e1c3f1741f87246c6dcae1c17e8b41a192eff700419fad1aea1f";
const GOLDEN_RUN_ID = "acc_00000000-0000-4000-8000-000000000000";

test("slot-free run manifest hashes to its pre-slotBindings golden", () => {
  const manifest = manifestOf(GOLDEN_RUN_ID, [{ name: "render.png", sha256: "a".repeat(64), bytes: 3 }]);
  expect(evidenceManifestHash(manifest)).toBe(GOLDEN_SLOT_FREE_MANIFEST_HASH);
});

const slotChild = (over: Partial<ResolvedSlotBinding> = {}): ResolvedSlotBinding => ({
  slot: "items", index: 0, componentId: "pay-child", name: "PayChild", version: 1,
  bundleHash: "bh-child-1", props: {}, propsHash: "props-empty", ...over,
});

test("evidenceSlotsOf groups the resolved tuple by slot and keeps render order", () => {
  const grouped = evidenceSlotsOf({
    slotBindings: [
      slotChild({ slot: "items", index: 0, props: { text: "one" }, propsHash: "ph-one" }),
      slotChild({ slot: "items", index: 1, props: { text: "two" }, propsHash: "ph-two" }),
      slotChild({ slot: "default", index: 0 }),
    ],
    slotsHash: "b".repeat(64),
  });
  expect(grouped.slotBindings).toEqual([
    {
      slot: "items",
      children: [
        { componentId: "pay-child", name: "PayChild", version: 1, bundleHash: "bh-child-1", props: { text: "one" }, propsHash: "ph-one" },
        { componentId: "pay-child", name: "PayChild", version: 1, bundleHash: "bh-child-1", props: { text: "two" }, propsHash: "ph-two" },
      ],
    },
    { slot: "default", children: [{ componentId: "pay-child", name: "PayChild", version: 1, bundleHash: "bh-child-1", props: {}, propsHash: "props-empty" }] },
  ]);
  expect(grouped.slotsHash).toBe("b".repeat(64));

  // Инвариант «отсутствует, а не пусто»: у slot-free случая слот-ключей нет вовсе, поэтому спред
  // результата не добавляет к записи манифеста ни одного байта.
  for (const empty of [undefined, {}, { slotBindings: [] }, { slotBindings: [], slotsHash: "c".repeat(64) }]) {
    expect(Object.keys(evidenceSlotsOf(empty))).toEqual([]);
  }
});

test("evidence manifest hash moves when a slot child's bundleHash alone changes", () => {
  const withChild = (bundleHash: string): RunManifest => {
    const manifest = manifestOf(GOLDEN_RUN_ID, [{ name: "render.png", sha256: "a".repeat(64), bytes: 3 }]);
    manifest.cases[0] = {
      ...manifest.cases[0]!,
      ...evidenceSlotsOf({ slotBindings: [slotChild({ bundleHash })], slotsHash: `${bundleHash}-slots` }),
    };
    return manifest;
  };
  expect(evidenceManifestHash(withChild("bh-child-1"))).not.toBe(evidenceManifestHash(withChild("bh-child-2")));
  // …и не совпадает с golden'ом slot-free рана: дерево слотов входит в доказательство.
  expect(evidenceManifestHash(withChild("bh-child-1"))).not.toBe(GOLDEN_SLOT_FREE_MANIFEST_HASH);
});

test("CAS is content-addressed: same bytes land on the same sharded path, different bytes do not", async () => {
  const dir = await tmpDir();
  const first = await putArtifact(dir, new Uint8Array([1, 2, 3]));
  const again = await putArtifact(dir, new Uint8Array([1, 2, 3]));
  const other = await putArtifact(dir, { metric: 1 });

  expect(first.sha256).toBe(again.sha256);
  expect(first.path).toBe(casPath(dir, first.sha256));
  expect(first.path).toBe(resolve(casRoot(dir), first.sha256.slice(0, 2), first.sha256));
  expect(other.sha256).not.toBe(first.sha256);
  expect(await artifactPresent(dir, first.sha256)).toBe(true);
  expect(await artifactPresent(dir, "not-a-sha")).toBe(false);
  expect(await artifactPresent(dir, "0".repeat(64))).toBe(false);
  // Канонизация JSON: порядок ключей на адрес не влияет.
  expect((await putArtifact(dir, { b: 2, a: 1 })).sha256).toBe((await putArtifact(dir, { a: 1, b: 2 })).sha256);
});

test("evidence names and run paths are validated, not sanitized silently", async () => {
  const dir = await tmpDir();
  const id = newRunId();
  expect(sanitizeEvidenceName("render.png")).toBe("render.png");
  for (const bad of ["../evil", "a/b", "", "x".repeat(65), "имя.png"]) {
    expect(() => sanitizeEvidenceName(bad)).toThrow();
  }
  expect(runEvidenceDir(dir, id)).toBe(resolve(dir, ".acceptance", id));
  expect(() => runEvidenceDir(dir, "../../etc")).toThrow();
  expect(() => runEvidenceDir(dir, "acc_nope")).toThrow();
  expect(() => casPath(dir, "../x")).toThrow();
});

test("run manifest writes SHA256SUMS in sha256sum format and a stable manifest hash", async () => {
  const dir = await tmpDir();
  const id = newRunId();
  const png = await putArtifact(dir, new Uint8Array([9, 9, 9]));
  const manifest = manifestOf(id, [{ name: "render.png", sha256: png.sha256, bytes: png.bytes }]);

  const written = await writeRunManifest(dir, id, manifest);
  expect(written.manifestHash).toBe(evidenceManifestHash(manifest));
  expect(await readRunManifest(dir, id)).toEqual(manifest);
  const sums = await Bun.file(resolve(runEvidenceDir(dir, id), "SHA256SUMS")).text();
  expect(sums).toBe(`${png.sha256}  full/render.png\n`);
  expect(sums).toBe(sha256Sums(manifest));

  // Небезопасное имя записи роняет запись целиком, а не пишет половину манифеста.
  const evil = manifestOf(id, [{ name: "../escape.png", sha256: png.sha256, bytes: png.bytes }]);
  await expect(writeRunManifest(dir, newRunId(), evil)).rejects.toThrow();
});

test("gcEvidence keeps referenced artifacts, drops the result row together with its artifacts, and honours the grace period", async () => {
  const dir = await tmpDir();
  const { db, repo } = seed();
  const live = await putArtifact(dir, new Uint8Array([1]));
  const stale = await putArtifact(dir, new Uint8Array([2]));
  const orphan = await putArtifact(dir, new Uint8Array([3]));
  const young = await putArtifact(dir, new Uint8Array([4]));

  // Живой результат: на его отпечаток ссылается строка `acceptance_cases`.
  const { runId: liveRun } = seedRun(repo, { caseFingerprint: "fp-live", status: "pass" });
  repo.putCaseResult({ caseFingerprint: "fp-live", componentId: "yp-badge", artifacts: [{ name: "render.png", sha256: live.sha256, bytes: live.bytes }], metrics: {}, verdict: "pass", producedRunId: liveRun });
  // Протухший результат без ссылок из случаев.
  const { runId: staleRun } = seedRun(repo, { caseFingerprint: "fp-other" });
  repo.putCaseResult({ caseFingerprint: "fp-stale", componentId: "yp-badge", artifacts: [{ name: "render.png", sha256: stale.sha256, bytes: stale.bytes }], metrics: {}, verdict: "fail", producedRunId: staleRun }, "2020-01-01T00:00:00.000Z");

  // Старим всё, кроме `young`: grace-период защищает молодые артефакты.
  const old = new Date(Date.now() - 3 * 3600_000);
  for (const artifact of [live, stale, orphan]) await utimes(artifact.path, old, old);

  const report = await gcEvidence(dir, repo);
  expect(await artifactPresent(dir, live.sha256)).toBe(true);
  expect(await artifactPresent(dir, stale.sha256)).toBe(false);
  expect(await artifactPresent(dir, orphan.sha256)).toBe(false);
  // Молодой сирота переживает проход: строка результата могла ещё не закоммититься.
  expect(await artifactPresent(dir, young.sha256)).toBe(true);
  expect(repo.caseResult("fp-stale")).toBeUndefined();
  expect(repo.caseResult("fp-live")).toBeDefined();
  expect(report.removedResults).toBe(1);
  expect(report.removedArtifacts).toBe(2);
  db.close();
});

test("gcEvidence evicts failed-run results under the byte ceiling and never touches run metadata", async () => {
  const dir = await tmpDir();
  const { db, repo } = seed();
  const failed = await putArtifact(dir, new Uint8Array(2048).fill(7));
  const passed = await putArtifact(dir, new Uint8Array(2048).fill(8));
  const { runId: failRun } = seedRun(repo, { caseFingerprint: "fp-fail", status: "fail" });
  const { runId: passRun } = seedRun(repo, { caseFingerprint: "fp-pass", status: "pass" });
  repo.putCaseResult({ caseFingerprint: "fp-fail", componentId: "yp-badge", artifacts: [{ name: "render.png", sha256: failed.sha256, bytes: failed.bytes }], metrics: {}, verdict: "fail", producedRunId: failRun });
  repo.putCaseResult({ caseFingerprint: "fp-pass", componentId: "yp-badge", artifacts: [{ name: "render.png", sha256: passed.sha256, bytes: passed.bytes }], metrics: {}, verdict: "pass", producedRunId: passRun });
  const manifest = manifestOf(failRun, [{ name: "render.png", sha256: failed.sha256, bytes: failed.bytes }]);
  await writeRunManifest(dir, failRun, manifest);

  const report = await gcEvidence(dir, repo, { maxBytes: 3000, graceMs: 0 });
  expect(await artifactPresent(dir, failed.sha256)).toBe(false);
  expect(repo.caseResult("fp-fail")).toBeUndefined();
  // Доказательства прошедшей приёмки не вытесняются.
  expect(await artifactPresent(dir, passed.sha256)).toBe(true);
  expect(repo.caseResult("fp-pass")).toBeDefined();
  // Метаданные рана — свидетельство, GC их не трогает.
  expect(await readRunManifest(dir, failRun)).toEqual(manifest);
  expect((await stat(resolve(runEvidenceDir(dir, failRun), "SHA256SUMS"))).size).toBeGreaterThan(0);
  expect(report.removedResults).toBe(1);
  db.close();
});

test("gcEvidence survives a crash between artifact write and result row (young orphan stays, old orphan goes)", async () => {
  const dir = await tmpDir();
  const { db, repo } = seed();
  const orphanPath = casPath(dir, "f".repeat(64));
  await Bun.write(orphanPath, "x");
  await writeFile(resolve(casRoot(dir), "not-a-shard-file"), "junk").catch(() => {});
  const before = await gcEvidence(dir, repo);
  expect(before.removedArtifacts).toBe(0);
  expect(await artifactPresent(dir, "f".repeat(64))).toBe(true);
  const after = await gcEvidence(dir, repo, { graceMs: 0 });
  expect(after.removedArtifacts).toBe(1);
  db.close();
});
