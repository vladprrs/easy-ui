import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { openDatabase } from "./db";
import { createHandler } from "./main";
import { UserRepo } from "./users";
import { prototypeDocSchema } from "../src/prototype/schema";
import { AcceptanceOrchestrator } from "./acceptance/orchestrator";
import { ScreenshotService, type RunJob, type WorkerResult } from "./screenshot/service";
import {
  __clearOverlayLeasesForTest, candidateBundlePresent, candidatesRoot, gcCandidates,
  overlayLeasePins, registerOverlayLease, releaseOverlayLease, setCandidatePinProvider,
} from "./components/candidates";
import { componentManifestHashOf } from "./repos/prototypes";

/**
 * `prototypeCandidateOverlay` (план `docs/plans/2026-08-05-slot-acceptance.md` §B1/B2, W2 T2.4).
 *
 * Предмет — HTTP-поверхность и постановка: гейт флага, коды отказов (в т.ч. **побайтово
 * одинаковый** отказ на чужого и на несуществующего кандидата), подмена пина, handshake по
 * подменённому списку, дельта allowlist'а, аренда пина против GC, авторизация чтения и
 * байтовая доставка кадра. Капчур — заглушка `runJob`: браузер здесь не предмет.
 */

const dirs: string[] = [];
const dbs: Database[] = [];
afterEach(async () => {
  setCandidatePinProvider(null);
  __clearOverlayLeasesForTest();
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const COMPONENT_ID = "overlay-stars";
const SPARE_ID = "overlay-spare";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]);

const imageStub: RunJob = async () => ({ ok: true, pngBase64: Buffer.from(PNG).toString("base64"), width: 1, height: 1, consoleErrors: [], pageErrors: [], browserVersion: "test/1" });
const neverResolves: RunJob = () => new Promise<WorkerResult>(() => {});

const componentSource = (label: string) => `import { z } from "zod";
export const definition = {
  props: z.strictObject({ value: z.number().min(0).max(5) }),
  events: [], slots: [],
  description: "Overlay probe: renders a ${label} rating badge",
  atomicLevel: "atom" as const,
  example: { value: 3 },
};
export default function OverlayStars({ props }: any) {
  return <div><span>{"${label}"}{props.value}</span></div>;
}`;

type Call = (method: string, path: string, body?: unknown) => Promise<Response>;

async function jsonOf<T>(response: Response): Promise<T> { return (await response.json()) as T; }
const codeOf = async (response: Response) => (await jsonOf<{ error: { code: string } }>(response)).error.code;

interface CandidateBody { candidateId: string; componentId: string; rev: number; sourceHash: string; bundleHash: string }
interface EnqueueBody { jobId: string; components: { id: string; name: string; version: number; bundleHash: string; status?: string; candidate?: { candidateId: string; rev: number; sourceHash: string } }[] }

/** Документ с одним экраном из custom-компонента — минимальный носитель пина. */
async function galleryDoc(id: string) {
  const base = prototypeDocSchema.parse(await Bun.file("test/fixtures/host-content.json").json());
  return {
    ...base, id, name: id,
    screens: base.screens.map((screen, index) => index ? screen : { ...screen, spec: { root: "stars", elements: { stars: { type: "OverlayStars", props: { value: 3 } } } } }),
  };
}

async function setup(options: { runJob?: RunJob; matrix?: boolean; validateDisabled?: boolean } = {}) {
  const dir = await mkdtemp(resolve(process.cwd(), ".overlay-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  dbs.push(db);
  const at = new Date().toISOString();
  db.query("INSERT INTO users (id,name,password_hash,is_admin,created_at) VALUES (?,?,?,?,?),(?,?,?,?,?)")
    .run("user_alice", "Alice", "unused", 0, at, "user_bob", "Bob", "unused", 0, at);
  // Встроенные ДС создаются без владельца; Алиса — не админ, поэтому владение назначается явно
  // (тот же приём, что делает `createTestHandler` для bootstrap-админа).
  db.query("UPDATE design_systems SET owner_id='user_alice' WHERE owner_id IS NULL").run();
  const users = new UserRepo(db);
  const alice = users.createSession("user_alice").token;
  const bob = users.createSession("user_bob").token;
  const service = new ScreenshotService({ db, dataDir: dir, serveDist: "dist", captureOrigin: "http://127.0.0.1:8787", chromiumAvailable: true, runJob: options.runJob ?? neverResolves });
  const orchestrator = options.matrix === false ? undefined : new AcceptanceOrchestrator({ db, dataDir: dir, service, autoDrain: false });
  const handler = createHandler(db, {
    dataDir: dir, screenshots: service, publicOrigin: "http://test",
    // Reuse-гейт в shadow: предмет теста — overlay, а не политика переиспользования каталога.
    reuseGateMode: "shadow",
    ...(options.validateDisabled ? { validateDisabled: true } : {}),
    ...(orchestrator ? { acceptance: orchestrator } : {}),
  });
  const as = (token: string): Call => (method, path, body) => handler(new Request(`http://test${path}`, {
    method,
    headers: {
      cookie: `easyui_session=${token}`,
      ...(method === "GET" ? {} : { origin: "http://test" }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { dir, db, service, orchestrator, handler, call: as(alice), asBob: as(bob), aliceToken: alice, bobToken: bob };
}

/** Компонент + публикация v1 + прототип, пиннущий эту версию. Кандидаты строятся поверх. */
async function seed(call: Call, prototypeId: string) {
  expect((await call("POST", "/api/components", { designSystem: "yandex-pay", id: COMPONENT_ID, name: "OverlayStars", source: componentSource("published"), intent: "Renders a rating badge for candidate overlay tests" })).status).toBe(201);
  expect((await call("POST", `/api/components/${COMPONENT_ID}/publish`, { baseRev: 1 })).status).toBe(201);
  expect((await call("POST", "/api/prototypes", { doc: await galleryDoc(prototypeId) })).status).toBe(201);
}

/** Сохраняет новую head-ревизию и строит по ней кандидата (его бандл ≠ опубликованному). */
async function makeCandidate(call: Call, componentId: string, baseRev: number, label: string): Promise<CandidateBody> {
  const saved = await call("PUT", `/api/components/${componentId}`, { baseRev, source: componentSource(label) });
  expect(saved.status, await saved.clone().text()).toBe(200);
  const created = await call("POST", `/api/components/${componentId}/candidates`);
  expect(created.status, await created.clone().text()).toBe(200);
  return jsonOf<CandidateBody>(created);
}

const overlayPost = (call: Call, prototypeId: string, candidateIds: unknown) =>
  call("POST", `/api/prototypes/${prototypeId}/screens/welcome/screenshot`, { viewport: { width: 390, height: 844 }, candidateOverrides: candidateIds });

describe("prototypeCandidateOverlay: refusals", () => {
  test("флаг матричной приёмки выключен (и kill-switch validate) — 404, обычная съёмка работает", async () => {
    const off = await setup({ matrix: false });
    await seed(off.call, "overlay-off");
    const refused = await overlayPost(off.call, "overlay-off", [{ candidateId: `cand_${"0".repeat(64)}` }]);
    expect([refused.status, await codeOf(refused)]).toEqual([404, "not_found"]);
    // Без `candidateOverrides` ручка остаётся прежней даже при выключённом флаге.
    expect((await off.call("POST", "/api/prototypes/overlay-off/screens/welcome/screenshot", { viewport: { width: 390, height: 844 } })).status).toBe(202);

    const killed = await setup({ validateDisabled: true });
    await seed(killed.call, "overlay-killed");
    const refusedKill = await overlayPost(killed.call, "overlay-killed", [{ candidateId: `cand_${"0".repeat(64)}` }]);
    expect([refusedKill.status, await codeOf(refusedKill)]).toEqual([404, "not_found"]);
  }, 120_000);

  test("форма и потолок — 400 invalid_request", async () => {
    const { call } = await setup();
    await seed(call, "overlay-shape");
    const bad = async (value: unknown) => {
      const response = await overlayPost(call, "overlay-shape", value);
      return [response.status, await codeOf(response)];
    };
    expect(await bad("nope")).toEqual([400, "invalid_request"]);
    expect(await bad(["cand_x"])).toEqual([400, "invalid_request"]);
    expect(await bad([{ candidateId: 1 }])).toEqual([400, "invalid_request"]);
    expect(await bad([{ candidateId: "cand_x", extra: 1 }])).toEqual([400, "invalid_request"]);
    expect(await bad([{ candidateId: "a" }, { candidateId: "b" }, { candidateId: "c" }])).toEqual([400, "invalid_request"]);
  }, 120_000);

  test("чужой и несуществующий кандидат дают ПОБАЙТОВО одинаковый 404 (нет оракула существования)", async () => {
    const { call, db } = await setup();
    await seed(call, "overlay-oracle");
    const candidate = await makeCandidate(call, COMPONENT_ID, 1, "candidate");
    // Кандидат существует, но компонент теперь чужой: отказ обязан совпасть с «такого нет».
    db.query("UPDATE components SET owner_id='user_bob' WHERE id=?").run(COMPONENT_ID);

    const foreign = await overlayPost(call, "overlay-oracle", [{ candidateId: candidate.candidateId }]);
    const missing = await overlayPost(call, "overlay-oracle", [{ candidateId: `cand_${"0".repeat(64)}` }]);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(foreign.status);
    expect(await missing.text()).toBe(await foreign.text());
  }, 120_000);

  test("кандидат компонента без пина в прототипе — 422; повтор одного компонента — 400", async () => {
    const { call } = await setup();
    await seed(call, "overlay-pin");
    // Компонент, которого нет в документе (и который не обязан быть опубликованным).
    expect((await call("POST", "/api/components", { designSystem: "yandex-pay", id: SPARE_ID, name: "OverlaySpare", source: componentSource("spare"), intent: "Renders an unrelated badge that no prototype pins" })).status).toBe(201);
    const spare = await makeCandidate(call, SPARE_ID, 1, "spare-next");
    const refused = await overlayPost(call, "overlay-pin", [{ candidateId: spare.candidateId }]);
    expect([refused.status, await codeOf(refused)]).toEqual([422, "candidate_component_not_in_prototype"]);

    const first = await makeCandidate(call, COMPONENT_ID, 1, "first");
    const second = await makeCandidate(call, COMPONENT_ID, 2, "second");
    expect(second.candidateId).not.toBe(first.candidateId);
    const duplicate = await overlayPost(call, "overlay-pin", [{ candidateId: first.candidateId }, { candidateId: second.candidateId }]);
    expect([duplicate.status, await codeOf(duplicate)]).toEqual([400, "invalid_request"]);
  }, 180_000);

  test("вытесненный бандл кандидата — 409 candidate_evicted, аренда снята", async () => {
    const { call, dir, service } = await setup();
    await seed(call, "overlay-evicted");
    const candidate = await makeCandidate(call, COMPONENT_ID, 1, "evicted");
    await rm(candidatesRoot(dir), { recursive: true, force: true });
    const refused = await overlayPost(call, "overlay-evicted", [{ candidateId: candidate.candidateId }]);
    expect([refused.status, await codeOf(refused)]).toEqual([409, "candidate_evicted"]);
    // Провалившийся роут не оставляет ни аренды, ни пина джобы.
    expect([...overlayLeasePins()]).toEqual([]);
    expect([...service.pinnedCandidateSourceHashes()]).toEqual([]);
  }, 120_000);
});

describe("prototypeCandidateOverlay: постановка", () => {
  test("подмена пина, handshake по подменённому списку, allowlist и байтовая доставка", async () => {
    const { call, db, dir, service } = await setup({ runJob: imageStub });
    await seed(call, "overlay-main");
    const candidate = await makeCandidate(call, COMPONENT_ID, 1, "candidate");
    const publishedBundleHash = (db.query("SELECT bundle_hash h FROM component_publishes WHERE component_id=? AND version=1").get(COMPONENT_ID) as { h: string }).h;
    expect(candidate.bundleHash).not.toBe(publishedBundleHash);
    const publishedAssets = (db.query("SELECT COUNT(*) n FROM assets").get() as { n: number }).n;

    const response = await overlayPost(call, "overlay-main", [{ candidateId: candidate.candidateId }]);
    expect(response.status, await response.clone().text()).toBe(202);
    const body = await jsonOf<EnqueueBody>(response);
    // Сигнал детекции (§B2.3): пин ответа несёт candidate-бандл, а не опубликованный.
    expect(body.components).toEqual([{ id: COMPONENT_ID, name: "OverlayStars", version: 1, bundleHash: candidate.bundleHash, status: "candidate", candidate: { candidateId: candidate.candidateId, rev: candidate.rev, sourceHash: candidate.sourceHash } }]);

    const job = service.peek(body.jobId)!;
    expect(job.capturePins).toEqual([expect.objectContaining({
      id: COMPONENT_ID, version: 1, status: "candidate", bundleHash: candidate.bundleHash,
      bundleUrl: `/api/components/${COMPONENT_ID}/draft/${candidate.sourceHash}/bundle.js`,
    })]);
    // §B2.3: обе точки записи — одна величина, посчитанная по подменённому списку, и она
    // отличается от manifest-хэша сохранённой ревизии.
    const overridden = componentManifestHashOf([{ id: COMPONENT_ID, version: 1, bundleHash: candidate.bundleHash }]);
    const stored = componentManifestHashOf([{ id: COMPONENT_ID, version: 1, bundleHash: publishedBundleHash }]);
    expect(job.expected.kind).toBe("prototype");
    if (job.expected.kind !== "prototype") throw new Error("expected a prototype job");
    expect(job.expected.componentManifestHash).toBe(overridden);
    expect(job.captureManifestHash).toBe(overridden);
    expect(job.expected.componentManifestHash).not.toBe(stored);
    expect(job.expected.candidateOverlay).toEqual([{ componentId: COMPONENT_ID, candidateId: candidate.candidateId, bundleHash: candidate.bundleHash }]);
    // §B2.1: overlay-джоба всегда байтовая.
    expect(job.deliver).toBe("bytes");

    // §B2.4: allowlist получил draft-бандл кандидата, но не бандл затенённой версии.
    expect(job.allowedUrls).toContain(`/api/components/${COMPONENT_ID}/draft/${candidate.sourceHash}/bundle.js`);
    expect(job.allowedUrls).not.toContain(`/api/components/${COMPONENT_ID}/versions/1/bundle.js`);

    // Аренда роута снята: пин перешёл к джобе (её пин проверяет тест аренды ниже — там капчур
    // не завершается, и джоба остаётся нетерминальной наблюдаемо).
    expect([...overlayLeasePins()]).toEqual([]);

    for (let i = 0; i < 200 && service.get(body.jobId).status !== "done"; i++) await Bun.sleep(10);
    const done = service.get(body.jobId);
    expect(done.status).toBe("done");
    expect(done.result?.kind).toBe("image-bytes");
    // Ассет не создаётся: кадр с неопубликованным кодом не входит в реестр.
    expect((db.query("SELECT COUNT(*) n FROM assets").get() as { n: number }).n).toBe(publishedAssets);
    // Терминальная джоба бандл кандидата больше не пинует.
    expect([...service.pinnedCandidateSourceHashes()]).toEqual([]);

    // HTTP-конверт статуса: метаданные вместо байтов.
    const status = await call("GET", `/api/screenshot-jobs/${body.jobId}`);
    expect(status.status).toBe(200);
    const statusBody = await jsonOf<{ result: Record<string, unknown> }>(status);
    expect(statusBody.result.bytes).toBeUndefined();
    expect(statusBody.result).toMatchObject({ kind: "image-bytes", width: 1, height: 1, byteLength: PNG.byteLength });
    expect(statusBody.result.pngSha256).toBe(new Bun.CryptoHasher("sha256").update(PNG).digest("hex"));

    // Байты — отдельной ручкой, пока жив результат.
    const bytes = await call("GET", `/api/screenshot-jobs/${body.jobId}/bytes`);
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(PNG);

    // §B2.6: receipt overlay-джобы не пишется вовсе — ручка честно отвечает 404.
    const receipt = await call("GET", `/api/screenshot-jobs/${body.jobId}/receipt`);
    expect([receipt.status, await codeOf(receipt)]).toEqual([404, "receipt_not_found"]);
    void dir;
  }, 180_000);

  test("обычная prototype-джоба receipt пишет — подавление точечное", async () => {
    const { call, service } = await setup({ runJob: imageStub });
    await seed(call, "overlay-receipt-contrast");
    const response = await call("POST", "/api/prototypes/overlay-receipt-contrast/screens/welcome/screenshot", { viewport: { width: 390, height: 844 } });
    expect(response.status).toBe(202);
    const { jobId } = await jsonOf<EnqueueBody>(response);
    for (let i = 0; i < 200 && service.get(jobId).status !== "done"; i++) await Bun.sleep(10);
    expect(service.get(jobId).status).toBe("done");
    expect((await call("GET", `/api/screenshot-jobs/${jobId}/receipt`)).status).toBe(200);
  }, 120_000);

  test("component-candidate байтовая джоба: HTTP-статус без байтов, in-process get() с байтами", async () => {
    const { call, service } = await setup({ runJob: imageStub });
    expect((await call("POST", "/api/components", { designSystem: "yandex-pay", id: COMPONENT_ID, name: "OverlayStars", source: componentSource("bytes"), intent: "Renders a rating badge for candidate overlay tests" })).status).toBe(201);
    // Прогрев candidate-кэша тем же путём, что и draft-preview.
    const warm = await service.enqueueComponentDraft(COMPONENT_ID, "user_alice", { props: { value: 3 }, viewport: { width: 320, height: 200 } });
    for (let i = 0; i < 200 && service.get(warm.jobId).status !== "done"; i++) await Bun.sleep(10);
    const sourceHash = (service.peek(warm.jobId)!.expected as { sourceHash: string }).sourceHash;

    const job = await service.enqueueComponentCandidate(COMPONENT_ID, { rev: 1, sourceHash }, { props: { value: 3 }, viewport: { width: 320, height: 200 }, deliver: "bytes" });
    for (let i = 0; i < 200 && service.get(job.jobId).status !== "done"; i++) await Bun.sleep(10);
    const inProcess = service.get(job.jobId);
    expect(inProcess.result?.kind).toBe("image-bytes");
    if (inProcess.result?.kind !== "image-bytes") throw new Error("expected image-bytes");
    // Гейт приёмки читает байты тем же аксессором — санитизация живёт только на HTTP-границе.
    expect(Array.from(inProcess.result.bytes)).toEqual(Array.from(PNG));

    const http = await call("GET", `/api/screenshot-jobs/${job.jobId}`);
    expect(http.status).toBe(200);
    const httpBody = await jsonOf<{ result: Record<string, unknown> }>(http);
    expect(httpBody.result.bytes).toBeUndefined();
    expect(httpBody.result).toMatchObject({ kind: "image-bytes", byteLength: PNG.byteLength });
  }, 120_000);
});

describe("prototypeCandidateOverlay: аренда пина и авторизация чтения", () => {
  test("GC между резолвом и постановкой не сносит бандл кандидата", async () => {
    const { call, dir, service } = await setup();
    await seed(call, "overlay-lease");
    const candidate = await makeCandidate(call, COMPONENT_ID, 1, "leased");
    // Провайдер пинов процесса — то же объединение, что собирает main.ts.
    setCandidatePinProvider(() => {
      const pins = new Set<string>(overlayLeasePins());
      for (const sha of service.pinnedCandidateSourceHashes()) pins.add(sha);
      return pins;
    });
    // GC проходит ровно в окне между резолвом кандидата и постановкой джобы.
    const original = service.resolveCandidateOverride.bind(service);
    service.resolveCandidateOverride = async (input) => {
      const resolved = await original(input);
      await gcCandidates(dir, { ttlMs: 0 });
      return resolved;
    };
    const response = await overlayPost(call, "overlay-lease", [{ candidateId: candidate.candidateId }]);
    expect(response.status, await response.clone().text()).toBe(202);
    expect(await candidateBundlePresent(dir, COMPONENT_ID, candidate.sourceHash)).toBe(true);
    // Капчур не завершается (`neverResolves`), поэтому джоба нетерминальна — и держит пин сама,
    // уже без аренды роута.
    expect([...service.pinnedCandidateSourceHashes()]).toEqual([candidate.sourceHash]);
    expect([...overlayLeasePins()]).toEqual([]);
  }, 120_000);

  test("брошенная аренда истекает и перестаёт пинить", async () => {
    const lease = registerOverlayLease("hash-a", { ttlMs: 60_000 });
    expect([...overlayLeasePins()]).toEqual(["hash-a"]);
    releaseOverlayLease(lease);
    expect([...overlayLeasePins()]).toEqual([]);

    registerOverlayLease("hash-b", { ttlMs: 0 });
    expect([...overlayLeasePins()]).toEqual([]);
  });

  test("не-владелец опубликованного прототипа и share-принципал не читают ни статус, ни байты", async () => {
    const { call, asBob, service, handler } = await setup({ runJob: imageStub });
    await seed(call, "overlay-authz");
    const candidate = await makeCandidate(call, COMPONENT_ID, 1, "authz");
    expect((await call("POST", "/api/prototypes/overlay-authz/publish", { baseRev: 1 })).status).toBe(201);
    expect((await call("POST", "/api/prototypes/overlay-authz/status", { status: "published" })).status).toBe(200);
    const { jobId } = await jsonOf<EnqueueBody>(await overlayPost(call, "overlay-authz", [{ candidateId: candidate.candidateId }]));
    for (let i = 0; i < 200 && service.get(jobId).status !== "done"; i++) await Bun.sleep(10);
    expect(service.get(jobId).status).toBe("done");

    // Прототип опубликован: `requirePrototypeRead` Боба пропускает — отказ даёт проверка
    // владения подменённым компонентом, и он — тот же единый 404.
    const status = await asBob("GET", `/api/screenshot-jobs/${jobId}`);
    expect([status.status, await codeOf(status)]).toEqual([404, "not_found"]);
    const bytes = await asBob("GET", `/api/screenshot-jobs/${jobId}/bytes`);
    expect([bytes.status, await codeOf(bytes)]).toEqual([404, "not_found"]);
    // Владелец обе ручки читает.
    expect((await call("GET", `/api/screenshot-jobs/${jobId}`)).status).toBe(200);
    expect((await call("GET", `/api/screenshot-jobs/${jobId}/bytes`)).status).toBe(200);

    // Share-принципал до ручки джобы не доходит вовсе: путь вне закрытия гранта.
    const grant = await call("POST", "/api/prototypes/overlay-authz/share", { version: 1, ttlSeconds: 3600 });
    expect(grant.status, await grant.clone().text()).toBe(201);
    const shareUrl = (await jsonOf<{ url: string }>(grant)).url;
    const exchange = await handler(new Request(`http://test/share/${shareUrl.split("/").at(-1)!}`, { redirect: "manual" }));
    const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0]!;
    const shared = (path: string) => handler(new Request(`http://test${path}`, { headers: { cookie } }));
    expect((await shared(`/api/screenshot-jobs/${jobId}`)).status).not.toBe(200);
    expect((await shared(`/api/screenshot-jobs/${jobId}/bytes`)).status).not.toBe(200);
  }, 180_000);
});
