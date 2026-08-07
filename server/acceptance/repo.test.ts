import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../migrations";
import { AcceptanceRepo, isTerminalRunStatus } from "./repo";
import { ApiError } from "../http";
import { buildFingerprint, candidateId, caseFingerprintsOf, isRunId, runId } from "./ids";
import { ACCEPTANCE_POLICIES, policyProfileHash, requiredGates } from "./policies";

const policy = ACCEPTANCE_POLICIES["default-v1"];
const profileHash = policyProfileHash(policy);

const dbForRepo = () => { const db = new Database(":memory:"); migrate(db); return db; };

const surface = { viewport: { width: 390, height: 844 }, dsf: 2, theme: "light" } as const;

function candidateInput(overrides: Partial<Parameters<AcceptanceRepo["createCandidate"]>[0]> = {}) {
  return {
    componentId: "yp-badge",
    designSystem: "yandex-pay",
    rev: 3,
    sourceHash: "src-hash",
    bundleHash: "bundle-hash",
    hostAbiVersion: 4,
    themeVersion: 7,
    observedCatalogRevision: "catalog-rev-1",
    policyProfileHash: profileHash,
    createdBy: "user_a",
    ...overrides,
  };
}

function seedRun(repo: AcceptanceRepo, id: string, extra: Record<string, unknown> = {}) {
  const { candidate } = repo.createCandidate(candidateInput(extra));
  return repo.createRun({
    candidateId: candidate.candidate_id,
    componentId: candidate.component_id,
    policyProfileId: policy.id,
    policyProfileHash: profileHash,
    createdBy: "user_a",
    cases: [{ caseId: id, caseKey: "default", propsHash: "props-1", casePolicyHash: "case-policy-v0", caseFingerprint: "fp-1" }],
  }).run;
}

// ------------------------------------------------------------------ схема v25

test("v25 lands on a database migrated from scratch and leaves no foreign-key violations", () => {
  const db = dbForRepo();
  expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(35);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  // Partial unique index — первый в проекте; его наличие и есть механизм «≤1 нетерминальный run».
  const index = db.query("SELECT sql FROM sqlite_master WHERE type='index' AND name='acceptance_runs_one_in_flight'").get() as { sql: string } | null;
  expect(index?.sql).toContain("WHERE status IN ('queued','running')");
  // v32 (план 2026-08-07 §W1a): объявленные поверхности случая — nullable, без backfill.
  const columns = (db.query("PRAGMA table_info(acceptance_cases)").all() as { name: string; notnull: number }[]);
  expect(columns.find((column) => column.name === "expected_surfaces_json")).toMatchObject({ notnull: 0 });
  db.close();
});

test("design_systems.acceptance defaults to 'off' so the pre-v25 INSERT (image rollback) still works", () => {
  const db = dbForRepo();
  db.run("INSERT INTO design_systems (id,name,description,builtin_provider,created_at,updated_at) VALUES ('legacy','Legacy','No acceptance column',NULL,'now','now')");
  expect(db.query("SELECT acceptance FROM design_systems WHERE id='legacy'").get()).toEqual({ acceptance: "off" });
  db.close();
});

// ------------------------------------------------------------ идентичность

test("fingerprints are deterministic and key-order independent", () => {
  const a = buildFingerprint({ sourceHash: "s", bundleHash: "b", hostAbiVersion: 4, themeVersion: 7 });
  const b = buildFingerprint({ themeVersion: 7, hostAbiVersion: 4, bundleHash: "b", sourceHash: "s" });
  expect(a).toBe(b);
  expect(buildFingerprint({ sourceHash: "s", bundleHash: "b", hostAbiVersion: 4, themeVersion: null })).not.toBe(a);
  expect(isRunId(runId())).toBe(true);
  expect(isRunId("acc_not-a-uuid")).toBe(false);
});

test("identity is component-scoped: one sourceHash shared by two components never shares a candidate or a case result", () => {
  const db = dbForRepo();
  const repo = new AcceptanceRepo(db);
  const first = repo.createCandidate(candidateInput({ componentId: "yp-badge" })).candidate;
  const second = repo.createCandidate(candidateInput({ componentId: "yp-chip" })).candidate;

  // Один и тот же source_hash/bundle_hash — это факт продукта (`componentIds` — множество).
  expect(first.source_hash).toBe(second.source_hash);
  expect(first.build_fingerprint).toBe(second.build_fingerprint);
  // …но кандидаты разные: componentId в ключе (триаж E1/B1).
  expect(first.candidate_id).not.toBe(second.candidate_id);
  expect(first.candidate_id).toBe(candidateId({
    componentId: "yp-badge", designSystem: "yandex-pay", rev: 3, buildFingerprint: first.build_fingerprint,
  }));

  // …и case-отпечатки разные при полностью одинаковых случае/поверхности — иначе cross-owner reuse.
  const fingerprintFor = (candidate: string): string => caseFingerprintsOf({
    candidateId: candidate, surface, policy: ACCEPTANCE_POLICIES["default-v1"],
    case: { caseKey: "default", propsHash: "p" },
  }).case;
  const caseA = fingerprintFor(first.candidate_id);
  const caseB = fingerprintFor(second.candidate_id);
  expect(caseA).not.toBe(caseB);
  expect(caseA).toBe(fingerprintFor(first.candidate_id));
  db.close();
});

test("policy registry hashes both profiles distinctly and geometry v2 is a required gate", () => {
  expect(policyProfileHash(ACCEPTANCE_POLICIES["default-v1"]))
    .not.toBe(policyProfileHash(ACCEPTANCE_POLICIES["pixel-strict-v1"]));
  // W3: advisory-фаза геометрии закончена — гейт входит в обязательный набор обоих профилей.
  // W4: `readiness` — тоже обязательный: кадр, снятый до готовности, не судится визуально (D5).
  expect(requiredGates(policy)).toEqual(["audit", "contract", "defaults", "determinism", "geometry", "readiness", "render"]);
  expect(policy.gates.geometry).toBe("required");
  expect(ACCEPTANCE_POLICIES["pixel-strict-v1"].gates.geometry).toBe("required");
  expect(policy.allowExceptions).toBe(false);
});

// -------------------------------------------------------------- кандидаты

test("candidate creation is idempotent by candidate_id and reports cached on repeat", () => {
  const db = dbForRepo();
  const repo = new AcceptanceRepo(db);
  const first = repo.createCandidate(candidateInput());
  const second = repo.createCandidate(candidateInput());
  expect(first.cached).toBe(false);
  expect(second.cached).toBe(true);
  expect(second.candidate.candidate_id).toBe(first.candidate.candidate_id);
  expect((db.query("SELECT COUNT(*) n FROM component_candidates").get() as { n: number }).n).toBe(1);

  // Повтор не переписывает мутируемые поля: promoted обязан пережить повторный POST.
  repo.markPromoted(first.candidate.candidate_id, 12);
  const third = repo.createCandidate(candidateInput());
  expect(third.cached).toBe(true);
  expect(third.candidate.status).toBe("promoted");
  expect(third.candidate.promoted_version).toBe(12);
  db.close();
});

test("candidate transitions validated -> promoted, is idempotent per version and conflicts on another", () => {
  const db = dbForRepo();
  const repo = new AcceptanceRepo(db);
  const id = repo.createCandidate(candidateInput()).candidate.candidate_id;
  expect(repo.requireCandidate(id).status).toBe("validated");
  expect(repo.markPromoted(id, 5).promoted_version).toBe(5);
  expect(repo.markPromoted(id, 5).status).toBe("promoted");
  expect(() => repo.markPromoted(id, 6)).toThrow(/already promoted/i);
  db.close();
});

// -------------------------------------------------------------------- раны

test("the partial unique index yields acceptance_run_in_flight and releases the candidate after terminalization", () => {
  const db = dbForRepo();
  const repo = new AcceptanceRepo(db);
  const candidate = repo.createCandidate(candidateInput()).candidate;
  const base = {
    candidateId: candidate.candidate_id, componentId: candidate.component_id,
    policyProfileId: policy.id, policyProfileHash: profileHash, createdBy: "user_a",
  };
  const first = repo.createRun(base).run;
  expect(first.status).toBe("queued");
  expect(repo.requireCandidate(candidate.candidate_id).acceptance_run_id).toBe(first.run_id);

  let error: unknown;
  try { repo.createRun(base); } catch (caught) { error = caught; }
  expect((error as { status: number; code: string }).status).toBe(409);
  expect((error as { code: string }).code).toBe("acceptance_run_in_flight");

  // Живой ран остаётся один — неудачная вставка не оставила мусора.
  expect((db.query("SELECT COUNT(*) n FROM acceptance_runs").get() as { n: number }).n).toBe(1);

  repo.startRun(first.run_id);
  repo.terminalizeRun(first.run_id, { status: "fail", gates: { render: "fail" } });
  const second = repo.createRun(base).run;
  expect(second.run_id).not.toBe(first.run_id);
  expect(second.status).toBe("queued");
  db.close();
});

test("idempotency key returns the same run instead of a conflict", () => {
  const db = dbForRepo();
  const repo = new AcceptanceRepo(db);
  const candidate = repo.createCandidate(candidateInput()).candidate;
  const base = {
    candidateId: candidate.candidate_id, componentId: candidate.component_id,
    policyProfileId: policy.id, policyProfileHash: profileHash, createdBy: "user_a", idempotencyKey: "key-1",
  };
  const first = repo.createRun(base);
  const second = repo.createRun(base);
  expect(first.cached).toBe(false);
  expect(second.cached).toBe(true);
  expect(second.run.run_id).toBe(first.run.run_id);
  db.close();
});

test("terminalization is a single transaction, is not repeated and does not rewrite a verdict", () => {
  const db = dbForRepo();
  const repo = new AcceptanceRepo(db);
  const run = seedRun(repo, "case-1");
  repo.startRun(run.run_id);
  expect(repo.requireRun(run.run_id).started_at).not.toBeNull();

  const failed = repo.terminalizeRun(run.run_id, { status: "fail", gates: { render: "fail" }, evidenceManifestHash: "sha-1" });
  expect(failed.status).toBe("fail");
  expect(failed.finished_at).not.toBeNull();
  expect(isTerminalRunStatus(failed.status)).toBe(true);

  const again = repo.terminalizeRun(run.run_id, { status: "pass", evidenceManifestHash: "sha-2" });
  expect(again.status).toBe("fail");
  expect(again.evidence_manifest_hash).toBe("sha-1");
  expect(again.finished_at).toBe(failed.finished_at);

  // Терминальный ран больше не двигается стартом.
  expect(repo.startRun(run.run_id)).toBe(false);
  db.close();
});

test("startup sweep terminalizes every non-terminal run and unblocks the candidate", () => {
  const db = dbForRepo();
  const repo = new AcceptanceRepo(db);
  const run = seedRun(repo, "case-1");
  repo.startRun(run.run_id);
  const queued = seedRun(repo, "case-2", { componentId: "yp-chip" });

  expect(repo.sweepNonTerminalRuns()).toBe(2);
  expect(repo.requireRun(run.run_id).status).toBe("error");
  expect(repo.requireRun(queued.run_id).status).toBe("error");
  expect(repo.requireRun(run.run_id).finished_at).not.toBeNull();
  expect(repo.inFlightRun(run.candidate_id)).toBeUndefined();
  // Повторная уборка на чистой базе — ноль изменений.
  expect(repo.sweepNonTerminalRuns()).toBe(0);
  db.close();
});

test("watchdog selects only running runs older than the deadline", () => {
  const db = dbForRepo();
  const repo = new AcceptanceRepo(db);
  const stale = seedRun(repo, "case-1");
  const fresh = seedRun(repo, "case-2", { componentId: "yp-chip" });
  repo.startRun(stale.run_id, new Date(Date.now() - 60 * 60 * 1000).toISOString());
  repo.startRun(fresh.run_id);

  const overdue = repo.runningRunsOlderThan(policy.runDeadlineMs);
  expect(overdue.map(row => row.run_id)).toEqual([stale.run_id]);
  for (const row of overdue) repo.terminalizeRun(row.run_id, { status: "error" });
  expect(repo.runningRunsOlderThan(policy.runDeadlineMs)).toEqual([]);
  db.close();
});

// ---------------------------------------------------------------- случаи

test("case rows are patched field-by-field and untouched fields survive", () => {
  const db = dbForRepo();
  const repo = new AcceptanceRepo(db);
  const run = seedRun(repo, "case-1");
  repo.updateCase(run.run_id, "case-1", { status: "running", startedAt: "2026-08-03T00:00:00.000Z" });
  repo.updateCase(run.run_id, "case-1", {
    status: "done", verdict: "fail",
    gates: { render: "fail" }, severity: { rank: 1, class: "structural" },
    captureQuality: { captureClean: false, productErrors: 1, runtimeWarnings: 0, infraWarnings: 0 },
    reuseReason: null, finishedAt: "2026-08-03T00:01:00.000Z",
  });
  const row = repo.case(run.run_id, "case-1");
  expect(row).toMatchObject({ status: "done", verdict: "fail", started_at: "2026-08-03T00:00:00.000Z" });
  expect(JSON.parse(row!.capture_quality_json!)).toMatchObject({ captureClean: false, productErrors: 1 });
  expect(repo.cases(run.run_id)).toHaveLength(1);
  db.close();
});

test("case results upsert, touch last_used_at, stay component-scoped and expose a union refcount", () => {
  const db = dbForRepo();
  const repo = new AcceptanceRepo(db);
  const run = seedRun(repo, "case-1");
  repo.putCaseResult({
    caseFingerprint: "fp-1", componentId: "yp-badge",
    artifacts: { png: "sha-a" }, metrics: { ms: 1200 }, verdict: "pass", producedRunId: run.run_id,
  }, "2026-08-01T00:00:00.000Z");
  repo.putCaseResult({
    caseFingerprint: "fp-1", componentId: "yp-badge",
    artifacts: { png: "sha-b" }, metrics: { ms: 900 }, verdict: "pass", producedRunId: run.run_id,
  }, "2026-08-02T00:00:00.000Z");
  expect((db.query("SELECT COUNT(*) n FROM acceptance_case_results").get() as { n: number }).n).toBe(1);
  expect(repo.caseResult("fp-1")?.last_used_at).toBe("2026-08-02T00:00:00.000Z");
  repo.touchCaseResult("fp-1", "2026-08-03T00:00:00.000Z");
  expect(repo.caseResult("fp-1")?.last_used_at).toBe("2026-08-03T00:00:00.000Z");

  // Владение проверяется поверх отпечатка — reuse чужого компонента невозможен.
  expect(repo.caseResultForComponent("fp-1", "yp-badge")).toBeDefined();
  expect(repo.caseResultForComponent("fp-1", "yp-chip")).toBeUndefined();

  // Union-refcount: живой случай + строка кэша.
  expect(repo.caseFingerprintRefcount("fp-1")).toEqual({ cases: 1, results: 1, total: 2 });
  expect(repo.unreferencedCaseResults("2026-09-01T00:00:00.000Z")).toEqual([]);
  db.run("DELETE FROM acceptance_cases");
  expect(repo.caseFingerprintRefcount("fp-1")).toEqual({ cases: 0, results: 1, total: 1 });
  expect(repo.unreferencedCaseResults("2026-09-01T00:00:00.000Z").map(row => row.case_fingerprint)).toEqual(["fp-1"]);
  db.close();
});

// -------------------------------------------------------------------- GC

test("the candidate sweeper skips promoted rows, live runs and anything a publish references", () => {
  const db = dbForRepo();
  const repo = new AcceptanceRepo(db);
  const past = "2026-01-01T00:00:00.000Z";
  const expired = (componentId: string) => {
    const row = repo.createCandidate(candidateInput({ componentId })).candidate;
    db.query("UPDATE component_candidates SET expires_at=? WHERE candidate_id=?").run(past, row.candidate_id);
    return row;
  };

  const plain = expired("yp-plain");
  const promoted = expired("yp-promoted");
  repo.markPromoted(promoted.candidate_id, 2);
  const busy = expired("yp-busy");
  repo.createRun({
    candidateId: busy.candidate_id, componentId: busy.component_id,
    policyProfileId: policy.id, policyProfileHash: profileHash, createdBy: "user_a",
  });
  const provenance = expired("yp-provenance");
  const provenanceRun = repo.createRun({
    candidateId: provenance.candidate_id, componentId: provenance.component_id,
    policyProfileId: policy.id, policyProfileHash: profileHash, createdBy: "user_a",
  }).run;
  repo.terminalizeRun(provenanceRun.run_id, { status: "pass" });
  // Плоские TEXT-колонки A9: FK нет, поэтому защиту обеспечивает только запрос свипера.
  db.run("INSERT INTO components (id,name,head_rev,design_system,created_at,updated_at) VALUES ('yp-provenance','YpProvenance',1,'yandex-pay','now','now')");
  db.run("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES ('yp-provenance',1,'src','yandex-pay','now')");
  db.query(`INSERT INTO component_publishes
    (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,published_at,candidate_id,acceptance_run_id)
    VALUES ('yp-provenance',1,1,'active','js','{}','src-hash','bundle-hash',4,'now',?,?)`)
    .run(provenance.candidate_id, provenanceRun.run_id);

  const swept = repo.sweepExpiredCandidates();
  expect(swept.deleted).toBe(1);
  // `promoted` отсеивается ещё выборкой (в кандидаты на удаление не попадает), поэтому в
  // `skipped` остаются двое: кандидат с живым раном и кандидат, чей ран держит publish.
  expect(swept.skipped).toBe(2);
  expect(repo.candidate(plain.candidate_id)).toBeUndefined();
  expect(repo.candidate(promoted.candidate_id)?.status).toBe("promoted");
  expect(repo.candidate(busy.candidate_id)).toBeDefined();
  expect(repo.candidate(provenance.candidate_id)).toBeDefined();
  expect(repo.isRunReferencedByPublish(provenanceRun.run_id)).toBe(true);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

/**
 * W7/C27: версия, подтверждённая **набором** ранов, защищает от GC каждый ран набора. Свипер
 * читает union скалярной колонки и `json_each(acceptance_run_ids)` — без второго слагаемого TTL
 * унёс бы все шарды семьи, кроме первого, и provenance активной версии стал бы битым.
 */
test("a publish backed by two runs protects both of them from the candidate sweeper", () => {
  const db = dbForRepo();
  const repo = new AcceptanceRepo(db);
  const { candidate } = repo.createCandidate(candidateInput({ componentId: "yp-family" }));
  const runs = ["shard-a", "shard-b"].map((caseId) => {
    const run = repo.createRun({
      candidateId: candidate.candidate_id, componentId: candidate.component_id,
      policyProfileId: policy.id, policyProfileHash: profileHash, createdBy: "user_a",
      cases: [{ caseId, caseKey: caseId, propsHash: `props-${caseId}`, casePolicyHash: "case-policy-v0", caseFingerprint: `fp-${caseId}` }],
    }).run;
    repo.terminalizeRun(run.run_id, { status: "pass" });
    return run;
  });
  db.run("INSERT INTO components (id,name,head_rev,design_system,created_at,updated_at) VALUES ('yp-family','YpFamily',1,'yandex-pay','now','now')");
  db.run("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES ('yp-family',1,'src','yandex-pay','now')");
  db.query(`INSERT INTO component_publishes
    (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,published_at)
    VALUES ('yp-family',1,1,'active','js','{}','src-hash','bundle-hash',4,'now')`).run();
  repo.linkPublish("yp-family", 1, { candidateId: candidate.candidate_id, acceptanceRunIds: runs.map((run) => run.run_id) });
  // Легаси-скаляр — первый элемент набора; второй ран виден только через массив.
  expect((db.query("SELECT acceptance_run_id id FROM component_publishes WHERE component_id='yp-family'").get() as { id: string }).id)
    .toBe(runs[0]!.run_id);
  for (const run of runs) expect(repo.isRunReferencedByPublish(run.run_id)).toBe(true);
  expect([...repo.runIdsReferencedByPublishes()].sort()).toEqual(runs.map((run) => run.run_id).sort());

  // Кандидат протух — но свипер обязан пропустить его целиком: оба рана держат publish.
  db.query("UPDATE component_candidates SET expires_at='2026-01-01T00:00:00.000Z'").run();
  expect(repo.sweepExpiredCandidates()).toEqual({ deleted: 0, skipped: 1 });
  for (const run of runs) expect(repo.run(run.run_id)).toBeDefined();
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

test("sweeping a plain expired candidate removes its terminal runs and cascades the cases", () => {
  const db = dbForRepo();
  const repo = new AcceptanceRepo(db);
  const run = seedRun(repo, "case-1");
  repo.terminalizeRun(run.run_id, { status: "pass" });
  db.query("UPDATE component_candidates SET expires_at='2026-01-01T00:00:00.000Z'").run();

  expect(repo.sweepExpiredCandidates()).toEqual({ deleted: 1, skipped: 0 });
  expect(repo.run(run.run_id)).toBeUndefined();
  expect((db.query("SELECT COUNT(*) n FROM acceptance_cases").get() as { n: number }).n).toBe(0);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

// ------------------------------------------------- отклонения (R3b, §3.2а)

test("rejecting a candidate writes an append-only tombstone and is terminal on repeat", () => {
  const db = dbForRepo();
  const repo = new AcceptanceRepo(db);
  const { candidate } = repo.createCandidate(candidateInput());

  expect(repo.decision(candidate.candidate_id)).toBeUndefined();
  const rejected = repo.rejectCandidate({ candidateId: candidate.candidate_id, reason: "baseline drifted", actor: "user_a" });
  expect(rejected.decision).toMatchObject({ decision: "rejected", reason: "baseline drifted", actor: "user_a" });
  // Надгробие не мутирует сам кандидат: `status` остаётся хранимым enum'ом (§3.2а).
  expect(repo.candidate(candidate.candidate_id)?.status).toBe("validated");

  // Повтор — терминальный конфликт с существующим решением в `details`, а не вторая строка.
  try {
    repo.rejectCandidate({ candidateId: candidate.candidate_id, reason: "again", actor: "user_b" });
    throw new Error("expected candidate_already_rejected");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    const api = error as ApiError;
    expect(api.status).toBe(409);
    expect(api.code).toBe("candidate_already_rejected");
    expect(api.details).toMatchObject({ reason: "baseline drifted", actor: "user_a" });
  }
  expect((db.query("SELECT COUNT(*) n FROM candidate_decisions").get() as { n: number }).n).toBe(1);
  db.close();
});

test("a promoted candidate cannot be rejected: candidate_promoted, not candidate_already_promoted", () => {
  const db = dbForRepo();
  const repo = new AcceptanceRepo(db);
  const { candidate } = repo.createCandidate(candidateInput());
  repo.markPromoted(candidate.candidate_id, 7);

  try {
    repo.rejectCandidate({ candidateId: candidate.candidate_id, reason: "too late", actor: "user_a" });
    throw new Error("expected candidate_promoted");
  } catch (error) {
    const api = error as ApiError;
    expect(api.status).toBe(409);
    // Два разных кода, два разных состояния (триаж раунд3-MJ-1): `candidate_already_promoted`
    // принадлежит CAS'у `markPromoted`, а не reject-ветке.
    expect(api.code).toBe("candidate_promoted");
    expect(api.details).toMatchObject({ currentVersion: 7 });
  }
  expect(repo.decision(candidate.candidate_id)).toBeUndefined();
  db.close();
});

test("the sweeper never deletes a rejected candidate: the tombstone outlives the TTL", () => {
  const db = dbForRepo();
  const repo = new AcceptanceRepo(db);
  const { candidate } = repo.createCandidate(candidateInput({ componentId: "yp-rejected" }));
  repo.rejectCandidate({ candidateId: candidate.candidate_id, reason: "wrong spacing", actor: "user_a" });
  db.query("UPDATE component_candidates SET expires_at='2026-01-01T00:00:00.000Z'").run();

  // Иначе каскад `ON DELETE CASCADE` снёс бы решение и TTL работал бы отложенным `unreject`.
  expect(repo.sweepExpiredCandidates()).toEqual({ deleted: 0, skipped: 0 });
  expect(repo.candidate(candidate.candidate_id)).toBeDefined();
  expect(repo.decision(candidate.candidate_id)?.reason).toBe("wrong spacing");

  // Анти-воскрешение: та же сборка даёт ту же строку — уже с надгробием.
  const repeated = repo.createCandidate(candidateInput({ componentId: "yp-rejected" }));
  expect(repeated.cached).toBe(true);
  expect(repeated.candidate.candidate_id).toBe(candidate.candidate_id);
  expect(repo.decision(repeated.candidate.candidate_id)).toBeDefined();
  db.close();
});

// -------------------------------------------------------------- покрытие (v31)

/**
 * Ран с произвольным набором случаев. Кандидат уникален по `componentId`, поэтому partial unique
 * index «≤1 нетерминальный ран» не мешает завести несколько ранов в одном тесте.
 */
function runWithCases(repo: AcceptanceRepo, componentId: string, cases: { caseId: string; propsHash: string; slotsHash?: string | null }[]) {
  const { candidate } = repo.createCandidate(candidateInput({ componentId }));
  const { run } = repo.createRun({
    candidateId: candidate.candidate_id,
    componentId: candidate.component_id,
    policyProfileId: policy.id,
    policyProfileHash: profileHash,
    createdBy: "user_a",
    cases: cases.map((item) => ({
      caseId: item.caseId, caseKey: item.caseId, propsHash: item.propsHash,
      casePolicyHash: "case-policy-v0", caseFingerprint: `fp-${componentId}-${item.caseId}`,
      ...(item.slotsHash === undefined ? {} : { slotsHash: item.slotsHash }),
    })),
  });
  return run;
}

/**
 * Поведенческий инвариант ключа покрытия (§A8). Ключ живёт только в памяти, поэтому его байтовый
 * формат не проверяется; проверяется то, ради чего promote его читает: **для бесслотовых ранов
 * (`slots_hash` NULL) мощности множеств и их попарные пересечения те же, что до v31**. Ожидание
 * посчитано вручную по старой функции `${props_hash}@${surfaceKey}`: два случая с props-1/props-1
 * дают ОДИН ключ, три случая с props-1/props-2/props-3 — ТРИ, пересечение — ровно props-1.
 */
test("runCoverage keeps slot-free cardinality and intersections: NULL slots_hash collapses to the pre-v31 key set", () => {
  const db = dbForRepo();
  const repo = new AcceptanceRepo(db);
  const left = runWithCases(repo, "yp-cov-left", [
    { caseId: "alpha", propsHash: "props-1" },
    { caseId: "beta", propsHash: "props-1" },
  ]);
  const right = runWithCases(repo, "yp-cov-right", [
    { caseId: "alpha", propsHash: "props-1" },
    { caseId: "beta", propsHash: "props-2" },
    { caseId: "gamma", propsHash: "props-3" },
  ]);

  const leftCoverage = repo.runCoverage(left);
  const rightCoverage = repo.runCoverage(right);
  // Строки на месте, но покрытие считается кадрами: две строки с одинаковыми props — один ключ.
  expect(leftCoverage.cases).toBe(2);
  expect(leftCoverage.keys.size).toBe(1);
  expect(rightCoverage.keys.size).toBe(3);
  // Поверхность у обоих ранов дефолтная (набора нет), поэтому ключи сравнимы между ранами.
  expect(leftCoverage.surfaceKey).toBe(rightCoverage.surfaceKey);
  const intersection = [...leftCoverage.keys].filter((key) => rightCoverage.keys.has(key));
  expect(intersection).toEqual([...leftCoverage.keys]);
  expect(intersection.length).toBe(1);
  // Объединение двух ранов покрывает ровно три props-кадра — как и до v31.
  expect(new Set([...leftCoverage.keys, ...rightCoverage.keys]).size).toBe(3);
  db.close();
});

/**
 * Ровно та коллизия, ради которой колонка заведена (§A3, кейс SMS): одинаковые props, разные дети
 * слотов — два разных кадра. До v31 они схлопывались в один элемент покрытия, и
 * `assertRunSetCoherent` видел ложное пересечение ранов.
 */
test("runCoverage separates two cases that differ only in slots_hash", () => {
  const db = dbForRepo();
  const repo = new AcceptanceRepo(db);
  const run = runWithCases(repo, "yp-cov-slots", [
    { caseId: "alpha", propsHash: "props-1", slotsHash: "slots-a" },
    { caseId: "beta", propsHash: "props-1", slotsHash: "slots-b" },
  ]);

  const coverage = repo.runCoverage(run);
  expect(coverage.cases).toBe(2);
  expect(coverage.keys.size).toBe(2);
  // Строки действительно разошлись по колонке, а не по props.
  expect(repo.cases(run.run_id).map((row) => [row.props_hash, row.slots_hash]))
    .toEqual([["props-1", "slots-a"], ["props-1", "slots-b"]]);

  // NULL — «случай без слотов» — не совпадает ни с одним слотовым кадром, но совпадает сам с собой.
  const other = runWithCases(repo, "yp-cov-slotless", [
    { caseId: "alpha", propsHash: "props-1" },
    { caseId: "beta", propsHash: "props-1", slotsHash: null },
  ]);
  const otherCoverage = repo.runCoverage(other);
  expect(otherCoverage.keys.size).toBe(1);
  expect([...otherCoverage.keys].filter((key) => coverage.keys.has(key))).toEqual([]);
  db.close();
});

// -------------------- candidate dependency overlay: durable-пин GC (§W3, план 2026-08-07)

const OVERLAY = [
  { componentId: "pay-leaf", candidateId: `cand_${"1".repeat(64)}`, rev: 1, sourceHash: "src-leaf", bundleHash: "bh-leaf" },
  { componentId: "pay-mid", candidateId: `cand_${"2".repeat(64)}`, rev: 1, sourceHash: "src-mid", bundleHash: "bh-mid" },
] as const;

test("§W3: overlay персистится на ране и пинует бандлы зависимостей от GC — durable, через рестарт", () => {
  const db = dbForRepo();
  const repo = new AcceptanceRepo(db);
  const { candidate } = repo.createCandidate(candidateInput());
  const { run } = repo.createRun({
    candidateId: candidate.candidate_id,
    componentId: candidate.component_id,
    policyProfileId: policy.id,
    policyProfileHash: profileHash,
    createdBy: "user_a",
    overlay: OVERLAY,
    cases: [{ caseId: "alpha", caseKey: "alpha", propsHash: "props-1", casePolicyHash: "case-policy-v0", caseFingerprint: "fp-1" }],
  });
  expect(JSON.parse(run.overlay_manifest_json!)).toEqual([...OVERLAY]);
  expect(run.overlay_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(repo.runOverlay(run)).toEqual([...OVERLAY]);

  // Пин: и голова кандидата, и **все** узлы графа. Иначе GC вытеснил бы бандл зависимости
  // посреди рана, и кадр снялся бы с пустым слотом при том же frame_fingerprint.
  expect([...repo.pinnedSourceHashes()].sort()).toEqual(["src-hash", "src-leaf", "src-mid"]);

  // Имитация рестарта процесса: свежий репозиторий над той же БД. In-memory лизы для этого
  // непригодны (триаж C-M2) — пин обязан жить в строке рана.
  expect([...new AcceptanceRepo(db).pinnedSourceHashes()].sort()).toEqual(["src-hash", "src-leaf", "src-mid"]);

  // Терминальный ран пин снимает: доказательства уже записаны, бандл больше не нужен.
  repo.terminalizeRun(run.run_id, { status: "pass" });
  expect([...repo.pinnedSourceHashes()]).toEqual([]);
  db.close();
});

test("§W3: overlay-free ран оставляет обе колонки NULL и прежний набор пинов", () => {
  const db = dbForRepo();
  const repo = new AcceptanceRepo(db);
  const run = seedRun(repo, "alpha");
  expect({ manifest: run.overlay_manifest_json, hash: run.overlay_hash }).toEqual({ manifest: null, hash: null });
  // Пустой массив — то же самое, что отсутствие графа (инвариант «отсутствует, а не пусто»).
  const { candidate } = repo.createCandidate(candidateInput({ componentId: "yp-other", sourceHash: "src-other" }));
  const empty = repo.createRun({
    candidateId: candidate.candidate_id, componentId: candidate.component_id,
    policyProfileId: policy.id, policyProfileHash: profileHash, createdBy: "user_a", overlay: [],
    cases: [{ caseId: "alpha", caseKey: "alpha", propsHash: "props-1", casePolicyHash: "case-policy-v0", caseFingerprint: "fp-2" }],
  }).run;
  expect(empty.overlay_manifest_json).toBeNull();
  expect([...repo.pinnedSourceHashes()].sort()).toEqual(["src-hash", "src-other"]);
  db.close();
});
