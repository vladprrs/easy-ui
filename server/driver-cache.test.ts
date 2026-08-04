// Клиентский кэш драйвера (план 2026-08-03 §5 W7, P1.3). Тест живёт рядом с
// `server/driver-cli.test.ts` — единственным местом, где харнес-драйвер прогоняется настоящим
// процессом: `test/` не входит ни в один include (vitest берёт только `src/**`), поэтому
// заявленный планом `test/driver-cache.test.ts` не запускался бы ничем.
//
// Проверяется контракт W7: hit/miss/refresh, изоляция учёток в ключе, стабильность ключа при
// перестановке query, отсутствие секретов на диске, sha-контроль blob'а, права 0700 и правило
// «терминальный ран кэшируется, running — нет».
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHandler } from "./main";
import { openDatabase } from "./db";
import { ensureBootstrapAdmin } from "./users";
import {
  canonicalJson,
  classify,
  extractFingerprints,
  identityHash,
  openCache,
  requestKey,
  safeSegment,
  sortedQuery,
  TERMINAL_RUN_STATUSES,
} from "../.claude/skills/author/cache.mjs";

const driver = resolve(".claude/skills/author/driver.mjs");
const servers: Bun.Server<unknown>[] = [];
const directories: string[] = [];
const databases: ReturnType<typeof openDatabase>[] = [];
let sessionFile = "";

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  sessionFile = "";
});

async function testDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(process.cwd(), ".driver-cache-test-"));
  directories.push(directory);
  sessionFile = resolve(directory, "session.json");
  return directory;
}

const key = (over: Record<string, unknown> = {}) => requestKey({
  identity: identityHash("http://localhost/api", "alice"),
  method: "GET", path: "/catalog/manifest", query: [], bodyHash: null, apiVersion: "1", ...over,
});

describe("cache key", () => {
  test("не зависит от порядка параметров query", () => {
    const one = key({ query: sortedQuery("designSystem=yp&limit=5") });
    const two = key({ query: sortedQuery("limit=5&designSystem=yp") });
    expect(one).toBe(two);
    expect(one).not.toBe(key({ query: sortedQuery("designSystem=yp&limit=6") }));
  });

  test("изолирует учётки: другая identity — другой ключ", () => {
    const alice = key();
    const bob = key({ identity: identityHash("http://localhost/api", "bob") });
    const other = key({ identity: identityHash("https://prod/api", "alice") });
    expect(new Set([alice, bob, other]).size).toBe(3);
  });

  test("меняется вместе с apiVersion, методом, путём и телом", () => {
    const keys = new Set([
      key(), key({ apiVersion: "2" }), key({ method: "POST" }), key({ path: "/capabilities" }), key({ bodyHash: "abc" }),
    ]);
    expect(keys.size).toBe(5);
  });

  test("canonicalJson сортирует ключи объектов", () => {
    expect(canonicalJson({ b: 1, a: [3, { d: 4, c: 5 }] })).toBe('{"a":[3,{"c":5,"d":4}],"b":1}');
  });
});

describe("cache policy", () => {
  test("кэширует только read-only GET'ы из allowlist'а", () => {
    expect(classify("GET", "/capabilities")?.mode).toBe("fresh");
    expect(classify("GET", "/catalog/manifest?designSystem=yp")?.mode).toBe("fresh");
    expect(classify("GET", "/case-sets/cs_1")?.mode).toBe("immutable");
    // Кандидат приёмки — `fresh`, а не `immutable` (план 2026-08-04 W3, C22): его строка
    // мутабельна (`status`/`acceptanceRunId`/`runs[]`), тёплый кэш иначе прятал бы новые раны.
    expect(classify("GET", "/component-candidates/cand_1")).toMatchObject({ mode: "fresh" });
    expect(classify("GET", "/component-candidates/cand_1")?.ttlMs).toBeGreaterThan(0);
    expect(classify("GET", "/components/a/versions/3")?.mode).toBe("immutable");
    expect(classify("GET", "/acceptance-runs/run_1")?.terminalOnly).toBe(true);
    expect(classify("GET", "/acceptance-runs/run_1/evidence")?.kind).toBe("blob");
    // Мутации и «живые» ручки — никогда.
    expect(classify("POST", "/acceptance-runs")).toBeNull();
    expect(classify("POST", "/components/a/candidates")).toBeNull();
    expect(classify("GET", "/auth/login")).toBeNull();
    expect(classify("GET", "/prototypes/p/draft")).toBeNull();
  });

  test("safeSegment отвергает обход каталога", () => {
    expect(() => safeSegment("..")).toThrow();
    expect(() => safeSegment("a/b")).toThrow();
    expect(() => safeSegment("/abs")).toThrow();
    expect(safeSegment("accept")).toBe("accept");
  });

  test("фингерпринты вытаскиваются из ответа", () => {
    expect(extractFingerprints({ catalogRevision: "r7", cases: [{ caseFingerprint: "f1" }, {}] }))
      .toEqual({ catalogRevision: "r7", caseFingerprints: ["f1"] });
  });
});

async function cacheDir() {
  const directory = await testDirectory();
  return join(directory, "cache");
}

describe("cache store", () => {
  test("hit/miss/refresh и права 0700", async () => {
    const dir = await cacheDir();
    const cache = await openCache({ dir, baseUrl: "http://localhost/api", user: "alice" });
    expect((await stat(dir)).mode & 0o777).toBe(0o700);

    expect(await cache.read("GET", "/case-sets/cs_1")).toBeNull();
    expect(cache.summary().status).toBe("miss");
    await cache.write("GET", "/case-sets/cs_1", undefined, { status: 200, json: { caseSetId: "cs_1", caseCount: 49 } });

    const warm = await openCache({ dir, baseUrl: "http://localhost/api", user: "alice" });
    const hit = await warm.read("GET", "/case-sets/cs_1");
    expect(hit?.json).toEqual({ caseSetId: "cs_1", caseCount: 49 });
    expect(warm.summary().status).toBe("hit");

    const forced = await openCache({ dir, baseUrl: "http://localhost/api", user: "alice", refresh: true });
    expect(await forced.read("GET", "/case-sets/cs_1")).toBeNull();
    expect(forced.summary().status).toBe("refresh");
    await forced.write("GET", "/case-sets/cs_1", undefined, { status: 200, json: { caseSetId: "cs_1", caseCount: 50 } });
    const entries = await readdir(join(dir, "requests"));
    const refreshed = JSON.parse(await readFile(join(dir, "requests", entries[0]!), "utf8"));
    expect(refreshed.refreshReason).toBe("flag:--cache-refresh");
  });

  test("чужая учётка не читает ответы соседа в общем каталоге", async () => {
    const dir = await cacheDir();
    const alice = await openCache({ dir, baseUrl: "http://localhost/api", user: "alice" });
    await alice.write("GET", "/case-sets/cs_1", undefined, { status: 200, json: { secretToAlice: true } });
    const bob = await openCache({ dir, baseUrl: "http://localhost/api", user: "bob" });
    expect(await bob.read("GET", "/case-sets/cs_1")).toBeNull();
    expect(await (await openCache({ dir, baseUrl: "http://localhost/api", user: "alice" })).read("GET", "/case-sets/cs_1")).not.toBeNull();
  });

  test("подмена blob'а ловится SHA256SUMS и даёт miss", async () => {
    const dir = await cacheDir();
    const cache = await openCache({ dir, baseUrl: "http://localhost/api", user: "alice" });
    await cache.write("GET", "/acceptance-runs/run_1/evidence", undefined, { status: 200, bytes: Buffer.from("PK-evidence"), contentType: "application/zip" });
    const warm = await openCache({ dir, baseUrl: "http://localhost/api", user: "alice" });
    expect((await warm.read("GET", "/acceptance-runs/run_1/evidence"))?.bytes?.toString()).toBe("PK-evidence");

    const blobs = await readdir(join(dir, "blobs"));
    await writeFile(join(dir, "blobs", blobs[0]!), "tampered");
    const tampered = await openCache({ dir, baseUrl: "http://localhost/api", user: "alice" });
    expect(await tampered.read("GET", "/acceptance-runs/run_1/evidence")).toBeNull();
    expect(tampered.summary().reason).toBe("blob checksum mismatch");
  });

  test("терминальный ран кэшируется, running — нет", async () => {
    const dir = await cacheDir();
    const cache = await openCache({ dir, baseUrl: "http://localhost/api", user: "alice" });
    await cache.write("GET", "/acceptance-runs/run_live", undefined, { status: 200, json: { runId: "run_live", status: "running" } });
    await cache.write("GET", "/acceptance-runs/run_done", undefined, { status: 200, json: { runId: "run_done", status: "fail" } });
    const warm = await openCache({ dir, baseUrl: "http://localhost/api", user: "alice" });
    expect(await warm.read("GET", "/acceptance-runs/run_live")).toBeNull();
    expect((await warm.read("GET", "/acceptance-runs/run_done"))?.json).toMatchObject({ status: "fail" });
    expect([...TERMINAL_RUN_STATUSES]).toContain("fail");
  });

  test("протухшая запись изменяемого ответа не отдаётся", async () => {
    const dir = await cacheDir();
    let clock = Date.parse("2026-08-03T10:00:00.000Z");
    const cache = await openCache({ dir, baseUrl: "http://localhost/api", user: "alice", now: () => clock });
    await cache.write("GET", "/capabilities", undefined, { status: 200, json: { apiVersion: 1 } });
    expect(await cache.read("GET", "/capabilities")).not.toBeNull();
    clock += 10 * 60 * 1000;
    expect(await cache.read("GET", "/capabilities")).toBeNull();
    expect(cache.summary().reason).toBe("stale");
  });

  test("receipts и links пишутся под контроль sha", async () => {
    const dir = await cacheDir();
    const cache = await openCache({ dir, baseUrl: "http://localhost/api", user: "alice" });
    await cache.receipt("accept", "run_1", { runId: "run_1", status: "pass" });
    await cache.link({ candidateId: "cand_1", runId: "run_1", cases: [{ caseId: "alpha", caseFingerprint: "f1" }] });
    expect(JSON.parse(await readFile(join(dir, "receipts", "accept", "run_1.json"), "utf8")).status).toBe("pass");
    const links = JSON.parse(await readFile(join(dir, "links.json"), "utf8"));
    expect(links.links[0].runId).toBe("run_1");
    const sums = await readFile(join(dir, "SHA256SUMS"), "utf8");
    expect(sums).toContain("links.json");
    expect(sums).toContain("receipts/accept/run_1.json");
  });
});

/** Настоящий сервер + настоящий процесс драйвера: считаем HTTP-запросы до и после кэша. */
async function setup() {
  const directory = await testDirectory();
  const db = openDatabase(":memory:");
  databases.push(db);
  await ensureBootstrapAdmin(db, { name: "Cache Admin", password: "cache-test-password" });
  const handler = createHandler(db, { dataDir: directory });
  const paths: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, bunServer) => {
      const url = new URL(request.url);
      if (url.pathname !== "/api/auth/login") paths.push(`${request.method} ${url.pathname}`);
      return handler(request, bunServer);
    },
  });
  servers.push(server);
  return { db, directory, api: `http://127.0.0.1:${server.port}/api`, paths };
}

async function run(api: string, args: string[], extraEnv: Record<string, string> = {}) {
  const child = Bun.spawn({
    cmd: ["node", driver, ...args],
    cwd: process.cwd(),
    env: {
      ...process.env,
      EASYUI_API: api,
      EASYUI_LEGACY_BASIC_AUTH: extraEnv.EASYUI_LEGACY_BASIC_AUTH ?? "",
      EASYUI_USERNAME: "Cache Admin",
      EASYUI_PASSWORD: "cache-test-password",
      EASYUI_SESSION_FILE: sessionFile,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("driver.mjs --cache-dir", () => {
  test("повторная команда обслуживается кэшем и не ходит на сервер", async () => {
    const { api, directory, paths } = await setup();
    const dir = join(directory, "cache");
    const first = await run(api, ["catalog", "list", "yandex-pay", "--json", "--cache-dir", dir]);
    expect([first.exitCode, first.stderr]).toEqual([0, ""]);
    expect(JSON.parse(first.stdout).cache.status).toBe("miss");
    const afterCold = paths.length;
    expect(afterCold).toBeGreaterThan(0);

    const second = await run(api, ["catalog", "list", "yandex-pay", "--json", "--cache-dir", dir]);
    const warm = JSON.parse(second.stdout);
    expect(warm.cache.status).toBe("hit");
    expect(warm.components).toEqual(JSON.parse(first.stdout).components);
    expect(paths.length).toBe(afterCold);

    const refreshed = await run(api, ["catalog", "list", "yandex-pay", "--json", "--cache-dir", dir, "--cache-refresh"]);
    expect(JSON.parse(refreshed.stdout).cache.status).toBe("refresh");
    expect(paths.length).toBeGreaterThan(afterCold);
  });

  test("в файлах кэша нет ни Authorization, ни Cookie, ни пароля", async () => {
    const { api, directory } = await setup();
    const dir = join(directory, "cache");
    await run(api, ["catalog", "list", "yandex-pay", "--json", "--cache-dir", dir]);
    const files: string[] = [];
    const walk = async (path: string) => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) await walk(full);
        else files.push(full);
      }
    };
    await walk(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = (await readFile(file)).toString("utf8").toLowerCase();
      for (const secret of ["authorization", "cookie", "easyui_session", "cache-test-password", "set-cookie"]) {
        expect(text.includes(secret)).toBe(false);
      }
    }
  });

  test("legacy-Basic выключает кэш: каталог не создаётся, статус off", async () => {
    const { api, directory } = await setup();
    const dir = join(directory, "cache");
    const result = await run(api, ["catalog", "list", "yandex-pay", "--json", "--cache-dir", dir], { EASYUI_LEGACY_BASIC_AUTH: "user:pass" });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).cache).toEqual({ status: "off", reason: "LEGACY_BASIC_AUTH" });
    expect(await readdir(dir).catch(() => null)).toBeNull();
  });

  test("без --cache-dir поведение прежнее: кэш off", async () => {
    const { api, paths } = await setup();
    const first = await run(api, ["catalog", "list", "yandex-pay", "--json"]);
    const cold = paths.length;
    const second = await run(api, ["catalog", "list", "yandex-pay", "--json"]);
    expect(JSON.parse(first.stdout).cache.status).toBe("off");
    expect(JSON.parse(second.stdout).cache.status).toBe("off");
    expect(paths.length).toBe(cold * 2);
  });
});
