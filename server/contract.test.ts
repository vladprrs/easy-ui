import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { renderOpenApiJson, OPENAPI_PATH } from "../scripts/generate-openapi";
import { prototypeDocSchema } from "../src/prototype/schema";
import { ELEMENTS_PER_SCREEN_LIMIT, REPEAT_ELEMENT_LIMIT, REPEAT_RENDER_COST_BUDGET, TREE_DEPTH_LIMIT } from "../src/prototype/validate";
import { MAX_ASSET_BYTES } from "./assets/validate";
import { capabilitiesResponseSchema, listContracts, type RouteContract } from "./contracts";
import { openDatabase } from "./db";
import { MAX_JSON_BODY_BYTES } from "./http";
import { createHandler } from "./main";
import { MAX_QUEUE } from "./screenshot/service";

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
  handler = createHandler(db, { dataDir: dir }) as (request: Request) => Promise<Response>;
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
  const original = prototypeDocSchema.parse(await Bun.file("prototypes/hello-world.json").json());
  return { ...original, id, name: id };
}

const componentSource = await Bun.file("server/fixtures/rating-stars.tsx").text();

type Expectation =
  | { kind: "success"; status?: number; contentType?: string }
  | { kind: "error"; status: number; code: string };

interface Case { run: () => Promise<Response>; expected: Expectation }

// Shared mutable fixture state threaded through the ordered execution below.
const state: { assetId?: string; referenceId?: string; screenId?: string } = {};

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
    // Design systems
    ["POST /api/design-systems", { run: () => call("POST", "/api/design-systems", { id: "contract-ds", name: "Contract DS", description: "Contract test system" }), expected: ok(201) }],
    ["GET /api/design-systems", { run: () => call("GET", "/api/design-systems"), expected: ok() }],
    ["GET /api/design-systems/{id}", { run: () => call("GET", "/api/design-systems/contract-ds"), expected: ok() }],
    ["PATCH /api/design-systems/{id}", { run: () => call("PATCH", "/api/design-systems/contract-ds", { tokens: { "color.brand": "#123456" }, baseVersion: 0 }), expected: ok() }],
    ["GET /api/design-systems/{id}/versions/{version}", { run: () => call("GET", "/api/design-systems/contract-ds/versions/1"), expected: ok() }],
    // Assets
    ["POST /api/assets", { run: () => call("POST", "/api/assets", PNG_1X1, "image/png"), expected: ok(201) }],
    ["GET /api/assets/{id}", { run: () => call("GET", `/api/assets/${state.assetId}`), expected: ok(200, "image/png") }],
    // Prototypes: create -> read -> save -> restore -> publish -> versions
    ["POST /api/prototypes", { run: async () => call("POST", "/api/prototypes", { doc: await helloDoc("contract-proto") }), expected: ok(201) }],
    ["GET /api/prototypes", { run: () => call("GET", "/api/prototypes"), expected: ok() }],
    ["GET /api/prototypes/{id}", { run: () => call("GET", "/api/prototypes/contract-proto"), expected: ok() }],
    ["GET /api/prototypes/{id}/draft", { run: () => call("GET", "/api/prototypes/contract-proto/draft"), expected: ok() }],
    ["PUT /api/prototypes/{id}", { run: async () => call("PUT", "/api/prototypes/contract-proto", { doc: await helloDoc("contract-proto"), baseRev: 1, message: "save" }), expected: ok() }],
    ["GET /api/prototypes/{id}/revisions", { run: () => call("GET", "/api/prototypes/contract-proto/revisions?limit=10"), expected: ok() }],
    ["GET /api/prototypes/{id}/revisions/{rev}", { run: () => call("GET", "/api/prototypes/contract-proto/revisions/1"), expected: ok() }],
    ["POST /api/prototypes/{id}/restore", { run: () => call("POST", "/api/prototypes/contract-proto/restore", { rev: 1, baseRev: 2 }), expected: ok() }],
    ["POST /api/prototypes/{id}/publish", { run: () => call("POST", "/api/prototypes/contract-proto/publish", { baseRev: 3 }), expected: ok(201) }],
    ["GET /api/prototypes/{id}/versions", { run: () => call("GET", "/api/prototypes/contract-proto/versions"), expected: ok() }],
    ["GET /api/prototypes/{id}/versions/{version}", { run: () => call("GET", "/api/prototypes/contract-proto/versions/1"), expected: ok() }],
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
    ["POST /api/components", { run: () => call("POST", "/api/components", { id: "contract-stars", name: "ContractStars", source: componentSource }), expected: ok(201) }],
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
    ["GET /api/shims/{abi}/{file}", { run: () => call("GET", "/api/shims/v1/react.js"), expected: ok(200, "text/javascript") }],
    // Deletions last (CAS on the final head revisions)
    ["DELETE /api/components/{id}", { run: () => call("DELETE", "/api/components/contract-stars", { baseRev: 3 }), expected: ok(204) }],
    ["DELETE /api/prototypes/{id}", { run: () => call("DELETE", "/api/prototypes/contract-proto", { baseRev: 3 }), expected: ok(204) }],
  ];
}

describe("route contracts", () => {
  test("every registered contract has a coverage case, and responses match their schemas", async () => {
    state.screenId = (await helloDoc("x")).screens[0]!.id;
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
      if (key === "PUT /api/visual-references") state.referenceId = (body as { id: string }).id;
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
    });
    expect(value.designSystems).toEqual(expect.arrayContaining(["shadcn", "wireframe"]));
    expect(Object.values(value.features).every((flag) => flag === true)).toBe(true);
  });

  test("GET /api/schemas/prototype-document.json is a JSON Schema with directive annotations", async () => {
    const response = await call("GET", "/api/schemas/prototype-document.json");
    expect(response.status).toBe(200);
    const schema = (await response.json()) as Record<string, unknown>;
    expect(schema.$schema).toContain("json-schema.org");
    expect(schema.type).toBe("object");
    const properties = schema.properties as Record<string, unknown>;
    for (const key of ["version", "id", "startScreen", "state", "screens"]) expect(properties).toHaveProperty(key);
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
  });

  test("GET /api/schemas/component-definition.json describes the definition contract", async () => {
    const response = await call("GET", "/api/schemas/component-definition.json");
    expect(response.status).toBe(200);
    const schema = (await response.json()) as { $schema: string; type: string; required: string[]; properties: Record<string, unknown> };
    expect(schema.$schema).toContain("json-schema.org");
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["props", "description"]);
    for (const key of ["props", "events", "slots", "capabilities", "description", "example", "atomicLevel"]) {
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
