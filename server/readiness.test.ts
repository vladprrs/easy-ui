import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { createHandler } from "./main";
import { createTestHandler } from "./test-auth";
import { UserRepo } from "./users";
import { computeReadiness, locate, parsePublishGates, READINESS_GATE_IDS, type ReadinessReport } from "./readiness";
import { prototypeDocSchema, type PrototypeDoc } from "../src/prototype/schema";

// Волна 4: ready-to-publish report. Инварианты плана, которые тест обязан защитить:
// пустой конфиг → blocking пуст и publishable=true; `unknown` не блокирует; гейт `screens`
// не зависит от serveDist; readiness считается до repo.publish и сверяет rev с baseRev.

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  delete process.env.EASYUI_PUBLISH_GATES;
});

async function fixture() {
  const dir = await mkdtemp(resolve(process.cwd(), ".readiness-test-")); dirs.push(dir);
  const db = openDatabase(":memory:"); createTestHandler(db, { dataDir: dir });
  const at = new Date().toISOString();
  db.query("INSERT INTO users (id,name,password_hash,is_admin,created_at) VALUES (?,?,?,?,?),(?,?,?,?,?)")
    .run("user_alice", "Alice", "unused", 0, at, "user_bob", "Bob", "unused", 0, at);
  const users = new UserRepo(db);
  const tokens = { alice: users.createSession("user_alice").token, bob: users.createSession("user_bob").token };
  const handler = createHandler(db, { dataDir: dir, publicOrigin: "http://test" });
  const call = (who: "alice" | "bob", method: string, path: string, body?: unknown) => handler(new Request(`http://test/api${path}`, {
    method,
    headers: { cookie: `easyui_session=${tokens[who]}`, ...(body === undefined ? {} : { "content-type": "application/json", origin: "http://test" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const base = prototypeDocSchema.parse(await Bun.file("test/fixtures/host-content.json").json());
  const doc = (id: string): PrototypeDoc => ({ ...base, id, name: id });
  return { db, dir, call, doc };
}

const gateOf = (report: ReadinessReport, id: string) => report.gates.find((gate) => gate.id === id)!;

/** Приколачивает к головной ревизии пин компонента с заданным статусом публикации. */
function pinComponent(db: import("bun:sqlite").Database, prototypeId: string, rev: number, name: string, status: string, meta: Record<string, unknown> = {}) {
  const id = `c_${name.toLowerCase()}`;
  db.query("INSERT INTO components (id,name,head_rev,design_system,created_at,updated_at) VALUES (?,?,1,'yandex-pay','now','now')").run(id, name);
  db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES (?,1,'source','yandex-pay','now')").run(id);
  db.query(`INSERT INTO component_publishes (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,published_at)
    VALUES (?,1,1,?,'js',?,?,?,1,'now')`).run(id, status, JSON.stringify(meta), `sh-${id}`, `bh-${id}`);
  db.query("INSERT INTO prototype_revision_components (prototype_id,rev,component_id,component_version) VALUES (?,?,?,1)").run(prototypeId, rev, id);
  return id;
}

describe("readiness report", () => {
  test("reports every gate, blocks nothing by default and never blocks on unknown", async () => {
    const { call, doc } = await fixture();
    expect((await call("alice", "POST", "/prototypes", { doc: doc("ready") })).status).toBe(201);
    const response = await call("alice", "GET", "/prototypes/ready/readiness");
    expect(response.status).toBe(200);
    const report = await response.json() as ReadinessReport;

    expect(report.prototypeId).toBe("ready");
    expect(report.rev).toBe(1);
    expect(report.gates.map((gate) => gate.id)).toEqual([...READINESS_GATE_IDS]);
    expect(report.blocking).toEqual([]);
    expect(report.publishable).toBe(true);
    expect(report.enabledGates).toEqual({});

    expect(gateOf(report, "architecture").status).toBe("pass");
    expect(gateOf(report, "schema").status).toBe("pass");
    // `screens` считается из classifyRevision, а не из serveDist: без билда он всё равно pass.
    expect(gateOf(report, "screens").status).toBe("pass");
    expect(gateOf(report, "screens").route).toEqual({ served: false, informational: true });
    expect(gateOf(report, "assets").status).toBe("pass");
    expect(gateOf(report, "pins").status).toBe("pass");
    expect(gateOf(report, "deprecated").status).toBe("pass");
    // Данных нет — но это не «плохо», а «неизвестно», и публикацию не трогает.
    expect(gateOf(report, "visual").status).toBe("unknown");
    expect(gateOf(report, "capture").status).toBe("unknown");
    expect(gateOf(report, "interactions").status).toBe("unknown");
    expect(gateOf(report, "publishDiff").status).toBe("unknown");
  });

  test("an enabled gate whose status is unknown still does not block", async () => {
    const { db, dir, doc, call } = await fixture();
    await call("alice", "POST", "/prototypes", { doc: doc("unknowns") });
    const report = await computeReadiness(db, "unknowns", { dataDir: dir, gates: { capture: "warn", interactions: "warn", visual: "warn" } });
    expect(report.blocking).toEqual([]);
    expect(report.publishable).toBe(true);
  });

  test("deprecated and superseded pins surface with the declared replacement", async () => {
    const { db, dir, call, doc } = await fixture();
    await call("alice", "POST", "/prototypes", { doc: doc("stale") });
    pinComponent(db, "stale", 1, "OldCard", "deprecated", { replacement: "NewCard" });
    pinComponent(db, "stale", 1, "GoneCard", "superseded");
    const report = await computeReadiness(db, "stale", { dataDir: dir });
    const gate = gateOf(report, "deprecated");
    expect(gate.status).toBe("warn");
    expect(gate.components).toMatchObject([
      { name: "GoneCard", status: "superseded" },
      { name: "OldCard", status: "deprecated", replacement: "NewCard" },
    ]);
    expect(gate.withReplacement).toBe(1);
    // Те же пины деградируют `pins`, но остаются рендерящимися — значит warn, не fail.
    expect(gateOf(report, "pins").status).toBe("warn");
  });

  test("an unrenderable pin fails the pins gate", async () => {
    const { db, dir, call, doc } = await fixture();
    await call("alice", "POST", "/prototypes", { doc: doc("broken") });
    pinComponent(db, "broken", 1, "RejectedCard", "rejected");
    const report = await computeReadiness(db, "broken", { dataDir: dir });
    expect(gateOf(report, "pins").status).toBe("fail");
  });

  test("publishDiff turns pass once a published version differs from head", async () => {
    const { db, dir, call, doc } = await fixture();
    await call("alice", "POST", "/prototypes", { doc: doc("diffy") });
    expect((await call("alice", "POST", "/prototypes/diffy/publish", { baseRev: 1 })).status).toBe(201);
    expect(gateOf(await computeReadiness(db, "diffy", { dataDir: dir }), "publishDiff")).toMatchObject({ status: "warn", summary: "already_published" });
    await call("alice", "PUT", "/prototypes/diffy", { doc: doc("diffy"), baseRev: 1 });
    expect(gateOf(await computeReadiness(db, "diffy", { dataDir: dir }), "publishDiff")).toMatchObject({ status: "pass", available: true, latestVersion: 1 });
  });

  test("404s for an unknown prototype and hides a private one from a non-reader", async () => {
    const { call, doc } = await fixture();
    await call("alice", "POST", "/prototypes", { doc: doc("private-proto") });
    expect((await call("alice", "GET", "/prototypes/nope/readiness")).status).toBe(404);
    expect((await call("bob", "GET", "/prototypes/private-proto/readiness")).status).toBe(404);
  });
});

describe("EASYUI_PUBLISH_GATES", () => {
  test("parses a CSV of gate ids with an optional warn threshold and ignores junk", () => {
    expect(parsePublishGates("")).toEqual({});
    expect(parsePublishGates(undefined)).toEqual({});
    expect(parsePublishGates("pins, screens:warn , nonsense, ,architecture:bogus"))
      .toEqual({ pins: "fail", screens: "warn", architecture: "fail" });
  });
});

describe("publish gating", () => {
  test("blocks with 409 publish_blocked, carries the report, and lets the owner force through", async () => {
    const { db, call, doc } = await fixture();
    await call("alice", "POST", "/prototypes", { doc: doc("gated") });
    pinComponent(db, "gated", 1, "RejectedCard", "rejected");
    process.env.EASYUI_PUBLISH_GATES = "pins";

    const blocked = await call("alice", "POST", "/prototypes/gated/publish", { baseRev: 1 });
    expect(blocked.status).toBe(409);
    const body = await blocked.json() as { error: { code: string; report?: ReadinessReport } };
    expect(body.error.code).toBe("publish_blocked");
    expect(body.error.report?.blocking).toEqual(["pins"]);
    expect(body.error.report?.publishable).toBe(false);
    expect((db.query("SELECT COUNT(*) n FROM prototype_publishes WHERE prototype_id='gated'").get() as { n: number }).n).toBe(0);

    const forced = await call("alice", "POST", "/prototypes/gated/publish", { baseRev: 1, force: true });
    expect(forced.status).toBe(201);
    const audit = db.query("SELECT COUNT(*) n FROM audit_events WHERE action='prototype.publish.forced' AND subject_id='gated'").get() as { n: number };
    expect(audit.n).toBe(1);
  });

  test("a stale baseRev is a revision_conflict before anything is published (TOCTOU)", async () => {
    const { db, call, doc } = await fixture();
    await call("alice", "POST", "/prototypes", { doc: doc("toctou") });
    await call("alice", "PUT", "/prototypes/toctou", { doc: doc("toctou"), baseRev: 1 });
    process.env.EASYUI_PUBLISH_GATES = "pins";
    const stale = await call("alice", "POST", "/prototypes/toctou/publish", { baseRev: 1 });
    expect(stale.status).toBe(409);
    expect((await stale.json() as { error: { code: string } }).error.code).toBe("revision_conflict");
    expect((db.query("SELECT COUNT(*) n FROM prototype_publishes WHERE prototype_id='toctou'").get() as { n: number }).n).toBe(0);
  });

  test("an empty config keeps publish exactly as it was", async () => {
    const { call, doc } = await fixture();
    await call("alice", "POST", "/prototypes", { doc: doc("free") });
    expect((await call("alice", "POST", "/prototypes/free/publish", { baseRev: 1 })).status).toBe(201);
  });
});

describe("repin", () => {
  test("dry run reports no change for a host-only document and writes nothing", async () => {
    const { db, call, doc } = await fixture();
    await call("alice", "POST", "/prototypes", { doc: doc("repin-me") });
    const response = await call("alice", "POST", "/prototypes/repin-me/repin?dryRun=1", {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ dryRun: true, rev: 1, changed: [] });
    expect((db.query("SELECT head_rev FROM prototypes WHERE id='repin-me'").get() as { head_rev: number }).head_rev).toBe(1);
  });

  test("a no-op repin does not create an empty revision", async () => {
    const { db, call, doc } = await fixture();
    await call("alice", "POST", "/prototypes", { doc: doc("repin-noop") });
    expect((await call("alice", "POST", "/prototypes/repin-noop/repin", {})).status).toBe(200);
    expect((db.query("SELECT head_rev FROM prototypes WHERE id='repin-noop'").get() as { head_rev: number }).head_rev).toBe(1);
  });

  test("is owner-only", async () => {
    const { call, doc } = await fixture();
    await call("alice", "POST", "/prototypes", { doc: doc("repin-owned") });
    expect((await call("bob", "POST", "/prototypes/repin-owned/repin?dryRun=1", {})).status).toBe(404);
  });
});

describe("locate", () => {
  test("resolves a screen index and element key from a JSON pointer", async () => {
    const { doc } = await fixture();
    const document = doc("pointers");
    const screenId = document.screens[0]!.id;
    const elementKey = Object.keys(document.screens[0]!.spec.elements)[0]!;
    expect(locate(document, `/screens/0/spec/elements/${elementKey}/props`, "bad")).toEqual({
      path: `/screens/0/spec/elements/${elementKey}/props`, message: "bad", screenId, elementKey,
    });
    expect(locate(document, "/designSystem", "bad")).toEqual({ path: "/designSystem", message: "bad" });
    expect(locate(document, "/screens/99/spec", "bad")).toEqual({ path: "/screens/99/spec", message: "bad" });
  });
});
