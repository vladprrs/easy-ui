import { readFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { prototypeActionSchemas } from "../../src/catalog/actions";
import { atomicLevels } from "../../src/designSystems/types";
import { layoutSpacingProps, spaceTokens } from "../../src/designSystems/types";
import { resolveSpacingScale } from "../../src/designSystems/spacingScale";
import {
  inputPrototypeDocSchema,
  ASSET_ID_PATTERN,
  FLOWS_LIMIT,
  FLOW_STEPS_LIMIT,
  FLOW_TOTAL_STEPS_LIMIT,
} from "../../src/prototype/schema";
import { ELEMENTS_PER_SCREEN_LIMIT, REPEAT_ELEMENT_LIMIT, REPEAT_RENDER_COST_BUDGET, TREE_DEPTH_LIMIT } from "../../src/prototype/validate";
import { MAX_ASSET_BYTES } from "../assets/validate";
import { listActiveDesignSystems } from "../designSystems";
import { getLatestDesignSystemContent } from "../designSystems";
import { ApiError, json, MAX_JSON_BODY_BYTES, noStore } from "../http";
import { GEOMETRY_RECT_LIMIT, MAX_QUEUE } from "../screenshot/service";

// Discovery endpoints (plan §G): /api/openapi.json, /api/schemas/*, /api/capabilities.
// The OpenAPI document is the committed artifact generated from server/contracts.ts;
// the JSON Schemas are derived from the same zod sources the server validates with.

type JsonObject = Record<string, unknown>;

// Component source ceiling enforced by checkSource in server/routes/components.ts (256 KiB).
// Kept here as the single non-imported limit: the enforcement site is owned by another task.
const COMPONENT_SOURCE_LIMIT_BYTES = 262144;

export const CAPABILITY_DIRECTIVES = ["$state", "$bindState", "$template", "$cond", "$asset"] as const;
export const CAPABILITY_PARAM_SOURCES = ["$event", "$elementId", "$itemIndex", "$itemKey"] as const;
// Closed v1 condition grammar operators (see checkCondition in src/prototype/validate.ts).
export const CAPABILITY_CONDITIONS = ["$and", "$or", "$state", "$item", "$index", "eq", "neq", "gt", "gte", "lt", "lte", "not"] as const;

export function capabilities(db: Database): JsonObject {
  const systems = listActiveDesignSystems(db);
  return {
    apiVersion: 1,
    documentVersion: 1,
    layoutContractVersion: 1,
    actions: Object.keys(prototypeActionSchemas),
    directives: [...CAPABILITY_DIRECTIVES],
    paramSources: [...CAPABILITY_PARAM_SOURCES],
    conditions: [...CAPABILITY_CONDITIONS],
    limits: {
      elements: ELEMENTS_PER_SCREEN_LIMIT,
      depth: TREE_DEPTH_LIMIT,
      bodyMiB: MAX_JSON_BODY_BYTES / (1024 * 1024),
      sourceKiB: COMPONENT_SOURCE_LIMIT_BYTES / 1024,
      assetMiB: MAX_ASSET_BYTES / (1024 * 1024),
      repeatBudget: REPEAT_RENDER_COST_BUDGET,
      repeatPerScreen: REPEAT_ELEMENT_LIMIT,
      screenshotQueue: MAX_QUEUE,
      geometryRects: GEOMETRY_RECT_LIMIT,
      flows: FLOWS_LIMIT,
      flowSteps: FLOW_STEPS_LIMIT,
      flowTotalSteps: FLOW_TOTAL_STEPS_LIMIT,
    },
    designSystems: systems.map((system) => system.id),
    resolvedSpaceScales: Object.fromEntries(systems.map((system) => {
      const theme = getLatestDesignSystemContent(db, system.id);
      return [system.id, resolveSpacingScale(system.id, theme.tokens)];
    })),
    regions: ["statusBar", "header", "footer"],
    features: {
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
    },
  };
}

const directive = (name: string, valueSchema: JsonObject, comment: string): JsonObject => ({
  type: "object",
  properties: { [name]: valueSchema },
  required: [name],
  additionalProperties: false,
  $comment: comment,
});

// prototypeDocSchema -> JSON Schema, with manual annotations for the directive grammar
// that lives in validate.ts rather than the zod schema (props are z.unknown there).
export function buildPrototypeDocumentSchema(): JsonObject {
  const schema = z.toJSONSchema(inputPrototypeDocSchema, { io: "input", reused: "ref", unrepresentable: "any" }) as JsonObject;
  schema.$id = "/api/schemas/prototype-document.json";
  schema.title = "easy-ui prototype document";
  const defs = ((schema.$defs ??= {}) as JsonObject);
  defs.stateDirective = directive("$state", { type: "string", pattern: "^/" }, "Binds the prop to the state value at this JSON Pointer.");
  defs.bindStateDirective = directive("$bindState", { type: "string", pattern: "^/" }, "Two-way binding: reads the state value and writes user input back to the same pointer.");
  defs.templateDirective = directive("$template", { type: "string" }, "String template; {{/pointer}} segments interpolate state values.");
  defs.condDirective = {
    type: "object",
    properties: { $cond: { type: "object", properties: { if: {}, then: {}, else: {} }, required: ["if"] } },
    required: ["$cond"],
    additionalProperties: false,
    $comment: "Conditional prop value; `if` uses the closed v1 condition grammar ($and/$or, one of $state/$item/$index, eq/neq/gt/gte/lt/lte/not).",
  };
  defs.assetDirective = directive("$asset", { type: "string", pattern: ASSET_ID_PATTERN.source }, "Content-addressed asset reference; resolves to /api/assets/<id> at render time.");
  const directiveRefs = ["stateDirective", "bindStateDirective", "templateDirective", "condDirective", "assetDirective"].map((name) => ({ $ref: `#/$defs/${name}` }));
  defs.propValue = {
    $comment: "A prop value is a literal JSON value or one of the directive objects: $state, $bindState, $template, $cond, $asset. Keys starting with __eui are reserved.",
    anyOf: [{ description: "Literal JSON value (directive-free)." }, ...directiveRefs],
  };
  defs.actionParamValue = {
    $comment:
      "Action param values are literal JSON values; inside custom-component events they may additionally use param sources: {\"$event\": \"/pointer\"} (typed payload pointer), \"$elementId\", \"$itemIndex\", \"$itemKey\" (repeat item context).",
    anyOf: [
      { description: "Literal JSON value." },
      directive("$event", { type: "string", pattern: "^/|^$" }, "Pointer into the typed event payload (custom-component events with a declared payload schema only)."),
      { const: "$elementId", $comment: "Resolves to the emitting element key." },
      { const: "$itemIndex", $comment: "Resolves to the repeat item index (requires a repeat ancestor)." },
      { const: "$itemKey", $comment: "Resolves to the repeat item identity (requires repeat.key)." },
    ],
  };
  // Attach the annotations to the generated tree: element props and action params are
  // open records in zod, so we locate those nodes structurally instead of by $defs name.
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const record = node as JsonObject;
    const properties = record.properties as JsonObject | undefined;
    if (properties && typeof properties === "object") {
      if (properties.type && properties.props && properties.on) {
        const props = properties.props as JsonObject;
        props.additionalProperties = { $ref: "#/$defs/propValue" };
      }
      if (properties.action && properties.params) {
        const params = properties.params as JsonObject;
        if (params.additionalProperties !== undefined) params.additionalProperties = { $ref: "#/$defs/actionParamValue" };
      }
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(schema);
  return schema;
}

// The custom-component `definition` contract (server/components/types.ts). The props and
// typed-event schemas are zod values in TSX source; on publish they are serialized to
// JSON Schema (propsJsonSchema / eventPayloads in the definition metadata).
export function buildComponentDefinitionSchema(): JsonObject {
  const jsonScalar = { type: ["string", "number", "boolean", "null"] };
  const layoutDirection = {
    anyOf: [
      { enum: ["vertical", "horizontal"] },
      {
        type: "object", additionalProperties: false, required: ["prop", "vertical", "horizontal"],
        properties: {
          prop: { type: "string" }, vertical: { type: "array", minItems: 1, items: jsonScalar },
          horizontal: { type: "array", minItems: 1, items: jsonScalar },
          none: { type: "array", minItems: 1, items: jsonScalar },
        },
      },
    ],
  };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "/api/schemas/component-definition.json",
    title: "easy-ui custom component definition",
    type: "object",
    required: ["props", "description"],
    additionalProperties: false,
    properties: {
      props: { $comment: "Zod object schema of the component props (serialized as propsJsonSchema on publish)." },
      events: {
        anyOf: [
          { type: "array", items: { type: "string" }, $comment: "Legacy payloadless event names." },
          {
            type: "object",
            additionalProperties: { $comment: "Zod schema of the typed event payload (serialized as eventPayloads on publish)." },
            $comment: "Typed event payloads; requires capabilities.typedEvents and host ABI v2.",
          },
        ],
      },
      slots: { type: "array", items: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }, $comment: "Named slots; requires capabilities.namedSlots." },
      capabilities: {
        type: "object",
        additionalProperties: false,
        properties: { typedEvents: { const: true }, namedSlots: { const: true } },
      },
      description: { type: "string" },
      example: { type: "object", $comment: "Example props used by Library previews and component capture." },
      examples: {
        type: "object",
        propertyNames: { pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 32, not: { const: "default" } },
        maxProperties: 8,
        additionalProperties: { type: "object" },
        $comment: "Named example props. Canonical JSON is limited to 16 KiB per example and 64 KiB per component.",
      },
      atomicLevel: { enum: [...atomicLevels] },
      layoutNeutral: { type: "boolean" },
      layout: {
        type: "object", additionalProperties: false, required: ["version"],
        properties: {
          version: { const: 1 },
          spacing: { type: "array", items: { enum: [...layoutSpacingProps] } },
          spacer: { const: true },
          flow: {
            type: "object", additionalProperties: false, required: ["kind", "direction"],
            properties: {
              kind: { const: "flex" }, direction: layoutDirection,
              wrap: { type: "object", additionalProperties: false, required: ["prop", "enabled"], properties: { prop: { type: "string" }, enabled: { type: "array", minItems: 1, items: jsonScalar } } },
              slot: { type: "string" },
            },
          },
        },
        $comment: `Layout metadata v1. Spacing props accept subsets of: ${spaceTokens.join(", ")}. Cross-field invariants are enforced during extraction.`,
      },
      interactive: { type: "boolean" },
      accessibleLabelProps: { type: "array", items: { type: "string" } },
      urlProps: { type: "array", items: { type: "string" } },
    },
  };
}

const openapiUrl = new URL("../openapi.json", import.meta.url);
let cachedOpenapi: string | null = null;
let cachedPrototypeDocumentSchema: string | null = null;
let cachedComponentDefinitionSchema: string | null = null;

const jsonText = (body: string): Response =>
  new Response(body, { headers: { "content-type": "application/json; charset=utf-8", ...noStore } });

/** Handles /api/openapi.json, /api/schemas/*, /api/capabilities; null when the path is not a meta route. */
export function routeMeta(request: Request, db: Database, segments: string[]): Response | null {
  const requireGet = () => { if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed"); };
  if (segments[0] === "openapi.json" && segments.length === 1) {
    requireGet();
    cachedOpenapi ??= readFileSync(openapiUrl, "utf8");
    return jsonText(cachedOpenapi);
  }
  if (segments[0] === "capabilities" && segments.length === 1) {
    requireGet();
    return json(capabilities(db), 200, noStore);
  }
  if (segments[0] === "schemas" && segments.length === 2) {
    requireGet();
    if (segments[1] === "prototype-document.json") {
      cachedPrototypeDocumentSchema ??= JSON.stringify(buildPrototypeDocumentSchema());
      return jsonText(cachedPrototypeDocumentSchema);
    }
    if (segments[1] === "component-definition.json") {
      cachedComponentDefinitionSchema ??= JSON.stringify(buildComponentDefinitionSchema());
      return jsonText(cachedComponentDefinitionSchema);
    }
    throw new ApiError(404, "not_found", "Unknown schema");
  }
  return null;
}
