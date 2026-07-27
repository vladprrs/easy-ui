import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { createHandler } from "./main";
import { createTestHandler } from "./test-auth";
import { UserRepo } from "./users";
import { computeReadiness } from "./readiness";
import { SCENARIOS_PER_PROTOTYPE_LIMIT } from "../src/prototype/scenario";
import { prototypeDocSchema, type PrototypeDoc } from "../src/prototype/schema";

// Сценарии взаимодействия (волна 6): CRUD, владение и информационный гейт `interactions`.

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fixture() {
  const dir = await mkdtemp(resolve(process.cwd(), ".scenarios-test-")); dirs.push(dir);
  const db = openDatabase(":memory:"); createTestHandler(db, { dataDir: dir });
  const at = new Date().toISOString();
  db.query("INSERT INTO users (id,name,password_hash,is_admin,created_at) VALUES (?,?,?,?,?),(?,?,?,?,?)")
    .run("user_alice", "Alice", "unused", 0, at, "user_bob", "Bob", "unused", 0, at);
  const users = new UserRepo(db);
  const tokens = { alice: users.createSession("user_alice").token, bob: users.createSession("user_bob").token };
  const handler = createHandler(db, { dataDir: dir, publicOrigin: "http://test" });
  const call = (who: "alice" | "bob", method: string, path: string, body?: unknown) => handler(new Request(`http://test/api${path}`, {
    method,
    // Origin обязателен для любого небезопасного метода, в том числе DELETE без тела.
    headers: { cookie: `easyui_session=${tokens[who]}`, ...(method === "GET" ? {} : { origin: "http://test" }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const base = prototypeDocSchema.parse(await Bun.file("test/fixtures/host-content.json").json());
  const doc = (id: string): PrototypeDoc => ({ ...base, id, name: id });
  await call("alice", "POST", "/prototypes", { doc: doc("scenario-proto") });
  return { db, dir, call, doc };
}

const steps = (screenId: string) => [{ type: "expectScreen", screenId }, { type: "expectText", text: "Hello" }];

test("scenario CRUD is owner-scoped and readable by the prototype's readers", async () => {
  const { call, doc } = await fixture();
  const screenId = doc("x").screens[0]!.id;

  const created = await call("alice", "POST", "/prototypes/scenario-proto/scenarios", { id: "happy", name: "Happy path", steps: steps(screenId) });
  expect(created.status).toBe(201);
  expect(await created.json()).toMatchObject({ id: "happy", prototypeId: "scenario-proto", name: "Happy path", author: "user_alice" });

  const list = await call("alice", "GET", "/prototypes/scenario-proto/scenarios");
  expect(((await list.json()) as { scenarios: unknown[] }).scenarios).toHaveLength(1);

  // Чужой пользователь не пишет и не видит приватный прототип.
  const forbidden = await call("bob", "PUT", "/prototypes/scenario-proto/scenarios/happy", { name: "Hijack", steps: steps(screenId) });
  expect(forbidden.status).toBe(404);
  expect(((await forbidden.json()) as { error: { code: string } }).error.code).toBe("prototype_not_found");

  const updated = await call("alice", "PUT", "/prototypes/scenario-proto/scenarios/happy", { name: "Happy path v2", steps: [{ type: "expectScreen", screenId }] });
  expect(await updated.json()).toMatchObject({ name: "Happy path v2", steps: [{ type: "expectScreen", screenId }] });

  const deleted = await call("alice", "DELETE", "/prototypes/scenario-proto/scenarios/happy");
  expect(deleted.status).toBe(204);
  const missing = await call("alice", "GET", "/prototypes/scenario-proto/scenarios/happy");
  expect(missing.status).toBe(404);
  expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("scenario_not_found");
});

test("scenario steps are validated by the shared schema", async () => {
  const { call } = await fixture();
  const bad = await call("alice", "POST", "/prototypes/scenario-proto/scenarios", { name: "Bad", steps: [{ type: "click" }] });
  expect(bad.status).toBe(422);
  const unsafePointer = await call("alice", "POST", "/prototypes/scenario-proto/scenarios", { name: "Bad", steps: [{ type: "setState", pointer: "/__proto__/x", value: 1 }] });
  expect(unsafePointer.status).toBe(422);
  const emptySteps = await call("alice", "POST", "/prototypes/scenario-proto/scenarios", { name: "Bad", steps: [] });
  expect(emptySteps.status).toBe(422);
});

test("the per-prototype scenario limit is enforced", async () => {
  const { call, doc } = await fixture();
  const screenId = doc("x").screens[0]!.id;
  for (let index = 0; index < SCENARIOS_PER_PROTOTYPE_LIMIT; index += 1) {
    const response = await call("alice", "POST", "/prototypes/scenario-proto/scenarios", { id: `s-${index}`, name: `S${index}`, steps: steps(screenId) });
    expect(response.status).toBe(201);
  }
  const overflow = await call("alice", "POST", "/prototypes/scenario-proto/scenarios", { id: "s-overflow", name: "Overflow", steps: steps(screenId) });
  expect(overflow.status).toBe(422);
});

test("the interactions gate reports scenarios without ever running them or blocking", async () => {
  const { db, dir, call, doc } = await fixture();
  const before = await computeReadiness(db, "scenario-proto", { dataDir: dir });
  const gate = (report: Awaited<ReturnType<typeof computeReadiness>>) => report.gates.find((item) => item.id === "interactions")!;
  expect(gate(before)).toMatchObject({ status: "unknown", summary: "no_scenarios", scenarioCount: 0 });
  expect(before.blocking).toEqual([]);

  await call("alice", "POST", "/prototypes/scenario-proto/scenarios", { id: "happy", name: "Happy", steps: steps(doc("x").screens[0]!.id) });
  const after = await computeReadiness(db, "scenario-proto", { dataDir: dir });
  expect(gate(after)).toMatchObject({ status: "pass", summary: "scenarios_recorded", scenarioCount: 1 });

  // Даже включённый в конфиг гейт остаётся неблокирующим при `unknown`.
  const strict = await computeReadiness(db, "scenario-proto", { dataDir: dir, gates: { interactions: "warn" } });
  expect(strict.blocking).toEqual([]);
  expect(strict.publishable).toBe(true);
});

test("deleting a prototype removes its scenarios", async () => {
  const { db, call, doc } = await fixture();
  await call("alice", "POST", "/prototypes/scenario-proto/scenarios", { id: "happy", name: "Happy", steps: steps(doc("x").screens[0]!.id) });
  const head = db.query("SELECT head_rev rev FROM prototypes WHERE id='scenario-proto'").get() as { rev: number };
  const deleted = await call("alice", "DELETE", "/prototypes/scenario-proto", { baseRev: head.rev });
  expect(deleted.status).toBe(204);
  expect(db.query("SELECT COUNT(*) count FROM prototype_scenarios").get()).toEqual({ count: 0 });
});
