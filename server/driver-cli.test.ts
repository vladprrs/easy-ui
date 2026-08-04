import { createTestHandler } from "./test-auth";
import { createHandler } from "./main";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createEasyUiClient } from "../scripts/easyui-auth.mjs";
import type { Database } from "bun:sqlite";
import { openDatabase } from "./db";
import { ensureBootstrapAdmin } from "./users";
import { prototypeDocSchema, type PrototypeDoc } from "../src/prototype/schema";
import { ScreenshotService, type RunJob, type WorkerJob } from "./screenshot/service";
import { ReuseDecisionRepo } from "./repos/reuseDecisions";
import {
  assertViewportPixelBudget,
  auditExitCode,
  auditFindings,
  auditRows,
  versionAuditFindings,
  versionAuditLines,
  versionAuditRows,
  reuseAuditLines,
  failingGates,
  readinessExitCode,
  snapExitCode,
  rendererPreflightWarning,
  captureCodes,
  captureReceiptEvidence,
  summarizeCapture,
  analyzeGeometryGaps,
  buildBaselineMembers,
  buildBaselinePlan,
  parseDiffArguments,
  parseArgs,
  previewDraftOutputPath,
  previewOutputPath,
  DEFAULT_EXPECT_TOLERANCE,
  evaluateExpectations,
  expectExitCode,
  expectLines,
  observedGaps,
  observedPadding,
  parseExpectations,
  readGeometryRects,
  resolveViewport,
  buildSnapPlan,
  screenDesignSystem,
  screenDevice,
  type DriverReadinessGate,
} from "../.claude/skills/author/driver.mjs";

// W7: `--json`-отчёт всегда несёт статус клиентского кэша; без `--cache-dir` он выключен.
const CACHE_OFF = { status: "off", reason: "no --cache-dir" };
const driver = resolve(".claude/skills/author/driver.mjs");
const servers: Bun.Server<unknown>[] = [];
const directories: string[] = [];
const databases: ReturnType<typeof openDatabase>[] = [];
/** Кэш сессии драйвера всегда живёт в каталоге теста: сабпроцесс наследует env разработчика. */
let sessionFile = "";

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  sessionFile = "";
  delete process.env.EASYUI_SESSION_FILE;
  delete process.env.EASYUI_SESSION_CACHE;
});

async function testDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(process.cwd(), ".driver-cli-test-"));
  directories.push(directory);
  sessionFile = resolve(directory, "session.json");
  return directory;
}

/** Прямой `createHandler` (без admin-cookie из `createTestHandler`) плюс счётчик логинов. */
async function setupCounted(legacyBasicAuth?: string) {
  const directory = await testDirectory();
  const db = openDatabase(":memory:");
  databases.push(db);
  await ensureBootstrapAdmin(db, { name: "Driver Admin", password: "driver-test-password" });
  const handler = createHandler(db, { dataDir: directory, legacyBasicAuth });
  let logins = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, bunServer) => {
      if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/login") logins += 1;
      return handler(request, bunServer);
    },
  });
  servers.push(server);
  return { db, directory, api: `http://127.0.0.1:${server.port}/api`, logins: () => logins };
}

async function writeSessionCache(api: string, cookie: string, username = "Driver Admin") {
  await writeFile(sessionFile, JSON.stringify({ cookie, apiBase: api, username, savedAt: new Date().toISOString() }));
}

/** Валидный по форме (`[A-Za-z0-9_-]{43}`), но неизвестный серверу токен сессии. */
function staleCookie(marker: string) {
  return `easyui_session=${(marker + "x".repeat(43)).slice(0, 43)}`;
}

async function setup(legacyBasicAuth?: string, runJob?: RunJob, handlerOptions: { acceptanceDisabled?: boolean } = {}) {
  const directory = await testDirectory();
  const db = openDatabase(":memory:");
  databases.push(db);
  await ensureBootstrapAdmin(db, { name: "Driver Admin", password: "driver-test-password" });
  const screenshots = runJob
    ? new ScreenshotService({ db, dataDir: directory, serveDist: "dist", captureOrigin: "http://127.0.0.1:8787", chromiumAvailable: true, runJob })
    : undefined;
  const handler = createTestHandler(db, { dataDir: directory, legacyBasicAuth, screenshots, ...handlerOptions });
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, bunServer) => { requests += 1; return handler(request, bunServer); },
  });
  servers.push(server);
  return { db, directory, api: `http://127.0.0.1:${server.port}/api`, requests: () => requests };
}

/** Worker stub: one PNG per call, recording the full job so surface flags can be asserted. */
function pngRunJob(consoleErrors: string[] = [], pageErrors: string[] = []): { runJob: RunJob; calls: () => number; jobs: () => WorkerJob[] } {
  let calls = 0;
  const jobs: WorkerJob[] = [];
  const runJob: RunJob = async (job) => {
    calls += 1;
    jobs.push(job);
    return { ok: true, pngBase64: Buffer.from(png()).toString("base64"), width: 2, height: 3, consoleErrors, pageErrors, browserVersion: "test/1" };
  };
  return { runJob, calls: () => calls, jobs: () => jobs };
}

async function saveDoc(api: string, doc: PrototypeDoc) {
  const response = await fetch(`${api}/prototypes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ doc, message: "snap fixture" }),
  });
  expect(response.status).toBe(201);
}

/** Экран-стикершит: canvas задаёт и поверхность съёмки, и дефолтный вьюпорт snap/geometry. */
async function canvasDoc(id: string, width: number, height: number): Promise<PrototypeDoc> {
  const base = await fixture(id);
  return { ...base, screens: [{ ...base.screens[0]!, canvas: { width, height } }] };
}

async function twoScreenDoc(id: string): Promise<PrototypeDoc> {
  const base = await fixture(id);
  const first = base.screens[0]!;
  return { ...base, screens: [first, { ...first, id: "second" }] };
}

async function run(api: string, args: string[], legacyBasicAuth = "", extraEnv: Record<string, string> = {}) {
  const child = Bun.spawn({
    cmd: ["node", driver, ...args],
    cwd: process.cwd(),
    env: {
      ...process.env,
      EASYUI_API: api,
      EASYUI_LEGACY_BASIC_AUTH: legacyBasicAuth,
      EASYUI_USERNAME: "Driver Admin",
      EASYUI_PASSWORD: "driver-test-password",
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

async function writeComponentSource(directory: string, name: string, description: string, marker: string): Promise<string> {
  const path = resolve(directory, `${name}-${marker}.tsx`);
  await Bun.write(path, `import { z } from "zod";
export const definition = { props: z.strictObject({ label: z.string().optional() }), description: ${JSON.stringify(description)}, atomicLevel: "atom" as const, events: ["press"], slots: [] };
export default function ${name}({ props }: any) { return <button data-marker=${JSON.stringify(marker)}>{props.label ?? ${JSON.stringify(marker)}}</button>; }
`);
  return path;
}

async function fixture(id: string): Promise<PrototypeDoc> {
  const value = prototypeDocSchema.parse(await Bun.file("test/fixtures/host-content.json").json());
  return { ...value, id, name: "First" };
}

async function createThreeRevisions(api: string, id = "driver-diff") {
  const first = await fixture(id);
  let response = await fetch(`${api}/prototypes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ doc: first, message: "one" }),
  });
  expect(response.status).toBe(201);
  const second = { ...first, name: "Second" };
  response = await fetch(`${api}/prototypes/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRev: 1, doc: second, message: "two" }),
  });
  expect(response.status).toBe(200);
  const third = { ...second, description: "Third" };
  response = await fetch(`${api}/prototypes/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRev: 2, doc: third, message: "three" }),
  });
  expect(response.status).toBe(200);
}

/**
 * Замер строки из двух детей: контейнер 328x56, паддинги 16/12, наблюдаемый зазор 6 px
 * (в макете — 8). Фикстура общая для юнит- и CLI-тестов верба `expect` (план P4).
 */
function expectFixtureRects() {
  return [
    { key: "stack", instance: 0, domIndex: 0, x: 0, y: 0, width: 328, height: 56, layoutContext: { display: "flex", flexDirection: "row", flexWrap: "nowrap", rowGap: "8px", columnGap: "8px" } },
    { key: "a", instance: 0, parentKey: "stack", parentInstance: 0, domIndex: 1, x: 16, y: 12, width: 145, height: 32, layoutContext: null },
    { key: "b", instance: 0, parentKey: "stack", parentInstance: 0, domIndex: 2, x: 167, y: 12, width: 145, height: 32, layoutContext: null },
  ];
}

function png(width = 2, height = 3): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(bytes.buffer).setUint32(16, width, false);
  new DataView(bytes.buffer).setUint32(20, height, false);
  return bytes;
}

describe("author driver CLI", () => {
  test("logs in and reaches the API through the legacy Basic barrier", async () => {
    const { api } = await setup("edge:secret");
    const result = await run(api, ["get", "prototypes"], "edge:secret");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  test("catalog list is compact while legacy --full preserves definition details", async () => {
    const { api, db } = await setup();
    seedComponent(db, "catalog-card", "CatalogCard", {
      deprecated: true,
      description: "Compact catalog card",
      events: ["select"],
      slots: ["body"],
      atomicLevel: "molecule",
    });
    const valid = await run(api, ["catalog", "yandex-pay"]);
    expect(valid.exitCode).toBe(0);
    const compact = JSON.parse(valid.stdout);
    expect(compact).toMatchObject({
      designSystem: { id: "yandex-pay", resolvedSpaceScale: { none: "0px", md: "12px", "4xl": "64px" } },
      custom: [expect.objectContaining({ id: "catalog-card", name: "CatalogCard", version: 1, atomicLevel: "molecule", description: "Compact catalog card", events: ["select"], slots: ["body"], deprecated: true })],
      builtins: [],
      hostPrimitives: expect.arrayContaining([expect.objectContaining({
        name: "Overlay",
        atomicLevel: "atom",
        slots: ["default"],
      }), expect.objectContaining({ name: "Image" }), expect.objectContaining({ name: "Hotspot" })]),
    });
    expect(JSON.stringify(compact)).not.toContain("propsJsonSchema");

    const list = await run(api, ["catalog", "list", "yandex-pay", "--json"]);
    expect(list.exitCode).toBe(0);
    expect(JSON.parse(list.stdout)).toMatchObject({ command: "catalog list", designSystem: { id: "yandex-pay" }, hostPrimitives: expect.arrayContaining([expect.objectContaining({ name: "Overlay", events: [], slots: ["default"] })]) });
    expect(JSON.parse(list.stdout).custom).toEqual([expect.objectContaining({ id: "catalog-card", events: ["select"], slots: ["body"], deprecated: true })]);
    expect(JSON.stringify(JSON.parse(list.stdout))).not.toContain("propsJsonSchema");

    const full = await run(api, ["catalog", "yandex-pay", "--full"]);
    expect(full.exitCode).toBe(0);
    expect(JSON.parse(full.stdout).hostPrimitives.find((item: { name: string }) => item.name === "Overlay").propsJsonSchema).toMatchObject({ type: "object" });

    const missing = await run(api, ["catalog", "missing-system"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("get design-systems");
  });

  test("catalog search reports compact candidates and exits zero for a successful search", async () => {
    const { api, db } = await setup();
    seedComponent(db, "checkout-button", "CheckoutButton", {
      description: "Button that starts checkout payment for an order",
      events: ["press"],
      slots: ["icon"],
      atomicLevel: "atom",
    });

    const json = await run(api, ["catalog", "search", "yandex-pay", "--intent", "start checkout payment for order", "--limit", "1", "--json"]);
    expect(json.exitCode).toBe(0);
    const payload = JSON.parse(json.stdout) as { command: string; catalogRevision: string; candidates: { id: string; events?: string[] }[] };
    expect(payload).toMatchObject({ command: "catalog search", designSystem: "yandex-pay", candidates: [{ id: "checkout-button" }] });
    expect(payload.catalogRevision).toHaveLength(64);
    expect(JSON.stringify(payload)).not.toContain("propsJsonSchema");
    expect(JSON.stringify(payload)).not.toContain("not-for-list-or-search");

    const human = await run(api, ["catalog", "search", "yandex-pay", "--intent", "start checkout payment for order", "--limit", "1"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("checkout-button");
    expect(human.stdout).toContain("score");
  });

  /**
   * W9: `--kind composition` печатает три исхода workbench'а. Исход рекомендательный, поэтому
   * exit code остаётся нулевым — драйвер ничего не запрещает.
   */
  test("catalog search --kind composition печатает исход, объяснение и мэтчи", async () => {
    const { api, db, directory } = await setup();
    const doc = {
      version: 2, name: "OrderRow", description: "Строка заказа с иконкой и ценой", atomicLevel: "molecule",
      params: { title: { type: "string", required: true } }, slots: [],
      spec: {
        root: "root",
        elements: {
          root: { type: "Overlay", props: { className: "row" }, children: ["icon"] },
          icon: { type: "Image", props: { src: "a.png" } },
        },
      },
    };
    db.query("INSERT INTO compositions (id,name,head_rev,design_system,deleted_at,delete_reason,created_at,updated_at,owner_id) VALUES ('order-row','OrderRow',1,'yandex-pay',NULL,NULL,'now','now','user_admin')").run();
    db.query("INSERT INTO composition_revisions (composition_id,rev,doc,design_system,message,author,created_at) VALUES ('order-row',1,?,'yandex-pay',NULL,NULL,'now')").run(JSON.stringify(doc));

    const docPath = resolve(directory, "candidate.json");
    await writeFile(docPath, JSON.stringify({ ...doc, name: "OrderLine", description: "Ещё одна строка заказа с иконкой и ценой" }));

    const result = await run(api, ["catalog", "search", "yandex-pay", "--intent", "строка заказа с иконкой и ценой", "--kind", "composition", "--doc", docPath, "--json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { outcome: string; explanation: string; analyzerVerdict: string; matches: { kind: string; id: string }[] };
    expect(payload.outcome).toBe("build-composition");
    expect(payload.explanation).toContain("order-row");
    expect(payload.analyzerVerdict).toBe("composition");
    expect(payload.matches.some((match) => match.kind === "composition" && match.id === "order-row")).toBe(true);

    const human = await run(api, ["catalog", "search", "yandex-pay", "--intent", "строка заказа с иконкой и ценой", "--kind", "composition", "--doc", docPath]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("outcome: build-composition");
    expect(human.stdout).toContain("match\tcomposition\torder-row");

    // `--doc` без `--kind composition` — ошибка использования, а не молча проигнорированный флаг.
    const misuse = await run(api, ["catalog", "search", "yandex-pay", "--intent", "строка заказа", "--doc", docPath]);
    expect(misuse.exitCode).toBe(1);
    expect(misuse.stderr).toContain("--doc requires --kind composition");
  });

  test("catalog get returns exact version details for only the selected artifacts", async () => {
    const { api, db } = await setup();
    seedComponent(db, "chosen-card", "ChosenCard", {
      description: "Chosen card details",
      source: "export const chosenSourceMarker = true;",
      events: ["select"],
      slots: ["body"],
    });
    seedComponent(db, "other-card", "OtherCard", {
      description: "Unselected private catalog marker",
      source: "export const unselectedSourceMarker = true;",
    });

    const result = await run(api, ["catalog", "get", "yandex-pay", "chosen-card", "Overlay", "--json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { command: string; artifacts: { kind: string; id?: string; name: string; details: Record<string, unknown> }[] };
    expect(payload.command).toBe("catalog get");
    expect(payload.artifacts.map((artifact) => [artifact.kind, artifact.id ?? artifact.name])).toEqual([["custom", "chosen-card"], ["host", "Overlay"]]);
    expect(payload.artifacts[0]).toMatchObject({ name: "ChosenCard", details: { version: 1, source: "export const chosenSourceMarker = true;", description: "Chosen card details", events: ["select"], slots: ["body"] } });
    expect(payload.artifacts[1]!.details.propsJsonSchema).toBeDefined();
    expect(result.stdout).not.toContain("Unselected private catalog marker");
    expect(result.stdout).not.toContain("unselectedSourceMarker");
  });

  test("component requires intent only on create and performs early discovery only there", async () => {
    const { api, directory } = await setup();
    const createSource = await writeComponentSource(directory, "DriverIntentCard", "Card showing checkout intent details", "create");
    const missing = await run(api, ["component", "driver-intent-card", "DriverIntentCard", createSource, "--design-system", "yandex-pay"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("component create requires --intent");

    const created = await run(api, ["component", "driver-intent-card", "DriverIntentCard", createSource, "--design-system", "yandex-pay", "--intent", "Show checkout intent details in a reusable card", "--json"]);
    expect(created.exitCode).toBe(0);
    const createPayload = JSON.parse(created.stdout) as { command: string; version: number; discovery?: { catalogRevision: string; candidates: unknown[] } };
    expect(createPayload).toMatchObject({ command: "component", version: 1, discovery: { candidates: expect.any(Array) } });
    expect(createPayload.discovery?.catalogRevision).toHaveLength(64);

    const updateSource = await writeComponentSource(directory, "DriverIntentCard", "Updated checkout intent details", "update");
    const updated = await run(api, ["component", "driver-intent-card", "DriverIntentCard", updateSource, "--design-system", "yandex-pay", "--json"]);
    expect(updated.exitCode).toBe(0);
    expect(JSON.parse(updated.stdout)).toMatchObject({ command: "component", version: 2 });
    expect(JSON.parse(updated.stdout).discovery).toBeUndefined();
  });

  test("re-saving an identical source prints a human 400 and keeps the code in --json", async () => {
    const { api, directory } = await setup();
    const source = await writeComponentSource(directory, "DriverNoopCard", "Card exercising the no-op guard", "noop");
    const created = await run(api, ["component", "driver-noop-card", "DriverNoopCard", source, "--design-system", "yandex-pay", "--intent", "Exercise the no-op guard with a card", "--json"]);
    expect(created.exitCode).toBe(0);

    const repeat = await run(api, ["component", "driver-noop-card", "DriverNoopCard", source, "--design-system", "yandex-pay", "--json"]);
    expect(repeat.exitCode).toBe(1);
    expect(JSON.parse(repeat.stdout)).toMatchObject({ failed: true, status: 400, code: "invalid_request", retryable: false });
    expect(repeat.stderr).toContain("save failed (400 invalid_request): Component source and design system are unchanged");
    expect(repeat.stderr).toContain("nothing to save: the source is identical to the head revision");
    expect(repeat.stderr).not.toContain('"error"');
  }, 20_000); // одна публикация: extract+typecheck в подпроцессе

  test("component reuse rejection is a terminal STOP report with exit 2", async () => {
    const { api, db, directory } = await setup();
    const sourcePath = await writeComponentSource(directory, "DriverDuplicate", "Checkout payment duplicate card", "duplicate");
    seedComponent(db, "existing-duplicate", "ExistingDuplicate", {
      description: "Checkout payment duplicate card",
      source: await Bun.file(sourcePath).text(),
      atomicLevel: "atom",
      events: ["press"],
    });

    const result = await run(api, ["component", "driver-duplicate", "DriverDuplicate", sourcePath, "--design-system", "yandex-pay", "--intent", "Show checkout payment duplicate card", "--json"]);
    expect(result.exitCode).toBe(2);
    const payload = JSON.parse(result.stdout) as { command: string; created: boolean; stop: boolean; exitCode: number; code: string; decisionId: string | null; candidates: { id: string }[] };
    expect(payload).toMatchObject({ command: "component", created: false, stop: true, exitCode: 2, code: "component_reuse_required" });
    expect(payload.decisionId).toMatch(/^reuse_/);
    expect(payload.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ id: "existing-duplicate" })]));
    expect(result.stderr).toContain("STOP");
    expect((db.query("SELECT COUNT(*) count FROM components WHERE id='driver-duplicate'").get() as { count: number }).count).toBe(0);
  });

  test("component-move keeps its command identity in a canonical-role publish STOP", async () => {
    const { api, db, directory } = await setup();
    db.query("INSERT INTO design_systems (id,name,description,builtin_provider,created_at,updated_at,owner_id) VALUES ('move-source','Move source','Move source fixtures',NULL,'now','now','user_admin')").run();
    const sourcePath = resolve(directory, "MoveRoleOwner.tsx");
    const source = `import { z } from "zod";
export const definition = { props: z.strictObject({}), description: "Owns the payment success role", atomicLevel: "atom" as const, canonicalFor: ["payment-success"] };
export default function MoveRoleOwner() { return <div>move role owner</div>; }
`;
    await Bun.write(sourcePath, source);
    seedComponent(db, "existing-role-owner", "ExistingRoleOwner", { canonicalFor: ["payment-success"] });
    seedComponent(db, "moving-role-owner", "MoveRoleOwner", { designSystem: "move-source", source, canonicalFor: ["payment-success"] });

    const result = await run(api, ["component-move", "moving-role-owner", "--design-system", "yandex-pay", "--json"]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ command: "component-move", id: "moving-role-owner", stop: true, exitCode: 2, code: "canonical_role_conflict", draftSaved: true });
    const moved = await (await fetch(`${api}/components/moving-role-owner`)).json() as { headRev: number; designSystem: string };
    expect(moved).toMatchObject({ headRev: 2, designSystem: "yandex-pay" });
  });

  test("component --force-new sends fresh blocking material and records the human reason", async () => {
    const { api, db, directory } = await setup();
    const sourcePath = await writeComponentSource(directory, "DriverForcedDuplicate", "Forced checkout payment duplicate", "forced-duplicate");
    seedComponent(db, "existing-forced-duplicate", "ExistingForcedDuplicate", {
      description: "Forced checkout payment duplicate",
      source: await Bun.file(sourcePath).text(),
      atomicLevel: "atom",
      events: ["press"],
    });
    const missingReason = await run(api, ["component", "driver-forced-duplicate", "DriverForcedDuplicate", sourcePath, "--design-system", "yandex-pay", "--intent", "Show forced checkout payment duplicate", "--force-new"]);
    expect(missingReason.exitCode).toBe(1);
    expect(missingReason.stderr).toContain("--force-new requires --reason");

    const reason = "Product owner approved a distinct checkout treatment";
    const result = await run(api, ["component", "driver-forced-duplicate", "DriverForcedDuplicate", sourcePath, "--design-system", "yandex-pay", "--intent", "Show forced checkout payment duplicate", "--force-new", "--reason", reason, "--json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { forceNew: boolean; acknowledgedCandidateKeys: string[]; discovery: { catalogRevision: string } };
    expect(payload).toMatchObject({ forceNew: true, acknowledgedCandidateKeys: ["component:yandex-pay:existing-forced-duplicate"], version: 1 });
    expect(payload.discovery.catalogRevision).toHaveLength(64);
    const audit = db.query("SELECT decision,reason,catalog_revision FROM catalog_reuse_decisions WHERE artifact_id=? ORDER BY created_at DESC LIMIT 1").get("driver-forced-duplicate") as { decision: string; reason: string; catalog_revision: string };
    expect(audit).toMatchObject({ decision: "force_new", reason, catalog_revision: payload.discovery.catalogRevision });
  });

  test("component --force-new omits reuseOverride when the authoritative template is empty", async () => {
    const { api, db, directory } = await setup();
    const sourcePath = await writeComponentSource(directory, "DriverUniqueControl", "Unique account recovery control", "unique-recovery");

    const result = await run(api, ["component", "driver-unique-control", "DriverUniqueControl", sourcePath, "--design-system", "yandex-pay", "--intent", "Show a unique account recovery control", "--force-new", "--reason", "Approved only if a reuse exception is required", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "component",
      id: "driver-unique-control",
      forceNew: true,
      acknowledgedCandidateKeys: [],
      version: 1,
    });
    const audit = db.query("SELECT decision,reason FROM catalog_reuse_decisions WHERE artifact_id='driver-unique-control' ORDER BY created_at DESC LIMIT 1").get() as { decision: string; reason: string | null };
    expect(audit).toEqual({ decision: "accepted_no_match", reason: null });
  });

  test("component --force-new consumes the complete authoritative template beyond the display limit", async () => {
    const { api, db, directory } = await setup();
    const sourcePath = await writeComponentSource(directory, "DriverCrowdedDuplicate", "Crowded checkout duplicate", "crowded");
    const source = (await Bun.file(sourcePath).text()).replace(
      'events: ["press"], slots: []',
      'events: ["press"], slots: [], canonicalFor: ["crowded-checkout"]',
    );
    await Bun.write(sourcePath, source);
    for (let index = 0; index < 64; index += 1) {
      seedComponent(db, `crowded-${index}`, `Crowded${index}`, { description: "Crowded checkout duplicate", source, atomicLevel: "atom", canonicalFor: [] });
    }
    seedComponent(db, "crowded-role-owner", "CrowdedRoleOwner", {
      description: "Unrelated role owner",
      source: "export const definition = { description: 'unrelated role owner' }; export default function CrowdedRoleOwner() { return <aside />; }",
      canonicalFor: ["crowded-checkout"],
    });

    const result = await run(api, ["component", "driver-crowded-duplicate", "DriverCrowdedDuplicate", sourcePath, "--design-system", "yandex-pay", "--intent", "Show crowded checkout duplicate", "--force-new", "--reason", "Approved separate treatment for the crowded checkout case", "--json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { acknowledgedCandidateKeys: string[]; discovery: { candidates: unknown[] } };
    expect(payload.acknowledgedCandidateKeys).toEqual(
      [
        ...Array.from({ length: 64 }, (_, index) => `component:yandex-pay:crowded-${index}`),
        "component:yandex-pay:crowded-role-owner",
      ].sort(),
    );
    expect(payload.discovery.candidates.length).toBeLessThan(payload.acknowledgedCandidateKeys.length);
    expect(payload).toMatchObject({ command: "component", id: "driver-crowded-duplicate", forceNew: true, version: 1 });
    expect((db.query("SELECT decision FROM catalog_reuse_decisions WHERE artifact_id='driver-crowded-duplicate' ORDER BY created_at DESC LIMIT 1").get() as { decision: string }).decision).toBe("force_new");
  });

  test("composition creates, updates with CAS, and publishes the current head", async () => {
    const { api, directory } = await setup();
    const firstPath = resolve(directory, "composition-first.json");
    const secondPath = resolve(directory, "composition-second.json");
    const compositionDoc = (name: string) => ({
      version: 1,
      name,
      params: {},
      slots: [],
      spec: { root: "image", elements: { image: { type: "Image", props: { src: "/fixture.png", alt: name } } } },
    });
    await Bun.write(firstPath, JSON.stringify(compositionDoc("Reusable image")));
    await Bun.write(secondPath, JSON.stringify(compositionDoc("Updated reusable image")));

    const missingSystem = await run(api, ["composition", "reusable-image", firstPath]);
    expect(missingSystem.exitCode).toBe(1);
    expect(missingSystem.stderr).toContain("composition requires --design-system");
    const foreignFlag = await run(api, ["composition", "publish", "reusable-image", "--design-system", "yandex-pay"]);
    expect(foreignFlag.exitCode).toBe(1);
    expect(foreignFlag.stderr).toContain("unknown flag for composition publish: --design-system");
    const missingPublishId = await run(api, ["composition", "publish"]);
    expect(missingPublishId.exitCode).toBe(1);
    expect(missingPublishId.stderr).toContain("invalid arguments for composition publish");

    const created = await run(api, ["composition", "reusable-image", firstPath, "--design-system", "yandex-pay", "--json"]);
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.stdout)).toEqual({ command: "composition", id: "reusable-image", created: true, rev: 1, designSystem: "yandex-pay", cache: CACHE_OFF });

    const updated = await run(api, ["composition", "reusable-image", secondPath, "--design-system", "yandex-pay", "--json"]);
    expect(updated.exitCode).toBe(0);
    expect(JSON.parse(updated.stdout)).toEqual({ command: "composition", id: "reusable-image", created: false, rev: 2, designSystem: "yandex-pay", cache: CACHE_OFF });

    const published = await run(api, ["composition", "publish", "reusable-image", "--json"]);
    expect(published.exitCode).toBe(0);
    expect(JSON.parse(published.stdout)).toEqual({ command: "composition publish", id: "reusable-image", version: 1, rev: 2, cache: CACHE_OFF });
    const meta = await (await fetch(`${api}/compositions/reusable-image`)).json() as { headRev: number; publishedVersion: number; doc: { name: string } };
    expect(meta).toMatchObject({ headRev: 2, publishedVersion: 1, doc: { name: "Updated reusable image" } });
  });

  test("diff supports defaults, explicit revisions, and JSON", async () => {
    const { api } = await setup();
    await createThreeRevisions(api);
    const adjacent = await run(api, ["diff", "driver-diff"]);
    expect(adjacent.exitCode).toBe(0);
    expect(adjacent.stdout).toContain("rev 2 -> 3");
    const explicit = await run(api, ["diff", "driver-diff", "1", "3"]);
    expect(explicit.exitCode).toBe(0);
    expect(explicit.stdout).toContain("rev 1 -> 3");
    const json = await run(api, ["diff", "driver-diff", "1", "--json"]);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ from: { rev: 1 }, to: { rev: 3 } });
  });

  test("get assets lists assets and routes an id to usage", async () => {
    const { api } = await setup();
    const upload = await fetch(`${api}/assets`, { method: "POST", headers: { "content-type": "image/png" }, body: new Blob([png() as BlobPart]) });
    expect(upload.status).toBe(201);
    const asset = await upload.json() as { id: string };
    const list = await run(api, ["get", "assets"]);
    expect(list.exitCode).toBe(0);
    expect(JSON.parse(list.stdout).assets[0].id).toBe(asset.id);
    const usage = await run(api, ["get", "assets", asset.id]);
    expect(usage.exitCode).toBe(0);
    expect(JSON.parse(usage.stdout)).toMatchObject({ asset: { id: asset.id }, prototypes: [], components: [] });
  });

  test("delete resolves singular kinds and retires a design system without a baseRev", async () => {
    const { api, db } = await setup();
    seedComponent(db, "retire-me", "RetireMe");

    const badKind = await run(api, ["delete", "widget", "retire-me"]);
    expect(badKind.exitCode).toBe(1);
    expect(badKind.stderr).toContain("cannot delete widget");

    // Регресс: единственное число уходило в путь как есть → GET /api/component/<id> → 404,
    // и CLI врал «component/<id> not found» про существующий компонент.
    const component = await run(api, ["delete", "component", "retire-me", "--json"]);
    expect(component.exitCode).toBe(0);
    expect(JSON.parse(component.stdout)).toEqual({ command: "delete", kind: "components", id: "retire-me", deleted: true, cache: CACHE_OFF });
    expect(db.query("SELECT deleted_at IS NOT NULL gone FROM components WHERE id='retire-me'").get()).toEqual({ gone: 1 });

    const system = await run(api, ["delete", "design-system", "yandex-pay"]);
    expect(system.exitCode).toBe(0);
    expect(system.stdout).toContain("retired design-systems/yandex-pay");
    expect(db.query("SELECT retired FROM design_systems WHERE id='yandex-pay'").get()).toEqual({ retired: 1 });

    const repeat = await run(api, ["delete", "design-system", "yandex-pay"]);
    expect(repeat.exitCode).toBe(1);
    expect(repeat.stderr).toContain("design_system_retired");
  });

  test("parser rejects unknown and duplicate flags without consuming positional values after booleans", async () => {
    const { api } = await setup();
    await createThreeRevisions(api, "parser-diff");
    const unknown = await run(api, ["diff", "parser-diff", "--wat"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("unknown flag");
    const duplicate = await run(api, ["diff", "parser-diff", "--json", "--json"]);
    expect(duplicate.exitCode).toBe(1);
    expect(duplicate.stderr).toContain("duplicate flag");
    const positionalAfterBoolean = await run(api, ["diff", "parser-diff", "--json", "1", "2", "3"]);
    expect(positionalAfterBoolean.exitCode).toBe(1);
    expect(positionalAfterBoolean.stderr).toContain("invalid arguments for diff");
  });

  test("catalog reserves subcommands and rejects flags from other catalog forms", async () => {
    const { api } = await setup();
    const missingListSystem = await run(api, ["catalog", "list"]);
    expect(missingListSystem.exitCode).toBe(1);
    expect(missingListSystem.stderr).toContain("invalid arguments for catalog list");

    const missingSearchIntent = await run(api, ["catalog", "search", "yandex-pay"]);
    expect(missingSearchIntent.exitCode).toBe(1);
    expect(missingSearchIntent.stderr).toContain("catalog search requires --intent");

    const missingArtifact = await run(api, ["catalog", "get", "yandex-pay"]);
    expect(missingArtifact.exitCode).toBe(1);
    expect(missingArtifact.stderr).toContain("catalog get requires at least one artifact");

    for (const [args, diagnostic] of [
      [["catalog", "list", "yandex-pay", "--limit", "2"], "unknown flag for catalog list: --limit"],
      [["catalog", "--full", "list", "yandex-pay"], "unknown flag for catalog list: --full"],
      [["catalog", "search", "yandex-pay", "--intent", "find a button", "--full"], "unknown flag for catalog search: --full"],
      [["catalog", "get", "yandex-pay", "Overlay", "--intent", "find overlay"], "unknown flag for catalog get: --intent"],
      [["catalog", "yandex-pay", "--intent", "find anything"], "unknown flag for catalog: --intent"],
      [["composition", "--design-system", "yandex-pay", "publish", "missing"], "unknown flag for composition publish: --design-system"],
    ] as const) {
      const result = await run(api, [...args]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(diagnostic);
    }

    const globalBeforeSubcommand = await run(api, ["catalog", "--json", "list", "yandex-pay"]);
    expect(globalBeforeSubcommand.exitCode).toBe(0);
    expect(JSON.parse(globalBeforeSubcommand.stdout)).toMatchObject({ command: "catalog list" });
  });
});

describe("author driver figma provenance", () => {
  const provenance = { fileKey: "Fig1_key-2", nodeIds: ["12:34", "56:78"] };

  async function writeFigma(directory: string, name: string, value: unknown): Promise<string> {
    const path = resolve(directory, name);
    await Bun.write(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
  }

  async function headFigma(api: string, id: string) {
    const response = await fetch(`${api}/components/${id}`);
    expect(response.status).toBe(200);
    return (await response.json() as { figma: unknown }).figma;
  }

  test("--figma rides along with create and update, and an update without it clears the head", async () => {
    const { api, directory } = await setup();
    const figmaPath = await writeFigma(directory, "figma.json", provenance);
    const createSource = await writeComponentSource(directory, "DriverFigmaCard", "Card rebuilt from a Figma frame", "figma-create");

    const created = await run(api, ["component", "driver-figma-card", "DriverFigmaCard", createSource, "--design-system", "yandex-pay", "--intent", "Rebuild the Figma checkout card frame", "--figma", figmaPath, "--json"]);
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({ command: "component", version: 1, figma: true });
    expect(await headFigma(api, "driver-figma-card")).toEqual(provenance);

    const updateSource = await writeComponentSource(directory, "DriverFigmaCard", "Card rebuilt from a Figma frame", "figma-update");
    const updated = await run(api, ["component", "driver-figma-card", "DriverFigmaCard", updateSource, "--design-system", "yandex-pay", "--figma", figmaPath, "--json"]);
    expect(updated.exitCode).toBe(0);
    expect(JSON.parse(updated.stdout)).toMatchObject({ version: 2, figma: true });
    expect(await headFigma(api, "driver-figma-card")).toEqual(provenance);

    // С волной R3a (RFC candidate-acceptance §6) семантика противоположна прежней: provenance
    // резолвится cross-revision, поэтому update **без** `--figma` её больше не обнуляет —
    // наследование обеспечивает резолвер. Операционное правило M8 (слать `--figma` каждый раз)
    // остаётся в силе как канон, но перестало быть страховкой от потери ссылки.
    const droppedSource = await writeComponentSource(directory, "DriverFigmaCard", "Card rebuilt from a Figma frame", "figma-dropped");
    const dropped = await run(api, ["component", "driver-figma-card", "DriverFigmaCard", droppedSource, "--design-system", "yandex-pay", "--json"]);
    expect(dropped.exitCode).toBe(0);
    expect(JSON.parse(dropped.stdout).figma).toBeUndefined();
    expect(await headFigma(api, "driver-figma-card")).toEqual(provenance);
  }, 30_000); // три публикации подряд: каждая платит extract+typecheck в подпроцессе

  test("the provenance verb edits the link without creating a revision or a version", async () => {
    const { api, directory } = await setup();
    const createSource = await writeComponentSource(directory, "DriverProvCard", "Card whose provenance is edited alone", "prov-verb");
    const created = await run(api, ["component", "driver-prov-card", "DriverProvCard", createSource, "--design-system", "yandex-pay", "--intent", "Edit the Figma link of a published card", "--json"]);
    expect(created.exitCode).toBe(0);

    const figmaPath = await writeFigma(directory, "prov.json", provenance);
    const written = await run(api, ["provenance", "driver-prov-card", figmaPath, "--json"]);
    expect(written.exitCode).toBe(0);
    expect(JSON.parse(written.stdout)).toMatchObject({ command: "provenance", id: "driver-prov-card", rev: 1, seq: 1, unchanged: false });
    expect(await headFigma(api, "driver-prov-card")).toEqual(provenance);

    // Повтор идентичного значения дедуплицируется, ревизия остаётся прежней.
    const repeat = await run(api, ["provenance", "driver-prov-card", figmaPath, "--json"]);
    expect(repeat.exitCode).toBe(0);
    expect(JSON.parse(repeat.stdout)).toMatchObject({ unchanged: true, seq: null });
    const meta = await (await fetch(`${api}/components/driver-prov-card`)).json() as { headRev: number; versions: unknown[] };
    expect(meta.headRev).toBe(1);
    expect(meta.versions).toHaveLength(1);
  }, 30_000);

  test("a missing or non-JSON --figma file is an argument error before any request", async () => {
    const { api, directory, requests } = await setup();
    const source = await writeComponentSource(directory, "DriverFigmaGuard", "Guarded figma provenance card", "figma-guard");
    const args = (figmaPath: string) => ["component", "driver-figma-guard", "DriverFigmaGuard", source, "--design-system", "yandex-pay", "--intent", "Guard the figma provenance flag", "--figma", figmaPath];

    const missing = await run(api, args(resolve(directory, "absent.json")));
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("--figma file cannot be read");
    expect(missing.stderr).toContain("ENOENT");

    const brokenPath = await writeFigma(directory, "broken.json", "{ not json");
    const broken = await run(api, args(brokenPath));
    expect(broken.exitCode).toBe(1);
    expect(broken.stderr).toContain("--figma file is not valid JSON");

    expect(requests()).toBe(0);
  });
});

describe("author driver session cache", () => {
  test("a second CLI call reuses the cached cookie instead of logging in again", async () => {
    const { api, logins } = await setupCounted();
    const first = await run(api, ["get", "prototypes"]);
    expect(first.exitCode).toBe(0);
    const second = await run(api, ["get", "prototypes"]);
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual([]);
    expect(logins()).toBe(1);
    const entry = JSON.parse(await Bun.file(sessionFile).text()) as { cookie: string; apiBase: string; username: string };
    expect(entry).toMatchObject({ apiBase: api, username: "Driver Admin" });
    expect(entry.cookie).toMatch(/^easyui_session=[A-Za-z0-9_-]{43}$/);
  });

  test("a stale cached cookie costs exactly one re-login and still succeeds", async () => {
    const { api, logins } = await setupCounted();
    await writeSessionCache(api, staleCookie("stale"));
    const result = await run(api, ["get", "prototypes"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
    expect(logins()).toBe(1);
    expect(JSON.parse(await Bun.file(sessionFile).text()).cookie).not.toBe(staleCookie("stale"));
  });

  test("a parallel batch on a stale cookie is deduplicated into one re-login", async () => {
    const { api, logins } = await setupCounted();
    await writeSessionCache(api, staleCookie("batch"));
    process.env.EASYUI_SESSION_FILE = sessionFile;
    const client = createEasyUiClient({ apiBase: api, credentials: { username: "Driver Admin", password: "driver-test-password" } });
    const responses = await Promise.all(["/prototypes", "/components", "/design-systems", "/prototypes"].map((path) => client.request(path)));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    expect(logins()).toBe(1);
    expect(client.cookieHeader).toMatch(/^easyui_session=/);
  });

  test("EASYUI_SESSION_CACHE=0 restores a login per call and removes the cache file", async () => {
    const { api, logins } = await setupCounted();
    await writeSessionCache(api, staleCookie("off"));
    for (let call = 0; call < 2; call += 1) {
      const result = await run(api, ["get", "prototypes"], "", { EASYUI_SESSION_CACHE: "0" });
      expect(result.exitCode).toBe(0);
    }
    expect(logins()).toBe(2);
    expect(await Bun.file(sessionFile).exists()).toBe(false);
  });

  test("a non-JSON 401 from the legacy Basic barrier is not retried", async () => {
    const { api, logins } = await setupCounted("edge:secret");
    await writeSessionCache(api, staleCookie("legacy"));
    const result = await run(api, ["get", "prototypes"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("EASYUI_LEGACY_BASIC_AUTH");
    expect(logins()).toBe(0);
  });
});

describe("author driver snap contract", () => {
  test("exit 0 when every screen produced a PNG without product errors", async () => {
    const { api, directory } = await setup(undefined, pngRunJob(["GET /favicon.ico 404", "ResizeObserver loop completed with undelivered notifications"]).runJob);
    await saveDoc(api, await fixture("snap-clean"));
    const result = await run(api, ["snap", "snap-clean", `${directory}/shots`, "--json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { exitCode: number; screens: { screenId: string; imageProduced: boolean; captureClean: boolean; infraNoise: string[]; path: string }[] };
    expect(payload.exitCode).toBe(0);
    expect(payload.screens).toHaveLength(1);
    expect(payload.screens[0]).toMatchObject({ imageProduced: true, captureClean: true, productErrors: [] });
    expect(payload.screens[0]!.infraNoise).toHaveLength(2);
    expect(await Bun.file(payload.screens[0]!.path).exists()).toBe(true);
  });

  test("exit 2 when a PNG was produced but the prototype logged errors", async () => {
    const { api, directory } = await setup(undefined, pngRunJob(["TypeError: props.items is not iterable"]).runJob);
    await saveDoc(api, await fixture("snap-dirty"));
    const result = await run(api, ["snap", "snap-dirty", `${directory}/shots`, "--json"]);
    expect(result.exitCode).toBe(2);
    const payload = JSON.parse(result.stdout) as { exitCode: number; screens: { imageProduced: boolean; productErrors: string[]; attempts: number; path: string }[] };
    expect(payload.exitCode).toBe(2);
    expect(payload.screens[0]).toMatchObject({ imageProduced: true, captureClean: false, attempts: 1 });
    expect(payload.screens[0]!.productErrors).toEqual(["TypeError: props.items is not iterable"]);
    // No retry on product errors, and the PNG is still on disk.
    expect(await Bun.file(payload.screens[0]!.path).exists()).toBe(true);
  });

  test("exit 1 with two attempts when the capture never produces an image", async () => {
    let calls = 0;
    const runJob: RunJob = async () => { calls += 1; return { ok: false, error: "capture reported error" }; };
    const { api, directory } = await setup(undefined, runJob);
    await saveDoc(api, await fixture("snap-broken"));
    const result = await run(api, ["snap", "snap-broken", `${directory}/shots`, "--json"]);
    expect(result.exitCode).toBe(1);
    expect(calls).toBe(2); // infra failure is retried exactly once
    const payload = JSON.parse(result.stdout) as { screens: { imageProduced: boolean; attempts: number; failure: string }[] };
    expect(payload.screens[0]).toMatchObject({ imageProduced: false, attempts: 2 });
    expect(payload.screens[0]!.failure).toContain("capture reported error");
  });

  test("--all-screens fans status out over every screen and stays machine-readable", async () => {
    const { api } = await setup();
    await saveDoc(api, await twoScreenDoc("status-all"));
    const result = await run(api, ["status", "status-all", "--all-screens", "--json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { screens: { screenId: string; renderable: boolean }[] };
    expect(payload.screens.map((screen) => screen.screenId)).toEqual(["welcome", "second"]);
    expect(payload.screens.every((screen) => screen.renderable)).toBe(true);
    const missing = await run(api, ["status", "status-all"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("--all-screens");
  });

  test("--dsf and --theme reach the worker job, and the default viewport follows the canvas", async () => {
    const stub = pngRunJob();
    const { api, directory } = await setup(undefined, stub.runJob);
    await saveDoc(api, await fixture("snap-flags"));
    const flagged = await run(api, ["snap", "snap-flags", `${directory}/shots`, "--dsf", "2", "--theme", "dark", "--json"]);
    expect(flagged.exitCode).toBe(0);
    expect(stub.jobs()[0]).toMatchObject({ deviceScaleFactor: 2, colorScheme: "dark", viewport: { width: 1280, height: 800 } });
    expect(JSON.parse(flagged.stdout)).toMatchObject({ command: "snap", dsf: 2, theme: "dark", screens: [{ viewport: { width: 1280, height: 800 } }] });

    // Новый дефолт (план §T3, M4): вьюпорт canvas-aware, как у geometry/baseline, а не 480x800.
    await saveDoc(api, await canvasDoc("snap-canvas", 1200, 900));
    const canvas = await run(api, ["snap", "snap-canvas", `${directory}/canvas-shots`, "--json"]);
    expect(canvas.exitCode).toBe(0);
    expect(stub.jobs()[1]).toMatchObject({ deviceScaleFactor: 1, colorScheme: "light", viewport: { width: 1200, height: 900 } });
    expect(JSON.parse(canvas.stdout)).toMatchObject({ dsf: 1, theme: "light", screens: [{ viewport: { width: 1200, height: 900 } }] });

    const override = await run(api, ["snap", "snap-canvas", `${directory}/canvas-shots`, "--viewport", "390x844", "--json"]);
    expect(override.exitCode).toBe(0);
    expect(stub.jobs()[2]).toMatchObject({ viewport: { width: 390, height: 844 } });
  }, 30_000);

  test("a canvas that would exceed the asset ingest limit at --dsf 2 is refused before enqueue", async () => {
    const stub = pngRunJob();
    const { api, directory } = await setup(undefined, stub.runJob);
    await saveDoc(api, await canvasDoc("snap-huge", 2000, 4000));
    const result = await run(api, ["snap", "snap-huge", `${directory}/shots`, "--dsf", "2", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("capture surface 2000x4000 at dsf 2");
    expect(result.stderr).toContain("asset ingest limit");
    expect(stub.calls()).toBe(0);

    // Тот же экран при dsf 1 укладывается в бюджет и снимается.
    const fits = await run(api, ["snap", "snap-huge", `${directory}/shots`, "--json"]);
    expect(fits.exitCode).toBe(0);
    expect(stub.calls()).toBe(1);
  });

  test("snap fans out over every screen of the draft", async () => {
    const stub = pngRunJob();
    const { api, directory } = await setup(undefined, stub.runJob);
    await saveDoc(api, await twoScreenDoc("snap-all"));
    const result = await run(api, ["snap", "snap-all", `${directory}/shots`, "--all-screens", "--json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { screens: { screenId: string }[] };
    expect(payload.screens.map((screen) => screen.screenId)).toEqual(["welcome", "second"]);
    expect(stub.calls()).toBe(2);
  });

  // R8a: локального браузера в драйвере нет — `shoot` снимает тем же серверным рендерером.
  test("shoot is a deprecated alias of snap --all-screens and never launches a local browser", async () => {
    const stub = pngRunJob();
    const { api, directory } = await setup(undefined, stub.runJob);
    await saveDoc(api, await twoScreenDoc("shoot-alias"));
    const result = await run(api, ["shoot", "shoot-alias", `${directory}/shots`, "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("deprecated alias");
    expect(stub.calls()).toBe(2);
    const payload = JSON.parse(result.stdout) as { command: string; screens: { screenId: string; path: string }[] };
    expect(payload.command).toBe("shoot");
    expect(payload.screens.map((screen) => screen.screenId)).toEqual(["welcome", "second"]);
    expect(await Bun.file(payload.screens[0]!.path).exists()).toBe(true);
    // Съёмочные флаги у алиаса те же, что у snap.
    const flagged = await run(api, ["shoot", "shoot-alias", `${directory}/shots`, "--dsf", "2", "--theme", "dark", "--json"]);
    expect(flagged.exitCode).toBe(0);
    expect(stub.jobs()[2]).toMatchObject({ deviceScaleFactor: 2, colorScheme: "dark" });
    // Два полных прогона драйвера (4 капчура) не укладываются в дефолтные 5с bun-таймаута.
  }, 30_000);

  test("--local-browser is refused with an explanation instead of an unknown-flag message", async () => {
    const { api, directory } = await setup(undefined, pngRunJob().runJob);
    const result = await run(api, ["shoot", "shoot-local", `${directory}/shots`, "--local-browser"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--local-browser is gone");
    expect(result.stderr).toContain("server renderer");
  });

  // Предполётная сверка (R8a): дев-сервер без renderer-манифеста предупреждает, но не валит съёмку.
  test("a server renderer without a manifest warns on stderr without changing the exit code", async () => {
    const stub = pngRunJob();
    const { api, directory } = await setup(undefined, stub.runJob);
    await saveDoc(api, await fixture("snap-fallback"));
    const result = await run(api, ["snap", "snap-fallback", `${directory}/shots`, "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("renderer:");
    expect(result.stderr).toContain("fallback");
  });

  test("renderer preflight only speaks up about builds whose frames are not comparable", () => {
    expect(rendererPreflightWarning({ renderer: { source: "manifest", browserVersion: "149.0.7827.55" } })).toBeNull();
    expect(rendererPreflightWarning({ renderer: { source: "fallback", browserVersion: "149.0.7827.55" } })).toContain("fallback");
    expect(rendererPreflightWarning({})).toContain("no renderer section");
    expect(rendererPreflightWarning(null)).toContain("no renderer section");
  });
});

// --- R8b: capture receipt в CLI (план renderer-contract-2 §5) --------------------------------

/** Разбор receipt-файла в тесте: ровно те поля, которые он проверяет (без `any`). */
type ReceiptDoc = { receiptVersion: number; renderer: { fingerprint: string }; target: unknown; output: { pngWidth: number; pngHeight: number; pngSha256: string | null } };
type ReceiptFileEntry = { screenId: string; jobId: string | null; receiptSha256: string | null; receipt: ReceiptDoc | null };

describe("author driver capture receipt", () => {
  test("codes are collected from the job failure, the receipt verdict and the renderer drift without duplicates", () => {
    const state = { failure: { code: "renderer_mismatch", message: "declared 149 vs observed 150" } };
    const receipt = {
      verdict: { codes: [{ code: "font_face_missing", severity: "error", detail: "Corpus Text 500" }] },
      renderer: {
        fingerprint: "fp",
        drift: [
          { code: "renderer_mismatch", severity: "warning", detail: "declared 149 vs observed 150" },
          { code: "renderer_mismatch", severity: "error", detail: "declared 149 vs observed 150" },
        ],
      },
    };
    expect(captureCodes(state, receipt)).toEqual([
      { code: "renderer_mismatch", severity: "error", detail: "declared 149 vs observed 150" },
      { code: "font_face_missing", severity: "error", detail: "Corpus Text 500" },
      { code: "renderer_mismatch", severity: "warning", detail: "declared 149 vs observed 150" },
    ]);
    expect(captureCodes(null, null)).toEqual([]);
  });

  test("the fingerprint comes from the job result, and a missing receipt degrades to nulls instead of lies", () => {
    const state = {
      result: { receiptSha256: "abc", renderer: { fingerprint: "fp", rendererVersion: "r2", source: "manifest", browserVersion: "149.0.1" } },
    };
    expect(captureReceiptEvidence(state, null)).toEqual({
      receiptSha256: "abc",
      renderer: { rendererFingerprint: "fp", rendererVersion: "r2", source: "manifest", browserVersion: "149.0.1" },
      codes: [],
    });
    expect(captureReceiptEvidence({ result: {} }, null)).toEqual({ receiptSha256: null, renderer: null, codes: [] });
  });

  test("snap --json carries receiptSha256/fingerprint/codes and --receipt writes the документ per screen", async () => {
    const { api, directory } = await setup(undefined, pngRunJob().runJob);
    await saveDoc(api, await twoScreenDoc("snap-receipt"));
    const receiptPath = resolve(directory, "receipts/snap.json");
    const result = await run(api, ["snap", "snap-receipt", `${directory}/shots`, "--receipt", receiptPath, "--json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      receipt: string;
      screens: { screenId: string; jobId: string; receiptSha256: string; renderer: { rendererFingerprint: string; source: string }; codes: unknown[] }[];
    };
    expect(payload.receipt).toBe(receiptPath);
    expect(payload.screens).toHaveLength(2);
    for (const screen of payload.screens) {
      expect(screen.receiptSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(screen.renderer.rendererFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(screen.codes).toEqual([]);
    }
    // Два экрана — два разных капчура, поэтому и джобы разные.
    expect(payload.screens[0]!.jobId).not.toBe(payload.screens[1]!.jobId);

    const file = JSON.parse(await Bun.file(receiptPath).text()) as { command: string; prototypeId: string; receipts: ReceiptFileEntry[] };
    expect(file).toMatchObject({ command: "snap", prototypeId: "snap-receipt" });
    expect(file.receipts.map((entry) => entry.screenId)).toEqual(["welcome", "second"]);
    for (const [index, entry] of file.receipts.entries()) {
      expect(entry.receiptSha256).toBe(payload.screens[index]!.receiptSha256);
      // Документ — тот самый, что отдаёт job-scoped ручка: рендерер, цель и PNG-идентичность.
      expect(entry.receipt!.receiptVersion).toBe(1);
      expect(entry.receipt!.renderer.fingerprint).toBe(payload.screens[index]!.renderer.rendererFingerprint);
      expect(entry.receipt!.target).toMatchObject({ kind: "prototype", prototypeId: "snap-receipt" });
      expect(entry.receipt!.output.pngWidth).toBe(2);
    }
  }, 30_000);

  test("preview --receipt writes the job receipt and prints its sha in both modes", async () => {
    const { api, db, directory } = await setup(undefined, pngRunJob().runJob);
    seedComponent(db, "stars", "Stars");
    const receiptPath = resolve(directory, "stars-receipt.json");
    const result = await run(api, ["preview", "stars", "--out", resolve(directory, "stars.png"), "--receipt", receiptPath, "--json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      receipt: string; receiptSha256: string; renderer: { rendererFingerprint: string }; codes: unknown[];
    };
    expect(payload.receipt).toBe(receiptPath);
    expect(payload.receiptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.renderer.rendererFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.codes).toEqual([]);
    const file = JSON.parse(await Bun.file(receiptPath).text()) as { command: string; componentId: string; receiptSha256: string; receipt: ReceiptDoc };
    expect(file).toMatchObject({ command: "preview", componentId: "stars", receiptSha256: payload.receiptSha256 });
    expect(file.receipt.target).toMatchObject({ kind: "component", componentId: "stars", version: 1 });
    // `pngSha256` считает воркер; стаб теста его не присылает, и receipt честно пишет null.
    expect(file.receipt.output).toMatchObject({ pngWidth: 2, pngHeight: 3, pngSha256: null });

    // Человекочитаемый режим печатает тот же адрес в строке пинов — без него агент не знает,
    // чем снят кадр, который он смотрит глазами.
    const human = await run(api, ["preview", "stars", "--out", resolve(directory, "stars-2.png"), "--receipt", resolve(directory, "r2.json")]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain(`receipt=${payload.receiptSha256}`);
    expect(human.stdout).toContain(resolve(directory, "r2.json"));
  }, 30_000);

  test("a server with receipts disabled still snaps: the file carries nulls and the reason goes to stderr", async () => {
    process.env.EASYUI_CAPTURE_RECEIPTS_DISABLED = "1";
    try {
      const { api, directory } = await setup(undefined, pngRunJob().runJob);
      await saveDoc(api, await fixture("snap-no-receipt"));
      const receiptPath = resolve(directory, "none.json");
      const result = await run(api, ["snap", "snap-no-receipt", `${directory}/shots`, "--receipt", receiptPath, "--json"]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("server returned no capture receipt");
      const payload = JSON.parse(result.stdout) as { screens: { receiptSha256: string | null; renderer: { rendererFingerprint: string } | null }[] };
      expect(payload.screens[0]!.receiptSha256).toBeNull();
      // Отпечаток объявлен на постановке джобы и не зависит от kill-switch'а receipt'ов.
      expect(payload.screens[0]!.renderer!.rendererFingerprint).toMatch(/^[0-9a-f]{64}$/);
      const file = JSON.parse(await Bun.file(receiptPath).text()) as { receipts: ReceiptFileEntry[] };
      expect(file.receipts[0]).toMatchObject({ receiptSha256: null, receipt: null });
    } finally {
      delete process.env.EASYUI_CAPTURE_RECEIPTS_DISABLED;
    }
  }, 30_000);
});

// --- Wave DX.1 verb: preview (component screenshot on the published head version) -----------

describe("author driver preview verb", () => {
  test("renders the published head version and reports what was rendered", async () => {
    const stub = pngRunJob();
    const { api, db, directory } = await setup(undefined, stub.runJob);
    seedComponent(db, "stars", "Stars");
    const out = resolve(directory, "stars.png");
    const result = await run(api, ["preview", "stars", "--out", out, "--json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      command: "preview", componentId: "stars", version: 1, bundleHash: "bh",
      designSystemMetaVersion: null, viewport: { width: 1280, height: 800 }, dsf: 1, theme: "light",
      path: out, queueRetries: 0, exitCode: 0, imageProduced: true, captureClean: true,
    });
    expect(await Bun.file(out).exists()).toBe(true);
    expect(stub.jobs()[0]).toMatchObject({
      viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: "light",
      bootstrap: { kind: "component", target: { kind: "component", componentId: "stars", version: 1 }, props: {} },
    });
  });

  test("--example resolves server-side, props.json reaches the worker, and the two are mutually exclusive", async () => {
    const stub = pngRunJob();
    const { api, db, directory } = await setup(undefined, stub.runJob);
    seedComponent(db, "stars", "Stars");
    const example = await run(api, ["preview", "stars", "--example", "full", "--out", resolve(directory, "ex.png"), "--json"]);
    expect(example.exitCode).toBe(0);
    expect(JSON.parse(example.stdout)).toMatchObject({ example: "full" });
    expect(stub.jobs()[0]!.bootstrap.props).toEqual({ secretDetail: "not-for-list-or-search" });

    const propsPath = resolve(directory, "props.json");
    await Bun.write(propsPath, JSON.stringify({ secretDetail: "custom" }));
    const withProps = await run(api, ["preview", "stars", propsPath, "--out", resolve(directory, "props.png"), "--json"]);
    expect(withProps.exitCode).toBe(0);
    expect(stub.jobs()[1]!.bootstrap.props).toEqual({ secretDetail: "custom" });

    const both = await run(api, ["preview", "stars", propsPath, "--example", "full"]);
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain("either props.json or --example");

    const unknownExample = await run(api, ["preview", "stars", "--example", "missing", "--json"]);
    expect(unknownExample.exitCode).toBe(1);
    expect(JSON.parse(unknownExample.stdout)).toMatchObject({ failed: true, status: 422, code: "unknown_example", retryable: false });
    expect(unknownExample.stderr).toContain("preview enqueue failed (422 unknown_example): Unknown component example: missing");

    await Bun.write(propsPath, JSON.stringify({ secretDetail: 42 }));
    const badProps = await run(api, ["preview", "stars", propsPath, "--json"]);
    expect(badProps.exitCode).toBe(1);
    expect(JSON.parse(badProps.stdout)).toMatchObject({ failed: true, status: 422, code: "invalid_props" });
    expect(badProps.stderr).toContain("prop secretDetail must be of type string");
  });

  test("429 queue_full is retried with backoff until the queue drains", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const stub = pngRunJob();
    const gated: RunJob = async (job, deadlineMs) => { await gate; return stub.runJob(job, deadlineMs); };
    const { api, db, directory } = await setup(undefined, gated);
    seedComponent(db, "stars", "Stars");
    // 1 running + 5 queued заполняют очередь сервера (concurrency 1, MAX_QUEUE 5).
    for (let index = 0; index < 6; index += 1) {
      const response = await fetch(`${api}/components/stars/versions/1/screenshot`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ viewport: { width: 200, height: 100 } }),
      });
      expect(response.status).toBe(202);
    }
    const pending = run(api, ["preview", "stars", "--out", resolve(directory, "retry.png"), "--json"]);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500)); // драйвер получает 429 и уходит в бэкофф
    release();
    const result = await pending;
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { queueRetries: number; path: string };
    expect(payload.queueRetries).toBeGreaterThanOrEqual(1);
    expect(result.stderr).toContain("screenshot queue is full");
    expect(await Bun.file(payload.path).exists()).toBe(true);
  }, 15_000);

  test("--probe geometry returns the component-surface measurement and writes it as expect input", async () => {
    const jobs: WorkerJob[] = [];
    const geometryJob: RunJob = async (job) => {
      jobs.push(job);
      return {
        ok: true,
        geometry: {
          rects: [
            { key: "c", instance: 0, domIndex: 0, x: 0, y: 0, width: 328, height: 56, layoutContext: { display: "flex", flexDirection: "row", flexWrap: "nowrap", rowGap: "8px", columnGap: "8px" } },
          ],
          truncated: false, total: 1,
          safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
          roleRects: {},
          frame: { x: 0, y: 0, width: 328, height: 56, source: "surface" as const },
          content: { x: 0, y: 0, width: 328, height: 56 },
          scroll: { width: 328, height: 56 },
          viewportOwnership: { frame: { width: 328, height: 56 }, content: { width: 328, height: 56 }, scroll: { width: 328, height: 56 }, scrollable: false, owners: [], unownedPct: 0 },
          issues: [],
        },
        consoleErrors: [], pageErrors: [], browserVersion: "test/geometry",
      };
    };
    const { api, db, directory } = await setup(undefined, geometryJob);
    seedComponent(db, "stars", "Stars");
    const out = resolve(directory, "actual.json");
    const result = await run(api, ["preview", "stars", "--probe", "geometry", "--out", out]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("preview stars v1 probe=geometry");
    expect(result.stdout).toContain("c#0 parent=- dom=0 rect=0,0 328x56");
    expect(jobs[0]).toMatchObject({ probe: "geometry" });
    const written = await Bun.file(out).json() as { kind: string; surface: string; rects: unknown[] };
    expect(written).toMatchObject({ kind: "geometry", surface: "component", componentId: "stars", version: 1 });
    expect(written.rects).toHaveLength(1);
  });

  test("expect verb compares an expected.json against a geometry probe without touching the network", async () => {
    const { api, directory, requests } = await setup();
    const expectedPath = resolve(directory, "expected.json");
    const actualPath = resolve(directory, "actual.json");
    await Bun.write(actualPath, JSON.stringify({ kind: "geometry", surface: "component", rects: expectFixtureRects() }));
    await Bun.write(expectedPath, JSON.stringify({ elements: [{ key: "stack", size: { width: 328, height: 56 }, gap: 8, padding: 16 }] }));

    const mismatch = await run(api, ["expect", expectedPath, actualPath]);
    expect(mismatch.exitCode).toBe(2);
    expect(mismatch.stdout).toContain("stack#0: gap expected 8, got 6");
    expect(mismatch.stdout).toContain("ok   stack#0: width expected 328, got 328");
    expect(mismatch.stdout).toContain("FAIL stack#0: padding.top expected 16, got 12");
    expect(mismatch.stderr).toContain("geometry does not match");
    // Оффлайновый верб: ни одного запроса к API (даже логина).
    expect(requests()).toBe(0);

    await Bun.write(expectedPath, JSON.stringify({ elements: [{ key: "stack", gap: 6, padding: { left: 16, top: 12 } }] }));
    const ok = await run(api, ["expect", expectedPath, actualPath, "--json"]);
    expect(ok.exitCode).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ command: "expect", tolerance: 1, mismatches: 0, exitCode: 0 });

    const loose = await run(api, ["expect", expectedPath, actualPath, "--tolerance", "0"]);
    expect(loose.exitCode).toBe(0);

    await Bun.write(expectedPath, JSON.stringify({ elements: [{ key: "stack", gaps: 6 }] }));
    const malformed = await run(api, ["expect", expectedPath, actualPath]);
    expect(malformed.exitCode).toBe(1);
    expect(malformed.stderr).toContain("unknown field gaps");

    await Bun.write(expectedPath, JSON.stringify({ elements: [{ key: "stack", gap: 6 }] }));
    await Bun.write(actualPath, JSON.stringify({ kind: "image" }));
    const notGeometry = await run(api, ["expect", expectedPath, actualPath]);
    expect(notGeometry.exitCode).toBe(1);
    expect(notGeometry.stderr).toContain("no rects[]");

    const missingFile = await run(api, ["expect", resolve(directory, "nope.json"), actualPath]);
    expect(missingFile.exitCode).toBe(1);
    expect(missingFile.stderr).toContain("expected.json cannot be read");
  });

  test("usage error without arguments, and clear errors when the component is missing or unpublished", async () => {
    const { api, db } = await setup();
    const noArgs = await run(api, ["preview"]);
    expect(noArgs.exitCode).toBe(1);
    expect(noArgs.stderr).toContain("invalid arguments for preview");
    expect(noArgs.stderr).toContain("usage: driver.mjs");

    const missing = await run(api, ["preview", "missing-component"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("components/missing-component not found");

    db.query("INSERT INTO components (id,name,head_rev,design_system,deleted_at,owner_id,created_at,updated_at) VALUES ('draft-only','DraftOnly',1,'yandex-pay',NULL,'user_admin','now','now')").run();
    db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES ('draft-only',1,'export const definition={}','yandex-pay','now')").run();
    const unpublished = await run(api, ["preview", "draft-only"]);
    expect(unpublished.exitCode).toBe(1);
    expect(unpublished.stderr).toContain("has no published version");
  });
});

// --- Wave 7.2 verbs: readiness / publish --verify / usages / audit --------------------------

/** A document whose only image references an uploaded asset, so the asset gate can be broken. */
async function assetDoc(id: string, assetId: string): Promise<PrototypeDoc> {
  const base = await fixture(id);
  const screen = base.screens[0]!;
  return {
    ...base,
    screens: [{ ...screen, spec: { root: "image", elements: { image: { type: "Image", props: { src: { $asset: assetId }, alt: "Fixture" } } } } }],
  } as PrototypeDoc;
}

async function uploadAsset(api: string): Promise<string> {
  const response = await fetch(`${api}/assets`, { method: "POST", headers: { "content-type": "image/png" }, body: new Blob([png() as BlobPart]) });
  expect(response.status).toBe(201);
  return (await response.json() as { id: string }).id;
}

/** Referenced asset disappears from the registry — `assets` gate turns `fail`. */
function dropAssets(db: Database) {
  db.run("DELETE FROM prototype_revision_assets");
  db.run("DELETE FROM assets");
}

/** Seeds a published component (optionally with a later deprecated version) directly in the DB. */
function seedComponent(db: Database, id: string, name: string, options: {
  deprecated?: boolean;
  description?: string;
  events?: string[];
  slots?: string[];
  source?: string;
  atomicLevel?: string;
  designSystem?: string;
  canonicalFor?: string[];
} = {}) {
  const { deprecated = false } = options;
  const designSystem = options.designSystem ?? "yandex-pay";
  const source = options.source ?? "export const definition={}";
  const definitionMeta = JSON.stringify({
    description: options.description ?? "seeded",
    events: options.events ?? [],
    slots: options.slots ?? [],
    ...(options.atomicLevel === undefined ? {} : { atomicLevel: options.atomicLevel }),
    scope: "screen",
    canonicalFor: options.canonicalFor ?? ["payment-success"],
    propsJsonSchema: { type: "object", properties: { secretDetail: { type: "string" } } },
    examples: { full: { secretDetail: "not-for-list-or-search" } },
  });
  db.query("INSERT INTO components (id,name,head_rev,design_system,deleted_at,owner_id,created_at,updated_at) VALUES (?,?,?,?,NULL,'user_admin','now','now')")
    .run(id, name, deprecated ? 2 : 1, designSystem);
  const versions: [number, string][] = deprecated ? [[1, "active"], [2, "deprecated"]] : [[1, "active"]];
  for (const [version, status] of versions) {
    db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES (?,?,?,?,'now')").run(id, version, source, designSystem);
    db.query(`INSERT INTO component_publishes (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,published_at)
      VALUES (?,?,?,?,'',?,'sh','bh',2,'now')`).run(id, version, version, status, definitionMeta);
  }
}

function seedPinnedPrototype(db: Database, id: string, componentId: string, componentName: string) {
  const doc = JSON.stringify({
    version: 1, id, name: id, designSystem: "yandex-pay", device: "mobile", startScreen: "home",
    screens: [{ id: "home", name: "HOME", spec: { root: "root", elements: { root: { type: componentName, props: {} } } } }],
  });
  db.query(`INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,instance_id,owner_id,status,kind,created_at,updated_at)
    VALUES (?,?,'mobile',1,1,'yandex-pay',?,'user_admin','private','product-flow','now','now')`).run(id, id, `instance-${id}`);
  db.query("INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES (?,1,?,'h','now')").run(id, doc);
  db.query("INSERT INTO prototype_revision_components (prototype_id,rev,component_id,component_version) VALUES (?,1,?,1)").run(id, componentId);
}

describe("author driver readiness and publish verbs", () => {
  test("readiness prints a gate table, exits 0 when publishable and 2 when a gate fails", async () => {
    const { api, db } = await setup();
    await saveDoc(api, await fixture("ready-clean"));
    const human = await run(api, ["readiness", "ready-clean"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("gate\tstatus\tsummary");
    expect(human.stdout).toContain("publishable=yes");
    expect(human.stdout).toMatch(/architecture\t(pass|warn)\t/);

    const assetId = await uploadAsset(api);
    await saveDoc(api, await assetDoc("ready-broken", assetId));
    dropAssets(db);
    const broken = await run(api, ["readiness", "ready-broken", "--json"]);
    expect(broken.exitCode).toBe(2);
    const payload = JSON.parse(broken.stdout) as { exitCode: number; publishable: boolean; gates: { id: string; status: string }[] };
    expect(payload.exitCode).toBe(2);
    expect(payload.gates.find((gate) => gate.id === "assets")).toMatchObject({ status: "fail" });
    expect(broken.stderr).toContain("not ready to publish");
  });

  test("publish --verify refuses a failing prototype without publishing, --force overrides a blocked gate", async () => {
    const { api, db } = await setup();
    const assetId = await uploadAsset(api);
    await saveDoc(api, await assetDoc("verify-broken", assetId));
    dropAssets(db);

    const refused = await run(api, ["publish", "verify-broken", "--verify", "--json"]);
    expect(refused.exitCode).toBe(2);
    const payload = JSON.parse(refused.stdout) as { published: boolean; refusedBy: string[]; exitCode: number };
    expect(payload).toMatchObject({ published: false, exitCode: 2 });
    expect(payload.refusedBy).toContain("assets");
    expect(await (await fetch(`${api}/prototypes/verify-broken/versions`)).json()).toEqual([]);

    // The same prototype publishes once the server-side gate is overridden with --force.
    process.env.EASYUI_PUBLISH_GATES = "assets";
    try {
      const blocked = await run(api, ["publish", "verify-broken", "--json"]);
      expect(blocked.exitCode).toBe(2);
      const blockedPayload = JSON.parse(blocked.stdout) as { published: boolean; blocking: string[] };
      expect(blockedPayload).toMatchObject({ published: false });
      expect(blockedPayload.blocking).toContain("assets");
      expect(blocked.stderr).toContain("--force");

      const forced = await run(api, ["publish", "verify-broken", "--force", "--json"]);
      expect(forced.exitCode).toBe(0);
      expect(JSON.parse(forced.stdout)).toMatchObject({ published: true, version: 1, forced: true });
    } finally {
      delete process.env.EASYUI_PUBLISH_GATES;
    }
  });

  test("publish reports the new version and surfaces 409 publish_blocked as a report", async () => {
    const { api } = await setup();
    await saveDoc(api, await fixture("publish-ok"));
    const published = await run(api, ["publish", "publish-ok", "--verify", "--json"]);
    expect(published.exitCode).toBe(0);
    expect(JSON.parse(published.stdout)).toMatchObject({ command: "publish", published: true, version: 1, rev: 1, verified: true });

    // Head is now identical to the published version: the publishDiff gate warns, and a
    // `warn` threshold turns that warning into a server-side 409 publish_blocked.
    process.env.EASYUI_PUBLISH_GATES = "publishDiff:warn";
    try {
      const blocked = await run(api, ["publish", "publish-ok"]);
      expect(blocked.exitCode).toBe(2);
      expect(blocked.stdout).toContain("publish blocked by readiness gates");
      expect(blocked.stdout).toContain("publishDiff");
    } finally {
      delete process.env.EASYUI_PUBLISH_GATES;
    }
  });
});

describe("author driver usages and audit verbs", () => {
  test("usages prints head and immutable usages, --tree switches the server format", async () => {
    const { api, db } = await setup();
    seedComponent(db, "stars", "Stars");
    seedPinnedPrototype(db, "checkout", "stars", "Stars");
    const flat = await run(api, ["usages", "stars"]);
    expect(flat.exitCode).toBe(0);
    expect(flat.stdout).toContain("head usages: 1");
    expect(flat.stdout).toContain("checkout rev=1 v1");
    expect(flat.stdout).toContain("immutable usages: 0");

    const tree = await run(api, ["usages", "stars", "--tree", "--json"]);
    expect(tree.exitCode).toBe(0);
    expect(JSON.parse(tree.stdout)).toMatchObject({ command: "usages", format: "tree", nodes: [{ kind: "prototype", id: "checkout" }] });

    const humanTree = await run(api, ["usages", "stars", "--tree"]);
    expect(humanTree.stdout).toContain("prototype checkout");
    expect(humanTree.stdout).toContain("element root");
  });

  test("audit sweeps a design system and exits 2 on deprecated components still used at head", async () => {
    const { api, db } = await setup();
    seedComponent(db, "stars", "Stars");
    seedComponent(db, "old-card", "OldCard", { deprecated: true });
    seedComponent(db, "orphan", "Orphan");
    seedPinnedPrototype(db, "checkout", "stars", "Stars");
    seedPinnedPrototype(db, "legacy", "old-card", "OldCard");

    const result = await run(api, ["audit", "--design-system", "yandex-pay", "--json"]);
    expect(result.exitCode).toBe(2);
    const payload = JSON.parse(result.stdout) as {
      exitCode: number;
      components: { id: string; version: number; status: string; scope: string | null; headUsageCount: number }[];
      findings: { deprecatedInUse: string[]; unused: string[] };
    };
    expect(payload.exitCode).toBe(2);
    expect(payload.components.find((row) => row.id === "old-card")).toMatchObject({ status: "deprecated", version: 1, headUsageCount: 1, scope: "screen" });
    expect(payload.components.find((row) => row.id === "stars")).toMatchObject({ status: "active", headUsageCount: 1 });
    expect(payload.findings).toEqual({ deprecatedInUse: ["old-card"], unused: ["orphan"] });

    const human = await run(api, ["audit", "--design-system", "yandex-pay"]);
    expect(human.exitCode).toBe(2);
    expect(human.stdout).toContain("component\tversion\tstatus\tscope\tcanonicalFor\theadUsages");
    expect(human.stdout).toContain("deprecated with head usages: old-card");
    expect(human.stdout).toContain("no head usages: orphan");

    const missing = await run(api, ["audit", "--design-system", "missing-system"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("get design-systems");
  });

  /**
   * `audit reuse` — чтение админского аудита гейта (план §4 T7/T10, спека §5). Решения
   * сидятся репозиторием: настоящий гейт платит extract+typecheck в подпроцессе на каждое
   * создание, а формат отчёта от этого не зависит.
   */
  test("audit reuse reads the gate audit and honours --json", async () => {
    const { api, db } = await setup();
    seedComponent(db, "legacy-card", "LegacyCard");
    const repo = new ReuseDecisionRepo(db);
    const base = {
      artifactKind: "component" as const,
      artifactId: "proposed-badge",
      designSystem: "yandex-pay",
      sourceOrDocHash: "sha",
      catalogRevision: "rev-1",
      policyVersion: 1,
      gateMode: "enforce" as const,
      intent: "Status badge for the order card",
      candidates: [{ id: "legacy-card", score: 0.9, blocking: true, reasons: ["same props/events/slots signature"] }],
    };
    repo.record({ ...base, actorId: "user_alice", decision: "blocked" });
    repo.record({ ...base, actorId: "user_alice", decision: "blocked" });
    repo.record({ ...base, actorId: "user_alice", gateMode: "shadow", decision: "would_block" });
    repo.record({ ...base, actorId: "user_admin", decision: "force_new", reason: "Approved: independent lifecycle" });
    repo.record({ ...base, actorId: "user_alice", artifactId: "role-clash", decision: "blocked", reason: "canonical_role_conflict:payment-success" });

    const json = await run(api, ["audit", "reuse", "--json"]);
    expect(json.exitCode).toBe(0);
    const payload = JSON.parse(json.stdout) as {
      command: string;
      totals: { decisions: number; byDecision: Record<string, number> };
      forceNew: { actorId: string }[];
      repeatedBlocked: { actorId: string; artifactId: string; attempts: number }[];
      canonicalRoleConflicts: { roles: string[] }[];
      wouldBlock: { total: number; actors: number };
      unreviewed: { total: number; artifacts: { id: string }[] };
    };
    expect(payload.command).toBe("audit reuse");
    expect(payload.totals.byDecision).toMatchObject({ blocked: 3, would_block: 1, force_new: 1 });
    expect(payload.forceNew).toEqual([expect.objectContaining({ actorId: "user_admin" })]);
    expect(payload.repeatedBlocked).toEqual([expect.objectContaining({ actorId: "user_alice", artifactId: "proposed-badge", attempts: 3 })]);
    expect(payload.canonicalRoleConflicts).toEqual([expect.objectContaining({ roles: ["payment-success"] })]);
    expect(payload.wouldBlock).toMatchObject({ total: 1, actors: 1 });
    expect(payload.unreviewed.artifacts).toEqual([expect.objectContaining({ id: "legacy-card" })]);

    const human = await run(api, ["audit", "reuse", "--design-system", "yandex-pay", "--min-attempts", "2", "--limit", "5"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("force-new overrides: 1");
    expect(human.stdout).toContain("repeated blocked attempts: 1");
    expect(human.stdout).toContain("canonical role conflicts: 1");
    expect(human.stdout).toContain("would_block: 1 across 1 actors");
    expect(human.stdout).toContain("artifacts never reuse-reviewed: 1");

    // Фильтр окна доезжает до сервера: за окном отчёт пуст, но команда успешна.
    const future = new Date(Date.now() + 60_000).toISOString();
    const empty = await run(api, ["audit", "reuse", "--since", future, "--json"]);
    expect(empty.exitCode).toBe(0);
    expect((JSON.parse(empty.stdout) as { totals: { decisions: number } }).totals.decisions).toBe(0);
  });

  test("audit reuse formats a report without a server", () => {
    const lines = reuseAuditLines({
      generatedAt: "2026-07-31T00:00:00.000Z",
      gateActiveSince: "2026-07-30T00:00:00.000Z",
      filter: { designSystem: "yandex-pay", limit: 100, minAttempts: 2 },
      totals: { decisions: 2, actors: 1, byDecision: { blocked: 2 }, byGateMode: { enforce: 2 } },
      forceNew: [],
      repeatedBlocked: [{
        actorId: "user_alice", artifactKind: "component", artifactId: "proposed-badge", designSystem: "yandex-pay",
        attempts: 2, blocked: 2, wouldBlock: 0, firstAt: "2026-07-30T00:00:00.000Z", lastAt: "2026-07-30T01:00:00.000Z",
        lastDecisionId: "reuse_1", lastReason: null, candidateIds: ["legacy-card"],
      }],
      canonicalRoleConflicts: [],
      wouldBlock: { total: 0, actors: 0, byActor: [], decisions: [] },
      unreviewed: { total: 0, artifacts: [] },
    });
    expect(lines[0]).toContain("2 decisions from 1 actors");
    expect(lines[0]).toContain("gate active since 2026-07-30T00:00:00.000Z");
    expect(lines.join("\n")).toContain("user_alice\tcomponent/proposed-badge\t2\t2\t0");
    expect(lines.join("\n")).toContain("(designSystem=yandex-pay)");
  });

  test("parser guards the new verbs", async () => {
    const { api } = await setup();
    const noSystem = await run(api, ["audit"]);
    expect(noSystem.exitCode).toBe(1);
    expect(noSystem.stderr).toContain("audit requires --design-system");
    const extra = await run(api, ["readiness", "a", "b"]);
    expect(extra.exitCode).toBe(1);
    expect(extra.stderr).toContain("invalid arguments for readiness");
    const unknownFlag = await run(api, ["usages", "stars", "--wat"]);
    expect(unknownFlag.exitCode).toBe(1);
    expect(unknownFlag.stderr).toContain("unknown flag for usages");
    const badVerb = await run(api, ["publish"]);
    expect(badVerb.exitCode).toBe(1);
    expect(badVerb.stderr).toContain("invalid arguments for publish");
    // Флаги привязаны к подкоманде: аудит-фильтры не должны молча приниматься каталожным sweep.
    const crossFlag = await run(api, ["audit", "--design-system", "yandex-pay", "--min-attempts", "3"]);
    expect(crossFlag.exitCode).toBe(1);
    expect(crossFlag.stderr).toContain("unknown flag for audit: --min-attempts");
    const unknownAuditFlag = await run(api, ["audit", "reuse", "--full"]);
    expect(unknownAuditFlag.exitCode).toBe(1);
    expect(unknownAuditFlag.stderr).toContain("unknown flag for audit reuse: --full");
    // `audit reuse` не требует --design-system: аудит гейта сквозной.
    const badAuditArgs = await run(api, ["audit", "reuse", "extra"]);
    expect(badAuditArgs.exitCode).toBe(1);
    expect(badAuditArgs.stderr).toContain("invalid arguments for audit reuse");
    const strayPositional = await run(api, ["audit", "sweep", "--design-system", "yandex-pay"]);
    expect(strayPositional.exitCode).toBe(1);
    expect(strayPositional.stderr).toContain("invalid arguments for audit");
    const badAttempts = await run(api, ["audit", "reuse", "--min-attempts", "1"]);
    expect(badAttempts.exitCode).toBe(1);
    expect(badAttempts.stderr).toContain("--min-attempts must be an integer from 2 to 50");
    // RFC candidate-acceptance R1: promote берёт ровно один компонент, `audit --versions`
    // снимает --design-system с обязательных.
    const noComponent = await run(api, ["promote"]);
    expect(noComponent.exitCode).toBe(1);
    expect(noComponent.stderr).toContain("invalid arguments for promote");
    const badSupersede = await run(api, ["promote", "stars", "--supersede", "maybe"]);
    expect(badSupersede.exitCode).toBe(1);
    expect(badSupersede.stderr).toContain("--supersede must be one of: auto, none");
    const strayPromoteFlag = await run(api, ["promote", "stars", "--tree"]);
    expect(strayPromoteFlag.exitCode).toBe(1);
    expect(strayPromoteFlag.stderr).toContain("unknown flag for promote: --tree");
    // W1c: `accept`/`accept-status` берут ровно один аргумент, а `--timeout-sec` ограничен.
    const noAcceptTarget = await run(api, ["accept"]);
    expect(noAcceptTarget.exitCode).toBe(1);
    expect(noAcceptTarget.stderr).toContain("invalid arguments for accept");
    const badTimeout = await run(api, ["accept", "stars", "--timeout-sec", "2"]);
    expect(badTimeout.exitCode).toBe(1);
    expect(badTimeout.stderr).toContain("--timeout-sec must be an integer from 10 to 7200");
    const strayAcceptFlag = await run(api, ["accept", "stars", "--supersede", "auto"]);
    expect(strayAcceptFlag.exitCode).toBe(1);
    expect(strayAcceptFlag.stderr).toContain("unknown flag for accept: --supersede");
  });
});

/**
 * RFC candidate-acceptance-pipeline, волна R1: верб `promote` (validate → promote одной
 * командой) и KPI-срез `audit --versions`.
 */
describe("author driver promote verb", () => {
  test("promote accepts the saved head as one public version and refuses to repeat itself", async () => {
    const { api, directory } = await setup();
    const source = await writeComponentSource(directory, "PromoteCli", "Promote CLI fixture", "one");
    const created = await run(api, ["component", "promote-cli", "PromoteCli", source, "--design-system", "yandex-pay", "--intent", "Accepts a checkout confirmation press"]);
    expect(created.exitCode).toBe(0);

    // Голова уже опубликована первым вызовом — promote обязан отказать читаемо и терминально.
    const repeated = await run(api, ["promote", "promote-cli"]);
    expect(repeated.exitCode).toBe(2);
    expect(repeated.stderr).toContain("already_published");
    expect(repeated.stderr).toContain("save a new revision");

    const next = await writeComponentSource(directory, "PromoteCli", "Promote CLI fixture", "two");
    const saved = await fetch(`${api}/components/promote-cli`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: new URL(api).origin },
      body: JSON.stringify({ source: await Bun.file(next).text(), baseRev: 1, message: "cli promote fixture" }),
    });
    expect(saved.status).toBe(200);

    const promoted = await run(api, ["promote", "promote-cli", "--json"]);
    expect(promoted.exitCode).toBe(0);
    const payload = JSON.parse(promoted.stdout) as { command: string; version: number; superseded: number[]; sourceHash: string; catalogRevision: string };
    expect(payload).toMatchObject({ command: "promote", id: "promote-cli", version: 2, superseded: [1] });
    expect(payload.sourceHash).toMatch(/^[0-9a-f]{64}$/);

    const versions = await (await fetch(`${api}/components/promote-cli/versions`)).json() as { version: number; status: string }[];
    expect(versions.map((row) => [row.version, row.status])).toEqual([[1, "superseded"], [2, "active"]]);
  }, 180_000);

  /** W1c: `--refresh` держит форму сервера (`none|failed|all|{caseIds}`), а не булеву деградацию. */
  test("accept parses --refresh into the server's shape", () => {
    expect(parseArgs(["accept", "pay-card", "--refresh", "failed"])).toMatchObject({ cmd: "accept", args: ["pay-card"], flags: { refresh: "failed" } });
    expect(parseArgs(["accept", "pay-card", "--refresh", "alpha, beta"])).toMatchObject({ flags: { refresh: { caseIds: ["alpha", "beta"] } } });
    expect(parseArgs(["accept", "pay-card", "--policy", "pixel-strict-v1", "--json"])).toMatchObject({ flags: { policy: "pixel-strict-v1", json: true } });
    expect(parseArgs(["accept-status", "acc_1", "--evidence", "run.zip"])).toMatchObject({ cmd: "accept-status", args: ["acc_1"], flags: { evidence: "run.zip" } });
  });

  /** W2: `case-set` — подкоманда в первом позиционале, арность проверяется до сети. */
  test("case-set parses its subcommands and refuses malformed argument lists", () => {
    expect(parseArgs(["case-set", "put", "pay-card", "matrix.json"]))
      .toMatchObject({ cmd: "case-set", args: ["put", "pay-card", "matrix.json"] });
    expect(parseArgs(["case-set", "get", `cset_${"0".repeat(64)}`, "--json"]))
      .toMatchObject({ cmd: "case-set", args: ["get", `cset_${"0".repeat(64)}`], flags: { json: true } });
    expect(parseArgs(["case-set", "coverage", `cset_${"0".repeat(64)}`]))
      .toMatchObject({ cmd: "case-set", args: ["coverage", `cset_${"0".repeat(64)}`] });
    for (const args of [["case-set", "list", "pay-card"], ["case-set", "put", "pay-card"], ["case-set", "get", "a", "b"]]) {
      expect(() => parseArgs(args)).toThrow();
    }
    // Ран по опубликованному набору: `--case-set` уезжает в тело постановки как `caseSetId`.
    expect(parseArgs(["accept", "pay-card", "--case-set", `cset_${"0".repeat(64)}`]))
      .toMatchObject({ cmd: "accept", flags: { caseSet: `cset_${"0".repeat(64)}` } });
  });

  /** Деградация без матричного стека: читаемое сообщение вместо серии 404 по ручкам. */
  test("accept refuses readably when the server has no acceptance matrix", async () => {
    const { api, db } = await setup();
    seedComponent(db, "matrixless", "Matrixless");
    for (const args of [["accept", "matrixless"], ["accept-status", "acc_00000000-0000-0000-0000-000000000000"], ["case-set", "coverage", `cset_${"0".repeat(64)}`]]) {
      const result = await run(api, args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("features.acceptanceMatrix is off");
    }
  }, 60_000);

  test("promote fails readably against a server with the acceptance kill-switch on", async () => {
    const { api, db } = await setup(undefined, undefined, { acceptanceDisabled: true });
    seedComponent(db, "killed", "Killed");
    const result = await run(api, ["promote", "killed"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("features.acceptancePromote is off");
  });
});

/**
 * План 2026-08-04 §W2a (P0-1 + D5): линковка promote с кандидатом/раном и CLI-половина алгебры
 * refresh. Матричный стек здесь не нужен целиком — проверяется контракт **клиента**: какие поля
 * уезжают в тело, что печатается до мутации и какие расхождения ловятся локально (без POST).
 * Поэтому сервер — скриптованный stub, а не полный handler: он позволяет подсунуть кандидата
 * «не той сборки» и ран чужого кандидата, чего живой оркестратор по построению не создаст.
 */
interface StubCall { method: string; path: string; body: Record<string, unknown> | null }
type StubReply = { status?: number; json: unknown };

async function stubApi(routes: Record<string, (body: Record<string, unknown> | null) => StubReply>) {
  await testDirectory();
  const calls: StubCall[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const raw = request.method === "GET" ? "" : await request.text();
      let body: Record<string, unknown> | null = null;
      try { body = raw ? JSON.parse(raw) as Record<string, unknown> : null; } catch { body = null; }
      const headers = { "content-type": "application/json" };
      if (url.pathname === "/api/auth/login") {
        return new Response("{}", { headers: { ...headers, "set-cookie": "easyui_session=stub-session-token; Path=/" } });
      }
      calls.push({ method: request.method, path: url.pathname, body });
      const route = routes[`${request.method} ${url.pathname}`];
      if (!route) return new Response(JSON.stringify({ error: { code: "not_found", message: `stub has no route for ${request.method} ${url.pathname}` } }), { status: 404, headers });
      const reply = route(body);
      return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200, headers });
    },
  });
  servers.push(server);
  return { api: `http://127.0.0.1:${server.port}/api`, calls, promotes: () => calls.filter((call) => call.path.endsWith("/promote")) };
}

const SOURCE_HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const CANDIDATE = "cand_00000000-0000-0000-0000-0000000000aa";
const OTHER_CANDIDATE = "cand_00000000-0000-0000-0000-0000000000bb";
const RUN = "acc_00000000-0000-0000-0000-000000000011";

function promoteStubRoutes(overrides: { candidate?: Record<string, unknown>; run?: Record<string, unknown> } = {}) {
  const candidate = { candidateId: CANDIDATE, componentId: "linked", rev: 2, sourceHash: SOURCE_HASH, status: "validated", ...overrides.candidate };
  const acceptanceRun = { runId: RUN, componentId: "linked", candidateId: CANDIDATE, status: "pass", policy: { id: "default-v1" }, ...overrides.run };
  return {
    "GET /api/capabilities": () => ({ json: { features: { acceptancePromote: true, acceptanceMatrix: true } } }),
    "GET /api/components/linked": () => ({ json: { id: "linked", headRev: 2, designSystem: "yandex-pay" } }),
    "POST /api/components/linked/validate": () => ({ json: { sourceHash: SOURCE_HASH, bundleHash: "bundle", catalogRevision: "cat-1", warnings: [] } }),
    [`GET /api/component-candidates/${CANDIDATE}`]: () => ({ json: candidate }),
    [`GET /api/acceptance-runs/${RUN}`]: () => ({ json: acceptanceRun }),
    "POST /api/components/linked/promote": (body: Record<string, unknown> | null) => ({
      status: 201,
      json: {
        version: 3, rev: 2, sourceHash: SOURCE_HASH, bundleHash: "bundle", hostAbiVersion: 4, themeVersion: 7,
        catalogRevision: "cat-1", superseded: [2], candidateId: body?.candidateId ?? null, acceptanceRunId: body?.acceptanceRunId ?? null,
      },
    }),
  } as Record<string, (body: Record<string, unknown> | null) => StubReply>;
}

describe("author driver promote linking (W2a)", () => {
  test("--candidate/--acceptance-run reach the promote body and both ids are reported", async () => {
    const { api, calls, promotes } = await stubApi(promoteStubRoutes());
    const human = await run(api, ["promote", "linked", "--candidate", CANDIDATE, "--acceptance-run", RUN]);
    expect(human.exitCode).toBe(0);
    // Связка печатается до мутации — и до строки о созданной версии.
    expect(human.stdout).toContain(`acceptance link: candidate=${CANDIDATE} (rev 2, validated) run=${RUN} (pass, policy default-v1)`);
    expect(human.stdout.indexOf("acceptance link:")).toBeLessThan(human.stdout.indexOf("promoted linked version"));
    expect(human.stdout).toContain(`acceptance: candidate=${CANDIDATE} run=${RUN}`);
    expect(promotes()[0]?.body).toMatchObject({ baseRev: 2, sourceHash: SOURCE_HASH, candidateId: CANDIDATE, acceptanceRunId: RUN });
    expect(calls.some((call) => call.path === `/api/component-candidates/${CANDIDATE}`)).toBe(true);

    const json = await run(api, ["promote", "linked", "--candidate", CANDIDATE, "--acceptance-run", RUN, "--json"]);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ command: "promote", id: "linked", version: 3, candidateId: CANDIDATE, acceptanceRunId: RUN });
  }, 30_000);

  test("promote without the flags stays unlinked and sends neither id", async () => {
    const { api, promotes } = await stubApi(promoteStubRoutes());
    const result = await run(api, ["promote", "linked"]);
    expect(result.exitCode).toBe(0);
    expect(Object.keys(promotes()[0]?.body ?? {})).not.toContain("candidateId");
    expect(result.stdout).toContain("acceptance: candidate=- run=-");
  }, 30_000);

  test("a candidate of another build is refused locally, without the promote POST", async () => {
    const { api, promotes } = await stubApi(promoteStubRoutes({ candidate: { sourceHash: OTHER_HASH } }));
    const result = await run(api, ["promote", "linked", "--candidate", CANDIDATE]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("describes another build");
    expect(promotes()).toHaveLength(0);
  }, 30_000);

  test("a candidate for an older revision is refused locally, without the promote POST", async () => {
    const { api, promotes } = await stubApi(promoteStubRoutes({ candidate: { rev: 1 } }));
    const result = await run(api, ["promote", "linked", "--candidate", CANDIDATE]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("is for rev 1, the head is rev 2");
    expect(promotes()).toHaveLength(0);
  }, 30_000);

  test("a run of another candidate is refused locally, without the promote POST", async () => {
    const { api, promotes } = await stubApi(promoteStubRoutes({ run: { candidateId: OTHER_CANDIDATE } }));
    const result = await run(api, ["promote", "linked", "--candidate", CANDIDATE, "--acceptance-run", RUN]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`belongs to candidate ${OTHER_CANDIDATE}`);
    expect(promotes()).toHaveLength(0);
  }, 30_000);

  test("a run of another component is refused locally, without the promote POST", async () => {
    const { api, promotes } = await stubApi(promoteStubRoutes({ run: { componentId: "other" } }));
    const result = await run(api, ["promote", "linked", "--acceptance-run", RUN]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("belongs to component other");
    expect(promotes()).toHaveLength(0);
  }, 30_000);

  test("two --acceptance-run values are refused locally (multi-run lands in W7)", async () => {
    const { api, promotes } = await stubApi(promoteStubRoutes());
    const result = await run(api, ["promote", "linked", "--acceptance-run", RUN, "--acceptance-run", "acc_00000000-0000-0000-0000-000000000022"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("multi-run promote is not supported by the server yet");
    expect(promotes()).toHaveLength(0);
    // Парсер уже копит значения — задел под W7 не ломает разбор.
    expect(parseArgs(["promote", "linked", "--acceptance-run", "acc_1", "--acceptance-run", "acc_2"]))
      .toMatchObject({ cmd: "promote", flags: { acceptanceRun: ["acc_1", "acc_2"] } });
  }, 30_000);

  test("linking without the matrix stack is refused before the mutation", async () => {
    const routes = { ...promoteStubRoutes(), "GET /api/capabilities": () => ({ json: { features: { acceptancePromote: true, acceptanceMatrix: false } } }) };
    const { api, promotes } = await stubApi(routes);
    const result = await run(api, ["promote", "linked", "--candidate", CANDIDATE]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("features.acceptanceMatrix is off");
    expect(promotes()).toHaveLength(0);
  }, 30_000);

  test("usage documents the linking flags and the refresh/recapture scopes", async () => {
    const { api } = await stubApi(promoteStubRoutes());
    const result = await run(api, []);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[--candidate <candidateId>] [--acceptance-run <runId>]");
    expect(result.stderr).toContain("[--recapture]");
    expect(result.stderr).toContain("--refresh failed = re-evaluate the verdict only");
    expect(result.stderr).toContain("--recapture = force a re-capture");
  }, 30_000);
});

/**
 * План 2026-08-04 §W2b: автовыбор связки promote без флагов. Проверяется ровно то, что делает
 * клиент: откуда он берёт раны (сеть, не кэш), какой из них выбирает (`promotionEligible`, не
 * скалярный `acceptanceRunId`) и что делает при 0 и ≥2 подходящих.
 */
const RUN_SECOND = "acc_00000000-0000-0000-0000-000000000022";
const RUN_FAILED = "acc_00000000-0000-0000-0000-000000000033";

type StubRunEntry = { runId: string; status: string; policyProfileId: string; caseSetId: string | null; finishedAt: string | null; promotionEligible: boolean };

function stubRun(runId: string, overrides: Partial<StubRunEntry> = {}): StubRunEntry {
  return { runId, status: "pass", policyProfileId: "pixel-strict-v1", caseSetId: "cset_x", finishedAt: "2026-08-04T10:00:00.000Z", promotionEligible: true, ...overrides };
}

/** Кандидат головы с подставляемым `runs[]`: список меняется между вызовами драйвера. */
function autoLinkRoutes(state: { runs: StubRunEntry[]; scalarRunId?: string | null }) {
  return {
    ...promoteStubRoutes(),
    "POST /api/components/linked/candidates": () => ({ json: { candidateId: CANDIDATE, componentId: "linked", rev: 2, sourceHash: SOURCE_HASH, cached: true, warnings: [] } }),
    [`GET /api/component-candidates/${CANDIDATE}`]: () => ({
      json: {
        candidateId: CANDIDATE, componentId: "linked", rev: 2, sourceHash: SOURCE_HASH, status: "validated",
        // Скалярное поле — «последний поставленный» ран: автовыбор обязан его игнорировать (C4).
        acceptanceRunId: state.scalarRunId === undefined ? RUN_FAILED : state.scalarRunId,
        runs: state.runs,
      },
    }),
  } as Record<string, (body: Record<string, unknown> | null) => StubReply>;
}

describe("author driver promote auto-link (W2b)", () => {
  test("a single promotion-eligible run is picked without flags and reaches the promote body", async () => {
    const state = { runs: [stubRun(RUN)] };
    const { api, calls, promotes } = await stubApi(autoLinkRoutes(state));
    const result = await run(api, ["promote", "linked"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`acceptance link: candidate=${CANDIDATE} (rev 2, validated) run=${RUN} (pass, policy pixel-strict-v1) (auto-selected from the candidate runs)`);
    expect(result.stdout.indexOf("acceptance link:")).toBeLessThan(result.stdout.indexOf("promoted linked version"));
    expect(promotes()[0]?.body).toMatchObject({ candidateId: CANDIDATE, acceptanceRunId: RUN });
    // Кандидат головы читается идемпотентным POST, раны — сетевым GET candidate-view.
    expect(calls.some((call) => call.method === "POST" && call.path === "/api/components/linked/candidates")).toBe(true);
    expect(calls.some((call) => call.method === "GET" && call.path === `/api/component-candidates/${CANDIDATE}`)).toBe(true);

    const json = await run(api, ["promote", "linked", "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({ command: "promote", candidateId: CANDIDATE, acceptanceRunId: RUN, acceptanceLinkSource: "auto" });
  }, 30_000);

  test("a warm cache with a stale candidate-view does not hide a fresh run", async () => {
    const state: { runs: StubRunEntry[] } = { runs: [] };
    const { api, promotes } = await stubApi(autoLinkRoutes(state));
    const cacheDir = resolve(await testDirectory(), "cache");
    // Первый прогон греет кэш кандидатом без ранов (fresh-TTL — 5 минут).
    const cold = await run(api, ["promote", "linked", "--cache-dir", cacheDir]);
    expect(cold.exitCode).toBe(0);
    expect(Object.keys(promotes()[0]?.body ?? {})).not.toContain("candidateId");
    // Ран появился после прогрева: тёплая запись про него не знает, а автовыбор — обязан.
    state.runs = [stubRun(RUN)];
    const warm = await run(api, ["promote", "linked", "--cache-dir", cacheDir]);
    expect(warm.exitCode).toBe(0);
    expect(promotes()[1]?.body).toMatchObject({ candidateId: CANDIDATE, acceptanceRunId: RUN });
  }, 30_000);

  test("no eligible run keeps promote unlinked with a warning; the scalar acceptanceRunId is not a source", async () => {
    const state = { runs: [stubRun(RUN_FAILED, { status: "fail", promotionEligible: false })], scalarRunId: RUN_FAILED };
    const { api, promotes } = await stubApi(autoLinkRoutes(state));
    const result = await run(api, ["promote", "linked"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no promotion-eligible acceptance run");
    expect(result.stdout).toContain("acceptance: candidate=- run=-");
    expect(Object.keys(promotes()[0]?.body ?? {})).not.toContain("candidateId");
    expect(Object.keys(promotes()[0]?.body ?? {})).not.toContain("acceptanceRunId");
  }, 30_000);

  test("a failed run next to an eligible one is not picked", async () => {
    const state = { runs: [stubRun(RUN_FAILED, { status: "fail", promotionEligible: false }), stubRun(RUN)] };
    const { api, promotes } = await stubApi(autoLinkRoutes(state));
    const result = await run(api, ["promote", "linked"]);
    expect(result.exitCode).toBe(0);
    expect(promotes()[0]?.body).toMatchObject({ candidateId: CANDIDATE, acceptanceRunId: RUN });
  }, 30_000);

  test("two eligible runs are an ambiguity: local error with the list, zero promote POSTs", async () => {
    const state = { runs: [stubRun(RUN), stubRun(RUN_SECOND, { policyProfileId: "default-v1", finishedAt: "2026-08-04T11:00:00.000Z" })] };
    const { api, promotes } = await stubApi(autoLinkRoutes(state));
    const result = await run(api, ["promote", "linked"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("2 runs of candidate");
    expect(result.stderr).toContain(`${RUN} status=pass policy=pixel-strict-v1 finished=2026-08-04T10:00:00.000Z`);
    expect(result.stderr).toContain(`${RUN_SECOND} status=pass policy=default-v1 finished=2026-08-04T11:00:00.000Z`);
    expect(promotes()).toHaveLength(0);
  }, 30_000);

  test("without the matrix stack promote does not even look for a candidate", async () => {
    const routes = {
      ...autoLinkRoutes({ runs: [stubRun(RUN)] }),
      "GET /api/capabilities": () => ({ json: { features: { acceptancePromote: true, acceptanceMatrix: false } } }),
    } as Record<string, (body: Record<string, unknown> | null) => StubReply>;
    const { api, calls, promotes } = await stubApi(routes);
    const result = await run(api, ["promote", "linked"]);
    expect(result.exitCode).toBe(0);
    expect(calls.some((call) => call.path === "/api/components/linked/candidates")).toBe(false);
    expect(Object.keys(promotes()[0]?.body ?? {})).not.toContain("candidateId");
  }, 30_000);
});

/** План 2026-08-04 §W2a (D5): `--recapture` — скоуп, `--refresh` — выбор случаев. */
describe("author driver accept refresh algebra (W2a)", () => {
  const acceptRoutes = (refresh: unknown) => ({
    "GET /api/capabilities": () => ({ json: { features: { acceptanceMatrix: true } } }),
    "GET /api/components/refreshed": () => ({ json: { id: "refreshed", headRev: 1, designSystem: "yandex-pay" } }),
    "POST /api/components/refreshed/candidates": () => ({ json: { candidateId: CANDIDATE, rev: 1, warnings: [] } }),
    "POST /api/acceptance-runs": () => ({ status: 202, json: { runId: RUN, cases: 3 } }),
    [`GET /api/acceptance-runs/${RUN}`]: () => ({
      json: {
        runId: RUN, candidateId: CANDIDATE, componentId: "refreshed", status: "pass", policy: { id: "default-v1" },
        progress: { completed: 3, total: 3, reused: 2, failed: 0 }, failedCases: [],
        ...(refresh === undefined ? {} : { refresh }),
      },
    }),
  } as Record<string, (body: Record<string, unknown> | null) => StubReply>);

  test("--recapture escalates the refresh scope in the run body; without it the field is absent", async () => {
    const { api, calls } = await stubApi(acceptRoutes(undefined));
    const escalated = await run(api, ["accept", "refreshed", "--refresh", "failed", "--recapture"]);
    expect(escalated.exitCode).toBe(0);
    expect(calls.find((call) => call.path === "/api/acceptance-runs")?.body).toMatchObject({ refresh: "failed", refreshMode: "frame" });

    const plain = await run(api, ["accept", "refreshed", "--refresh", "failed"]);
    expect(plain.exitCode).toBe(0);
    const bodies = calls.filter((call) => call.path === "/api/acceptance-runs");
    expect(Object.keys(bodies[1]?.body ?? {})).not.toContain("refreshMode");
  }, 30_000);

  test("the run's refresh triple is printed and stays in --json; an older server just omits it", async () => {
    const withTriple = await stubApi(acceptRoutes({ requested: { mode: "failed", scope: "verdict" }, impact: { mode: "none" }, effective: { mode: "failed", scope: "frame", caseIds: ["alpha", "beta"] } }));
    const human = await run(withTriple.api, ["accept", "refreshed", "--refresh", "failed", "--recapture"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("refresh: requested=failed:verdict impact=none effective=failed:frame [alpha,beta]");

    const asJson = await run(withTriple.api, ["accept", "refreshed", "--refresh", "failed", "--json"]);
    expect(JSON.parse(asJson.stdout)).toMatchObject({ refresh: { effective: { scope: "frame" } } });

    // Обратная совместимость: сервер до W1 поля не отдаёт — строки просто нет.
    const legacy = await stubApi(acceptRoutes(undefined));
    const older = await run(legacy.api, ["accept", "refreshed", "--refresh", "failed"]);
    expect(older.exitCode).toBe(0);
    expect(older.stdout).not.toContain("refresh:");
  }, 30_000);

  test("--recapture contradicts --refresh none and is rejected by the parser", () => {
    expect(parseArgs(["accept", "pay-card", "--refresh", "failed", "--recapture"]))
      .toMatchObject({ cmd: "accept", flags: { refresh: "failed", recapture: true } });
    expect(() => parseArgs(["accept", "pay-card", "--refresh", "none", "--recapture"])).toThrow(/--recapture contradicts --refresh none/);
  });
});

describe("author driver audit --versions (KPI, RFC §9)", () => {
  test("sweeps public versions per component and exits 2 when a component has no active version", async () => {
    const { api, db } = await setup();
    seedComponent(db, "stars", "Stars");
    seedComponent(db, "old-card", "OldCard", { deprecated: true });
    const altSystem = await fetch(`${api}/design-systems`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: new URL(api).origin },
      body: JSON.stringify({ id: "driver-alt", name: "Driver Alt", description: "Second design system for the version audit" }),
    });
    expect(altSystem.status).toBe(201);
    seedComponent(db, "other-ds", "OtherDs", { designSystem: "driver-alt" });
    // Единственная active-версия уведена вручную — компонент выпал из каталога.
    db.query("UPDATE component_publishes SET status='deprecated' WHERE component_id='stars' AND version=1").run();

    const result = await run(api, ["audit", "--versions", "--design-system", "yandex-pay", "--json"]);
    expect(result.exitCode).toBe(2);
    const payload = JSON.parse(result.stdout) as {
      command: string; exitCode: number;
      components: { id: string; versions: number; active: number }[];
      findings: { published: number; totalVersions: number; versionsPerComponent: number; noActiveVersion: string[] };
    };
    expect(payload.command).toBe("audit versions");
    expect(payload.components.map((row) => row.id)).toEqual(["old-card", "stars"]);
    expect(payload.components.find((row) => row.id === "old-card")).toMatchObject({ versions: 2, active: 1 });
    expect(payload.findings).toMatchObject({ published: 2, totalVersions: 3, versionsPerComponent: 1.5, noActiveVersion: ["stars"] });

    const human = await run(api, ["audit", "--versions"]);
    expect(human.exitCode).toBe(2);
    expect(human.stdout).toContain("component\tdesignSystem\tversions\tactive\tlatest\tstatuses\tacceptance\tfirstPublishedAt\tlastPublishedAt");
    // Колонка «есть/нет acceptance evidence» (RFC §12.6(в)): каталог без приёмки честно пуст.
    expect(human.stdout).toContain("acceptance evidence: 0/");
    expect(human.stdout).toContain("no active version: stars");
    // Без фильтра в срез попадают все дизайн-системы.
    expect(human.stdout).toContain("other-ds");
  });

  test("formats the KPI slice without a server", () => {
    const rows = versionAuditRows(
      [{ id: "a", designSystem: "yp" }, { id: "b", designSystem: "yp" }, { id: "c", designSystem: "yp" }],
      {
        a: [{ version: 1, status: "superseded", publishedAt: "2026-01-01" }, { version: 2, status: "active", publishedAt: "2026-01-02" }],
        b: [{ version: 1, status: "deprecated", publishedAt: "2026-01-03" }],
        c: [],
      },
    );
    expect(rows[0]).toMatchObject({ id: "a", versions: 2, active: 1, latestVersion: 2, firstPublishedAt: "2026-01-01", lastPublishedAt: "2026-01-02", byStatus: { superseded: 1, active: 1 } });
    const findings = versionAuditFindings(rows);
    expect(findings).toMatchObject({ components: 3, published: 2, totalVersions: 3, versionsPerComponent: 1.5, noActiveVersion: ["b"], unpublished: ["c"], firstVersionOnly: ["b"] });
    const lines = versionAuditLines("designSystem=yp", rows, findings);
    expect(lines[0]).toContain("2/3 components published, 3 public versions, 1.5 versions per published component");
    // Без ссылок на раны колонка пуста везде — это ожидаемое состояние, а не сбой (§11-R3c).
    expect(rows[0]).toMatchObject({ acceptanceEvidence: 0, acceptedActive: false });
    expect(findings).toMatchObject({ versionsWithEvidence: 0, acceptedComponents: [], withoutEvidence: ["a", "b"] });
    expect(lines[2]).toBe("acceptance evidence: 0/3 versions · accepted active version: 0/2 components · published components without any evidence: 2");
    expect(lines[3]).toContain("acceptance");
    expect(lines[4]?.split("\t")[6]).toBe("0/2 active=no");

    // Evidence на активной версии: строка и сводка показывают и покрытие, и принятую активную.
    const accepted = versionAuditRows([{ id: "a", designSystem: "yp" }], {
      a: [
        { version: 1, status: "superseded", publishedAt: "2026-01-01" },
        { version: 2, status: "active", publishedAt: "2026-01-02", acceptanceRunId: "acc_1" },
      ],
    });
    expect(accepted[0]).toMatchObject({ acceptanceEvidence: 1, acceptedActive: true });
    const acceptedFindings = versionAuditFindings(accepted);
    expect(acceptedFindings).toMatchObject({ versionsWithEvidence: 1, acceptedComponents: ["a"], withoutEvidence: [] });
    expect(versionAuditLines("", accepted, acceptedFindings)[4]?.split("\t")[6]).toBe("1/2 active=yes");
    expect(lines.at(-1)).toBe("no active version: b");
  });
});

describe("author driver planners", () => {
  test("capture summaries classify results and map onto exit codes", () => {
    expect(summarizeCapture({ imageProduced: true, captureClean: true, productErrors: [], infraNoise: ["favicon"], runtimeWarnings: ["w"] }))
      .toEqual({ imageProduced: true, captureClean: true, productErrors: [], infraNoise: ["favicon"], runtimeWarnings: ["w"] });
    // Pre-7.1 servers do not classify: raw browser errors stay product errors.
    expect(summarizeCapture({ imageUrl: "/api/assets/x", consoleErrors: ["boom"], pageErrors: [] }))
      .toMatchObject({ imageProduced: true, captureClean: false, productErrors: ["boom"], infraNoise: [] });
    expect(snapExitCode([{ imageProduced: true, productErrors: [] }])).toBe(0);
    expect(snapExitCode([{ imageProduced: true, productErrors: ["boom"] }])).toBe(2);
    expect(snapExitCode([{ imageProduced: false, productErrors: ["boom"] }])).toBe(1);
    expect(snapExitCode([])).toBe(0);
  });

  test("geometry gaps require static flow and confirming non-wrapped flex", () => {
    const screen: {spec:{root:string;elements:Record<string,{type:string;props:Record<string,unknown>;children?:string[];repeat?:unknown}>}} = { spec:{ root:"stack", elements:{
      stack:{type:"Stack",props:{direction:"vertical"},children:["a","b"]},
      a:{type:"Text",props:{}}, b:{type:"Text",props:{}},
    } } };
    const definitions = { Stack:{layout:{flow:{kind:"flex",direction:{prop:"direction",vertical:["vertical"],horizontal:["horizontal"]}}}} };
    const geometry: {rects:Array<{key:string;instance:number;parentKey?:string;parentInstance?:number;domIndex:number;x:number;y:number;width:number;height:number;layoutContext:{display:string;flexDirection:string;flexWrap:string;rowGap:string;columnGap:string}|null}>} = { rects:[
      {key:"stack",instance:0,domIndex:0,x:0,y:0,width:20,height:32,layoutContext:{display:"flex",flexDirection:"column",flexWrap:"nowrap",rowGap:"12px",columnGap:"12px"}},
      {key:"a",instance:0,parentKey:"stack",parentInstance:0,domIndex:1,x:0,y:0,width:20,height:10,layoutContext:null},
      {key:"b",instance:0,parentKey:"stack",parentInstance:0,domIndex:2,x:0,y:22,width:20,height:10,layoutContext:null},
    ] };
    expect(analyzeGeometryGaps(screen,definitions,geometry)[0]).toMatchObject({reason:null,cssGap:{rowGap:"12px"},observed:[12]});
    const owner = geometry.rects[0]!.layoutContext!;
    owner.flexWrap="wrap";
    expect(analyzeGeometryGaps(screen,definitions,geometry)[0]?.reason).toContain("wraps");
    owner.flexWrap="nowrap";
    screen.spec.elements.b.repeat={items:[1,2]};
    expect(analyzeGeometryGaps(screen,definitions,geometry)[0]?.reason).toBe("repeat in flow group");
    delete screen.spec.elements.b.repeat;
    (screen.spec.elements.b as typeof screen.spec.elements.b & {slot?:string}).slot="header";
    expect(analyzeGeometryGaps(screen,definitions,geometry)[0]?.reason).toBe("named slots in flow group");
  });

  test("viewport cascade rounds canvas values and ignores object key order", () => {
    expect(resolveViewport({ canvas: { height: 844.6, width: 389.5 } }, undefined, "desktop")).toEqual({ width: 390, height: 845 });
    expect(resolveViewport({ canvas: { width: 1, height: 9000 } }, undefined, "desktop")).toEqual({ width: 64, height: 4000 });
    expect(resolveViewport({}, undefined, "mobile")).toEqual({ width: 390, height: 844 });
    expect(resolveViewport({}, undefined, "desktop")).toEqual({ width: 1280, height: 800 });
  });

  test("multi-surface docs resolve viewport and catalog from the screen surface", () => {
    // План 2026-08-02 multi-surface-flows, W5/R3-M5: у дуо-дока КСО-поверхность desktop, а
    // приложение mobile — снимать обе в `doc.device` значило бы снимать в чужом вьюпорте.
    const doc = {
      device: "mobile",
      designSystem: "app-ds",
      surfaces: [
        { id: "app", name: "Приложение", device: "mobile", startScreen: "app-home" },
        { id: "kso", name: "КСО", device: "desktop", designSystem: "kso-ds", startScreen: "kso-idle" },
      ],
      screens: [
        { id: "app-home", surface: "app" },
        { id: "kso-idle", surface: "kso", canvas: { width: 1280, height: 800 } },
        { id: "untagged" },
      ],
    };
    expect(doc.screens.map((screen) => screenDevice(doc, screen))).toEqual(["mobile", "desktop", "mobile"]);
    expect(doc.screens.map((screen) => screenDesignSystem(doc, screen))).toEqual(["app-ds", "kso-ds", "app-ds"]);
    expect(buildSnapPlan({ doc }).map((surface) => surface.viewport)).toEqual([
      { width: 390, height: 844 },
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]);
    // Одно-поверхностный документ: устройство и вьюпорт ровно прежние.
    const single = { device: "tablet", designSystem: "solo-ds", screens: [{ id: "a" }] };
    expect(screenDevice(single, single.screens[0])).toBe("tablet");
    expect(screenDesignSystem(single, single.screens[0])).toBe("solo-ds");
    expect(buildSnapPlan({ doc: single })[0]?.viewport).toEqual({ width: 834, height: 1112 });
    expect(buildBaselinePlan({ rev: 1, prototypeInstanceId: "i", doc }, {}).surfaces.map((surface) => surface.viewport))
      .toEqual([{ width: 390, height: 844 }, { width: 1280, height: 800 }, { width: 390, height: 844 }]);
  });

  test("enforces the 20 Mpx invariant and builds complete members", () => {
    expect(assertViewportPixelBudget({ width: 2000, height: 2500 }, 2)).toEqual({ width: 2000, height: 2500 });
    expect(() => assertViewportPixelBudget({ width: 2000, height: 2501 }, 2)).toThrow("20 Mpx");
    const draft = {
      rev: 4,
      prototypeInstanceId: "instance",
      doc: { device: "tablet", screens: [{ id: "b" }, { id: "a", canvas: { height: 700.2, width: 300.8 } }] },
    };
    const plan = buildBaselinePlan(draft, { theme: "dark", dsf: 1 });
    expect(plan.surfaces).toEqual([
      { screenId: "b", viewport: { width: 834, height: 1112 }, deviceScaleFactor: 1, theme: "dark" },
      { screenId: "a", viewport: { width: 301, height: 700 }, deviceScaleFactor: 1, theme: "dark" },
    ]);
    expect(buildBaselineMembers(plan.surfaces, [{ screenId: "a", assetId: "asset-a" }, { screenId: "b", assetId: "asset-b" }])).toEqual([
      { ...plan.surfaces[0], assetId: "asset-b" },
      { ...plan.surfaces[1], assetId: "asset-a" },
    ]);
  });

  test("readiness exit codes follow publishable, blocking and failing gates", () => {
    const gates: DriverReadinessGate[] = [{ id: "schema", status: "pass", summary: "clean" }, { id: "assets", status: "warn", summary: "assets_unpinned" }];
    expect(readinessExitCode({ publishable: true, blocking: [], gates })).toBe(0);
    expect(readinessExitCode({ publishable: true, blocking: [], gates: [...gates, { id: "pins", status: "fail", summary: "pins_unrenderable" }] })).toBe(2);
    expect(readinessExitCode({ publishable: false, blocking: ["assets"], gates })).toBe(2);
    expect(failingGates({ gates: [...gates, { id: "pins", status: "fail", summary: "x" }] }).map((gate) => gate.id)).toEqual(["pins"]);
    expect(failingGates(undefined)).toEqual([]);
  });

  test("audit joins the manifest with the usage index and flags deprecated components in use", () => {
    const manifest = {
      components: [
        { id: "a", name: "A", version: 3, deprecated: false, scope: "block", canonicalFor: ["cta"], headUsageCount: 9 },
        { id: "b", name: "B", version: 1, deprecated: true, replacement: "a", headUsageCount: 9 },
        { id: "c", name: "C", version: 2, deprecated: true },
      ],
    };
    const usages = {
      components: [
        { componentId: "a", headUsageCount: 2, prototypes: [{ prototypeId: "p1" }, { prototypeId: "p2" }] },
        { componentId: "b", headUsageCount: 1, prototypes: [{ prototypeId: "p3" }] },
        { componentId: "c", headUsageCount: 0, prototypes: [] },
      ],
    };
    const rows = auditRows(manifest, usages);
    // The usage index wins over the manifest counter: both come from the same cache, but the
    // index is the one that carries the prototype list the row prints.
    expect(rows[0]).toMatchObject({ id: "a", status: "active", scope: "block", canonicalFor: ["cta"], headUsageCount: 2, prototypes: ["p1", "p2"] });
    expect(rows[1]).toMatchObject({ id: "b", status: "deprecated", replacement: "a", headUsageCount: 1, scope: null });
    expect(rows[2]).toMatchObject({ id: "c", status: "deprecated", headUsageCount: 0 });
    const findings = auditFindings(rows);
    expect(findings).toEqual({ deprecatedInUse: ["b"], unused: ["c"] });
    expect(auditExitCode(findings)).toBe(2);
    expect(auditExitCode({ deprecatedInUse: [] })).toBe(0);
  });

  test("plans all diff argument forms", () => {
    expect(parseDiffArguments([], 3)).toEqual({ toRev: 3, againstRev: 2 });
    expect(parseDiffArguments(["1"], 3)).toEqual({ toRev: 3, againstRev: 1 });
    expect(parseDiffArguments(["1", "2"], 3)).toEqual({ toRev: 2, againstRev: 1 });
    expect(() => parseDiffArguments([], 1)).toThrow("revision 1");
    expect(() => parseDiffArguments(["x"], 3)).toThrow("positive integer");
  });

  test("expect derives gaps and paddings from the measured rects", () => {
    const rects = expectFixtureRects();
    expect(readGeometryRects({ rects })).toBe(rects);
    expect(readGeometryRects({ result: { rects } })).toBe(rects);
    expect(() => readGeometryRects({})).toThrow("no rects[]");
    const parent = rects[0]!;
    const children = rects.slice(1);
    expect(observedGaps(children, "row")).toEqual([6]);
    expect(observedPadding(parent, children)).toEqual({ top: 12, right: 16, bottom: 12, left: 16 });
    expect(observedPadding(parent, [])).toBeNull();
  });

  test("expect reports the numeric verdict and rejects malformed expectations", () => {
    const rects = expectFixtureRects();
    const expectations = parseExpectations({
      elements: [{ key: "stack", size: { width: 328, height: 56 }, gap: 8, padding: { left: 16, top: 12 } }],
    });
    expect(expectations.tolerance).toBe(DEFAULT_EXPECT_TOLERANCE);
    const evaluation = evaluateExpectations(expectations, rects);
    expect(expectExitCode(evaluation)).toBe(2);
    expect(evaluation.mismatches).toHaveLength(1);
    expect(evaluation.mismatches[0]!.message).toBe("stack#0: gap expected 8, got 6");
    expect(expectLines(evaluation, "expected.json", "actual.json")[0]).toBe("expect expected.json vs actual.json: 5 checks, 1 mismatch (tolerance ±1px)");
    // Допуск снимает расхождение целиком; per-element tolerance перекрывает файловый.
    expect(expectExitCode(evaluateExpectations(parseExpectations({ tolerance: 2, elements: [{ key: "stack", gap: 8 }] }), rects))).toBe(0);
    expect(expectExitCode(evaluateExpectations(parseExpectations({ tolerance: 2, elements: [{ key: "stack", gap: 8, tolerance: 0 }] }), rects))).toBe(2);
    // CLI-флаг перекрывает файловый дефолт, но не per-element.
    expect(expectExitCode(evaluateExpectations(parseExpectations({ tolerance: 0, elements: [{ key: "stack", gap: 8 }] }, 5), rects))).toBe(0);
    // Отсутствующий rect — не «ok по умолчанию».
    const missing = evaluateExpectations(parseExpectations({ elements: [{ key: "ghost", size: { width: 1 } }] }), rects);
    expect(missing.mismatches[0]!.message).toContain("ghost#0: not measured");
    expect(() => parseExpectations({ elements: [] })).toThrow("non-empty elements[]");
    expect(() => parseExpectations({ elements: [{ key: "stack", padding: { start: 1 } }] })).toThrow("unknown side start");
    expect(() => parseExpectations({ elements: [{ key: "stack", gapp: 8 }] })).toThrow("unknown field gapp");
    expect(() => parseExpectations({ elements: [{ key: "stack" }] })).toThrow("declares nothing to check");
    expect(() => parseExpectations({ elements: [{ key: "stack", gap: [8, 8] }] })).not.toThrow();
  });

  test("preview default output path follows the author-shots convention", () => {
    expect(previewOutputPath("pay-button", 3, undefined)).toBe("author-shots/pay-button/pay-button-v3.png");
    expect(previewOutputPath("pay-button", 3, "primary")).toBe("author-shots/pay-button/pay-button-v3-primary.png");
    // Драфт-превью (P1b): rev-адресный стем вместо published-версии.
    expect(previewDraftOutputPath("pay-button", 5, undefined)).toBe("author-shots/pay-button/pay-button-draft-r5.png");
    expect(previewDraftOutputPath("pay-button", 5, "wide")).toBe("author-shots/pay-button/pay-button-draft-r5-wide.png");
  });

  test("preview --rev accepts only head-draft", () => {
    expect(parseArgs(["preview", "pay-button", "--rev", "head-draft"])).toMatchObject({ cmd: "preview", args: ["pay-button"], flags: { rev: "head-draft" } });
    expect(() => parseArgs(["preview", "pay-button", "--rev", "3"])).toThrow("--rev must be one of: head-draft");
    expect(() => parseArgs(["preview", "pay-button", "--rev", "draft"])).toThrow("--rev must be one of: head-draft");
  });
});
