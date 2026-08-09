/**
 * BR-09 (план `docs/plans/2026-08-08-blocker-removal-eui-br.md` §9): kill-switch **записи** документа
 * с `elements[].overflowOwnership`.
 *
 * Поле — персистируемая форма в строгом allowlist: документ с ним старый образ не прочитает вовсе
 * (`strictObject` ⇒ 422). Поэтому запись гейтится тумблером группы, а **чтение** сохранённого
 * документа не гейтится никогда — тот же канон, что у `doc.surfaces` (D16): иначе откат образа
 * превращал бы уже сохранённые прототипы в нечитаемые.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { createHandler } from "./main";
import { createTestHandler } from "./test-auth";
import { UserRepo } from "./users";

const dirs: string[] = [];
const previous = process.env.EASYUI_GEOMETRY_OWNERSHIP_DISABLED;
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  if (previous === undefined) delete process.env.EASYUI_GEOMETRY_OWNERSHIP_DISABLED;
  else process.env.EASYUI_GEOMETRY_OWNERSHIP_DISABLED = previous;
});

const image = { type: "Image", props: { src: "https://example.com/fixture.png", alt: "Fixture" } };

const railDoc = (id: string, declared: boolean) => ({
  version: 1, id, name: id, designSystem: "yandex-pay", device: "mobile", startScreen: "home", state: {},
  screens: [{
    id: "home", name: "Home",
    spec: {
      root: "rail",
      elements: {
        rail: {
          ...image,
          ...(declared ? { overflowOwnership: { axis: "x", mode: "scroll", expectedContentOverflow: true } } : {}),
        },
      },
    },
  }],
});

async function fixture() {
  const dir = await mkdtemp(resolve(process.cwd(), ".overflow-own-test-")); dirs.push(dir);
  const db = openDatabase(":memory:"); createTestHandler(db, { dataDir: dir });
  db.query("INSERT INTO users (id,name,password_hash,is_admin,created_at) VALUES (?,?,?,?,?)")
    .run("user_alice", "Alice", "unused", 0, new Date().toISOString());
  const token = new UserRepo(db).createSession("user_alice").token;
  const handler = createHandler(db, { dataDir: dir, publicOrigin: "http://test" });
  const call = (method: string, path: string, body?: unknown) => handler(new Request(`http://test/api${path}`, {
    method,
    headers: {
      cookie: `easyui_session=${token}`,
      ...(method === "GET" ? {} : { origin: "http://test", "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { call };
}

test("BR-09: под kill-switch'ем документ с overflowOwnership отвергается 422, соседний — нет", async () => {
  process.env.EASYUI_GEOMETRY_OWNERSHIP_DISABLED = "1";
  const { call } = await fixture();
  const refused = await call("POST", "/prototypes", { doc: railDoc("rail", true) });
  expect(refused.status).toBe(422);
  expect((await refused.json() as { error: { code: string } }).error.code).toBe("flow_overflow_ownership_disabled");
  // Строки в БД не появилось, а документ без декларации не затронут вовсе.
  expect((await call("GET", "/prototypes/rail")).status).toBe(404);
  expect((await call("POST", "/prototypes", { doc: railDoc("plain", false) })).status).toBe(201);
});

test("BR-09: при снятом свитче декларация переживает round-trip, а чтение не гейтится никогда", async () => {
  delete process.env.EASYUI_GEOMETRY_OWNERSHIP_DISABLED;
  const { call } = await fixture();
  expect((await call("POST", "/prototypes", { doc: railDoc("rail", true) })).status).toBe(201);
  const draft = await (await call("GET", "/prototypes/rail/draft")).json() as {
    doc: { screens: { spec: { elements: Record<string, { overflowOwnership?: unknown }> } }[] };
  };
  expect(draft.doc.screens[0]!.spec.elements.rail!.overflowOwnership)
    .toEqual({ axis: "x", mode: "scroll", expectedContentOverflow: true });
  // Откат тумблера не должен превращать сохранённый документ в нечитаемый.
  process.env.EASYUI_GEOMETRY_OWNERSHIP_DISABLED = "1";
  expect((await call("GET", "/prototypes/rail/draft")).status).toBe(200);
});
