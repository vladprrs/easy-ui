import { createTestHandler } from "./test-auth";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { renderOpenApiJson, OPENAPI_PATH } from "../scripts/generate-openapi";
import {
  prototypeDocSchema,
  FLOWS_LIMIT,
  FLOW_STEPS_LIMIT,
  FLOW_TOTAL_STEPS_LIMIT,
  type PrototypeDoc,
} from "../src/prototype/schema";
import { ELEMENTS_PER_SCREEN_LIMIT, REPEAT_ELEMENT_LIMIT, REPEAT_RENDER_COST_BUDGET, TREE_DEPTH_LIMIT } from "../src/prototype/validate";
import { MAX_ASSET_BYTES } from "./assets/validate";
import { capabilitiesResponseSchema, listContracts, type RouteContract } from "./contracts";
import { openDatabase } from "./db";
import { MAX_JSON_BODY_BYTES } from "./http";
import { GEOMETRY_RECT_LIMIT, MAX_QUEUE } from "./screenshot/service";
import { UserRepo } from "./users";

// Contract test (plan §G): every registered route contract is exercised through
// createHandler — happy-path where the fixture is cheap, otherwise the typed error
// envelope — and each 2xx JSON body is checked against the contract responseSchema.

const contractKey = (contract: RouteContract) => `${contract.method} ${contract.path}`;

let dir: string;
let db: Database;
let handler: (request: Request) => Promise<Response>;

beforeAll(async () => {
  dir = await mkdtemp(resolve(process.cwd(), ".contract-test-"));
  db = openDatabase(":memory:");
  handler = createTestHandler(db, { dataDir: dir }) as (request: Request) => Promise<Response>;
  await new UserRepo(db).create({ name: "Login Fixture", password: "contract password", actorId: "user_admin" });
});
afterAll(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const call = (method: string, path: string, body?: unknown, contentType = "application/json") =>
  handler(new Request(`http://test${path}`, {
    method,
    headers: body !== undefined ? { "content-type": contentType } : undefined,
    body: body === undefined ? undefined : contentType === "application/json" ? JSON.stringify(body) : (body as BodyInit),
  }));

// 1x1 transparent PNG for asset/visual fixtures.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

async function helloDoc(id: string) {
  const original = prototypeDocSchema.parse(await Bun.file("test/fixtures/host-content.json").json());
  return { ...original, id, name: id };
}

async function flowDoc(id: string, screenIds = ["home", "a", "b"]): Promise<PrototypeDoc> {
  const original = prototypeDocSchema.parse(await Bun.file("test/fixtures/host-content.json").json());
  const source = original.screens[0]!;
  return {
    ...original,
    id,
    name: id,
    startScreen: screenIds[0]!,
    screens: screenIds.map((screenId) => ({
      ...structuredClone(source),
      id: screenId,
      name: screenId,
    })),
  };
}

const componentSource = await Bun.file("server/fixtures/rating-stars.tsx").text();

type Expectation =
  | { kind: "success"; status?: number; contentType?: string }
  | { kind: "error"; status: number; code: string };

interface Case { run: () => Promise<Response>; expected: Expectation }

// Shared mutable fixture state threaded through the ordered execution below.
const state: { assetId?: string; referenceId?: string; screenId?: string; screenIds?:string[]; shareId?: string; prototypeInstanceId?:string; loginCookie?:string } = {};

function orderedCases(): [string, Case][] {
  const ok = (status?: number, contentType?: string): Expectation => ({ kind: "success", status, contentType });
  const err = (status: number, code: string): Expectation => ({ kind: "error", status, code });
  return [
    // Health, discovery
    ["GET /api/health", { run: () => call("GET", "/api/health"), expected: ok() }],
    ["GET /api/openapi.json", { run: () => call("GET", "/api/openapi.json"), expected: ok() }],
    ["GET /api/schemas/prototype-document.json", { run: () => call("GET", "/api/schemas/prototype-document.json"), expected: ok() }],
    ["GET /api/schemas/component-definition.json", { run: () => call("GET", "/api/schemas/component-definition.json"), expected: ok() }],
    ["GET /api/capabilities", { run: () => call("GET", "/api/capabilities"), expected: ok() }],
    // Named users and cookie sessions
    ["POST /api/users", { run: () => call("POST", "/api/users", { name: "Contract Operator", password: "operator password", isAdmin: false }), expected: ok(201) }],
    ["GET /api/users", { run: () => call("GET", "/api/users"), expected: ok() }],
    ["POST /api/auth/login", { run: () => call("POST", "/api/auth/login", { name: "Login Fixture", password: "contract password" }), expected: ok() }],
    ["GET /api/auth/me", { run: () => call("GET", "/api/auth/me"), expected: ok() }],
    // Design systems
    ["POST /api/design-systems", { run: () => call("POST", "/api/design-systems", { id: "contract-ds", name: "Contract DS", description: "Contract test system" }), expected: ok(201) }],
    ["GET /api/design-systems", { run: () => call("GET", "/api/design-systems"), expected: ok() }],
    ["GET /api/design-systems/{id}", { run: () => call("GET", "/api/design-systems/contract-ds"), expected: ok() }],
    ["PATCH /api/design-systems/{id}", { run: () => call("PATCH", "/api/design-systems/contract-ds", { tokens: { "color.brand": "#123456" }, baseVersion: 0 }), expected: ok() }],
    ["GET /api/design-systems/{id}/versions/{version}", { run: () => call("GET", "/api/design-systems/contract-ds/versions/1"), expected: ok() }],
    // Assets
    ["POST /api/assets", { run: () => call("POST", "/api/assets", PNG_1X1, "image/png"), expected: ok(201) }],
    ["GET /api/assets", { run: () => call("GET", "/api/assets?limit=50"), expected: ok() }],
    ["GET /api/assets/{id}", { run: () => call("GET", `/api/assets/${state.assetId}`), expected: ok(200, "image/png") }],
    ["GET /api/assets/{id}/usage", { run: () => call("GET", `/api/assets/${state.assetId}/usage`), expected: ok() }],
    // Prototypes: create -> read -> save -> restore -> publish -> versions
    ["POST /api/prototypes", { run: async () => call("POST", "/api/prototypes", { doc: await helloDoc("contract-proto") }), expected: ok(201) }],
    ["GET /api/prototypes", { run: () => call("GET", "/api/prototypes"), expected: ok() }],
    ["GET /api/prototypes/{id}", { run: () => call("GET", "/api/prototypes/contract-proto"), expected: ok() }],
    ["GET /api/prototypes/{id}/draft", { run: () => call("GET", "/api/prototypes/contract-proto/draft"), expected: ok() }],
    ["PUT /api/visual-baselines/prototypes/{id}", {run:()=>call("PUT","/api/visual-baselines/prototypes/contract-proto",{rev:1,prototypeInstanceId:state.prototypeInstanceId,baseGeneration:null,members:state.screenIds!.map(screenId=>({screenId,viewport:{width:320,height:480},deviceScaleFactor:1,theme:"light",assetId:state.assetId}))}),expected:ok()}],
    ["GET /api/visual-baselines/prototypes/{id}", {run:()=>call("GET","/api/visual-baselines/prototypes/contract-proto"),expected:ok()}],
    ["PUT /api/prototypes/{id}", { run: async () => call("PUT", "/api/prototypes/contract-proto", { doc: await helloDoc("contract-proto"), baseRev: 1, message: "save" }), expected: ok() }],
    ["GET /api/prototypes/{id}/revisions", { run: () => call("GET", "/api/prototypes/contract-proto/revisions?limit=10"), expected: ok() }],
    ["GET /api/prototypes/{id}/revisions/{rev}", { run: () => call("GET", "/api/prototypes/contract-proto/revisions/1"), expected: ok() }],
    ["GET /api/prototypes/{id}/revisions/{rev}/diff", { run: () => call("GET", "/api/prototypes/contract-proto/revisions/2/diff?against=1"), expected: ok() }],
    ["POST /api/prototypes/{id}/restore", { run: () => call("POST", "/api/prototypes/contract-proto/restore", { rev: 1, baseRev: 2 }), expected: ok() }],
    ["POST /api/prototypes/{id}/status", { run: () => call("POST", "/api/prototypes/contract-proto/status", { status: "published" }), expected: ok() }],
    ["POST /api/prototypes/{id}/publish", { run: () => call("POST", "/api/prototypes/contract-proto/publish", { baseRev: 3 }), expected: ok(201) }],
    ["GET /api/prototypes/{id}/versions", { run: () => call("GET", "/api/prototypes/contract-proto/versions"), expected: ok() }],
    ["GET /api/prototypes/{id}/versions/{version}", { run: () => call("GET", "/api/prototypes/contract-proto/versions/1"), expected: ok() }],
    ["POST /api/prototypes/{id}/share", { run: () => call("POST", "/api/prototypes/contract-proto/share", { version: 1, ttlSeconds: 3600 }), expected: ok(201) }],
    ["GET /api/prototypes/{id}/share", { run: () => call("GET", "/api/prototypes/contract-proto/share"), expected: ok() }],
    ["POST /api/prototypes/{id}/share", { run: () => call("POST", "/api/prototypes/contract-proto/share", { version: 1, ttlSeconds: 1 }), expected: err(422, "validation_failed") }],
    // Granular 404 codes (W0-4): prototype vs version vs revision
    ["GET /api/prototypes/{id}", { run: () => call("GET", "/api/prototypes/contract-missing"), expected: err(404, "prototype_not_found") }],
    ["GET /api/prototypes/{id}/versions/{version}", { run: () => call("GET", "/api/prototypes/contract-missing/versions/1"), expected: err(404, "prototype_not_found") }],
    ["GET /api/prototypes/{id}/versions/{version}", { run: () => call("GET", "/api/prototypes/contract-proto/versions/99"), expected: err(404, "version_not_found") }],
    ["GET /api/prototypes/{id}/revisions/{rev}", { run: () => call("GET", "/api/prototypes/contract-proto/revisions/99"), expected: err(404, "revision_not_found") }],
    ["GET /api/prototypes/{id}/screens/{screenId}/render-status", { run: () => call("GET", `/api/prototypes/contract-proto/screens/${state.screenId}/render-status`), expected: ok() }],
    // Screenshots: unavailable in this environment (no service) — typed error envelope
    ["POST /api/prototypes/{id}/screens/{screenId}/screenshot", { run: () => call("POST", `/api/prototypes/contract-proto/screens/${state.screenId}/screenshot`, { viewport: { width: 320, height: 480 } }), expected: err(501, "screenshot_unavailable") }],
    ["POST /api/components/{id}/versions/{version}/screenshot", { run: () => call("POST", "/api/components/contract-stars/versions/1/screenshot", { viewport: { width: 320, height: 480 } }), expected: err(501, "screenshot_unavailable") }],
    ["GET /api/screenshot-jobs/{jobId}", { run: () => call("GET", "/api/screenshot-jobs/nope"), expected: err(404, "job_not_found") }],
    // Visual references (DB-backed happy paths; check requires the capture pipeline)
    ["PUT /api/visual-references", { run: () => call("PUT", "/api/visual-references", { fingerprint: { scope: "prototype-screen", prototypeId: "contract-proto", screenId: state.screenId, refRevision: 1, viewport: { width: 320, height: 480 }, deviceScaleFactor: 1, theme: "light" }, assetId: state.assetId }), expected: ok() }],
    ["GET /api/visual-references", { run: () => call("GET", "/api/visual-references?scope=prototype-screen"), expected: ok() }],
    ["GET /api/visual-references/{id}", { run: () => call("GET", `/api/visual-references/${state.referenceId}`), expected: ok() }],
    ["POST /api/visual-references/{id}/check", { run: () => call("POST", `/api/visual-references/${state.referenceId}/check`, {}), expected: err(501, "screenshot_unavailable") }],
    ["GET /api/visual-runs/{runId}", { run: () => call("GET", "/api/visual-runs/nope"), expected: err(404, "run_not_found") }],
    // Components: create/save/read happy paths; publish is exercised as its CAS error
    // envelope (activation runs typecheck + import — out of scope for a contract test)
    ["POST /api/components", { run: () => call("POST", "/api/components", { id: "contract-stars", name: "ContractStars", source: componentSource, designSystem:"contract-ds" }), expected: ok(201) }],
    ["GET /api/components", { run: () => call("GET", "/api/components"), expected: ok() }],
    ["GET /api/components/{id}", { run: () => call("GET", "/api/components/contract-stars"), expected: ok() }],
    ["PUT /api/components/{id}", { run: () => call("PUT", "/api/components/contract-stars", { source: componentSource + "\n// v2\n", baseRev: 1 }), expected: ok() }],
    ["GET /api/components/{id}/source", { run: () => call("GET", "/api/components/contract-stars/source"), expected: ok() }],
    ["GET /api/components/{id}/draft", { run: () => call("GET", "/api/components/contract-stars/draft"), expected: ok() }],
    ["GET /api/components/{id}/revisions", { run: () => call("GET", "/api/components/contract-stars/revisions"), expected: ok() }],
    ["GET /api/components/{id}/revisions/{rev}", { run: () => call("GET", "/api/components/contract-stars/revisions/1"), expected: ok() }],
    ["POST /api/components/{id}/restore", { run: () => call("POST", "/api/components/contract-stars/restore", { rev: 1, baseRev: 2 }), expected: ok() }],
    ["POST /api/components/{id}/publish", { run: () => call("POST", "/api/components/contract-stars/publish", { baseRev: 999 }), expected: err(409, "revision_conflict") }],
    ["GET /api/components/{id}/versions", { run: () => call("GET", "/api/components/contract-stars/versions"), expected: ok() }],
    ["GET /api/components/{id}/versions/{version}", { run: () => call("GET", "/api/components/contract-stars/versions/1"), expected: err(404, "not_found") }],
    ["GET /api/components/{id}/versions/{version}/bundle.js", { run: () => call("GET", "/api/components/contract-stars/versions/1/bundle.js"), expected: err(404, "not_found") }],
    ["POST /api/components/{id}/versions/{version}/status", { run: () => call("POST", "/api/components/contract-stars/versions/1/status", { status: "deprecated", baseStatusRev: 1 }), expected: err(404, "not_found") }],
    // Catalog / shims
    ["GET /api/catalog/manifest", { run: () => call("GET", "/api/catalog/manifest"), expected: ok() }],
    ["GET /api/catalog/manifest", { run: () => call("GET", "/api/catalog/manifest?designSystem=contract-ds"), expected: ok() }],
    ["GET /api/catalog/manifest", { run: () => call("GET", "/api/catalog/manifest?designSystem=missing-system"), expected: err(404, "not_found") }],
    ["GET /api/catalog/manifest", { run: () => call("GET", "/api/catalog/manifest?designSystem=Bad_slug"), expected: err(422, "validation_failed") }],
    ["GET /api/shims/{abi}/{file}", { run: () => call("GET", "/api/shims/v1/react.js"), expected: ok(200, "text/javascript") }],
    // Deletions last (CAS on the final head revisions)
    ["DELETE /api/prototypes/{id}/share/{shareId}", { run: () => call("DELETE", `/api/prototypes/contract-proto/share/${state.shareId}`), expected: ok(204) }],
    ["DELETE /api/prototypes/{id}/share/{shareId}", { run: () => call("DELETE", `/api/prototypes/contract-proto/share/${state.shareId}`), expected: err(404, "share_not_found") }],
    ["DELETE /api/visual-references/{id}", { run: () => call("DELETE", `/api/visual-references/${state.referenceId}`), expected: ok(204) }],
    ["DELETE /api/visual-references/{id}", { run: () => call("DELETE", `/api/visual-references/${state.referenceId}`), expected: err(404, "reference_not_found") }],
    ["DELETE /api/components/{id}", { run: () => call("DELETE", "/api/components/contract-stars", { baseRev: 3 }), expected: ok(204) }],
    ["DELETE /api/prototypes/{id}", { run: () => call("DELETE", "/api/prototypes/contract-proto", { baseRev: 3 }), expected: ok(204) }],
    ["POST /api/auth/logout", { run: () => handler(new Request("http://test/api/auth/logout", { method: "POST", headers: { origin: "http://test", cookie: state.loginCookie! } })), expected: ok(204) }],
  ];
}

describe("route contracts", () => {
  test("every registered contract has a coverage case, and responses match their schemas", async () => {
    state.screenIds=(await helloDoc("x")).screens.map(screen=>screen.id); state.screenId=state.screenIds[0]!;
    const contracts = new Map(listContracts().map((contract) => [contractKey(contract), contract]));
    const cases = orderedCases();
    const covered = new Set(cases.map(([key]) => key));
    expect([...contracts.keys()].filter((key) => !covered.has(key))).toEqual([]);
    expect([...covered].filter((key) => !contracts.has(key))).toEqual([]);

    for (const [key, entry] of cases) {
      const contract = contracts.get(key)!;
      const response = await entry.run();
      if (entry.expected.kind === "error") {
        expect({ key, status: response.status }).toEqual({ key, status: entry.expected.status });
        const body = (await response.json()) as { error: { code: string; message: string } };
        expect({ key, code: body.error.code }).toEqual({ key, code: entry.expected.code });
        expect(typeof body.error.message).toBe("string");
        // The observed error must be declared on the contract.
        expect(contract.errors.some((error) => error.status === response.status && error.code === body.error.code)).toBe(true);
        continue;
      }
      const expectedStatus = entry.expected.status ?? contract.status ?? 200;
      expect({ key, status: response.status }).toEqual({ key, status: expectedStatus });
      if (expectedStatus === 204) continue;
      const expectedType = entry.expected.contentType ?? contract.contentType;
      if (expectedType) {
        expect(response.headers.get("content-type") ?? "").toContain(expectedType.split(";")[0]!);
        if (!contract.responseSchema) continue;
      }
      const body = await response.json();
      const parsed = contract.responseSchema ? contract.responseSchema.safeParse(body) : { success: true as const, error: undefined };
      if (!parsed.success) throw new Error(`${key}: response does not match contract schema: ${parsed.error}`);
      if (key === "POST /api/assets") state.assetId = (body as { id: string }).id;
      if (key === "GET /api/prototypes/{id}/draft") state.prototypeInstanceId=(body as {prototypeInstanceId:string}).prototypeInstanceId;
      if (key === "PUT /api/visual-references") state.referenceId = (body as { id: string }).id;
      if (key === "POST /api/prototypes/{id}/share") state.shareId = (body as { id: string }).id;
      if (key === "POST /api/auth/login") state.loginCookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
    }
  }, 120_000);

  test("server/openapi.json has no drift against the contract registry", () => {
    expect(readFileSync(OPENAPI_PATH, "utf8")).toBe(renderOpenApiJson());
  });

  test("GET /api/capabilities exposes actions, directives, param sources, limits and design systems", async () => {
    const response = await call("GET", "/api/capabilities");
    expect(response.status).toBe(200);
    const body = await response.json();
    const parsed = capabilitiesResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    const value = parsed.data!;
    expect(value.actions).toEqual(expect.arrayContaining(["navigate", "back", "openUrl", "restart", "setState", "pushState", "removeState"]));
    expect(value.directives).toEqual(["$state", "$bindState", "$template", "$cond", "$asset"]);
    expect(value.paramSources).toEqual(["$event", "$elementId", "$itemIndex", "$itemKey"]);
    expect(value.conditions).toEqual(expect.arrayContaining(["$and", "$or", "eq", "neq", "not"]));
    expect(value.limits).toEqual({
      elements: ELEMENTS_PER_SCREEN_LIMIT,
      depth: TREE_DEPTH_LIMIT,
      bodyMiB: MAX_JSON_BODY_BYTES / (1024 * 1024),
      sourceKiB: 256,
      assetMiB: MAX_ASSET_BYTES / (1024 * 1024),
      repeatBudget: REPEAT_RENDER_COST_BUDGET,
      repeatPerScreen: REPEAT_ELEMENT_LIMIT,
      screenshotQueue: MAX_QUEUE,
      geometryRects: GEOMETRY_RECT_LIMIT,
      flows: FLOWS_LIMIT,
      flowSteps: FLOW_STEPS_LIMIT,
      flowTotalSteps: FLOW_TOTAL_STEPS_LIMIT,
    });
    expect(value.designSystems).toEqual(expect.arrayContaining(["contract-ds", "yandex-pay"]));
    expect(value.layoutContractVersion).toBe(1);
    expect(value.regions).toEqual(["statusBar", "header", "footer"]);
    expect(value.features).toEqual({
      renderStatus: true,
      screenshots: true,
      visualRegression: true,
      assets: true,
      typedEvents: true,
      repeat: true,
      namedSlots: true,
      themeVersions: true,
      layoutContract: true,
      flows: true,
      screenRegions: true,
    });
    expect(value.resolvedSpaceScales["yandex-pay"]).toMatchObject({ none: "0px", md: "12px", "4xl": "64px" });
  });

  test("GET /api/schemas/prototype-document.json is a JSON Schema with directive annotations", async () => {
    const response = await call("GET", "/api/schemas/prototype-document.json");
    expect(response.status).toBe(200);
    const schema = (await response.json()) as Record<string, unknown>;
    expect(schema.$schema).toContain("json-schema.org");
    expect(schema.type).toBe("object");
    const properties = schema.properties as Record<string, unknown>;
    for (const key of ["version", "id", "startScreen", "state", "screens", "flows"]) expect(properties).toHaveProperty(key);
    const defs = schema.$defs as Record<string, { anyOf?: unknown[] }>;
    for (const name of ["stateDirective", "bindStateDirective", "templateDirective", "condDirective", "assetDirective", "propValue", "actionParamValue"]) {
      expect(defs).toHaveProperty(name);
    }
    expect(defs.propValue!.anyOf!.length).toBe(6);
    // Element props and action params reference the annotated directive unions.
    const text = JSON.stringify(schema);
    expect(text).toContain('"#/$defs/propValue"');
    expect(text).toContain('"#/$defs/actionParamValue"');
    expect(text).toContain("asset_[0-9a-f]{64}");
    const regionSchemas: unknown[] = [];
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      const nodeProperties = record.properties;
      if (nodeProperties && typeof nodeProperties === "object" && !Array.isArray(nodeProperties)) {
        const region = (nodeProperties as Record<string, unknown>).region;
        if (region) regionSchemas.push(region);
      }
      Object.values(record).forEach(visit);
    };
    visit(schema);
    expect(regionSchemas).toContainEqual({ type: "string", enum: ["statusBar", "header", "footer"] });
  });

  test("POST /api/prototypes rejects an unknown screen region", async () => {
    const doc = await helloDoc("contract-invalid-region");
    (doc.screens[0]!.spec.elements.image as { region?: unknown }).region = "sidebar";
    const response = await call("POST", "/api/prototypes", { doc });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: {
        code: "validation_failed",
        issues: [expect.objectContaining({ path: ["screens", 0, "spec", "elements", "image", "region"] })],
      },
    });
  });

  test("POST and PUT prototype documents with flows return semantic warnings", async () => {
    const doc = await flowDoc("contract-flows", ["home", "done"]);
    doc.flows = [{
      id: "main",
      name: "Main",
      steps: [{ screenId: "home" }, { screenId: "done" }],
    }];

    let response = await call("POST", "/api/prototypes", { doc });
    expect(response.status).toBe(201);
    let value = await response.json() as { warnings: { path: string; message: string }[] };
    expect(value.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "/flows/0/steps/1/screenId",
        message: "flow step is not connected to the previous step by a navigate action",
      }),
    ]));

    response = await call("PUT", "/api/prototypes/contract-flows", {
      baseRev: 1,
      doc: { ...doc, name: "contract-flows-saved" },
    });
    expect(response.status).toBe(200);
    value = await response.json() as { warnings: { path: string; message: string }[] };
    expect(value.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/flows/0/steps/1/screenId" }),
    ]));
  });

  test("POST rejects every v1 flows schema rule and all flow limits", async () => {
    const cases: {
      name: string;
      screens?: string[];
      flows: unknown[];
    }[] = [
      {
        name: "main-start",
        flows: [{ id: "main", name: "Main", steps: [{ screenId: "a" }] }],
      },
      {
        name: "main-duplicate",
        flows: [{ id: "main", name: "Main", steps: [{ screenId: "home" }, { screenId: "a" }, { screenId: "home" }] }],
      },
      {
        name: "anchor-shortcut",
        flows: [
          { id: "main", name: "Main", steps: [{ screenId: "home" }, { screenId: "a" }, { screenId: "b" }] },
          { id: "shortcut", name: "Shortcut", steps: [{ screenId: "home" }, { screenId: "b" }] },
        ],
      },
      {
        name: "anchor-backward",
        flows: [
          { id: "main", name: "Main", steps: [{ screenId: "home" }, { screenId: "a" }, { screenId: "b" }] },
          { id: "backward", name: "Backward", steps: [{ screenId: "b" }, { screenId: "a" }] },
        ],
      },
      {
        name: "adjacent-equal",
        flows: [
          { id: "main", name: "Main", steps: [{ screenId: "home" }] },
          { id: "equal", name: "Equal", steps: [{ screenId: "a" }, { screenId: "a" }] },
        ],
      },
      { name: "empty", flows: [] },
      {
        name: "flow-count",
        flows: [
          { id: "main", name: "Main", steps: [{ screenId: "home" }] },
          ...Array.from({ length: FLOWS_LIMIT }, (_, index) => ({
            id: `branch-${index}`,
            name: `Branch ${index}`,
            steps: [{ screenId: "a" }],
          })),
        ],
      },
      {
        name: "flow-steps",
        flows: [
          { id: "main", name: "Main", steps: [{ screenId: "home" }] },
          {
            id: "long",
            name: "Long",
            steps: Array.from({ length: FLOW_STEPS_LIMIT + 1 }, (_, index) => ({ screenId: index % 2 ? "a" : "b" })),
          },
        ],
      },
      {
        name: "flow-total-steps",
        flows: [
          { id: "main", name: "Main", steps: [{ screenId: "home" }] },
          ...Array.from({ length: 4 }, (_, flowIndex) => ({
            id: `long-${flowIndex}`,
            name: `Long ${flowIndex}`,
            steps: Array.from({ length: FLOW_STEPS_LIMIT }, (_, index) => ({ screenId: index % 2 ? "a" : "b" })),
          })),
        ],
      },
    ];

    for (const entry of cases) {
      const doc = await flowDoc(`invalid-${entry.name}`, entry.screens);
      const response = await call("POST", "/api/prototypes", { doc: { ...doc, flows: entry.flows } });
      expect({ name: entry.name, status: response.status }).toEqual({ name: entry.name, status: 422 });
      expect(await response.json()).toMatchObject({ error: { code: "validation_failed", issues: expect.any(Array) } });
    }
  });

  test("GET /api/schemas/component-definition.json describes the definition contract", async () => {
    const response = await call("GET", "/api/schemas/component-definition.json");
    expect(response.status).toBe(200);
    const schema = (await response.json()) as { $schema: string; type: string; required: string[]; properties: Record<string, unknown> };
    expect(schema.$schema).toContain("json-schema.org");
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["props", "description"]);
    for (const key of ["props", "events", "slots", "capabilities", "description", "example", "atomicLevel", "layoutNeutral", "layout"]) {
      expect(schema.properties).toHaveProperty(key);
    }
    const events = schema.properties.events as { anyOf: unknown[] };
    expect(events.anyOf.length).toBe(2);
    expect((schema.properties.atomicLevel as { enum: string[] }).enum).toEqual(["atom", "molecule", "organism", "template", "page"]);
  });

  test("GET /api/openapi.json serves the committed OpenAPI document", async () => {
    const response = await call("GET", "/api/openapi.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    const doc = (await response.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths).length).toBe(new Set(listContracts().map((contract) => contract.path)).size);
    for (const contract of listContracts()) expect(Object.hasOwn(doc.paths, contract.path)).toBe(true);
  });
});
