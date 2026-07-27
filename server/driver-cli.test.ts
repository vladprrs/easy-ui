import { createTestHandler } from "./test-auth";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { ensureBootstrapAdmin } from "./users";
import { prototypeDocSchema, type PrototypeDoc } from "../src/prototype/schema";
import { ScreenshotService, type RunJob } from "./screenshot/service";
import {
  assertViewportPixelBudget,
  snapExitCode,
  summarizeCapture,
  analyzeGeometryGaps,
  buildBaselineMembers,
  buildBaselinePlan,
  parseDiffArguments,
  resolveViewport,
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

  test("catalog emits compact server catalog and hints on an unknown system", async () => {
    const { api } = await setup();
    const valid = await run(api, ["catalog", "yandex-pay"]);
    expect(valid.exitCode).toBe(0);
    expect(JSON.parse(valid.stdout)).toMatchObject({
      designSystem: { id: "yandex-pay", resolvedSpaceScale: { none: "0px", md: "12px", "4xl": "64px" } },
      custom: [],
      builtins: [],
      hostPrimitives: expect.arrayContaining([expect.objectContaining({
        name: "Overlay",
        atomicLevel: "atom",
        layoutNeutral: true,
        slots: ["default"],
        propsJsonSchema: expect.objectContaining({ type: "object" }),
      }), expect.objectContaining({ name: "Image" }), expect.objectContaining({ name: "Hotspot" })]),
    });
    const missing = await run(api, ["catalog", "missing-system"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("get design-systems");
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

  test("plans all diff argument forms", () => {
    expect(parseDiffArguments([], 3)).toEqual({ toRev: 3, againstRev: 2 });
    expect(parseDiffArguments(["1"], 3)).toEqual({ toRev: 3, againstRev: 1 });
    expect(parseDiffArguments(["1", "2"], 3)).toEqual({ toRev: 2, againstRev: 1 });
    expect(() => parseDiffArguments([], 1)).toThrow("revision 1");
    expect(() => parseDiffArguments(["x"], 3)).toThrow("positive integer");
  });
});
