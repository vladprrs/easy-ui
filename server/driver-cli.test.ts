import { createTestHandler } from "./test-auth";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { prototypeDocSchema, type PrototypeDoc } from "../src/prototype/schema";
import {
  assertViewportPixelBudget,
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

async function setup() {
  const directory = await mkdtemp(resolve(process.cwd(), ".driver-cli-test-"));
  directories.push(directory);
  const db = openDatabase(":memory:");
  databases.push(db);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createTestHandler(db, { dataDir: directory }) });
  servers.push(server);
  return { db, api: `http://127.0.0.1:${server.port}/api` };
}

async function run(api: string, args: string[]) {
  const child = Bun.spawn({
    cmd: ["node", driver, ...args],
    cwd: process.cwd(),
    env: { ...process.env, EASYUI_API: api, EASYUI_AUTH: "" },
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
  const value = prototypeDocSchema.parse(await Bun.file("prototypes/hello-world.json").json());
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
  test("catalog emits compact server catalog and hints on an unknown system", async () => {
    const { api } = await setup();
    const valid = await run(api, ["catalog", "shadcn"]);
    expect(valid.exitCode).toBe(0);
    expect(JSON.parse(valid.stdout)).toMatchObject({
      designSystem: { id: "shadcn", resolvedSpaceScale: { none: "0px", md: "12px", "4xl": "64px" } },
      custom: [],
      builtins: expect.arrayContaining([expect.objectContaining({ name: "Button", layoutNeutral: false, propsJsonSchema: expect.objectContaining({ type: "object" }), events: expect.any(Array), slots: expect.any(Array) })]),
      hostPrimitives: [expect.objectContaining({
        name: "Overlay",
        atomicLevel: "atom",
        layoutNeutral: true,
        slots: ["default"],
        propsJsonSchema: expect.objectContaining({ type: "object" }),
      })],
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

describe("author driver planners", () => {
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
