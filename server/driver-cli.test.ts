import { createTestHandler } from "./test-auth";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { openDatabase } from "./db";
import { ensureBootstrapAdmin } from "./users";
import { prototypeDocSchema, type PrototypeDoc } from "../src/prototype/schema";
import { ScreenshotService, type RunJob } from "./screenshot/service";
import { ReuseDecisionRepo } from "./repos/reuseDecisions";
import {
  assertViewportPixelBudget,
  auditExitCode,
  auditFindings,
  auditRows,
  reuseAuditLines,
  failingGates,
  readinessExitCode,
  snapExitCode,
  summarizeCapture,
  analyzeGeometryGaps,
  buildBaselineMembers,
  buildBaselinePlan,
  parseDiffArguments,
  resolveViewport,
  type DriverReadinessGate,
} from "../.claude/skills/author/driver.mjs";

const driver = resolve(".claude/skills/author/driver.mjs");
const servers: Bun.Server<unknown>[] = [];
const directories: string[] = [];
const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function setup(legacyBasicAuth?: string, runJob?: RunJob) {
  const directory = await mkdtemp(resolve(process.cwd(), ".driver-cli-test-"));
  directories.push(directory);
  const db = openDatabase(":memory:");
  databases.push(db);
  await ensureBootstrapAdmin(db, { name: "Driver Admin", password: "driver-test-password" });
  const screenshots = runJob
    ? new ScreenshotService({ db, dataDir: directory, serveDist: "dist", captureOrigin: "http://127.0.0.1:8787", chromiumAvailable: true, runJob })
    : undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createTestHandler(db, { dataDir: directory, legacyBasicAuth, screenshots }) });
  servers.push(server);
  return { db, directory, api: `http://127.0.0.1:${server.port}/api` };
}

/** Worker stub: one PNG per call, with whatever console output the case needs. */
function pngRunJob(consoleErrors: string[] = [], pageErrors: string[] = []): { runJob: RunJob; calls: () => number } {
  let calls = 0;
  const runJob: RunJob = async () => {
    calls += 1;
    return { ok: true, pngBase64: Buffer.from(png()).toString("base64"), width: 2, height: 3, consoleErrors, pageErrors, browserVersion: "test/1" };
  };
  return { runJob, calls: () => calls };
}

async function saveDoc(api: string, doc: PrototypeDoc) {
  const response = await fetch(`${api}/prototypes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ doc, message: "snap fixture" }),
  });
  expect(response.status).toBe(201);
}

async function twoScreenDoc(id: string): Promise<PrototypeDoc> {
  const base = await fixture(id);
  const first = base.screens[0]!;
  return { ...base, screens: [first, { ...first, id: "second" }] };
}

async function run(api: string, args: string[], legacyBasicAuth = "") {
  const child = Bun.spawn({
    cmd: ["node", driver, ...args],
    cwd: process.cwd(),
    env: {
      ...process.env,
      EASYUI_API: api,
      EASYUI_LEGACY_BASIC_AUTH: legacyBasicAuth,
      EASYUI_USERNAME: "Driver Admin",
      EASYUI_PASSWORD: "driver-test-password",
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
    expect(JSON.parse(created.stdout)).toEqual({ command: "composition", id: "reusable-image", created: true, rev: 1, designSystem: "yandex-pay" });

    const updated = await run(api, ["composition", "reusable-image", secondPath, "--design-system", "yandex-pay", "--json"]);
    expect(updated.exitCode).toBe(0);
    expect(JSON.parse(updated.stdout)).toEqual({ command: "composition", id: "reusable-image", created: false, rev: 2, designSystem: "yandex-pay" });

    const published = await run(api, ["composition", "publish", "reusable-image", "--json"]);
    expect(published.exitCode).toBe(0);
    expect(JSON.parse(published.stdout)).toEqual({ command: "composition publish", id: "reusable-image", version: 1, rev: 2 });
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
});
