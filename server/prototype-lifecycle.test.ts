import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { createHandler } from "./main";
import { createTestHandler } from "./test-auth";
import { UserRepo } from "./users";
import { prototypeDocSchema, type PrototypeDoc } from "../src/prototype/schema";

// Волна 0: lifecycle-метаданные прототипа (kind/tags/derivedFrom, миграция v16).

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fixture() {
  const dir = await mkdtemp(resolve(process.cwd(), ".lifecycle-test-")); dirs.push(dir);
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
  return { db, call, doc };
}

describe("prototype lifecycle metadata", () => {
  test("defaults to product-flow, accepts lifecycle on create and exposes it in list/meta", async () => {
    const { call, doc } = await fixture();
    expect((await call("alice", "POST", "/prototypes", { doc: doc("plain") })).status).toBe(201);
    const created = await call("alice", "POST", "/prototypes", {
      doc: doc("fixture-proto"), kind: "composition-fixture", tags: ["ctyp", "payment-success"], derivedFrom: "plain",
    });
    expect(created.status).toBe(201);

    const list = await (await call("alice", "GET", "/prototypes")).json() as { id: string; kind: string; tags: string[]; derivedFrom: string | null }[];
    expect(list.find((row) => row.id === "plain")).toMatchObject({ kind: "product-flow", tags: [], derivedFrom: null });
    expect(list.find((row) => row.id === "fixture-proto")).toMatchObject({ kind: "composition-fixture", tags: ["ctyp", "payment-success"], derivedFrom: "plain" });

    const meta = await (await call("alice", "GET", "/prototypes/fixture-proto")).json() as { kind: string; tags: string[]; derivedFrom: string | null };
    expect(meta).toMatchObject({ kind: "composition-fixture", tags: ["ctyp", "payment-success"], derivedFrom: "plain" });
  });

  test("patches kind/tags/derivedFrom additively and clears the lineage with null", async () => {
    const { call, doc } = await fixture();
    await call("alice", "POST", "/prototypes", { doc: doc("p1"), kind: "evidence", tags: ["proof"], derivedFrom: "source" });

    const kindOnly = await call("alice", "POST", "/prototypes/p1/lifecycle", { kind: "experiment" });
    expect(kindOnly.status).toBe(200);
    // Отсутствующие поля патча не трогаются.
    expect(await kindOnly.json()).toEqual({ kind: "experiment", tags: ["proof"], derivedFrom: "source" });

    const cleared = await call("alice", "POST", "/prototypes/p1/lifecycle", { tags: [], derivedFrom: null });
    expect(await cleared.json()).toEqual({ kind: "experiment", tags: [], derivedFrom: null });

    // Пустой патч — чистый read-back.
    expect(await (await call("alice", "POST", "/prototypes/p1/lifecycle", {})).json()).toEqual({ kind: "experiment", tags: [], derivedFrom: null });
  });

  test("rejects unknown kinds, malformed tags and self-lineage", async () => {
    const { call, doc } = await fixture();
    await call("alice", "POST", "/prototypes", { doc: doc("p1") });
    for (const body of [{ kind: "archived" }, { tags: ["Bad Tag"] }, { unknown: 1 }, { tags: Array.from({ length: 17 }, (_, index) => `tag-${index}`) }]) {
      const response = await call("alice", "POST", "/prototypes/p1/lifecycle", body);
      expect([response.status, (await response.json() as { error: { code: string } }).error.code]).toEqual([422, "validation_failed"]);
    }
    expect((await call("alice", "POST", "/prototypes/p1/lifecycle", { derivedFrom: "p1" })).status).toBe(422);
    // Невалидный kind на создании тоже отвергается — строка в БД не появляется.
    expect((await call("alice", "POST", "/prototypes", { doc: doc("p2"), kind: "nope" })).status).toBe(422);
    expect((await call("alice", "GET", "/prototypes/p2")).status).toBe(404);
  });

  test("is owner-only and reports a typed 404 for a missing prototype", async () => {
    const { call, doc } = await fixture();
    await call("alice", "POST", "/prototypes", { doc: doc("p1") });
    await call("alice", "POST", "/prototypes/p1/status", { status: "published" });
    expect((await call("bob", "POST", "/prototypes/p1/lifecycle", { kind: "evidence" })).status).toBe(403);
    expect((await call("alice", "GET", "/prototypes/p1")).status).toBe(200);
    const missing = await call("alice", "POST", "/prototypes/missing/lifecycle", { kind: "evidence" });
    expect([missing.status, (await missing.json() as { error: { code: string } }).error.code]).toEqual([404, "prototype_not_found"]);
    expect((await call("alice", "GET", "/prototypes/p1/lifecycle")).status).toBe(405);
  });

  test("filters the listing by a CSV ?kind= parameter", async () => {
    const { call, doc } = await fixture();
    await call("alice", "POST", "/prototypes", { doc: doc("flow") });
    await call("alice", "POST", "/prototypes", { doc: doc("gallery"), kind: "component-gallery" });
    await call("alice", "POST", "/prototypes", { doc: doc("lab"), kind: "experiment" });
    const ids = async (query: string) => ((await (await call("alice", "GET", `/prototypes${query}`)).json()) as { id: string }[]).map((row) => row.id).sort();

    expect(await ids("")).toEqual(["flow", "gallery", "lab"]);
    expect(await ids("?kind=component-gallery")).toEqual(["gallery"]);
    expect(await ids("?kind=component-gallery,experiment")).toEqual(["gallery", "lab"]);
    // Пустое значение читается как «фильтра нет» (совместимость со старыми клиентами).
    expect(await ids("?kind=")).toEqual(["flow", "gallery", "lab"]);
    expect((await call("alice", "GET", "/prototypes?kind=nope")).status).toBe(422);
  });
});
