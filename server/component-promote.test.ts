import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { createTestHandler } from "./test-auth";
import { createHandler } from "./main";
import { openDatabase } from "./db";
import { sha256 } from "./components/pipeline";
import { readCandidate, writeCandidate } from "./components/candidates";
import { failStagingPublishes } from "./repos/components";
import { PrototypeRepo } from "./repos/prototypes";
import { BOOTSTRAP_ADMIN_ID, ensureBootstrapAdmin, UserRepo } from "./users";
import { routeComponents } from "./routes/components";
import { AcceptanceOrchestrator } from "./acceptance/orchestrator";
import { ACCEPTANCE_POLICIES, DEFAULT_ACCEPTANCE_POLICY_ID, policyProfileHash } from "./acceptance/policies";
import type { AcceptanceCaptureService } from "./acceptance/gates/types";

/**
 * RFC candidate-acceptance-pipeline, волна R1: promote-сага, расширенный `already_published`,
 * фаза B (activate+pinAssets+recordValidation+auto-supersede), auth драфт-бандла,
 * readiness «no active version», kill-switch и аудит-события.
 *
 * Компонентные id уникальны для файла: кэши import-верификации живут в общем процессе
 * `bun test`, и чужие публикации того же id сломали бы утверждения про них.
 */

const dirs: string[] = [];
const databases: Database[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/**
 * Капчур приёмки в этом файле не исполняется: раны создаются напрямую через `orchestrator.repo`
 * и терминализуются нужным вердиктом. Предмет тестов — сага promote, а не съёмка (её проверяют
 * `acceptance/runner.test.ts` и `acceptance-routes.test.ts`), поэтому заглушка обязана падать,
 * если ран всё-таки поехал бы.
 */
const noCapture: AcceptanceCaptureService = {
  enqueueComponentCandidate() { throw new Error("acceptance capture must not run in promote saga tests"); },
  get() { throw new Error("acceptance capture must not run in promote saga tests"); },
  outcome() { return undefined; },
  hasBackgroundCapacity() { return true; },
} as unknown as AcceptanceCaptureService;

async function setup(options: { acceptanceDisabled?: boolean; matrix?: boolean } = {}) {
  const { matrix, ...handlerOptions } = options;
  const dir = await mkdtemp(resolve(process.cwd(), ".promote-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  databases.push(db);
  // Флаг матрицы — наличие оркестратора (тот же шов, что и в `startServer`); autoDrain выключен:
  // очередь в этих тестах двигают руками.
  const orchestrator = matrix ? new AcceptanceOrchestrator({ db, dataDir: dir, service: noCapture, autoDrain: false }) : undefined;
  const handler = createTestHandler(db, { dataDir: dir, ...handlerOptions, ...(orchestrator ? { acceptance: orchestrator } : {}) });
  return { dir, db, handler, orchestrator };
}

const DEFAULT_POLICY = ACCEPTANCE_POLICIES[DEFAULT_ACCEPTANCE_POLICY_ID];

const req = (url: string, method = "GET", value?: unknown) =>
  new Request(`http://test/api${url}`, {
    method,
    headers: value === undefined ? undefined : { "content-type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value),
  });

const fixture = (name: string) => Bun.file(resolve("server/fixtures", name)).text();

async function createComponent(handler: (r: Request) => Promise<Response>, id: string, name: string, source: string) {
  const response = await handler(req("/components", "POST", {
    designSystem: "yandex-pay", id, name, source,
    intent: `Promotes ${name} for the acceptance pipeline test`,
  }));
  expect(response.status).toBe(201);
}

/** validate → promote: пара `{baseRev, sourceHash}` берётся из receipt, как это делает CLI. */
async function validateThenPromote(handler: (r: Request) => Promise<Response>, id: string, rev: number, body: Record<string, unknown> = {}) {
  const receipt = await handler(req(`/components/${id}/validate`, "POST"));
  expect(receipt.status).toBe(200);
  const { sourceHash } = await receipt.json() as { sourceHash: string };
  return handler(req(`/components/${id}/promote`, "POST", { baseRev: rev, sourceHash, ...body }));
}

const versionRows = (db: Database, id: string) =>
  db.query("SELECT version,rev,status,status_reason statusReason,superseded_by supersededBy,host_abi_version hostAbi FROM component_publishes WHERE component_id=? ORDER BY version")
    .all(id) as { version: number; rev: number; status: string; statusReason: string | null; supersededBy: number | null; hostAbi: number }[];

const auditActions = (db: Database, id: string) =>
  (db.query("SELECT action,detail FROM audit_events WHERE subject_id=? ORDER BY id").all(id) as { action: string; detail: string | null }[]);

async function saveRevision(handler: (r: Request) => Promise<Response>, id: string, source: string, baseRev: number) {
  const response = await handler(req(`/components/${id}`, "PUT", { source, baseRev }));
  expect(response.status).toBe(200);
  return (await response.json() as { rev: number }).rev;
}

/** Тот же исходник с уникальным маркером: новая ревизия и новый sourceHash. */
const variant = (source: string, marker: string) => `${source}\n// ${marker}\n`;

describe("component promote saga (RFC R1)", () => {
  test("promote activates one version and auto-supersedes the previous active ones in one transaction", async () => {
    const { db, handler } = await setup();
    const source = await fixture("rating-stars.tsx");
    await createComponent(handler, "promote-stars", "PromoteStars", source);

    const first = await validateThenPromote(handler, "promote-stars", 1);
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ version: 1, rev: 1, superseded: [] });

    const rev2 = await saveRevision(handler, "promote-stars", variant(source, "v2"), 1);
    const second = await validateThenPromote(handler, "promote-stars", rev2);
    expect(second.status).toBe(201);
    const body = await second.json() as { version: number; superseded: number[]; cached: boolean };
    expect(body).toMatchObject({ version: 2, superseded: [1] });

    const rows = versionRows(db, "promote-stars");
    expect(rows.map((row) => [row.version, row.status])).toEqual([[1, "superseded"], [2, "active"]]);
    expect(rows[0]).toMatchObject({ supersededBy: 2, statusReason: "auto: promoted v2" });
    // Инвариант пула: ровно одна active-версия после промоушена.
    expect(rows.filter((row) => row.status === "active")).toHaveLength(1);
  }, 120_000);

  test("two concurrent promotes never leave the component without an active version", async () => {
    const { db, handler } = await setup();
    const source = await fixture("rating-stars.tsx");
    await createComponent(handler, "promote-race", "PromoteRace", source);
    expect((await validateThenPromote(handler, "promote-race", 1)).status).toBe(201);

    const rev2 = await saveRevision(handler, "promote-race", variant(source, "race"), 1);
    const receipt = await (await handler(req("/components/promote-race/validate", "POST"))).json() as { sourceHash: string };
    // Два одновременных promote одной и той же ревизии: один создаёт версию, второй обязан
    // упереться в `already_published` — оба не имеют права оставить 0 active.
    const [a, b] = await Promise.all([
      handler(req("/components/promote-race/promote", "POST", { baseRev: rev2, sourceHash: receipt.sourceHash })),
      handler(req("/components/promote-race/promote", "POST", { baseRev: rev2, sourceHash: receipt.sourceHash })),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(201);
    expect([409, 429]).toContain(statuses[1]!);
    const rows = versionRows(db, "promote-race");
    expect(rows.filter((row) => row.status === "active")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "active")[0]!.version).toBe(2);
  }, 120_000);

  test("supersede: \"none\" leaves the previous versions active in parallel", async () => {
    const { db, handler } = await setup();
    const source = await fixture("rating-stars.tsx");
    await createComponent(handler, "promote-parallel", "PromoteParallel", source);
    expect((await validateThenPromote(handler, "promote-parallel", 1)).status).toBe(201);
    const rev2 = await saveRevision(handler, "promote-parallel", variant(source, "parallel"), 1);
    const second = await validateThenPromote(handler, "promote-parallel", rev2, { supersede: "none" });
    expect(second.status).toBe(201);
    expect(await second.json()).toMatchObject({ version: 2, superseded: [] });
    expect(versionRows(db, "promote-parallel").map((row) => row.status)).toEqual(["active", "active"]);
  }, 120_000);

  test("recovery: promote after a crashed saga passes the widened already_published check and leaves a numbering gap", async () => {
    const { db, handler } = await setup();
    const source = await fixture("rating-stars.tsx");
    await createComponent(handler, "promote-recovery", "PromoteRecovery", source);

    const receipt = await (await handler(req("/components/promote-recovery/validate", "POST"))).json() as { sourceHash: string };
    // Симуляция краха между stage и activate: строка v1 остаётся staging, стартовая уборка
    // переводит её в failed (существующий механизм `failStagingPublishes`).
    db.query("INSERT INTO component_publishes (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,published_at) VALUES (?,1,1,'staging','','{}',?,'x',1,?)")
      .run("promote-recovery", receipt.sourceHash, new Date().toISOString());
    expect(failStagingPublishes(db)).toBe(1);

    const promoted = await handler(req("/components/promote-recovery/promote", "POST", { baseRev: 1, sourceHash: receipt.sourceHash }));
    expect(promoted.status).toBe(201);
    // `UNIQUE (component_id, rev)` не даёт завести вторую строку той же ревизии, поэтому повтор
    // переписывает failed-строку на месте: номер версии сохраняется, дырки в нумерации нет.
    expect(versionRows(db, "promote-recovery").map((row) => [row.version, row.status])).toEqual([[1, "active"]]);
    expect(versionRows(db, "promote-recovery")[0]!.rev).toBe(1);
  }, 120_000);

  test("a second promote of an already published revision is a terminal 409 already_published", async () => {
    const { handler } = await setup();
    const source = await fixture("rating-stars.tsx");
    await createComponent(handler, "promote-twice", "PromoteTwice", source);
    expect((await validateThenPromote(handler, "promote-twice", 1)).status).toBe(201);
    const again = await validateThenPromote(handler, "promote-twice", 1);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: "already_published" } });
  }, 120_000);

  test("promoted version matches the publish path: ABI, asset pins, validation record, DTO", async () => {
    const { db, handler } = await setup();
    // Typed events → host ABI v2: доказывает, что promote не хардкодит `1` в stage.
    const base = await fixture("typed-events-stars.tsx");
    const assetId = `asset_${"a".repeat(64)}`;
    db.query("INSERT INTO assets (id,sha256,mime,size,created_at) VALUES (?,?,?,?,?)")
      .run(assetId, "a".repeat(64), "image/png", 10, new Date().toISOString());
    const source = base.replace("export default", `const icon = "/api/assets/${assetId}";\nvoid icon;\nexport default`);

    // Один компонент, две ревизии: v1 — существующим publish, v2 — promote. Разные компоненты
    // с одинаковым исходником здесь невозможны — их отсекает гейт переиспользования.
    await createComponent(handler, "promote-parity", "PromoteParity", source);
    expect((await handler(req("/components/promote-parity/publish", "POST", { baseRev: 1 }))).status).toBe(201);
    const rev2 = await saveRevision(handler, "promote-parity", variant(source, "parity v2"), 1);
    expect((await validateThenPromote(handler, "promote-parity", rev2, { supersede: "none" })).status).toBe(201);

    const row = (version: number) => db.query("SELECT host_abi_version hostAbi,status,source_hash sourceHash,definition_meta meta FROM component_publishes WHERE component_id='promote-parity' AND version=?").get(version) as { hostAbi: number; status: string; sourceHash: string; meta: string };
    const published = row(1), promoted = row(2);
    // Фактический ABI (не хардкод 1) и статус — те же, что на publish-пути.
    expect(promoted.hostAbi).toBe(2);
    expect(promoted.hostAbi).toBe(published.hostAbi);
    expect(promoted.status).toBe(published.status);
    expect(promoted.meta).toBe(published.meta);
    // Пины ассетов — единственный источник `component_publish_assets`; без них DTO версии пуст.
    const pins = (version: number) => db.query("SELECT asset_id id FROM component_publish_assets WHERE component_id='promote-parity' AND version=?").all(version) as { id: string }[];
    expect(pins(2)).toEqual([{ id: assetId }]);
    expect(pins(2)).toEqual(pins(1));
    // recordValidation: успешная запись на промоутнутой ревизии, как и на опубликованной.
    const records = db.query("SELECT rev,ok FROM validation_records WHERE resource_type='component' AND resource_id='promote-parity' ORDER BY rowid").all() as { rev: number; ok: number }[];
    expect(records).toEqual([{ rev: 1, ok: 1 }, { rev: rev2, ok: 1 }]);
    // DTO версии одинаково полон на обоих путях.
    const dto = await (await handler(req("/components/promote-parity/versions/2"))).json() as { assets: unknown[]; hostAbiVersion: number };
    expect(dto).toMatchObject({ hostAbiVersion: 2 });
    expect(dto.assets).toHaveLength(1);
  }, 180_000);

  test("a warm candidate cache skips typecheck and compile: promote ships the cached artifacts verbatim", async () => {
    const { dir, db, handler } = await setup();
    const source = await fixture("rating-stars.tsx");
    await createComponent(handler, "promote-warm", "PromoteWarm", source);
    expect((await handler(req("/components/promote-warm/validate", "POST"))).status).toBe(200);

    // Sentinel: подменяем содержимое кэша. Если бы promote перекомпилировал исходник, ни
    // маркер в бандле, ни подменённый bundleHash, ни лишнее предупреждение не доехали бы.
    const sourceHash = sha256(source);
    const entry = (await readCandidate(dir, sourceHash))!;
    const bundleJs = `${await Bun.file(resolve(dir, ".candidates", sourceHash, "bundle.js")).text()}\n// SENTINEL warm candidate bundle\n`;
    entry.bundleHash = "f".repeat(64);
    entry.extracted!.warnings.push("SENTINEL cached extraction reused");
    await writeCandidate(dir, entry, bundleJs);

    const promoted = await handler(req("/components/promote-warm/promote", "POST", { baseRev: 1, sourceHash }));
    expect(promoted.status).toBe(201);
    const body = await promoted.json() as { bundleHash: string; cached: boolean; warnings: string[] };
    expect(body).toMatchObject({ bundleHash: "f".repeat(64), cached: true });
    expect(body.warnings).toContain("SENTINEL cached extraction reused");
    const stored = db.query("SELECT compiled_js js,bundle_hash hash FROM component_publishes WHERE component_id=? AND version=1").get("promote-warm") as { js: string; hash: string };
    expect(stored.js).toContain("SENTINEL warm candidate bundle");
    expect(stored.hash).toBe("f".repeat(64));
  }, 120_000);

  test("preconditions: sourceHash mismatch, stale baseRev and expectedCatalogRevision are typed 409s", async () => {
    const { handler } = await setup();
    const source = await fixture("rating-stars.tsx");
    await createComponent(handler, "promote-cas", "PromoteCas", source);
    const receipt = await (await handler(req("/components/promote-cas/validate", "POST"))).json() as { sourceHash: string; catalogRevision: string };

    const mismatch = await handler(req("/components/promote-cas/promote", "POST", { baseRev: 1, sourceHash: "0".repeat(64) }));
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({ error: { code: "source_hash_mismatch" } });

    const stale = await handler(req("/components/promote-cas/promote", "POST", { baseRev: 99, sourceHash: receipt.sourceHash }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "revision_conflict", currentRev: 1 } });

    const drifted = await handler(req("/components/promote-cas/promote", "POST", { baseRev: 1, sourceHash: receipt.sourceHash, expectedCatalogRevision: "catalog-revision-not-current" }));
    expect(drifted.status).toBe(409);
    expect(await drifted.json()).toMatchObject({ error: { code: "catalog_changed" } });

    // Актуальная ревизия каталога из receipt проходит CAS.
    const ok = await handler(req("/components/promote-cas/promote", "POST", { baseRev: 1, sourceHash: receipt.sourceHash, expectedCatalogRevision: receipt.catalogRevision }));
    expect(ok.status).toBe(201);
  }, 120_000);

  test("promote writes component.promoted with the full fingerprint set", async () => {
    const { db, handler } = await setup();
    const source = await fixture("rating-stars.tsx");
    await createComponent(handler, "promote-audit", "PromoteAudit", source);
    const promoted = await validateThenPromote(handler, "promote-audit", 1);
    expect(promoted.status).toBe(201);
    const event = auditActions(db, "promote-audit").find((row) => row.action === "component.promoted");
    expect(event).toBeDefined();
    expect(JSON.parse(event!.detail!)).toMatchObject({
      version: 1, rev: 1, sourceHash: sha256(source), hostAbiVersion: 1, supersede: "auto", superseded: [],
    });
    expect(JSON.parse(event!.detail!)).toHaveProperty("bundleHash");
    expect(JSON.parse(event!.detail!)).toHaveProperty("catalogRevision");
    expect(JSON.parse(event!.detail!)).toHaveProperty("themeVersion");
  }, 120_000);

  test("kill-switch hides the promote route and drops the capability flag", async () => {
    const { handler } = await setup({ acceptanceDisabled: true });
    const source = await fixture("rating-stars.tsx");
    await createComponent(handler, "promote-killed", "PromoteKilled", source);
    expect((await handler(req("/components/promote-killed/promote", "POST", { baseRev: 1, sourceHash: sha256(source) }))).status).toBe(404);
    const caps = await (await handler(req("/capabilities"))).json() as { features: Record<string, boolean> };
    expect(caps.features.acceptancePromote).toBe(false);
    // Publish остаётся рабочим: гашение приёмки не делает дизайн-систему неопубликуемой.
    expect((await handler(req("/components/promote-killed/publish", "POST", { baseRev: 1 }))).status).toBe(201);
  }, 120_000);

  test("capabilities advertise acceptancePromote by default", async () => {
    const { handler } = await setup();
    const caps = await (await handler(req("/capabilities"))).json() as { features: Record<string, boolean> };
    expect(caps.features.acceptancePromote).toBe(true);
  });
});

/**
 * Волна W1c (план 2026-08-03 §5, амендмент A9): ссылки `candidateId`/`acceptanceRunId` в promote.
 * Раны здесь создаются и терминализуются напрямую через repo — предмет проверки в том, как сага
 * их сверяет и записывает, а не в том, как оркестратор их исполняет.
 */
describe("promote with acceptance references (W1c, A9)", () => {
  const POLICY_HASH = policyProfileHash(DEFAULT_POLICY);

  async function acceptanceFixture(id: string, name: string) {
    const context = await setup({ matrix: true });
    const source = await fixture("rating-stars.tsx");
    await createComponent(context.handler, id, name, source);
    const created = await context.handler(req(`/components/${id}/candidates`, "POST"));
    expect(created.status, await created.clone().text()).toBe(200);
    const candidate = await created.json() as { candidateId: string; sourceHash: string; rev: number };
    return { ...context, orchestrator: context.orchestrator!, id, source, candidate };
  }

  const createRun = (orchestrator: AcceptanceOrchestrator, candidateId: string, componentId: string) =>
    orchestrator.repo.createRun({
      candidateId, componentId,
      policyProfileId: DEFAULT_POLICY.id, policyProfileHash: POLICY_HASH,
      createdBy: BOOTSTRAP_ADMIN_ID, cases: [],
    }).run;

  const publishRow = (db: Database, id: string, version: number) =>
    db.query("SELECT candidate_id candidateId,acceptance_run_id runId FROM component_publishes WHERE component_id=? AND version=?")
      .get(id, version) as { candidateId: string | null; runId: string | null };

  test("passed run: refs land on the version row, the candidate becomes promoted, audit carries both ids", async () => {
    const { db, handler, orchestrator, id, candidate } = await acceptanceFixture("promote-refs", "PromoteRefs");
    const run = createRun(orchestrator, candidate.candidateId, id);
    orchestrator.repo.terminalizeRun(run.run_id, { status: "pass" });

    const promoted = await handler(req(`/components/${id}/promote`, "POST", {
      baseRev: 1, sourceHash: candidate.sourceHash, candidateId: candidate.candidateId, acceptanceRunId: run.run_id,
    }));
    expect(promoted.status, await promoted.clone().text()).toBe(201);
    expect(await promoted.json()).toMatchObject({ version: 1, candidateId: candidate.candidateId, acceptanceRunId: run.run_id });

    // A9-receipts — плоские TEXT-колонки на строке версии (без FK).
    expect(publishRow(db, id, 1)).toEqual({ candidateId: candidate.candidateId, runId: run.run_id });
    const row = orchestrator.repo.requireCandidate(candidate.candidateId);
    expect(row).toMatchObject({ status: "promoted", promoted_version: 1, acceptance_run_id: run.run_id });
    const event = auditActions(db, id).find((entry) => entry.action === "component.promoted");
    expect(JSON.parse(event!.detail!)).toMatchObject({ candidateId: candidate.candidateId, acceptanceRunId: run.run_id });
  }, 180_000);

  test("promote without references leaves the receipt columns null (R1 path is untouched)", async () => {
    const { db, handler, id } = await acceptanceFixture("promote-norefs", "PromoteNorefs");
    const promoted = await validateThenPromote(handler, id, 1);
    expect(promoted.status).toBe(201);
    expect(await promoted.json()).toMatchObject({ candidateId: null, acceptanceRunId: null });
    expect(publishRow(db, id, 1)).toEqual({ candidateId: null, runId: null });
  }, 180_000);

  test("refusals: live run, failed run, foreign run and a candidate of another revision", async () => {
    const { db, handler, orchestrator, id, candidate } = await acceptanceFixture("promote-refuse", "PromoteRefuse");
    const promote = (body: Record<string, unknown>) =>
      handler(req(`/components/${id}/promote`, "POST", { baseRev: 1, sourceHash: candidate.sourceHash, ...body }));
    const codeOf = async (response: Response) => (await response.json() as { error: { code: string } }).error.code;

    // Живой (queued) ран кандидата: вердикта ещё нет — публиковать нечего.
    const live = createRun(orchestrator, candidate.candidateId, id);
    const inFlight = await promote({ candidateId: candidate.candidateId });
    expect(inFlight.status).toBe(409);
    expect(await codeOf(inFlight)).toBe("acceptance_run_in_flight");
    orchestrator.cancelQueuedRun(live.run_id);

    // Терминальный, но провальный ран.
    const failed = createRun(orchestrator, candidate.candidateId, id);
    orchestrator.repo.terminalizeRun(failed.run_id, { status: "fail" });
    const notPassed = await promote({ candidateId: candidate.candidateId, acceptanceRunId: failed.run_id });
    expect(notPassed.status).toBe(422);
    expect(await codeOf(notPassed)).toBe("acceptance_run_not_passed");

    // Ран чужого кандидата того же компонента: `pass` не переносится между сборками.
    const other = orchestrator.repo.createCandidate({
      componentId: id, designSystem: "yandex-pay", rev: 99, sourceHash: "0".repeat(64), bundleHash: "1".repeat(64),
      hostAbiVersion: 1, themeVersion: null, observedCatalogRevision: "catalog-x", policyProfileHash: POLICY_HASH,
      createdBy: BOOTSTRAP_ADMIN_ID,
    }).candidate;
    const otherRun = createRun(orchestrator, other.candidate_id, id);
    orchestrator.repo.terminalizeRun(otherRun.run_id, { status: "pass" });
    const mismatch = await promote({ candidateId: candidate.candidateId, acceptanceRunId: otherRun.run_id });
    expect(mismatch.status).toBe(422);
    expect(await codeOf(mismatch)).toBe("acceptance_run_mismatch");

    // Кандидат другой ревизии — и напрямую, и через ран, у которого он единственный источник.
    const stale = await promote({ candidateId: other.candidate_id });
    expect(stale.status).toBe(409);
    expect(await codeOf(stale)).toBe("revision_conflict");
    const staleByRun = await promote({ acceptanceRunId: otherRun.run_id });
    expect(staleByRun.status).toBe(409);
    expect(await codeOf(staleByRun)).toBe("revision_conflict");

    // Ни один отказ не создал версии и не тронул кандидатов.
    expect(versionRows(db, id)).toEqual([]);
    expect(orchestrator.repo.requireCandidate(candidate.candidateId).status).toBe("validated");
  }, 180_000);

  test("unknown ids are 404 and malformed ids are 400 — neither leaks another owner's acceptance", async () => {
    const { handler, id, candidate } = await acceptanceFixture("promote-badrefs", "PromoteBadrefs");
    const promote = (body: Record<string, unknown>) =>
      handler(req(`/components/${id}/promote`, "POST", { baseRev: 1, sourceHash: candidate.sourceHash, ...body }));
    expect((await promote({ candidateId: `cand_${"0".repeat(64)}` })).status).toBe(404);
    expect((await promote({ acceptanceRunId: "acc_00000000-0000-0000-0000-000000000000" })).status).toBe(404);
    const malformed = await promote({ candidateId: "not-a-candidate" });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "invalid_request" } });
  }, 180_000);
});

describe("draft candidate bundle authorization (RFC R1, M5/V11)", () => {
  test("owner reads the bundle, a foreign user is refused, an anonymous caller is unauthorized", async () => {
    const dir = await mkdtemp(resolve(process.cwd(), ".promote-auth-test-"));
    dirs.push(dir);
    const db = openDatabase(":memory:");
    databases.push(db);
    const admin = (await ensureBootstrapAdmin(db, { name: "Promote Admin", password: "promote admin password" }))!;
    const users = new UserRepo(db);
    const owner = await users.create({ name: "Draft Owner", password: "draft owner password", actorId: admin.id });
    const stranger = await users.create({ name: "Draft Stranger", password: "draft stranger password", actorId: admin.id });
    const handler = createHandler(db, { dataDir: dir });
    const cookie = (token: string) => ({ cookie: `easyui_session=${token}` });
    const ownerSession = users.createSession(owner.id), strangerSession = users.createSession(stranger.id);
    db.query("UPDATE design_systems SET owner_id=? WHERE id='yandex-pay'").run(owner.id);

    const source = await fixture("rating-stars.tsx");
    const created = await handler(new Request("http://test/api/components", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://test", ...cookie(ownerSession.token) },
      body: JSON.stringify({ designSystem: "yandex-pay", id: "draft-auth", name: "DraftAuth", source, intent: "Draft bundle authorization fixture" }),
    }));
    expect(created.status).toBe(201);
    expect((await handler(new Request("http://test/api/components/draft-auth/validate", {
      method: "POST", headers: { origin: "http://test", ...cookie(ownerSession.token) },
    }))).status).toBe(200);

    const path = `/api/components/draft-auth/draft/${sha256(source)}/bundle.js`;
    const asOwner = await handler(new Request(`http://test${path}`, { headers: cookie(ownerSession.token) }));
    expect(asOwner.status).toBe(200);
    expect(await asOwner.text()).toContain("export");

    const asStranger = await handler(new Request(`http://test${path}`, { headers: cookie(strangerSession.token) }));
    expect(asStranger.status).toBe(403);

    const anonymous = await handler(new Request(`http://test${path}`));
    expect(anonymous.status).toBe(401);
  }, 120_000);

  test("the capture principal keeps reading the candidate bundle (allowlist precedent, not owner-check)", async () => {
    const { dir, handler } = await setup();
    const source = await fixture("rating-stars.tsx");
    await createComponent(handler, "capture-auth", "CaptureAuth", source);
    expect((await handler(req("/components/capture-auth/validate", "POST"))).status).toBe(200);

    // Capture-принципал резолвится в `createHandler` только для loopback-запроса с живым
    // токеном джобы, поэтому ветка проверяется на уровне роутера: сам путь уже сверен с
    // allowlist'ом сессии выше по стеку. Owner-check здесь сломал бы съёмку — воркер не user.
    const path = `/api/components/capture-auth/draft/${sha256(source)}/bundle.js`;
    const response = await routeComponents(
      new Request(`http://test${path}`),
      databases[0]!,
      ["components", "capture-auth", "draft", sha256(source), "bundle.js"],
      { kind: "capture", scope: { token: "capture-token", allowedUrls: [path] } },
      dir,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("export");
  }, 120_000);
});

describe("readiness reports a component without an active version (RFC R1, M7)", () => {
  test("bundleReadiness warns when a pinned component has no active version at all", async () => {
    const { db, handler } = await setup();
    const source = await fixture("props-badge.tsx");
    await createComponent(handler, "readiness-noactive", "ReadinessNoactive", source);
    expect((await validateThenPromote(handler, "readiness-noactive", 1)).status).toBe(201);

    const original = await Bun.file("test/fixtures/host-content.json").json() as Record<string, unknown> & { screens: Record<string, unknown>[] };
    const doc = {
      ...original, id: "readiness-proto", name: "Readiness proto",
      screens: original.screens.map((screen, index) => index ? screen : { ...screen, spec: { root: "badge", elements: { badge: { type: "ReadinessNoactive", props: { label: "Ready", tone: "neutral" } } } } }),
    };
    const saved = await handler(req("/prototypes", "POST", { doc }));
    expect(saved.status).toBe(201);
    const repo = new PrototypeRepo(db);
    expect(repo.bundleReadiness("readiness-proto", 1).warnings).toEqual([]);

    // Единственная active-версия уводится вручную — active-пул пуст, деградация обязана быть видна.
    const statusRev = (db.query("SELECT status_rev r FROM component_publishes WHERE component_id=? AND version=1").get("readiness-noactive") as { r: number }).r;
    expect((await handler(req("/components/readiness-noactive/versions/1/status", "POST", { status: "deprecated", baseStatusRev: statusRev }))).status).toBe(200);

    const readiness = repo.bundleReadiness("readiness-proto", 1);
    expect(readiness.warnings.map((warning) => warning.code)).toContain("component_no_active_version");
    // Закреплённая deprecated-версия всё ещё рендерится: статус бандлов не деградирует.
    expect(readiness.bundleStatus).toBe("ready");
    const report = await (await handler(req("/prototypes/readiness-proto/readiness"))).json() as { gates: { id: string; status: string; warnings?: { code: string }[] }[] };
    const pins = report.gates.find((item) => item.id === "pins")!;
    expect(pins.status).toBe("warn");
    expect(pins.warnings!.map((warning) => warning.code)).toContain("component_no_active_version");
  }, 180_000);
});
