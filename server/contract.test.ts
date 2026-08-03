import { createTestHandler } from "./test-auth";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { renderOpenApiJson, OPENAPI_PATH } from "../scripts/generate-openapi";
import {
  prototypeDocSchema,
  COMPUTED_ENTRIES_LIMIT,
  COMPUTED_FIELDS_LIMIT,
  COMPUTED_OPS,
  COMPUTED_TERMS_LIMIT,
  FLOWS_LIMIT,
  FLOW_STEPS_LIMIT,
  FLOW_TOTAL_STEPS_LIMIT,
  FLOW_DEPTH_LIMIT,
  SURFACES_LIMIT,
  type PrototypeDoc,
} from "../src/prototype/schema";
import { ELEMENTS_PER_SCREEN_LIMIT, REPEAT_ELEMENT_LIMIT, REPEAT_RENDER_COST_BUDGET, TREE_DEPTH_LIMIT } from "../src/prototype/validate";
import { MAX_ASSET_BYTES } from "./assets/validate";
import {
  capabilitiesResponseSchema,
  catalogCandidatesContract,
  catalogCandidatesGetContract,
  createComponentContract,
  listContracts,
  publishComponentContract,
  type RouteContract,
} from "./contracts";
import { CALIBRATED_POLICY } from "./catalog/policy";
import { openDatabase } from "./db";
import { MAX_JSON_BODY_BYTES } from "./http";
import { GEOMETRY_RECT_LIMIT, MAX_QUEUE } from "./screenshot/service";
import {
  ACCEPTANCE_POLICIES,
  acceptanceCaseTtlHours as ACCEPTANCE_CASE_TTL_HOURS,
  acceptanceMaxCasesPerRun as ACCEPTANCE_MAX_CASES_PER_RUN,
  evidenceMaxBytes as EVIDENCE_MAX_BYTES,
} from "./acceptance/policies";
import { UserRepo } from "./users";
import { AcceptanceOrchestrator } from "./acceptance/orchestrator";
import { caseSetIdOf } from "./acceptance/caseSets";
import { caseSetManifestSchema } from "../src/acceptance/caseSetSchema";
import type { AcceptanceCaptureService } from "./acceptance/gates/types";

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
  // Оркестратор приёмки — с заглушкой капчура и без автопрокрутки очереди: контракт-тест
  // покрывает форму ручек и их типизованные отказы, а не исполнение рана (оно — в
  // server/acceptance-routes.test.ts и в e2e/preview/acceptance-run.spec.ts).
  const captureStub = {
    enqueueComponentCandidate: async () => ({ jobId: "job_contract_stub" }),
    get: () => ({ status: "error", error: { code: "screenshot_unavailable", message: "stub" } }),
    outcome: () => undefined,
    hasBackgroundCapacity: () => false,
  } as unknown as AcceptanceCaptureService;
  const acceptance = new AcceptanceOrchestrator({ db, dataDir: dir, service: captureStub, autoDrain: false });
  handler = createTestHandler(db, { dataDir: dir, acceptance }) as (request: Request) => Promise<Response>;
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
/** Валидный по форме, но несуществующий `runId` приёмки (`acc_` + uuid — regex `isRunId`). */
const MISSING_RUN_ID = "acc_00000000-0000-0000-0000-000000000000";

/**
 * Манифест case-set'а для контракта (план §5 W2). Две координаты одного измерения — достаточно,
 * чтобы coverage-ответ был непустым; id набора вычисляется тем же контентным адресом, что на
 * сервере, поэтому чтение и coverage адресуются без разбора ответа PUT.
 */
const CONTRACT_MANIFEST = {
  manifestVersion: 1 as const,
  componentId: "contract-stars",
  capture: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 as const, theme: "light" as const },
  dimensions: { tone: ["light", "dark"] },
  cases: [
    { id: "tone-light", props: { rating: 1 }, dims: { tone: "light" } },
    { id: "tone-dark", props: { rating: 2 }, dims: { tone: "dark" } },
  ],
};
const CONTRACT_CASE_SET_ID = caseSetIdOf(caseSetManifestSchema.parse(CONTRACT_MANIFEST));
const componentPreviewSource = `import { z } from "zod";
import type { BaseComponentProps } from "@json-render/react";

export const definition = {
  props: z.strictObject({ label: z.string().min(1) }),
  events: [],
  slots: [],
  description: "A compact preview label for the component library",
  example: { label: "Preview" },
};

type Props = z.output<typeof definition.props>;

export default function ContractPreview({ props }: BaseComponentProps<Props>) {
  return <span>{props.label}</span>;
}
`;
const componentPreviewSourceWithoutExample = componentPreviewSource.replace('  example: { label: "Preview" },\n', "");

// Композиция контрактного теста держится только на host-примитивах: `assertKnownTypes`
// требует опубликованных компонентов, а contract-stars намеренно остаётся неопубликованным.
const compositionDoc = {
  version: 1,
  name: "Contract Composition",
  params: { alt: { type: "string", required: true } },
  slots: [],
  spec: { root: "root", elements: { root: { type: "Image", props: { src: "/contract.png", alt: { $param: "alt" } } } } },
};

type Expectation =
  | { kind: "success"; status?: number; contentType?: string }
  | { kind: "error"; status: number; code: string };

interface Case { run: () => Promise<Response>; expected: Expectation }

// Shared mutable fixture state threaded through the ordered execution below.
const state: { assetId?: string; referenceId?: string; screenId?: string; screenIds?:string[]; shareId?: string; prototypeInstanceId?:string; loginCookie?:string; operatorId?:string; migrationPlan?: unknown; migrationRunId?: string } = {};

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
    ["POST /api/users", { run: async () => { const response = await call("POST", "/api/users", { name: "Contract Operator", password: "operator password", isAdmin: false }); state.operatorId = ((await response.clone().json()) as { id: string }).id; return response; }, expected: ok(201) }],
    ["PATCH /api/users/{id}", { run: () => call("PATCH", `/api/users/${state.operatorId}`, { isAdmin: true }), expected: ok() }],
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
    ["POST /api/prototypes/{id}/lifecycle", { run: () => call("POST", "/api/prototypes/contract-proto/lifecycle", { kind: "evidence", tags: ["contract"], derivedFrom: null }), expected: ok() }],
    ["GET /api/prototypes/{id}/readiness", { run: () => call("GET", "/api/prototypes/contract-proto/readiness"), expected: ok() }],
    ["POST /api/prototypes/{id}/repin", { run: () => call("POST", "/api/prototypes/contract-proto/repin?dryRun=1", {}), expected: ok() }],
    // Сценарии взаимодействия (волна 6)
    ["POST /api/prototypes/{id}/scenarios", { run: () => call("POST", "/api/prototypes/contract-proto/scenarios", { id: "contract-scenario", name: "Contract scenario", steps: [{ type: "expectScreen", screenId: state.screenId }, { type: "expectText", text: "Hello" }] }), expected: ok(201) }],
    ["GET /api/prototypes/{id}/scenarios", { run: () => call("GET", "/api/prototypes/contract-proto/scenarios"), expected: ok() }],
    ["GET /api/prototypes/{id}/scenarios/{scenarioId}", { run: () => call("GET", "/api/prototypes/contract-proto/scenarios/contract-scenario"), expected: ok() }],
    ["PUT /api/prototypes/{id}/scenarios/{scenarioId}", { run: () => call("PUT", "/api/prototypes/contract-proto/scenarios/contract-scenario", { name: "Contract scenario v2", steps: [{ type: "expectScreen", screenId: state.screenId }] }), expected: ok() }],
    ["GET /api/prototypes/{id}/scenarios/{scenarioId}", { run: () => call("GET", "/api/prototypes/contract-proto/scenarios/missing"), expected: err(404, "scenario_not_found") }],
    ["DELETE /api/prototypes/{id}/scenarios/{scenarioId}", { run: () => call("DELETE", "/api/prototypes/contract-proto/scenarios/contract-scenario"), expected: ok(204) }],
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
    ["POST /api/components/{id}/head/screenshot", { run: () => call("POST", "/api/components/contract-stars/head/screenshot", { viewport: { width: 320, height: 480 } }), expected: err(501, "screenshot_unavailable") }],
    ["GET /api/screenshot-jobs/{jobId}", { run: () => call("GET", "/api/screenshot-jobs/nope"), expected: err(404, "job_not_found") }],
    // Visual references (DB-backed happy paths; check requires the capture pipeline)
    ["PUT /api/visual-references", { run: () => call("PUT", "/api/visual-references", { fingerprint: { scope: "prototype-screen", prototypeId: "contract-proto", screenId: state.screenId, refRevision: 1, viewport: { width: 320, height: 480 }, deviceScaleFactor: 1, theme: "light" }, assetId: state.assetId }), expected: ok() }],
    ["GET /api/visual-references", { run: () => call("GET", "/api/visual-references?scope=prototype-screen"), expected: ok() }],
    ["GET /api/visual-references/{id}", { run: () => call("GET", `/api/visual-references/${state.referenceId}`), expected: ok() }],
    ["POST /api/visual-references/{id}/check", { run: () => call("POST", `/api/visual-references/${state.referenceId}/check`, {}), expected: err(501, "screenshot_unavailable") }],
    ["GET /api/visual-runs/{runId}", { run: () => call("GET", "/api/visual-runs/nope"), expected: err(404, "run_not_found") }],
    // Components: create/save/read happy paths; publish is exercised as its CAS error
    // envelope (activation runs typecheck + import — out of scope for a contract test)
    ["POST /api/components", { run: () => call("POST", "/api/components", { id: "contract-stars", name: "ContractStars", source: componentSource, designSystem:"contract-ds", intent: "Interactive rating stars for product cards" }), expected: ok(201) }],
    ["GET /api/components", { run: () => call("GET", "/api/components"), expected: ok() }],
    ["GET /api/components/{id}", { run: () => call("GET", "/api/components/contract-stars"), expected: ok() }],
    ["PUT /api/components/{id}", { run: () => call("PUT", "/api/components/contract-stars", { source: componentSource + "\n// v2\n", baseRev: 1 }), expected: ok() }],
    ["GET /api/components/{id}/source", { run: () => call("GET", "/api/components/contract-stars/source"), expected: ok() }],
    ["GET /api/components/{id}/draft", { run: () => call("GET", "/api/components/contract-stars/draft"), expected: ok() }],
    ["GET /api/components/{id}/revisions", { run: () => call("GET", "/api/components/contract-stars/revisions"), expected: ok() }],
    ["GET /api/components/{id}/revisions/{rev}", { run: () => call("GET", "/api/components/contract-stars/revisions/1"), expected: ok() }],
    ["POST /api/components/{id}/restore", { run: () => call("POST", "/api/components/contract-stars/restore", { rev: 1, baseRev: 2 }), expected: ok() }],
    ["POST /api/components/{id}/publish", { run: () => call("POST", "/api/components/contract-stars/publish", { baseRev: 999 }), expected: err(409, "revision_conflict") }],
    // Promote (RFC candidate-acceptance R1) — happy path саги покрыт в component-promote.test.ts
    // (там же kill-switch и auto-supersede); здесь — CAS-конверт 409.
    ["POST /api/components/{id}/promote", { run: () => call("POST", "/api/components/contract-stars/promote", { baseRev: 999, sourceHash: "0".repeat(64) }), expected: err(409, "revision_conflict") }],
    // Validate-префлайт — как и publish, тяжёлый happy path (typecheck+compile+import) покрыт
    // в component-validate.test.ts; здесь — envelope 404.
    ["POST /api/components/{id}/validate", { run: () => call("POST", "/api/components/contract-missing/validate"), expected: err(404, "not_found") }],
    // Матричная приёмка (план 2026-08-03 §5 W1a): happy-path (кандидат → ран → evidence) —
    // в acceptance-routes.test.ts и e2e; здесь — форма ручек и их 404-конверт.
    ["POST /api/components/{id}/candidates", { run: () => call("POST", "/api/components/contract-missing/candidates"), expected: err(404, "not_found") }],
    ["GET /api/component-candidates/{candidateId}", { run: () => call("GET", `/api/component-candidates/cand_${"0".repeat(64)}`), expected: err(404, "not_found") }],
    ["POST /api/acceptance-runs", { run: () => call("POST", "/api/acceptance-runs", { candidateId: `cand_${"0".repeat(64)}` }), expected: err(404, "not_found") }],
    ["POST /api/acceptance-runs", { run: () => call("POST", "/api/acceptance-runs", { candidateId: `cand_${"0".repeat(64)}`, caseSetId: "cset_x" }), expected: err(400, "invalid_request") }],
    ["GET /api/acceptance-runs/{runId}", { run: () => call("GET", `/api/acceptance-runs/${MISSING_RUN_ID}`), expected: err(404, "not_found") }],
    ["GET /api/acceptance-runs/{runId}/cases", { run: () => call("GET", `/api/acceptance-runs/${MISSING_RUN_ID}/cases`), expected: err(404, "not_found") }],
    ["GET /api/acceptance-runs/{runId}/evidence", { run: () => call("GET", `/api/acceptance-runs/${MISSING_RUN_ID}/evidence`), expected: err(404, "not_found") }],
    ["POST /api/acceptance-runs/{runId}/cancel", { run: () => call("POST", `/api/acceptance-runs/${MISSING_RUN_ID}/cancel`, {}), expected: err(404, "not_found") }],
    // W6: импакт-анализ. Как и у соседей, покрытие — по отказу: несуществующий кандидат отвечает
    // 404 до чтения baseline-рана (адрес кандидата не должен работать оракулом).
    ["POST /api/components/{id}/impact", { run: () => call("POST", "/api/components/contract-stars/impact", { candidateId: `cand_${"0".repeat(64)}`, baselineRunId: MISSING_RUN_ID }), expected: err(404, "not_found") }],
    // Case-set-манифесты (план 2026-08-03 §5 W2): PUT — happy path (он дешёвый, капчур не нужен),
    // чтение и coverage — по вычисленному контентному адресу того же манифеста.
    ["PUT /api/components/{id}/case-sets", { run: () => call("PUT", "/api/components/contract-stars/case-sets", { manifest: CONTRACT_MANIFEST }), expected: ok() }],
    ["GET /api/case-sets/{caseSetId}", { run: () => call("GET", `/api/case-sets/${CONTRACT_CASE_SET_ID}`), expected: ok() }],
    ["GET /api/case-sets/{caseSetId}/coverage", { run: () => call("GET", `/api/case-sets/${CONTRACT_CASE_SET_ID}/coverage`), expected: ok() }],
    ["GET /api/components/{id}/versions", { run: () => call("GET", "/api/components/contract-stars/versions"), expected: ok() }],
    ["GET /api/components/{id}/versions/{version}", { run: () => call("GET", "/api/components/contract-stars/versions/1"), expected: err(404, "not_found") }],
    ["GET /api/components/{id}/versions/{version}/bundle.js", { run: () => call("GET", "/api/components/contract-stars/versions/1/bundle.js"), expected: err(404, "not_found") }],
    ["POST /api/components/{id}/versions/{version}/status", { run: () => call("POST", "/api/components/contract-stars/versions/1/status", { status: "deprecated", baseStatusRev: 1 }), expected: err(404, "not_found") }],
    // Инлайн-превью библиотеки: единственный по-настоящему опубликованный компонент контракт-теста.
    // v1 несёт legacy-`example`, v2 — нет, поэтому обе 422-ветки покрываются одним компонентом.
    ["POST /api/components", { run: () => call("POST", "/api/components", { id: "contract-preview", name: "ContractPreview", source: componentPreviewSource, designSystem: "contract-ds", intent: "Preview component for contract coverage" }), expected: ok(201) }],
    ["POST /api/components/{id}/publish", { run: () => call("POST", "/api/components/contract-preview/publish", { baseRev: 1 }), expected: ok(201) }],
    ["PUT /api/components/{id}", { run: () => call("PUT", "/api/components/contract-preview", { source: componentPreviewSourceWithoutExample, baseRev: 1 }), expected: ok() }],
    ["POST /api/components/{id}/publish", { run: () => call("POST", "/api/components/contract-preview/publish", { baseRev: 2 }), expected: ok(201) }],
    ["GET /api/components/{id}/versions/{version}/preview", { run: () => call("GET", "/api/components/contract-preview/versions/1/preview?selector=legacy"), expected: ok() }],
    ["GET /api/components/{id}/versions/{version}/preview", { run: () => call("GET", "/api/components/contract-preview/versions/1/preview?selector=named&name=missing"), expected: err(422, "unknown_example") }],
    ["GET /api/components/{id}/versions/{version}/preview", { run: () => call("GET", "/api/components/contract-preview/versions/2/preview?selector=legacy"), expected: err(422, "example_unavailable") }],
    ["GET /api/components/{id}/versions/{version}/preview", { run: () => call("GET", "/api/components/contract-preview/versions/99/preview?selector=legacy"), expected: err(404, "not_found") }],
    ["GET /api/components/{id}/versions/{version}/preview", { run: () => call("GET", "/api/components/contract-preview/versions/1/preview?selector=named"), expected: err(400, "invalid_request") }],
    ["POST /api/components/{id}/versions/{version}/status", { run: () => call("POST", "/api/components/contract-preview/versions/1/status", { status: "archived", baseStatusRev: 1 }), expected: ok() }],
    ["GET /api/components/{id}/versions/{version}/preview", { run: () => call("GET", "/api/components/contract-preview/versions/1/preview?selector=legacy"), expected: err(404, "bundle_unavailable") }],
    // Usage graph (волна 3)
    ["GET /api/components/{id}/usages", { run: () => call("GET", "/api/components/contract-stars/usages"), expected: ok() }],
    ["GET /api/components/{id}/usages", { run: () => call("GET", "/api/components/contract-stars/usages?format=tree"), expected: ok() }],
    ["GET /api/components/{id}/usages", { run: () => call("GET", "/api/components/contract-missing/usages"), expected: err(404, "not_found") }],
    // Compositions (волна 5): create -> read -> save -> publish -> versions -> status -> usages
    ["POST /api/compositions", { run: () => call("POST", "/api/compositions", { id: "contract-composition", designSystem: "contract-ds", doc: compositionDoc }), expected: ok(201) }],
    ["GET /api/compositions", { run: () => call("GET", "/api/compositions"), expected: ok() }],
    ["GET /api/compositions/{id}", { run: () => call("GET", "/api/compositions/contract-composition"), expected: ok() }],
    ["PUT /api/compositions/{id}", { run: () => call("PUT", "/api/compositions/contract-composition", { doc: { ...compositionDoc, description: "v2" }, baseRev: 1, message: "save" }), expected: ok() }],
    ["GET /api/compositions/{id}/revisions", { run: () => call("GET", "/api/compositions/contract-composition/revisions"), expected: ok() }],
    ["GET /api/compositions/{id}/revisions/{rev}", { run: () => call("GET", "/api/compositions/contract-composition/revisions/1"), expected: ok() }],
    ["POST /api/compositions/{id}/publish", { run: () => call("POST", "/api/compositions/contract-composition/publish", { baseRev: 2 }), expected: ok(201) }],
    ["GET /api/compositions/{id}/versions", { run: () => call("GET", "/api/compositions/contract-composition/versions"), expected: ok() }],
    ["GET /api/compositions/{id}/versions/{version}", { run: () => call("GET", "/api/compositions/contract-composition/versions/1"), expected: ok() }],
    ["POST /api/compositions/{id}/versions/{version}/status", { run: () => call("POST", "/api/compositions/contract-composition/versions/1/status", { status: "deprecated", baseStatusRev: 1 }), expected: ok() }],
    ["GET /api/compositions/{id}/usages", { run: () => call("GET", "/api/compositions/contract-composition/usages"), expected: ok() }],
    // W8g: анализ и preview-дерево — read-only, поэтому стоят между публикацией и удалением.
    ["POST /api/compositions/analyze", { run: () => call("POST", "/api/compositions/analyze", { doc: compositionDoc, designSystem: "contract-ds" }), expected: ok() }],
    ["POST /api/compositions/{id}/preview-tree", { run: () => call("POST", "/api/compositions/contract-composition/preview-tree", { params: { alt: "Contract" } }), expected: ok() }],
    ["DELETE /api/compositions/{id}", { run: () => call("DELETE", "/api/compositions/contract-composition", { baseRev: 2 }), expected: ok(204) }],
    // Catalog / shims
    ["GET /api/catalog/usages", { run: () => call("GET", "/api/catalog/usages"), expected: ok() }],
    ["GET /api/catalog/usages", { run: () => call("GET", "/api/catalog/usages?designSystem=contract-ds"), expected: ok() }],
    ["GET /api/catalog/usages", { run: () => call("GET", "/api/catalog/usages?designSystem=missing-system"), expected: err(404, "not_found") }],
    ["GET /api/catalog/manifest", { run: () => call("GET", "/api/catalog/manifest"), expected: ok() }],
    ["GET /api/catalog/manifest", { run: () => call("GET", "/api/catalog/manifest?designSystem=contract-ds"), expected: ok() }],
    ["GET /api/catalog/manifest", { run: () => call("GET", "/api/catalog/manifest?designSystem=missing-system"), expected: err(404, "not_found") }],
    ["GET /api/catalog/manifest", { run: () => call("GET", "/api/catalog/manifest?designSystem=Bad_slug"), expected: err(422, "validation_failed") }],
    ["GET /api/catalog/library", { run: () => call("GET", "/api/catalog/library"), expected: ok() }],
    ["GET /api/catalog/library", { run: () => call("GET", "/api/catalog/library?designSystem=contract-ds"), expected: ok() }],
    ["GET /api/catalog/library", { run: () => call("GET", "/api/catalog/library?designSystem=missing-system"), expected: err(404, "not_found") }],
    ["GET /api/catalog/library", { run: () => call("GET", "/api/catalog/library?designSystem=Bad_slug"), expected: err(422, "validation_failed") }],
    // Reuse-кандидаты (проект 2 §4 T4): полная POST-форма, GET без Origin и композиционный
    // кандидат (план 2026-08-03 W9: рекомендательные три исхода вместо прежнего 422).
    ["POST /api/catalog/candidates", { run: () => call("POST", "/api/catalog/candidates", { designSystem: "contract-ds", intent: "rating stars for a product card", limit: 5 }), expected: ok() }],
    ["POST /api/catalog/candidates", { run: () => call("POST", "/api/catalog/candidates", { designSystem: "contract-ds", intent: "payment success screen", proposed: { kind: "composition" } }), expected: ok() }],
    ["POST /api/catalog/candidates", { run: () => call("POST", "/api/catalog/candidates", { designSystem: "contract-ds", intent: "payment success screen", proposed: { kind: "composition", source: "export default () => null;" } }), expected: err(422, "validation_failed") }],
    ["POST /api/catalog/candidates", { run: () => call("POST", "/api/catalog/candidates", { designSystem: "missing-system", intent: "rating stars for a product card" }), expected: err(404, "not_found") }],
    ["POST /api/catalog/candidates", { run: () => call("POST", "/api/catalog/candidates", { designSystem: "contract-ds", intent: "компонент ui" }), expected: err(422, "validation_failed") }],
    ["GET /api/catalog/candidates", { run: () => call("GET", "/api/catalog/candidates?designSystem=contract-ds&intent=rating%20stars%20for%20a%20product%20card&limit=3"), expected: ok() }],
    ["GET /api/catalog/candidates", { run: () => call("GET", "/api/catalog/candidates?designSystem=contract-ds&intent=rating%20stars&limit=21"), expected: err(422, "validation_failed") }],
    // Админский аудит гейта (проект 2 §4 T10): чтение отчёта и отказ невалидного лимита.
    ["GET /api/catalog/reuse-decisions", { run: () => call("GET", "/api/catalog/reuse-decisions?minAttempts=2&limit=50"), expected: ok() }],
    ["GET /api/catalog/reuse-decisions", { run: () => call("GET", "/api/catalog/reuse-decisions?limit=0"), expected: err(422, "validation_failed") }],
    // Protected catalog audit/cutover control plane. The empty fixture plan still exercises
    // fingerprint validation, staging, the maintenance lock and the atomic ledger transition.
    ["GET /api/catalog/migrations/audit", { run: async () => {
      const response = await call("GET", "/api/catalog/migrations/audit");
      if (response.ok) state.migrationPlan = (await response.clone().json() as { plan: unknown }).plan;
      return response;
    }, expected: ok() }],
    ["GET /api/catalog/migrations", { run: () => call("GET", "/api/catalog/migrations"), expected: ok() }],
    ["POST /api/catalog/migrations/prepare", { run: async () => {
      const response = await call("POST", "/api/catalog/migrations/prepare", state.migrationPlan);
      if (response.ok) state.migrationRunId = (await response.clone().json() as { runId: string }).runId;
      return response;
    }, expected: ok(201) }],
    ["POST /api/catalog/migrations/{runId}/apply", { run: () => call("POST", `/api/catalog/migrations/${state.migrationRunId}/apply`, state.migrationPlan), expected: ok() }],
    ["POST /api/catalog/migrations/{runId}/rollback", { run: () => call("POST", `/api/catalog/migrations/${state.migrationRunId}/rollback`, {}), expected: ok() }],
    ["GET /api/shims/{abi}/{file}",{ run: () => call("GET", "/api/shims/v1/react.js"), expected: ok(200, "text/javascript") }],
    // Bundle export (ZIP): owner draft, unpublished component draft, bulk (all owned)
    ["GET /api/prototypes/{id}/export", { run: () => call("GET", "/api/prototypes/contract-proto/export"), expected: ok(200, "application/zip") }],
    ["GET /api/components/{id}/export", { run: () => call("GET", "/api/components/contract-stars/export"), expected: ok(200, "application/zip") }],
    ["GET /api/bundles/export", { run: () => call("GET", "/api/bundles/export"), expected: ok(200, "application/zip") }],
    // Bundle import (ZIP): round-tripped from the exporter (raw application/zip; multipart boundaries break call()).
    // dry-run keeps the shared fixture db untouched while still exercising the manifest/report path.
    ["POST /api/bundles/import", { run: async () => {
      const zip = new Uint8Array(await (await call("GET", "/api/bundles/export")).arrayBuffer());
      return call("POST", "/api/bundles/import?mode=dry-run", zip, "application/zip");
    }, expected: ok(200) }],
    // Deletions last (CAS on the final head revisions)
    ["DELETE /api/prototypes/{id}/share/{shareId}", { run: () => call("DELETE", `/api/prototypes/contract-proto/share/${state.shareId}`), expected: ok(204) }],
    ["DELETE /api/prototypes/{id}/share/{shareId}", { run: () => call("DELETE", `/api/prototypes/contract-proto/share/${state.shareId}`), expected: err(404, "share_not_found") }],
    ["DELETE /api/visual-references/{id}", { run: () => call("DELETE", `/api/visual-references/${state.referenceId}`), expected: ok(204) }],
    ["DELETE /api/visual-references/{id}", { run: () => call("DELETE", `/api/visual-references/${state.referenceId}`), expected: err(404, "reference_not_found") }],
    // Ретайр дизайн-системы: успех на свежей пустой системе, 409 на повторе и на непустой.
    ["POST /api/design-systems", { run: () => call("POST", "/api/design-systems", { id: "contract-ds-retire", name: "Contract DS Retire", description: "Retired by the contract test" }), expected: ok(201) }],
    ["DELETE /api/design-systems/{id}", { run: () => call("DELETE", "/api/design-systems/contract-ds-retire"), expected: ok(204) }],
    ["DELETE /api/design-systems/{id}", { run: () => call("DELETE", "/api/design-systems/contract-ds-retire"), expected: err(409, "design_system_retired") }],
    ["DELETE /api/design-systems/{id}", { run: () => call("DELETE", "/api/design-systems/contract-ds"), expected: err(409, "design_system_in_use") }],
    ["DELETE /api/components/{id}", { run: () => call("DELETE", "/api/components/contract-stars", { baseRev: 3 }), expected: ok(204) }],
    ["DELETE /api/prototypes/{id}", { run: () => call("DELETE", "/api/prototypes/contract-proto", { baseRev: 3 }), expected: ok(204) }],
    ["POST /api/auth/logout", { run: () => handler(new Request("http://test/api/auth/logout", { method: "POST", headers: { origin: "http://test", cookie: state.loginCookie! } })), expected: ok(204) }],
  ];
}

describe("route contracts", () => {
  test("catalog gate is directly importable in a fresh Bun process", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", `
        import { reuseOverrideSchema } from "./server/catalog/gate.ts";
        const parsed = reuseOverrideSchema.parse({
          catalogRevision: "catalog-revision-1",
          candidateKeys: ["component:contract-ds:existing-rating"],
          reason: "  The approved exception keeps this component independently owned.  ",
        });
        console.log(JSON.stringify(parsed));
      `],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({
      catalogRevision: "catalog-revision-1",
      candidateKeys: ["component:contract-ds:existing-rating"],
      reason: "The approved exception keeps this component independently owned.",
    });
  });

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

  test("only POST candidate discovery declares the authoritative override template", () => {
    const response = {
      designSystem: "contract-ds",
      catalogRevision: "catalog-revision-1",
      policyVersion: 1,
      candidates: [],
      overrideTemplate: {
        catalogRevision: "catalog-revision-1",
        candidateKeys: ["component:contract-ds:existing-rating"],
      },
    };
    expect(catalogCandidatesContract.responseSchema!.safeParse(response).success).toBe(true);
    expect(catalogCandidatesGetContract.responseSchema!.safeParse(response).success).toBe(false);

    const document = JSON.parse(renderOpenApiJson()) as {
      paths: Record<string, Record<string, { responses: Record<string, { content: { "application/json": { schema: { properties: Record<string, unknown> } } } }> }>>;
    };
    const candidates = document.paths["/api/catalog/candidates"]!;
    expect(candidates.post!.responses["200"]!.content["application/json"].schema.properties).toHaveProperty("overrideTemplate");
    expect(candidates.get!.responses["200"]!.content["application/json"].schema.properties).not.toHaveProperty("overrideTemplate");
    expect(catalogCandidatesContract.errors.some((error) => error.status === 422 && error.code === "event_schema_not_serializable")).toBe(true);
    expect(catalogCandidatesGetContract.errors.some((error) => error.code === "event_schema_not_serializable")).toBe(false);
  });

  test("POST /api/components contract retains reuse-gate input and declared rejections", () => {
    const request = createComponentContract.requestSchema!;
    const parsed = request.parse({
      id: "contract-reuse",
      name: "ContractReuse",
      source: componentSource,
      designSystem: "contract-ds",
      intent: "A distinct product control for curated ratings",
      reuseOverride: {
        catalogRevision: "catalog-revision-1",
        candidateKeys: ["component:contract-ds:existing-rating"],
        reason: "The approved product exception needs an independently owned control.",
      },
    }) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      intent: "A distinct product control for curated ratings",
      reuseOverride: {
        catalogRevision: "catalog-revision-1",
        candidateKeys: ["component:contract-ds:existing-rating"],
      },
    });
    expect(createComponentContract.errors.map(({ status, code }) => ({ status, code }))).toEqual(expect.arrayContaining([
      { status: 403, code: "admin_required" },
      { status: 409, code: "component_reuse_required" },
      { status: 409, code: "catalog_changed" },
      { status: 409, code: "canonical_role_conflict" },
    ]));
    const errorResponseSchemas = (createComponentContract as RouteContract & {
      errorResponseSchemas?: Readonly<Record<number, { safeParse(value: unknown): { success: boolean } }>>;
    }).errorResponseSchemas;
    expect(errorResponseSchemas?.[409]?.safeParse({
      error: {
        code: "component_reuse_required",
        message: "An existing component already covers this proposal",
        catalogRevision: "catalog-revision-1",
        policyVersion: 1,
        candidates: [{
          kind: "component", key: "component:contract-ds:existing-rating", id: "existing-rating", name: "ExistingRating",
          designSystem: "contract-ds", version: 1, draft: false, description: "Existing rating", canonicalFor: [],
          deprecated: false, recommendable: true, headUsageCount: 0, score: 0.95, blocking: true, reasons: ["same product job"],
        }],
        retryable: false,
        resolution: "reuse",
        nextSteps: ["Reuse the existing component"],
        overrideTemplate: { catalogRevision: "catalog-revision-1", candidateKeys: ["component:contract-ds:existing-rating"] },
        decisionId: "decision-1",
        repeatedAttempts: 1,
      },
    }).success).toBe(true);
  });

  test("generated POST /api/components 409 schema exposes the reuse-gate envelope", () => {
    const document = JSON.parse(renderOpenApiJson()) as {
      paths: Record<string, { post: { responses: Record<string, { content: Record<string, { schema: Record<string, unknown> }> }> } }>;
    };
    const schema = document.paths["/api/components"]!.post.responses["409"]!.content["application/json"]!.schema;
    expect(schema).not.toEqual({ $ref: "#/components/schemas/ErrorEnvelope" });
    const error = schema.properties as Record<string, { anyOf: Array<{ properties: Record<string, Record<string, unknown>>; required: string[] }> }>;
    const reuseError = error.error.anyOf.find((variant) => Object.hasOwn(variant.properties, "catalogRevision"))!;
    expect(reuseError.properties.code).toMatchObject({ enum: ["component_reuse_required", "catalog_changed", "canonical_role_conflict"] });
    expect(reuseError.properties.catalogRevision).toMatchObject({ type: "string" });
    expect(reuseError.properties.policyVersion).toMatchObject({ type: "integer", minimum: 0 });
    expect(reuseError.properties.candidates).toMatchObject({
      type: "array",
      items: { type: "object", properties: { key: { type: "string" }, blocking: { type: "boolean" }, reasons: { type: "array" } } },
    });
    expect(reuseError.properties.retryable).toMatchObject({ type: "boolean", const: false });
    expect(reuseError.properties.resolution).toMatchObject({ enum: ["reuse", "escalate"] });
    expect(reuseError.properties.nextSteps).toMatchObject({ type: "array", items: { type: "string" } });
    expect(reuseError.properties.decisionId).toMatchObject({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect(reuseError.properties.repeatedAttempts).toMatchObject({
      anyOf: [expect.objectContaining({ type: "integer", minimum: 0 }), { type: "null" }],
    });
    expect(reuseError.properties.overrideTemplate).toMatchObject({
      properties: { candidateKeys: { type: "array", items: { type: "string" } } },
    });
    expect(reuseError.properties.conflictingRoles).toMatchObject({ type: "array", items: { type: "string" } });
    expect(reuseError.required).toEqual(expect.arrayContaining([
      "catalogRevision", "policyVersion", "candidates", "retryable", "resolution", "nextSteps",
      "overrideTemplate", "decisionId", "repeatedAttempts",
    ]));
    expect(reuseError.required).not.toContain("conflictingRoles");
  });

  test("POST /api/components/{id}/publish exposes the runtime reuse contract", () => {
    const reuseOverride = {
      catalogRevision: "catalog-revision-1",
      candidateKeys: ["component:contract-ds:existing-rating"],
      reason: "The approved product exception needs an independently owned control.",
    };
    const parsedRequest = publishComponentContract.requestSchema!.parse({
      baseRev: 2,
      message: "Publish the reviewed canonical role",
      reuseOverride,
    }) as Record<string, unknown>;
    expect(parsedRequest).toEqual({
      baseRev: 2,
      message: "Publish the reviewed canonical role",
      reuseOverride,
    });
    expect(publishComponentContract.requestSchema!.safeParse({ baseRev: 2, reuseOverride, unexpected: true }).success).toBe(false);
    expect(publishComponentContract.requestSchema!.safeParse({
      baseRev: 2,
      reuseOverride: { ...reuseOverride, unexpected: true },
    }).success).toBe(false);

    const declaredErrors = publishComponentContract.errors.map(({ status, code }) => ({ status, code }));
    expect(declaredErrors).toEqual(expect.arrayContaining([
      { status: 403, code: "admin_required" },
      { status: 409, code: "catalog_changed" },
      { status: 409, code: "canonical_role_conflict" },
    ]));
    expect(declaredErrors).not.toContainEqual({ status: 409, code: "component_reuse_required" });

    const errorResponseSchemas = (publishComponentContract as RouteContract & {
      errorResponseSchemas?: Readonly<Record<number, { safeParse(value: unknown): { success: boolean } }>>;
    }).errorResponseSchemas;
    const reuseError = {
      message: "Canonical role payment-success is already owned",
      catalogRevision: "catalog-revision-1",
      policyVersion: 1,
      candidates: [{
        kind: "component", key: "component:contract-ds:existing-rating", id: "existing-rating", name: "ExistingRating",
        designSystem: "contract-ds", version: 1, draft: false, description: "Existing rating", canonicalFor: ["payment-success"],
        deprecated: false, recommendable: true, headUsageCount: 0, score: 1, blocking: true, reasons: ["same canonical role"],
      }],
      retryable: false,
      resolution: "escalate",
      nextSteps: ["Ask an administrator for a reuse override"],
      overrideTemplate: { catalogRevision: "catalog-revision-1", candidateKeys: ["component:contract-ds:existing-rating"] },
      decisionId: "decision-1",
      repeatedAttempts: 1,
    } as const;
    expect(errorResponseSchemas?.[409]?.safeParse({ error: { code: "catalog_changed", ...reuseError } }).success).toBe(true);
    expect(errorResponseSchemas?.[409]?.safeParse({
      error: { code: "canonical_role_conflict", ...reuseError, conflictingRoles: ["payment-success"] },
    }).success).toBe(true);
    expect(errorResponseSchemas?.[409]?.safeParse({ error: { code: "component_reuse_required", ...reuseError } }).success).toBe(false);

    const document = JSON.parse(renderOpenApiJson()) as {
      paths: Record<string, { post: {
        requestBody: { content: { "application/json": { schema: Record<string, unknown> } } };
        responses: Record<string, { content: { "application/json": { schema: Record<string, unknown> } } }>;
      } }>;
    };
    const operation = document.paths["/api/components/{id}/publish"]!.post;
    expect(operation.requestBody.content["application/json"].schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["baseRev"],
      properties: {
        reuseOverride: {
          type: "object",
          additionalProperties: false,
          required: ["catalogRevision", "candidateKeys", "reason"],
        },
      },
    });
    expect(operation.responses).toHaveProperty("403");
    const conflictSchema = operation.responses["409"]!.content["application/json"].schema as {
      properties: { error: { anyOf: Array<{ properties: { code?: { enum?: string[] }; catalogRevision?: unknown } }> } };
    };
    const publishReuseError = conflictSchema.properties.error.anyOf.find((variant) => Object.hasOwn(variant.properties, "catalogRevision"))!;
    expect(publishReuseError.properties.code).toMatchObject({ enum: ["catalog_changed", "canonical_role_conflict"] });
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
      flowDepth: FLOW_DEPTH_LIMIT,
      compositionDepth: 5,
      validateUserConcurrent: 1,
      validateGlobalConcurrent: 2,
      validateCacheTtlHours: 24,
      validateCacheMiB: 32,
      computedEntries: COMPUTED_ENTRIES_LIMIT,
      computedFields: COMPUTED_FIELDS_LIMIT,
      computedTerms: COMPUTED_TERMS_LIMIT,
      acceptanceMaxCasesPerRun: ACCEPTANCE_MAX_CASES_PER_RUN,
      acceptanceMaxJobsPerRun: ACCEPTANCE_POLICIES["default-v1"].maxJobsPerRun,
      acceptanceCaseTtlHours: ACCEPTANCE_CASE_TTL_HOURS,
      evidenceMaxBytes: EVIDENCE_MAX_BYTES,
      surfaces: SURFACES_LIMIT,
    });
    expect(value.computedOps).toEqual([...COMPUTED_OPS]);
    // The ordered contract case may have created the fixture system already; Bun can execute
    // this independent case before or after it, so assert the stable built-in system only.
    expect(value.designSystems).toEqual(expect.arrayContaining(["yandex-pay"]));
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
      bundleExport: true,
      bundleImport: true,
      componentReuseGate: true,
      compositionV2: true,
      catalogMigration: true,
      componentValidate: true,
      componentGeometry: true,
      geometryPaint: true,
      // W4: декларативная readiness капчура + обязательный гейт `readiness`.
      captureReadiness: true,
      componentDraftPreview: true,
      prototypeHeadTracking: true,
      readinessProfile: true,
      themeDryRun: true,
      themeSparseOps: true,
      themeSpacingResolverV2: true,
      acceptancePromote: true,
      // Контракт-тест поднимает handler с оркестратором приёмки (иначе acceptance-роуты
      // не покрыть), поэтому матрица тут включена — на проде это `EASYUI_ACCEPTANCE_MATRIX`.
      acceptanceMatrix: true,
      acceptanceCandidates: true,
      acceptanceRuns: true,
      computed: true,
      surfaces: true,
      // Write-политика мульти-поверхностных документов — kill-switch EASYUI_SURFACES (D16).
      surfacesWrite: process.env.EASYUI_SURFACES === "1",
      // Write-политика композиций v3 — kill-switch EASYUI_COMPOSITION_V3 (D9, план 2026-08-03).
      compositionV3: process.env.EASYUI_COMPOSITION_V3 === "1",
    });
    expect(value.resolvedSpaceScales["yandex-pay"]).toMatchObject({ none: "0px", md: "12px", "4xl": "64px" });
  });

  // Фаза гейта — единственное поле discovery, которое зависит от конфигурации процесса.
  // До T4′ `main.ts` не прокидывал режим в `routeMeta`, и прод в shadow рапортовал `enforce`:
  // агент узнавал фактическую фазу только сломав собственный `POST /api/components`.
  test("GET /api/capabilities reports the resolved reuse-gate mode, not the code default", async () => {
    const readGate = async (call: (request: Request) => Promise<Response>) => {
      const response = await call(new Request("http://test/api/capabilities"));
      expect(response.status).toBe(200);
      return capabilitiesResponseSchema.parse(await response.json()).reuseGate;
    };
    expect(await readGate(handler)).toEqual({ mode: "enforce", intentRequired: true, policyVersion: CALIBRATED_POLICY.policyVersion });
    const shadow = createTestHandler(db, { dataDir: dir, reuseGateMode: "shadow" }) as (request: Request) => Promise<Response>;
    expect(await readGate(shadow)).toEqual({ mode: "shadow", intentRequired: false, policyVersion: CALIBRATED_POLICY.policyVersion });
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

  // План 2026-08-02 (computed-state), D5/D11: схема документа строится из **input**-ветки,
  // поэтому агент видит строгую грамматику `computed` без ручных `$defs` — record с regex
  // ключа и дискриминированным `oneOf` (не `anyOf`: варианты взаимоисключающие по `op`).
  test("GET /api/schemas/prototype-document.json describes computed as a keyed union of the four v1 ops", async () => {
    const response = await call("GET", "/api/schemas/prototype-document.json");
    expect(response.status).toBe(200);
    const schema = (await response.json()) as Record<string, unknown>;
    const defs = schema.$defs as Record<string, Record<string, unknown>>;
    // `reused: "ref"` выносит переиспользованные узлы в `$defs`; резолвим их по месту.
    const deref = (node: unknown): Record<string, unknown> => {
      let current = node as Record<string, unknown>;
      while (typeof current.$ref === "string") current = defs[(current.$ref as string).replace("#/$defs/", "")]!;
      return current;
    };
    const properties = schema.properties as Record<string, unknown>;
    expect(properties).toHaveProperty("computed");
    const computed = deref(properties.computed);
    expect(computed.type).toBe("object");
    expect(deref(computed.propertyNames).pattern).toBe("^[A-Za-z][A-Za-z0-9_-]*$");
    const entry = deref(computed.additionalProperties);
    expect(entry.anyOf).toBeUndefined();
    const variants = entry.oneOf as Array<{ properties: { op: { const?: string } } }>;
    expect(variants.map((variant) => variant.properties.op.const)).toEqual([...COMPUTED_OPS]);
    const byOp = new Map(variants.map((variant) => [variant.properties.op.const, variant as unknown as Record<string, unknown>]));
    expect((byOp.get("sumProduct")!.properties as Record<string, { maxItems?: number }>).fields!.maxItems).toBe(COMPUTED_FIELDS_LIMIT);
    expect((byOp.get("add")!.properties as Record<string, { maxItems?: number }>).terms!.maxItems).toBe(COMPUTED_TERMS_LIMIT);
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

  // Галерея показывает число сценариев в мете карточки, поэтому список обязан отдавать
  // `flowCount` головной ревизии — и обнулять его, когда документ сохранён без flows.
  test("GET /api/prototypes reports the head revision flow count", async () => {
    const doc = await flowDoc("contract-flow-count", ["home", "done"]);
    doc.flows = [{ id: "main", name: "Main", steps: [{ screenId: "home" }, { screenId: "done" }] }];
    expect((await call("POST", "/api/prototypes", { doc })).status).toBe(201);
    const flowCountOf = async (id: string) => ((await (await call("GET", "/api/prototypes")).json()) as { id: string; flowCount: number }[])
      .find((item) => item.id === id)!.flowCount;
    expect(await flowCountOf("contract-flow-count")).toBe(1);

    const withoutFlows: PrototypeDoc = { ...doc };
    delete withoutFlows.flows;
    expect((await call("PUT", "/api/prototypes/contract-flow-count", { baseRev: 1, doc: withoutFlows })).status).toBe(200);
    expect(await flowCountOf("contract-flow-count")).toBe(0);
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
          // Столько максимальных по длине флоу, чтобы суммарно перевалить за FLOW_TOTAL_STEPS_LIMIT
          // (после T4 лимит 320, и захардкоженные 4×50 его больше не превышали).
          ...Array.from({ length: Math.ceil((FLOW_TOTAL_STEPS_LIMIT + 1) / FLOW_STEPS_LIMIT) }, (_, flowIndex) => ({
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
