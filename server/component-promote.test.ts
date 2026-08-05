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
import { AcceptanceRepo } from "./acceptance/repo";
import { CaseSetRepo } from "./acceptance/caseSets";
import { caseSetManifestSchema } from "../src/acceptance/caseSetSchema";
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

/**
 * Rejected-предикат promote (RFC §4.3.1, волна R3b).
 *
 * Предмет — ровно то, ради чего предикат переформулировали по субъекту: он обязан срабатывать
 * там, где `candidateId` не передаётся вовсе (receipt-путь R1) и где acceptance-репозиторий не
 * инжектирован (`EASYUI_ACCEPTANCE_MATRIX=0`) — таблицы v25/v27 заводятся безусловно.
 */
describe("promote refuses a rejected revision (R3b, §4.3.1)", () => {
  const rejectRevision = (db: Database, input: { componentId: string; rev: number; sourceHash: string; reason: string }) => {
    const repo = new AcceptanceRepo(db);
    const { candidate } = repo.createCandidate({
      componentId: input.componentId, designSystem: "yandex-pay", rev: input.rev,
      sourceHash: input.sourceHash, bundleHash: "bundle-x", hostAbiVersion: 1, themeVersion: null,
      observedCatalogRevision: "catalog-x", policyProfileHash: policyProfileHash(DEFAULT_POLICY),
      createdBy: BOOTSTRAP_ADMIN_ID,
    });
    repo.rejectCandidate({ candidateId: candidate.candidate_id, reason: input.reason, actor: BOOTSTRAP_ADMIN_ID });
    return candidate;
  };

  test("the R1 receipt path is blocked with EASYUI_ACCEPTANCE_MATRIX off", async () => {
    // Матрицы нет вовсе: оркестратор не инжектирован, ручек приёмки не существует.
    const { db, handler } = await setup();
    const source = await fixture("rating-stars.tsx");
    await createComponent(handler, "promote-rejected", "PromoteRejected", source);
    const tombstone = rejectRevision(db, { componentId: "promote-rejected", rev: 1, sourceHash: "f".repeat(64), reason: "интервалы не по макету" });

    const promoted = await validateThenPromote(handler, "promote-rejected", 1);
    expect(promoted.status).toBe(409);
    expect(await promoted.json()).toMatchObject({
      error: {
        code: "candidate_rejected",
        candidateId: tombstone.candidate_id,
        decision: { reason: "интервалы не по макету", actor: BOOTSTRAP_ADMIN_ID },
      },
    });
    // Отказ дешёвый: ни версии, ни staging-строки.
    expect(versionRows(db, "promote-rejected")).toEqual([]);

    // Выход — новая ревизия: надгробий на неё нет по определению.
    const rev2 = await saveRevision(handler, "promote-rejected", variant(source, "clean"), 1);
    const clean = await validateThenPromote(handler, "promote-rejected", rev2);
    expect(clean.status, await clean.clone().text()).toBe(201);
  }, 180_000);

  test("rejection blocks the WHOLE revision: a sibling build of the same rev is refused too", async () => {
    const { db, handler, orchestrator } = await setup({ matrix: true });
    const source = await fixture("rating-stars.tsx");
    await createComponent(handler, "promote-rejsibling", "PromoteRejSibling", source);
    const created = await handler(req("/components/promote-rejsibling/candidates", "POST"));
    expect(created.status, await created.clone().text()).toBe(200);
    const candidate = await created.json() as { candidateId: string; sourceHash: string };

    // Надгробие — на ДРУГОЙ сборке той же ревизии (иной build_fingerprint: другая тема/ABI).
    rejectRevision(db, { componentId: "promote-rejsibling", rev: 1, sourceHash: "e".repeat(64), reason: "ревизия отклонена" });

    const promoted = await handler(req("/components/promote-rejsibling/promote", "POST", {
      baseRev: 1, sourceHash: candidate.sourceHash, candidateId: candidate.candidateId,
    }));
    expect(promoted.status).toBe(409);
    expect(await promoted.json()).toMatchObject({ error: { code: "candidate_rejected" } });
    expect(versionRows(db, "promote-rejsibling")).toEqual([]);
    expect(orchestrator!.repo.requireCandidate(candidate.candidateId).status).toBe("validated");
  }, 180_000);

  test("idempotency is untouched: a repeat promote of a promoted candidate is not candidate_rejected", async () => {
    const { db, handler, orchestrator } = await setup({ matrix: true });
    const source = await fixture("rating-stars.tsx");
    await createComponent(handler, "promote-rejidem", "PromoteRejIdem", source);
    const created = await handler(req("/components/promote-rejidem/candidates", "POST"));
    const candidate = await created.json() as { candidateId: string; sourceHash: string };
    const body = { baseRev: 1, sourceHash: candidate.sourceHash, candidateId: candidate.candidateId };

    const first = await handler(req("/components/promote-rejidem/promote", "POST", body));
    expect(first.status, await first.clone().text()).toBe(201);
    const repeat = await handler(req("/components/promote-rejidem/promote", "POST", body));
    expect(repeat.status).toBe(409);
    // Терминальный отказ приходит от саги (расширенный `already_published`-чек фазы A либо CAS
    // `markPromoted` фазы B) — но никак не от предиката: надгробий на эту ревизию нет.
    const code = (await repeat.json() as { error: { code: string } }).error.code;
    expect(code).not.toBe("candidate_rejected");
    expect(["already_published", "candidate_already_promoted"]).toContain(code);
    expect(versionRows(db, "promote-rejidem")).toHaveLength(1);
    expect(orchestrator!.repo.requireCandidate(candidate.candidateId).promoted_version).toBe(1);
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

/**
 * Волна W3 плана 2026-08-04 (D-A/C18/C22/C30): promotion policy. Кандидат штампуется хэшем
 * `default-v1` при создании, поэтому равенство «хэш рана == хэш кандидата» делало любой
 * `pixel-strict-v1`-ран непромоутабельным (дефект P0-2). Предикат заменён на членство профиля
 * рана в `PROMOTION_POLICY_PROFILES`, а расхождение хэша с текущим определением профиля стало
 * warning'ом с provenance вместо отказа.
 */
describe("promotion policy (план 2026-08-04 W3)", () => {
  async function policyFixture(id: string, name: string) {
    const context = await setup({ matrix: true });
    const source = await fixture("rating-stars.tsx");
    await createComponent(context.handler, id, name, source);
    const created = await context.handler(req(`/components/${id}/candidates`, "POST"));
    expect(created.status, await created.clone().text()).toBe(200);
    const candidate = await created.json() as { candidateId: string; sourceHash: string };
    return { ...context, orchestrator: context.orchestrator!, id, candidate };
  }

  /** Ран создаётся напрямую через repo: тут проверяется предикат promote, а не постановка. */
  const runWith = (
    orchestrator: AcceptanceOrchestrator, candidateId: string, componentId: string,
    policy: { policyProfileId: string; policyProfileHash: string },
  ) => orchestrator.repo.createRun({
    candidateId, componentId, createdBy: BOOTSTRAP_ADMIN_ID, cases: [],
    policyProfileId: policy.policyProfileId, policyProfileHash: policy.policyProfileHash,
  }).run;

  const STRICT = ACCEPTANCE_POLICIES["pixel-strict-v1"];

  test("репро P0-2: pixel-strict-v1 ран промоутится, хотя штамп кандидата — default-v1", async () => {
    const { db, handler, orchestrator, id, candidate } = await policyFixture("promote-strict", "PromoteStrict");
    // Именно эта пара и падала в проде: кандидат штампуется default-v1, ран исполнен strict-профилем.
    expect(orchestrator.repo.requireCandidate(candidate.candidateId).policy_profile_hash)
      .toBe(policyProfileHash(DEFAULT_POLICY));
    const run = runWith(orchestrator, candidate.candidateId, id, {
      policyProfileId: STRICT.id, policyProfileHash: policyProfileHash(STRICT),
    });
    orchestrator.repo.terminalizeRun(run.run_id, { status: "pass" });

    const promoted = await handler(req(`/components/${id}/promote`, "POST", {
      baseRev: 1, sourceHash: candidate.sourceHash, candidateId: candidate.candidateId, acceptanceRunId: run.run_id,
    }));
    expect(promoted.status, await promoted.clone().text()).toBe(201);
    const body = await promoted.json() as { candidateId: string; acceptanceRunId: string; warnings: string[]; acceptancePolicy: Record<string, unknown> };
    expect(body).toMatchObject({ candidateId: candidate.candidateId, acceptanceRunId: run.run_id });
    // Профиль не менялся с момента рана — provenance есть, но stale не утверждается и warning'а нет.
    expect(body.acceptancePolicy).toEqual({
      profileId: "pixel-strict-v1",
      runPolicyProfileHash: policyProfileHash(STRICT),
      currentPolicyProfileHash: policyProfileHash(STRICT),
      stale: false,
    });
    expect(body.warnings.some((warning) => warning.includes("policy profile"))).toBe(false);

    // Версия несёт обе ссылки — и в списке, и в одиночном DTO (C30).
    const version = await (await handler(req(`/components/${id}/versions/1`))).json() as Record<string, unknown>;
    expect(version).toMatchObject({ candidateId: candidate.candidateId, acceptanceRunId: run.run_id });
    const list = await (await handler(req(`/components/${id}`))).json() as { versions: Record<string, unknown>[] };
    expect(list.versions[0]).toMatchObject({ candidateId: candidate.candidateId, acceptanceRunId: run.run_id });
    expect(db.query("SELECT acceptance_run_id r FROM component_publishes WHERE component_id=?").get(id))
      .toEqual({ r: run.run_id });
  }, 180_000);

  test("профиль вне promotion policy (инъекция мимо роута) → 422 acceptance_policy_mismatch", async () => {
    const { handler, orchestrator, id, candidate } = await policyFixture("promote-badpolicy", "PromoteBadpolicy");
    // Реестр сегодня содержит ровно два профиля, и `startRun` отвергает чужие (C3), поэтому
    // единственный способ дойти до ветки отказа — записать ран мимо роута.
    const run = runWith(orchestrator, candidate.candidateId, id, {
      policyProfileId: "experimental-v9", policyProfileHash: "9".repeat(64),
    });
    orchestrator.repo.terminalizeRun(run.run_id, { status: "pass" });
    const response = await handler(req(`/components/${id}/promote`, "POST", {
      baseRev: 1, sourceHash: candidate.sourceHash, candidateId: candidate.candidateId, acceptanceRunId: run.run_id,
    }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: {
        code: "acceptance_policy_mismatch",
        runPolicyProfileId: "experimental-v9",
        allowed: ["default-v1", "pixel-strict-v1"],
      },
    });
  }, 180_000);

  test("ран чужого кандидата остаётся acceptance_run_mismatch — код разведён с политикой", async () => {
    const { handler, orchestrator, id, candidate } = await policyFixture("promote-foreignrun", "PromoteForeignrun");
    const other = orchestrator.repo.createCandidate({
      componentId: id, designSystem: "yandex-pay", rev: 77, sourceHash: "2".repeat(64), bundleHash: "3".repeat(64),
      hostAbiVersion: 1, themeVersion: null, observedCatalogRevision: "catalog-y",
      policyProfileHash: policyProfileHash(DEFAULT_POLICY), createdBy: BOOTSTRAP_ADMIN_ID,
    }).candidate;
    // Ран чужого кандидата исполнен ровно тем же (допущенным) профилем: отказ обязан быть про
    // принадлежность, а не про политику.
    const run = runWith(orchestrator, other.candidate_id, id, {
      policyProfileId: DEFAULT_POLICY.id, policyProfileHash: policyProfileHash(DEFAULT_POLICY),
    });
    orchestrator.repo.terminalizeRun(run.run_id, { status: "pass" });
    const response = await handler(req(`/components/${id}/promote`, "POST", {
      baseRev: 1, sourceHash: candidate.sourceHash, candidateId: candidate.candidateId, acceptanceRunId: run.run_id,
    }));
    expect(response.status).toBe(422);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("acceptance_run_mismatch");
    expect(body.error.message).toContain("another candidate");
  }, 180_000);

  test("C18: устаревший хэш профиля — warning и оба хэша в ответе и в аудите, а не отказ", async () => {
    const { db, handler, orchestrator, id, candidate } = await policyFixture("promote-stalehash", "PromoteStalehash");
    // Профиль правили после рана: хэш строки рана не сходится с текущим определением.
    const staleHash = "a".repeat(64);
    const run = runWith(orchestrator, candidate.candidateId, id, {
      policyProfileId: DEFAULT_POLICY.id, policyProfileHash: staleHash,
    });
    orchestrator.repo.terminalizeRun(run.run_id, { status: "pass" });
    const promoted = await handler(req(`/components/${id}/promote`, "POST", {
      baseRev: 1, sourceHash: candidate.sourceHash, candidateId: candidate.candidateId, acceptanceRunId: run.run_id,
    }));
    expect(promoted.status, await promoted.clone().text()).toBe(201);
    const body = await promoted.json() as { warnings: string[]; acceptancePolicy: Record<string, unknown> };
    expect(body.acceptancePolicy).toEqual({
      profileId: "default-v1",
      runPolicyProfileHash: staleHash,
      currentPolicyProfileHash: policyProfileHash(DEFAULT_POLICY),
      stale: true,
    });
    expect(body.warnings.some((warning) => warning.includes(staleHash) && warning.includes(policyProfileHash(DEFAULT_POLICY)))).toBe(true);
    const event = auditActions(db, id).find((entry) => entry.action === "component.promoted");
    expect(JSON.parse(event!.detail!).acceptancePolicy).toMatchObject({
      runPolicyProfileHash: staleHash, currentPolicyProfileHash: policyProfileHash(DEFAULT_POLICY), stale: true,
    });
  }, 180_000);

  test("kill-switch EASYUI_PROMOTE_POLICY_STRICT=1 возвращает старое равенство хэшей (P0-2)", async () => {
    const { handler, orchestrator, id, candidate } = await policyFixture("promote-killswitch", "PromoteKillswitch");
    const run = runWith(orchestrator, candidate.candidateId, id, {
      policyProfileId: STRICT.id, policyProfileHash: policyProfileHash(STRICT),
    });
    orchestrator.repo.terminalizeRun(run.run_id, { status: "pass" });
    const promote = () => handler(req(`/components/${id}/promote`, "POST", {
      baseRev: 1, sourceHash: candidate.sourceHash, candidateId: candidate.candidateId, acceptanceRunId: run.run_id,
    }));
    process.env.EASYUI_PROMOTE_POLICY_STRICT = "1";
    try {
      const refused = await promote();
      expect(refused.status).toBe(422);
      const body = await refused.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe("acceptance_run_mismatch");
      expect(body.error.message).toContain("policy profile");
    } finally {
      delete process.env.EASYUI_PROMOTE_POLICY_STRICT;
    }
    // Флаг снят — тот же ран промоутится.
    expect((await promote()).status).toBe(201);
  }, 180_000);

  test("candidate-view отдаёт runs[] с promotionEligible; capabilities — состав promotion policy", async () => {
    const { handler, orchestrator, id, candidate } = await policyFixture("promote-candview", "PromoteCandview");
    const passed = runWith(orchestrator, candidate.candidateId, id, {
      policyProfileId: STRICT.id, policyProfileHash: policyProfileHash(STRICT),
    });
    orchestrator.repo.terminalizeRun(passed.run_id, { status: "pass" });
    const failed = runWith(orchestrator, candidate.candidateId, id, {
      policyProfileId: DEFAULT_POLICY.id, policyProfileHash: policyProfileHash(DEFAULT_POLICY),
    });
    orchestrator.repo.terminalizeRun(failed.run_id, { status: "fail" });
    const injected = runWith(orchestrator, candidate.candidateId, id, {
      policyProfileId: "experimental-v9", policyProfileHash: "9".repeat(64),
    });
    orchestrator.repo.terminalizeRun(injected.run_id, { status: "pass" });

    const view = await (await handler(req(`/component-candidates/${candidate.candidateId}`))).json() as {
      acceptanceRunId: string; runs: { runId: string; status: string; policyProfileId: string; promotionEligible: boolean; caseSetId: string | null; finishedAt: string | null }[];
    };
    // Порядок — `ORDER BY created_at, run_id`; внутри одной секунды он определяется id, поэтому
    // утверждение идёт по составу, а не по позиции.
    const eligible = Object.fromEntries(view.runs.map((run) => [run.runId, run.promotionEligible]));
    expect(eligible).toEqual({
      [passed.run_id]: true,      // terminal pass + promotion-профиль
      [failed.run_id]: false,     // терминальный, но не pass
      [injected.run_id]: false,   // pass, но профиль не допущен к публикации
    });
    const passedView = view.runs.find((run) => run.runId === passed.run_id)!;
    expect(passedView).toMatchObject({ status: "pass", policyProfileId: "pixel-strict-v1", caseSetId: null });
    expect(passedView.finishedAt).toEqual(expect.any(String));
    // Скалярное поле — «последний поставленный ран», а не промоутабельный (C4).
    expect(view.acceptanceRunId).toBe(injected.run_id);

    const caps = await (await handler(req("/capabilities"))).json() as {
      acceptance: { policyProfiles: string[]; defaultPolicyProfile: string; promotionPolicyProfiles: string[] };
    };
    expect(caps.acceptance).toEqual({
      policyProfiles: ["default-v1", "pixel-strict-v1"],
      defaultPolicyProfile: "default-v1",
      promotionPolicyProfiles: ["default-v1", "pixel-strict-v1"],
    });
  }, 180_000);
});

/**
 * Волна W7 плана 2026-08-04 (D-D): multi-run provenance. Семья, не влезающая в один ран,
 * публикуется набором ранов; предмет проверки — предикаты когерентности набора и то, что версия
 * несёт **всё** покрытие, а старые читатели продолжают видеть один детерминированный id.
 *
 * Раны создаются напрямую через repo (как и в W1c/W3): исполнение оркестратора здесь ни при чём,
 * важны только строки, которые сага сверяет.
 */
describe("multi-run promote (план 2026-08-04 W7)", () => {
  const POLICY_HASH = policyProfileHash(DEFAULT_POLICY);
  const RENDERER = "r".repeat(64);

  async function familyFixture(id: string, name: string) {
    const context = await setup({ matrix: true });
    const source = await fixture("rating-stars.tsx");
    await createComponent(context.handler, id, name, source);
    const created = await context.handler(req(`/components/${id}/candidates`, "POST"));
    expect(created.status, await created.clone().text()).toBe(200);
    const candidate = await created.json() as { candidateId: string; sourceHash: string };
    return { ...context, orchestrator: context.orchestrator!, id, candidate };
  }

  /** Набор случаев на заданной поверхности; `case_set_id` рана — единственный источник surface. */
  const putCaseSet = (db: Database, componentId: string, theme: "light" | "dark", cases: string[]) =>
    new CaseSetRepo(db).put({
      componentId, designSystem: "yandex-pay", createdBy: BOOTSTRAP_ADMIN_ID,
      manifest: caseSetManifestSchema.parse({
        manifestVersion: 1, componentId,
        capture: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, theme },
        cases: cases.map((key) => ({ id: key, props: { label: key } })),
      }),
    }).row;

  /**
   * Ран с явным покрытием. `propsHash`/`caseFingerprint` — литералы: предикаты W7 сравнивают
   * строки, а как они посчитаны, проверяет `ids.test.ts`.
   */
  const shard = (
    orchestrator: AcceptanceOrchestrator, candidateId: string, componentId: string,
    options: {
      caseSetId?: string | null; propsHashes: string[]; caseKeys?: string[];
      /** §A8: `slots_hash` строк случая — параллельный `propsHashes` массив; NULL = бесслотовый. */
      slotsHashes?: (string | null)[];
      status?: "pass" | "fail"; policyProfileId?: string; rendererFingerprint?: string | null;
      evidenceManifestHash?: string;
    },
  ) => {
    const run = orchestrator.repo.createRun({
      candidateId, componentId, createdBy: BOOTSTRAP_ADMIN_ID,
      policyProfileId: options.policyProfileId ?? DEFAULT_POLICY.id, policyProfileHash: POLICY_HASH,
      caseSetId: options.caseSetId ?? null,
      rendererFingerprint: options.rendererFingerprint === undefined ? RENDERER : options.rendererFingerprint,
      cases: options.propsHashes.map((propsHash, index) => {
        // PK — (run_id, case_id): при равных props случаи различаются слотовым суффиксом.
        const slotsHash = options.slotsHashes?.[index] ?? null;
        return {
          caseId: `case_${propsHash}${slotsHash === null ? "" : `_${slotsHash}`}`,
          caseKey: options.caseKeys?.[index] ?? `key-${propsHash}`,
          propsHash, caseFingerprint: `fp-${propsHash}-${slotsHash ?? "-"}-${index}`, casePolicyHash: "cp",
          ...(slotsHash === null ? {} : { slotsHash }),
        };
      }),
    }).run;
    orchestrator.repo.terminalizeRun(run.run_id, {
      status: options.status ?? "pass",
      ...(options.evidenceManifestHash === undefined ? {} : { evidenceManifestHash: options.evidenceManifestHash }),
    });
    return run;
  };

  const publishRunIds = (db: Database, id: string) =>
    db.query("SELECT acceptance_run_id one, acceptance_run_ids many FROM component_publishes WHERE component_id=? AND version=1")
      .get(id) as { one: string | null; many: string | null };

  const codeOf = async (response: Response) => (await response.json() as { error: { code: string } }).error.code;

  test("два дизъюнктных шарда: версия несёт оба рана (отсортированно), оба манифест-хэша и легаси-скаляр = первый", async () => {
    const { db, handler, orchestrator, id, candidate } = await familyFixture("promote-shards", "PromoteShards");
    const setA = putCaseSet(db, id, "light", ["a1", "a2"]);
    const setB = putCaseSet(db, id, "light", ["b1", "b2"]);
    const runA = shard(orchestrator, candidate.candidateId, id, { caseSetId: setA.case_set_id, propsHashes: ["p1", "p2"], evidenceManifestHash: "m-a" });
    const runB = shard(orchestrator, candidate.candidateId, id, { caseSetId: setB.case_set_id, propsHashes: ["p3", "p4"], evidenceManifestHash: "m-b" });
    const sorted = orchestrator.repo.sortRunIds([runA.run_id, runB.run_id]);

    // Порядок аргументов — обратный отсортированному: хранение обязано его игнорировать.
    const promoted = await handler(req(`/components/${id}/promote`, "POST", {
      baseRev: 1, sourceHash: candidate.sourceHash, candidateId: candidate.candidateId,
      acceptanceRunIds: [...sorted].reverse(), expectedCases: 4,
    }));
    expect(promoted.status, await promoted.clone().text()).toBe(201);
    const body = await promoted.json() as { acceptanceRunId: string; acceptanceRunIds: string[]; evidenceManifestHashes: string[] };
    expect(body.acceptanceRunIds).toEqual(sorted);
    expect(body.acceptanceRunId).toBe(sorted[0]);
    expect(body.evidenceManifestHashes.sort()).toEqual(["m-a", "m-b"]);

    // Строка версии: массив + легаси-скаляр, равный первому элементу.
    expect(publishRunIds(db, id)).toEqual({ one: sorted[0]!, many: JSON.stringify(sorted) });
    // DTO версий — и список, и одиночный.
    const version = await (await handler(req(`/components/${id}/versions/1`))).json() as Record<string, unknown>;
    expect(version).toMatchObject({ acceptanceRunId: sorted[0], acceptanceRunIds: sorted });
    expect((version.evidenceManifestHashes as string[]).slice().sort()).toEqual(["m-a", "m-b"]);
    const list = await (await handler(req(`/components/${id}`))).json() as { versions: Record<string, unknown>[] };
    expect(list.versions[0]).toMatchObject({ acceptanceRunId: sorted[0], acceptanceRunIds: sorted });
    // Аудит несёт весь набор.
    const event = auditActions(db, id).find((entry) => entry.action === "component.promoted");
    expect(JSON.parse(event!.detail!)).toMatchObject({ acceptanceRunId: sorted[0], acceptanceRunIds: sorted });
  }, 180_000);

  test("пересечение покрытия по (propsHash, surface) → 422 acceptance_coverage_overlap", async () => {
    const { db, handler, orchestrator, id, candidate } = await familyFixture("promote-overlap", "PromoteOverlap");
    const setA = putCaseSet(db, id, "light", ["a1"]);
    const setB = putCaseSet(db, id, "light", ["b1"]);
    const runA = shard(orchestrator, candidate.candidateId, id, { caseSetId: setA.case_set_id, propsHashes: ["p1", "p2"] });
    const runB = shard(orchestrator, candidate.candidateId, id, { caseSetId: setB.case_set_id, propsHashes: ["p2", "p3"] });
    const response = await handler(req(`/components/${id}/promote`, "POST", {
      baseRev: 1, sourceHash: candidate.sourceHash, acceptanceRunIds: [runA.run_id, runB.run_id],
    }));
    expect(response.status).toBe(422);
    const body = await response.json() as { error: { code: string; overlapCount: number } };
    expect(body.error.code).toBe("acceptance_coverage_overlap");
    expect(body.error.overlapCount).toBe(1);
    expect(versionRows(db, id)).toEqual([]);
  }, 180_000);

  /**
   * §A8 (план 2026-08-05, T3.2). Ключ покрытия стал (propsHash, slotsHash, surface), и promote
   * читает его как непрозрачную строку из `repo.runCoverage` — код саги не менялся, меняется
   * только поведение. Кейс SMS в терминах promote: два рана одного кандидата на ОДНОЙ поверхности
   * с одинаковым `props_hash`, но разными детьми слотов. До v31 их ключи совпадали → ложный
   * `acceptance_coverage_overlap` и `coveredCases: 1`; теперь это два разных кадра.
   */
  test("одинаковые props, разные slotsHash → покрытие дизъюнктно, expectedCases считает два кадра (§A8)", async () => {
    const { db, handler, orchestrator, id, candidate } = await familyFixture("promote-slots", "PromoteSlots");
    // Одна и та же поверхность (light) в обоих наборах — иначе разошлись бы уже по surfaceKey.
    const setA = putCaseSet(db, id, "light", ["a1"]);
    const setB = putCaseSet(db, id, "light", ["b1"]);
    const runA = shard(orchestrator, candidate.candidateId, id, {
      caseSetId: setA.case_set_id, propsHashes: ["p-sms"], slotsHashes: ["slots-a"], caseKeys: ["sms-empty"],
    });
    const runB = shard(orchestrator, candidate.candidateId, id, {
      caseSetId: setB.case_set_id, propsHashes: ["p-sms"], slotsHashes: ["slots-b"], caseKeys: ["sms-filled"],
    });
    // Строки действительно разошлись только по слотовой колонке.
    expect(orchestrator.repo.cases(runA.run_id).map((row) => [row.props_hash, row.slots_hash]))
      .toEqual([["p-sms", "slots-a"]]);
    expect(orchestrator.repo.cases(runB.run_id).map((row) => [row.props_hash, row.slots_hash]))
      .toEqual([["p-sms", "slots-b"]]);

    const promoted = await handler(req(`/components/${id}/promote`, "POST", {
      baseRev: 1, sourceHash: candidate.sourceHash, candidateId: candidate.candidateId,
      acceptanceRunIds: [runA.run_id, runB.run_id], expectedCases: 2,
    }));
    expect(promoted.status, await promoted.clone().text()).toBe(201);
    const body = await promoted.json() as { acceptanceRunIds: string[]; warnings: string[] };
    expect(body.acceptanceRunIds).toHaveLength(2);
    // Ни отказа по пересечению, ни warning'а о совпавших caseKey (ключи случаев здесь разные).
    expect(body.warnings.some((warning) => warning.includes("case key(s)"))).toBe(false);
  }, 180_000);

  /**
   * Обратная сторона того же ключа: слоты не ослабляют дизъюнктность. Совпали И props, И слоты —
   * это один и тот же кадр, принятый дважды, и отказ остаётся прежним.
   */
  test("одинаковые props И одинаковые slotsHash → по-прежнему 422 acceptance_coverage_overlap (§A8)", async () => {
    const { db, handler, orchestrator, id, candidate } = await familyFixture("promote-slotsdup", "PromoteSlotsdup");
    const setA = putCaseSet(db, id, "light", ["a1"]);
    const setB = putCaseSet(db, id, "light", ["b1"]);
    const runA = shard(orchestrator, candidate.candidateId, id, {
      caseSetId: setA.case_set_id, propsHashes: ["p-sms", "p-other"], slotsHashes: ["slots-a", "slots-a"],
    });
    const runB = shard(orchestrator, candidate.candidateId, id, {
      caseSetId: setB.case_set_id, propsHashes: ["p-sms"], slotsHashes: ["slots-a"],
    });
    const response = await handler(req(`/components/${id}/promote`, "POST", {
      baseRev: 1, sourceHash: candidate.sourceHash, acceptanceRunIds: [runA.run_id, runB.run_id],
    }));
    expect(response.status).toBe(422);
    const body = await response.json() as { error: { code: string; overlapCount: number } };
    expect(body.error.code).toBe("acceptance_coverage_overlap");
    expect(body.error.overlapCount).toBe(1);
    expect(versionRows(db, id)).toEqual([]);
  }, 180_000);

  /**
   * Легаси-инвариант §A8 на уровне саги: бесслотовый ран (`slots_hash` NULL) и слотовый с теми же
   * props — разные кадры, а два бесслотовых с одинаковыми props — по-прежнему один. Это
   * гарантирует, что подстановка `"-"` не сделала NULL «джокером» ни в ту, ни в другую сторону.
   */
  test("бесслотовый ран не пересекается со слотовым, но с бесслотовым — да (§A8, легаси)", async () => {
    const { db, handler, orchestrator, id, candidate } = await familyFixture("promote-slotsnull", "PromoteSlotsnull");
    const setA = putCaseSet(db, id, "light", ["a1"]);
    const setB = putCaseSet(db, id, "light", ["b1"]);
    const slotless = shard(orchestrator, candidate.candidateId, id, { caseSetId: setA.case_set_id, propsHashes: ["p-sms"] });
    const slotted = shard(orchestrator, candidate.candidateId, id, {
      caseSetId: setB.case_set_id, propsHashes: ["p-sms"], slotsHashes: ["slots-a"],
    });
    expect(orchestrator.repo.cases(slotless.run_id).map((row) => row.slots_hash)).toEqual([null]);

    const promoted = await handler(req(`/components/${id}/promote`, "POST", {
      baseRev: 1, sourceHash: candidate.sourceHash, candidateId: candidate.candidateId,
      acceptanceRunIds: [slotless.run_id, slotted.run_id], expectedCases: 2,
    }));
    expect(promoted.status, await promoted.clone().text()).toBe(201);

    // Второй компонент: два бесслотовых рана с одинаковыми props — доv31-поведение, отказ.
    const legacy = await familyFixture("promote-slotsnull2", "PromoteSlotsnull2");
    const setC = putCaseSet(legacy.db, legacy.id, "light", ["c1"]);
    const setD = putCaseSet(legacy.db, legacy.id, "light", ["d1"]);
    const one = shard(legacy.orchestrator, legacy.candidate.candidateId, legacy.id, { caseSetId: setC.case_set_id, propsHashes: ["p-sms"] });
    const two = shard(legacy.orchestrator, legacy.candidate.candidateId, legacy.id, { caseSetId: setD.case_set_id, propsHashes: ["p-sms"] });
    const refused = await legacy.handler(req(`/components/${legacy.id}/promote`, "POST", {
      baseRev: 1, sourceHash: legacy.candidate.sourceHash, acceptanceRunIds: [one.run_id, two.run_id],
    }));
    expect(refused.status).toBe(422);
    expect(await codeOf(refused)).toBe("acceptance_coverage_overlap");
  }, 240_000);

  test("одинаковые props на РАЗНЫХ поверхностях промоутятся, а совпавшие caseKey дают warning (D12)", async () => {
    const { db, handler, orchestrator, id, candidate } = await familyFixture("promote-themes", "PromoteThemes");
    const light = putCaseSet(db, id, "light", ["c1"]);
    const dark = putCaseSet(db, id, "dark", ["c1"]);
    const keys = ["default", "pressed"];
    const runLight = shard(orchestrator, candidate.candidateId, id, { caseSetId: light.case_set_id, propsHashes: ["p1", "p2"], caseKeys: keys });
    const runDark = shard(orchestrator, candidate.candidateId, id, { caseSetId: dark.case_set_id, propsHashes: ["p1", "p2"], caseKeys: keys });
    const promoted = await handler(req(`/components/${id}/promote`, "POST", {
      baseRev: 1, sourceHash: candidate.sourceHash, acceptanceRunIds: [runLight.run_id, runDark.run_id], expectedCases: 4,
    }));
    expect(promoted.status, await promoted.clone().text()).toBe(201);
    const body = await promoted.json() as { warnings: string[]; acceptanceRunIds: string[] };
    expect(body.acceptanceRunIds).toHaveLength(2);
    expect(body.warnings.some((warning) => warning.includes("share 2 case key(s)"))).toBe(true);
  }, 180_000);

  test("несогласованный набор: провальный ран, чужой ран, смешанные профили, разные рендереры", async () => {
    const { db, handler, orchestrator, id, candidate } = await familyFixture("promote-incoherent", "PromoteIncoherent");
    const promote = (runIds: string[]) => handler(req(`/components/${id}/promote`, "POST", {
      baseRev: 1, sourceHash: candidate.sourceHash, candidateId: candidate.candidateId, acceptanceRunIds: runIds,
    }));
    const ok = shard(orchestrator, candidate.candidateId, id, { propsHashes: ["p1"] });

    const failed = shard(orchestrator, candidate.candidateId, id, { propsHashes: ["p2"], status: "fail" });
    expect(await codeOf(await promote([ok.run_id, failed.run_id]))).toBe("acceptance_run_not_passed");

    const strict = shard(orchestrator, candidate.candidateId, id, { propsHashes: ["p3"], policyProfileId: "pixel-strict-v1" });
    expect(await codeOf(await promote([ok.run_id, strict.run_id]))).toBe("acceptance_policy_mismatch");

    const otherRenderer = shard(orchestrator, candidate.candidateId, id, { propsHashes: ["p4"], rendererFingerprint: "s".repeat(64) });
    expect(await codeOf(await promote([ok.run_id, otherRenderer.run_id]))).toBe("acceptance_renderer_mismatch");

    // Ран чужого кандидата того же компонента — принадлежность, а не политика.
    const other = orchestrator.repo.createCandidate({
      componentId: id, designSystem: "yandex-pay", rev: 42, sourceHash: "4".repeat(64), bundleHash: "5".repeat(64),
      hostAbiVersion: 1, themeVersion: null, observedCatalogRevision: "catalog-z", policyProfileHash: POLICY_HASH,
      createdBy: BOOTSTRAP_ADMIN_ID,
    }).candidate;
    const foreign = shard(orchestrator, other.candidate_id, id, { propsHashes: ["p5"] });
    expect(await codeOf(await promote([ok.run_id, foreign.run_id]))).toBe("acceptance_run_mismatch");

    expect(versionRows(db, id)).toEqual([]);
  }, 180_000);

  test("legacy-ран без renderer_fingerprint (до v30) промоутится с warning, а не отказом", async () => {
    const { db, handler, orchestrator, id, candidate } = await familyFixture("promote-legacyrenderer", "PromoteLegacyrenderer");
    const setA = putCaseSet(db, id, "light", ["a1"]);
    const setB = putCaseSet(db, id, "light", ["b1"]);
    const modern = shard(orchestrator, candidate.candidateId, id, { caseSetId: setA.case_set_id, propsHashes: ["p1"] });
    const legacy = shard(orchestrator, candidate.candidateId, id, { caseSetId: setB.case_set_id, propsHashes: ["p2"], rendererFingerprint: null });
    const promoted = await handler(req(`/components/${id}/promote`, "POST", {
      baseRev: 1, sourceHash: candidate.sourceHash, acceptanceRunIds: [modern.run_id, legacy.run_id],
    }));
    expect(promoted.status, await promoted.clone().text()).toBe(201);
    const body = await promoted.json() as { warnings: string[] };
    expect(body.warnings.some((warning) => warning.includes(legacy.run_id) && warning.includes("renderer provenance"))).toBe(true);
  }, 180_000);

  test("expectedCases не сходится → 422 acceptance_coverage_incomplete", async () => {
    const { db, handler, orchestrator, id, candidate } = await familyFixture("promote-incomplete", "PromoteIncomplete");
    const setA = putCaseSet(db, id, "light", ["a1"]);
    const setB = putCaseSet(db, id, "light", ["b1"]);
    const runA = shard(orchestrator, candidate.candidateId, id, { caseSetId: setA.case_set_id, propsHashes: ["p1", "p2"] });
    const runB = shard(orchestrator, candidate.candidateId, id, { caseSetId: setB.case_set_id, propsHashes: ["p3"] });
    const response = await handler(req(`/components/${id}/promote`, "POST", {
      baseRev: 1, sourceHash: candidate.sourceHash, acceptanceRunIds: [runA.run_id, runB.run_id], expectedCases: 4,
    }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "acceptance_coverage_incomplete", expectedCases: 4, coveredCases: 3 } });
    expect(versionRows(db, id)).toEqual([]);
  }, 180_000);

  test("оба поля сразу → 400; одиночный promote байтово совместим и всё равно пишет массив", async () => {
    const { db, handler, orchestrator, id, candidate } = await familyFixture("promote-xor", "PromoteXor");
    const run = shard(orchestrator, candidate.candidateId, id, { propsHashes: ["p1"] });
    const both = await handler(req(`/components/${id}/promote`, "POST", {
      baseRev: 1, sourceHash: candidate.sourceHash, acceptanceRunId: run.run_id, acceptanceRunIds: [run.run_id],
    }));
    expect(both.status).toBe(400);
    expect(await codeOf(both)).toBe("invalid_request");

    const promoted = await handler(req(`/components/${id}/promote`, "POST", {
      baseRev: 1, sourceHash: candidate.sourceHash, acceptanceRunId: run.run_id,
    }));
    expect(promoted.status, await promoted.clone().text()).toBe(201);
    expect(await promoted.json()).toMatchObject({ acceptanceRunId: run.run_id, acceptanceRunIds: [run.run_id] });
    expect(publishRunIds(db, id)).toEqual({ one: run.run_id, many: JSON.stringify([run.run_id]) });
  }, 180_000);

  test("capabilities объявляют acceptanceMultiRunPromote вместе с матрицей", async () => {
    const withMatrix = await setup({ matrix: true });
    const on = await (await withMatrix.handler(req("/capabilities"))).json() as { features: Record<string, boolean> };
    expect(on.features.acceptanceMultiRunPromote).toBe(true);
    const withoutMatrix = await setup();
    const off = await (await withoutMatrix.handler(req("/capabilities"))).json() as { features: Record<string, boolean> };
    expect(off.features.acceptanceMultiRunPromote).toBe(false);
  }, 120_000);
});
