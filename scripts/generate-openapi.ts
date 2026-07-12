// Generates server/openapi.json (OpenAPI 3.1) from the route-contract registry
// (server/contracts.ts). Deterministic: object keys are deep-sorted before writing,
// so re-running the generator on an unchanged registry is a no-op.
//
//   npm run generate:openapi   — regenerate the committed document
//   npm run verify:openapi     — drift check (scripts/check-openapi-drift.ts)

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { listContracts, type RouteContract } from "../server/contracts";

export const OPENAPI_PATH = resolve(import.meta.dirname, "../server/openapi.json");

type JsonObject = Record<string, unknown>;

const sortKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const record = value as JsonObject;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortKeysDeep(record[key])]));
  }
  return value;
};

// Contract zod schema -> JSON Schema. Request/query schemas are converted with io:"input"
// (defaults optional, pre-transform types); responses with io:"output". Transforms and
// other unrepresentable constructs degrade to permissive schemas instead of throwing.
const toJsonSchema = (schema: z.ZodType, io: "input" | "output"): JsonObject => {
  const result = z.toJSONSchema(schema, { io, reused: "ref", unrepresentable: "any" }) as JsonObject;
  delete result.$schema;
  return result;
};

const pathParameters = (path: string): JsonObject[] =>
  [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1]!,
    in: "path",
    required: true,
    schema: { type: "string" },
  }));

const queryParameters = (schema: z.ZodType): JsonObject[] => {
  const json = toJsonSchema(schema, "input");
  const properties = (json.properties ?? {}) as Record<string, JsonObject>;
  const required = new Set((json.required as string[] | undefined) ?? []);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: "query",
    required: required.has(name),
    schema: property,
  }));
};

const ERROR_ENVELOPE_REF = "#/components/schemas/ErrorEnvelope";

const errorEnvelopeSchema: JsonObject = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        issues: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { description: "Issue location as a path array or string (legacy shape)." },
              pointer: { type: "string", description: "RFC 6901 JSON Pointer to the invalid location." },
              message: { type: "string" },
            },
          },
        },
        warnings: { type: "array" },
        currentRev: { type: "number" },
        currentVersion: { type: "number" },
      },
    },
  },
};

const successResponse = (contract: RouteContract): JsonObject => {
  const status = contract.status ?? 200;
  if (status === 204) return { description: "No content" };
  const response: JsonObject = { description: "Success" };
  if (contract.contentType) response.content = { [contract.contentType]: {} };
  else if (contract.responseSchema) response.content = { "application/json": { schema: toJsonSchema(contract.responseSchema, "output") } };
  return response;
};

const errorResponses = (contract: RouteContract): JsonObject => {
  const byStatus = new Map<number, string[]>();
  for (const error of contract.errors) {
    const label = error.description ? `${error.code} (${error.description})` : error.code;
    byStatus.set(error.status, [...(byStatus.get(error.status) ?? []), label]);
  }
  return Object.fromEntries(
    [...byStatus.entries()].map(([status, codes]) => [
      String(status),
      { description: codes.join(" | "), content: { "application/json": { schema: { $ref: ERROR_ENVELOPE_REF } } } },
    ]),
  );
};

const operationId = (contract: RouteContract): string =>
  `${contract.method.toLowerCase()}_${contract.path.replace(/^\/api\//, "").replace(/[{}]/g, "").replace(/[^a-zA-Z0-9]+/g, "_").replace(/_+$/, "")}`;

export function buildOpenApiDocument(): JsonObject {
  const paths: Record<string, JsonObject> = {};
  for (const contract of listContracts()) {
    const parameters = [...pathParameters(contract.path), ...(contract.query ? queryParameters(contract.query) : [])];
    const operation: JsonObject = {
      operationId: operationId(contract),
      summary: contract.summary ?? "",
      "x-easyui-validated": contract.validated === true,
      responses: {
        [String(contract.status ?? 200)]: successResponse(contract),
        ...errorResponses(contract),
      },
    };
    if (parameters.length) operation.parameters = parameters;
    if (contract.requestSchema) {
      operation.requestBody = { required: true, content: { "application/json": { schema: toJsonSchema(contract.requestSchema, "input") } } };
    }
    const entry = (paths[contract.path] ??= {});
    const method = contract.method.toLowerCase();
    if (entry[method]) throw new Error(`Duplicate contract for ${contract.method} ${contract.path}`);
    entry[method] = operation;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "easy-ui API",
      version: "1.0.0",
      description:
        "Prototype-viewer server API. Generated from the route-contract registry (server/contracts.ts); regenerate with `npm run generate:openapi`. Operations marked `x-easyui-validated: false` document handlers that validate input independently of the contract schemas.",
    },
    paths,
    components: { schemas: { ErrorEnvelope: errorEnvelopeSchema } },
  };
}

export function renderOpenApiJson(): string {
  return JSON.stringify(sortKeysDeep(buildOpenApiDocument()), null, 2) + "\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(OPENAPI_PATH, renderOpenApiJson());
  console.log(`Wrote ${OPENAPI_PATH}`);
}
