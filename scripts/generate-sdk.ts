// Generates the typed authoring SDK catalog (sdk/catalog.<designSystem>.d.ts) from the live
// catalog manifest (GET /api/catalog/manifest?designSystem=…) or from a committed JSON snapshot.
// Deterministic: components and object properties are sorted before rendering, so re-running the
// generator on an unchanged manifest is a no-op (see scripts/check-sdk-drift.ts).
//
//   npm run generate:sdk -- --design-system yandex-pay --api http://127.0.0.1:8787/api
//   npm run generate:sdk -- --design-system sdk-demo --from sdk/fixtures/catalog.sdk-demo.json
//   npm run verify:sdk        — typecheck + drift check + sdk tests
//
// Auth for the live mode uses the repo-wide env vars consumed by scripts/easyui-auth.mjs:
// EASYUI_USERNAME / EASYUI_PASSWORD (and optionally EASYUI_LEGACY_BASIC_AUTH).

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createEasyUiClient, easyUiCredentials } from "./easyui-auth.mjs";

export const SDK_DIR = resolve(import.meta.dirname, "../sdk");
/** Design system of the committed snapshot the drift check runs against (no server required). */
export const SNAPSHOT_DESIGN_SYSTEM = "sdk-demo";
export const snapshotPath = (designSystem: string) => resolve(SDK_DIR, `fixtures/catalog.${designSystem}.json`);
export const catalogDtsPath = (designSystem: string) => resolve(SDK_DIR, `catalog.${designSystem}.d.ts`);

/** The subset of the manifest entry the SDK needs. Unknown extra fields are ignored. */
export interface ManifestComponent {
  id: string;
  name: string;
  designSystem: string;
  version: number;
  description?: string;
  atomicLevel?: string;
  events?: string[];
  eventPayloads?: Record<string, unknown>;
  slots?: string[];
  capabilities?: { typedEvents?: true; namedSlots?: true };
  propsJsonSchema?: unknown;
  // Not emitted by the server today (wave 2 metadata); read defensively so the SDK picks them up
  // as soon as they appear.
  scope?: string;
  canonicalFor?: string[];
}

/**
 * Discovery summary of the reuse gate, read from `GET /api/capabilities` (`reuseGate`).
 * The SDK carries it because the phase decides whether `intent` is mandatory on component
 * creation — see docs/agent-authoring-policy.md §4 and docs/server-api.md.
 */
export interface ReuseGateSummary { mode: string; intentRequired: boolean; policyVersion: number }

export interface CatalogManifestSnapshot { components: ManifestComponent[]; reuseGate?: ReuseGateSummary }


const COMPONENT_NAME_PATTERN = /^[A-Z][A-Za-z0-9]*$/;
const JSON_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isReuseGateSummary = (value: unknown): value is ReuseGateSummary =>
  isObject(value) && typeof value.mode === "string" && typeof value.intentRequired === "boolean" && typeof value.policyVersion === "number";

/** Header line describing the gate phase; omitted when the manifest source carries no capabilities. */
export const reuseGateNote = (gate: ReuseGateSummary | undefined): string[] => (gate
  ? [`// Reuse gate: ${gate.mode} · intent ${gate.intentRequired ? "required" : "optional"} for new components · policy v${gate.policyVersion} (GET /api/capabilities)`]
  : []);

const quote = (value: string) => JSON.stringify(value);
const propertyKey = (name: string) => (JSON_IDENTIFIER.test(name) ? name : quote(name));
const unionOf = (parts: string[]) => (parts.length ? [...new Set(parts)].join(" | ") : "never");
const literal = (value: unknown): string => (typeof value === "string" ? quote(value) : value === undefined ? "undefined" : JSON.stringify(value));

// --- JSON Schema -> TypeScript -------------------------------------------------------------

type Schema = Record<string, unknown>;

interface RenderContext { root: Schema; seen: Set<string>; indent: string }

const resolveRef = (ref: string, root: Schema): Schema | undefined => {
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObject(node)) return undefined;
    node = node[segment];
  }
  return isObject(node) ? node : undefined;
};

const primitiveType = (type: string): string => {
  switch (type) {
    case "string": return "string";
    case "number": case "integer": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "array": return "unknown[]";
    case "object": return "Record<string, unknown>";
    default: return "unknown";
  }
};

/** Renders a JSON Schema node as a TypeScript type expression. Unsupported constructs widen to `unknown`. */
function tsType(node: unknown, context: RenderContext): string {
  if (node === true || node === undefined) return "unknown";
  if (node === false) return "never";
  if (!isObject(node)) return "unknown";

  if (typeof node.$ref === "string") {
    const ref = node.$ref;
    if (context.seen.has(ref)) return "unknown"; // recursive schema — widen instead of looping
    const target = resolveRef(ref, context.root);
    if (!target) return "unknown";
    return tsType(target, { ...context, seen: new Set([...context.seen, ref]) });
  }

  if ("const" in node) return literal(node.const);
  if (Array.isArray(node.enum)) return unionOf(node.enum.map(literal));

  const variants = node.anyOf ?? node.oneOf;
  if (Array.isArray(variants)) return unionOf(variants.map((variant) => tsType(variant, context)));
  if (Array.isArray(node.allOf)) {
    const parts = node.allOf.map((part) => tsType(part, context));
    return parts.length ? [...new Set(parts)].join(" & ") : "unknown";
  }

  if (Array.isArray(node.type)) return unionOf(node.type.map((type) => (typeof type === "string" ? primitiveType(type) : "unknown")));

  if (node.type === "array" || Array.isArray(node.prefixItems)) {
    if (Array.isArray(node.prefixItems)) {
      const tuple = node.prefixItems.map((item) => tsType(item, context)).join(", ");
      const rest = node.items === undefined || node.items === false ? "" : `, ...${tsType(node.items, context)}[]`;
      return `[${tuple}${rest}]`;
    }
    return `Array<${tsType(node.items, context)}>`;
  }

  if (node.type === "object" || isObject(node.properties) || node.additionalProperties !== undefined) return objectType(node, context);
  if (typeof node.type === "string") return primitiveType(node.type);
  return "unknown";
}

function objectType(node: Schema, context: RenderContext): string {
  const properties = isObject(node.properties) ? node.properties : {};
  const required = new Set(Array.isArray(node.required) ? node.required.filter((name): name is string => typeof name === "string") : []);
  const inner = context.indent + "  ";
  const lines = Object.keys(properties).sort().map((name) => {
    const type = tsType(properties[name], { ...context, indent: inner });
    return `${inner}${propertyKey(name)}${required.has(name) ? "" : "?"}: ${type};`;
  });
  const additional = node.additionalProperties;
  if (additional !== undefined && additional !== false) {
    lines.push(`${inner}[key: string]: ${additional === true ? "unknown" : tsType(additional, { ...context, indent: inner })};`);
  }
  if (!lines.length) return "Record<string, never>";
  return `{\n${lines.join("\n")}\n${context.indent}}`;
}

const schemaContext = (schema: unknown): RenderContext => ({ root: isObject(schema) ? schema : {}, seen: new Set(), indent: "" });

/** Renders the props interface body (`Authored<T>` per top-level prop) or a type alias for non-object schemas. */
function renderPropsDeclaration(name: string, schema: unknown): string {
  const context = schemaContext(schema);
  const node = isObject(schema) ? schema : undefined;
  const properties = node && isObject(node.properties) ? node.properties : undefined;
  if (!node || (!properties && node.type !== "object")) return `export type ${name}Props = Record<string, unknown>;`;

  const required = new Set(Array.isArray(node.required) ? node.required.filter((value): value is string => typeof value === "string") : []);
  const lines = Object.keys(properties ?? {}).sort().map((property) => {
    const type = tsType((properties ?? {})[property], { ...context, indent: "  " });
    return `  ${propertyKey(property)}${required.has(property) ? "" : "?"}: Authored<${type}>;`;
  });
  if (node.additionalProperties !== undefined && node.additionalProperties !== false) {
    const type = node.additionalProperties === true ? "unknown" : tsType(node.additionalProperties, { ...context, indent: "  " });
    lines.push(`  [key: string]: Authored<${type}>;`);
  }
  if (!lines.length) return `export type ${name}Props = Record<string, never>;`;
  return `export interface ${name}Props {\n${lines.join("\n")}\n}`;
}

// --- Renderer -------------------------------------------------------------------------------

const HEADER_NOTE = [
  "// Generated by scripts/generate-sdk.ts. Do not edit by hand.",
  "// Regenerate: npm run generate:sdk -- --design-system <id> [--api <base> | --from <snapshot.json>]",
];

const PRELUDE = `/** Render-time directive accepted in place of a literal prop value ($state/$bindState/$template/$cond/$asset). */
export type Directive = { [key: \`$\${string}\`]: unknown };
/** An authored prop value: a literal, or a directive resolved by the runtime. */
export type Authored<T> = T | Directive;`;

export function renderCatalogDts(manifest: CatalogManifestSnapshot, designSystem: string): string {
  const components = manifest.components
    .filter((component) => component.designSystem === designSystem)
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  if (!components.length) throw new Error(`Catalog manifest has no components for design system "${designSystem}"`);
  const seenNames = new Set<string>();
  for (const component of components) {
    if (!COMPONENT_NAME_PATTERN.test(component.name)) throw new Error(`Component name is not a TypeScript identifier: ${component.name} (${component.id})`);
    if (seenNames.has(component.name)) throw new Error(`Duplicate component name in manifest: ${component.name}`);
    seenNames.add(component.name);
  }

  const blocks: string[] = [];
  const entries: string[] = [];

  for (const component of components) {
    const { name } = component;
    const events = [...new Set(component.events ?? [])].sort();
    const slots = [...new Set(component.slots ?? [])].sort();
    const payloads = isObject(component.eventPayloads) ? component.eventPayloads : {};
    const payloadLines = Object.keys(payloads).sort().map((event) => {
      const context = schemaContext(payloads[event]);
      return `  ${propertyKey(event)}: ${tsType(payloads[event], { ...context, indent: "  " })};`;
    });

    const doc = [`/** ${component.description?.replace(/\s+/g, " ").trim() || name} */`];
    blocks.push([
      doc.join("\n"),
      renderPropsDeclaration(name, component.propsJsonSchema),
      `export type ${name}Slots = ${unionOf(slots.map(quote))};`,
      `export type ${name}Events = ${unionOf(events.map(quote))};`,
      payloadLines.length
        ? `export interface ${name}EventPayloads {\n${payloadLines.join("\n")}\n}`
        : `export type ${name}EventPayloads = Record<string, never>;`,
    ].join("\n"));

    entries.push([
      `  ${propertyKey(name)}: {`,
      `    id: ${quote(component.id)};`,
      `    version: ${component.version};`,
      `    props: ${name}Props;`,
      `    slots: ${name}Slots;`,
      `    events: ${name}Events;`,
      `    eventPayloads: ${name}EventPayloads;`,
      `    atomicLevel: ${component.atomicLevel ? quote(component.atomicLevel) : "undefined"};`,
      `    namedSlots: ${component.capabilities?.namedSlots ? "true" : "false"};`,
      `    typedEvents: ${component.capabilities?.typedEvents ? "true" : "false"};`,
      `    scope: ${component.scope ? quote(component.scope) : "undefined"};`,
      `    canonicalFor: ${component.canonicalFor?.length ? unionOf(component.canonicalFor.map(quote)) : "never"};`,
      "  };",
    ].join("\n"));
  }

  const tail = [
    `export interface CatalogComponents {\n${entries.join("\n")}\n}`,
    "export type ComponentName = keyof CatalogComponents & string;",
    "export type PropsOf<N extends ComponentName> = CatalogComponents[N][\"props\"];",
    "export type SlotsOf<N extends ComponentName> = CatalogComponents[N][\"slots\"];",
    "export type EventsOf<N extends ComponentName> = CatalogComponents[N][\"events\"];",
    "export type EventPayloadsOf<N extends ComponentName> = CatalogComponents[N][\"eventPayloads\"];",
  ];

  return [
    ...HEADER_NOTE,
    `// Design system: ${designSystem} · components: ${components.length}`,
    ...reuseGateNote(manifest.reuseGate),
    "",
    PRELUDE,
    "",
    ...blocks.flatMap((block) => [block, ""]),
    ...tail.flatMap((block) => [block, ""]),
  ].join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
}

// --- Manifest sources -----------------------------------------------------------------------

export function readSnapshot(path: string): CatalogManifestSnapshot {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isObject(parsed) || !Array.isArray(parsed.components)) throw new Error(`${path} is not a catalog manifest ({components: [...]})`);
  return parsed as unknown as CatalogManifestSnapshot;
}

/**
 * Reads the reuse-gate phase from discovery. Never fatal: an instance that does not publish
 * `reuseGate` (or an unreachable one) simply produces types without the discovery summary line.
 */
export async function fetchReuseGate(apiBase: string): Promise<ReuseGateSummary | undefined> {
  const client = createEasyUiClient({ apiBase, credentials: easyUiCredentials() });
  const response = await client.request("/capabilities");
  if (!response.ok) return undefined;
  const capabilities = await response.json() as unknown;
  const gate = isObject(capabilities) ? capabilities.reuseGate : undefined;
  return isReuseGateSummary(gate) ? gate : undefined;
}

export async function fetchManifest(apiBase: string, designSystem: string): Promise<CatalogManifestSnapshot> {
  const client = createEasyUiClient({ apiBase, credentials: easyUiCredentials() });
  const response = await client.request(`/catalog/manifest?designSystem=${encodeURIComponent(designSystem)}`);
  if (!response.ok) throw new Error(`GET /catalog/manifest failed: HTTP ${response.status} ${await response.text()}`);
  const manifest = await response.json() as CatalogManifestSnapshot;
  if (!Array.isArray(manifest.components)) throw new Error("Catalog manifest response has no components array");
  return manifest;
}

/** Stable snapshot serialization so `--snapshot-out` output is diffable across runs. */
export const renderSnapshotJson = (manifest: CatalogManifestSnapshot, designSystem: string): string =>
  JSON.stringify({
    components: manifest.components
      .filter((component) => component.designSystem === designSystem)
      .slice()
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    ...(manifest.reuseGate === undefined ? {} : { reuseGate: manifest.reuseGate }),
  }, null, 2) + "\n";

// --- CLI ------------------------------------------------------------------------------------

const argument = (argv: string[], flag: string, fallback?: string): string | undefined => {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

export async function main(argv: string[]): Promise<void> {
  const designSystem = argument(argv, "--design-system") ?? argument(argv, "--designSystem");
  if (!designSystem) throw new Error("Usage: tsx scripts/generate-sdk.ts --design-system <id> [--api <base> | --from <snapshot.json>] [--out <file.d.ts>] [--snapshot-out <file.json>]");
  const from = argument(argv, "--from");
  const apiBase = argument(argv, "--api", process.env.EASYUI_API ?? "http://127.0.0.1:8787/api")!;

  const manifest = from ? readSnapshot(resolve(from)) : await fetchManifest(apiBase, designSystem);
  if (!from && manifest.reuseGate === undefined) manifest.reuseGate = await fetchReuseGate(apiBase);
  console.log(manifest.reuseGate
    ? `Reuse gate: ${manifest.reuseGate.mode} · intent ${manifest.reuseGate.intentRequired ? "required" : "optional"} for new components · policy v${manifest.reuseGate.policyVersion}`
    : "Reuse gate: unknown (source carries no capabilities; regenerate with --api to record it)");
  const snapshotOut = argument(argv, "--snapshot-out");
  if (snapshotOut) {
    const path = resolve(snapshotOut);
    writeFileSync(path, renderSnapshotJson(manifest, designSystem));
    console.log(`Wrote ${path}`);
  }
  const out = resolve(argument(argv, "--out") ?? catalogDtsPath(designSystem));
  writeFileSync(out, renderCatalogDts(manifest, designSystem));
  console.log(`Wrote ${out} (${from ? `snapshot ${from}` : `${apiBase} · ${designSystem}`})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
