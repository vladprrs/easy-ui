import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import {
  compositionDocSchema,
  expandCompositions,
  type CompositionDoc,
  isCompositionWithMetadata,
  type CompositionDocWithMetadata,
  type CompositionCatalogEntry,
  type CompositionSource,
} from "../../src/prototype/composition";
import type { PrototypeDoc } from "../../src/prototype/schema";
import { paramPlaceholder } from "../../src/prototype/compositionV3/params";
import { hostPrimitiveNames } from "../../src/catalog/hostPrimitives/definitions";
import { COMPOSITION_TYPE } from "../../src/catalog/hostPrimitives/composition.definition";
import { ApiError } from "../http";

/**
 * Репозиторий версионированных композиций (волна 5, миграция v18).
 * Зеркалит `ComponentRepo`: head_rev + ревизии + неизменяемые публикации + мягкое удаление.
 * Отличие — публиковать нечего компилировать: артефакт публикации это сам документ,
 * его `source_hash` считается по каноническому JSON.
 */

const now = () => new Date().toISOString();
const TRANSITIONS: Record<string, string[]> = {
  active: ["deprecated", "superseded", "archived"],
  deprecated: ["archived", "active"],
  superseded: ["archived", "active"],
  archived: [],
};

const canonicalRoleSlugs = new Set<string>((JSON.parse(readFileSync(new URL("../catalog/roles.json", import.meta.url), "utf8")) as { roles?: Array<{ slug?: unknown }> }).roles
  ?.map((role) => role.slug).filter((slug): slug is string => typeof slug === "string") ?? []);

export type { CompositionDocV2, CompositionDocV3, CompositionDocWithMetadata } from "../../src/prototype/composition";
export type AnyCompositionDoc = CompositionDoc;

export function safeParseCompositionDocument(value: unknown) {
  return compositionDocSchema.safeParse(value);
}

export function parseCompositionDocument(value: unknown): AnyCompositionDoc {
  const parsed = safeParseCompositionDocument(value);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}

/**
 * Документ несёт каталожные метаданные (`atomicLevel`/`canonicalFor`/строгий closure) —
 * то есть v2 **или старше**. С появлением v3 (план 2026-08-03 W8a) точечная сверка с
 * `version === 2` молча выключала бы для v3 роли, strict-closure и publish-валидацию.
 */
export const isCompositionV2 = (doc: CompositionDoc | AnyCompositionDoc): doc is CompositionDocWithMetadata =>
  isCompositionWithMetadata(doc as { version?: unknown });

function assertCanonicalRoles(db: Database, doc: CompositionDoc, designSystem: string, excludeId?: string): void {
  if (!isCompositionV2(doc)) return;
  const roles = [...new Set(doc.canonicalFor ?? [])];
  const unknown = roles.filter((role) => !canonicalRoleSlugs.has(role));
  if (unknown.length) throw new ApiError(422, "validation_failed", "Composition canonical roles are invalid", { issues: unknown.map((role) => ({ path: ["canonicalFor"], message: `unknown canonical role: ${role}` })) });
  if (roles.length !== (doc.canonicalFor ?? []).length) throw new ApiError(422, "validation_failed", "Composition canonical roles must be unique", { issues: [{ path: ["canonicalFor"], message: "canonicalFor must not contain duplicate roles" }] });
  const conflicts = new Set<string>();
  const componentRows = db.query(`SELECT p.definition_meta definitionMeta
    FROM component_publishes p JOIN component_revisions r ON r.component_id=p.component_id AND r.rev=p.rev
    WHERE p.status='active' AND r.design_system=?`).all(designSystem) as { definitionMeta: string }[];
  for (const row of componentRows) {
    try {
      const meta = JSON.parse(row.definitionMeta) as { canonicalFor?: unknown };
      for (const role of roles) if (Array.isArray(meta.canonicalFor) && meta.canonicalFor.includes(role)) conflicts.add(role);
    } catch { /* invalid legacy metadata is reported by its own validation path */ }
  }
  const compositionRows = db.query(`SELECT c.id,r.doc,r.rev
    FROM compositions c JOIN composition_publishes p ON p.composition_id=c.id AND p.status='active'
    JOIN composition_revisions r ON r.composition_id=p.composition_id AND r.rev=p.rev
    WHERE c.design_system=? AND c.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM composition_publishes newer WHERE newer.composition_id=p.composition_id AND newer.status='active' AND newer.version>p.version)`).all(designSystem) as { id: string; doc: string; rev: number }[];
  for (const row of compositionRows) {
    if (row.id === excludeId) continue;
    try {
      const other = parseStoredCompositionDoc(row.doc, row.id, row.rev);
      if (isCompositionV2(other)) for (const role of roles) if (other.canonicalFor?.includes(role)) conflicts.add(role);
    } catch { /* see component branch */ }
  }
  if (conflicts.size) throw new ApiError(409, "canonical_role_conflict", `Canonical role(s) ${[...conflicts].sort().join(", ")} are already owned in ${designSystem}`, { issues: [{ path: ["canonicalFor"], message: "canonical roles are unique per design system" }] });
}

export const compositionSourceHash = (doc: CompositionDoc | AnyCompositionDoc): string =>
  new Bun.CryptoHasher("sha256").update(canonicalJson(doc)).digest("hex");

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export type CompositionRow = {
  id: string; name: string; head_rev: number; design_system: string; owner_id: string | null;
  deleted_at: string | null; delete_reason: string | null; created_at: string; updated_at: string;
};

export type CompositionDependencyPin = { id: string; name: string; version: number; sourceHash: string };
export type ComponentDependencyPin = { id: string; name: string; version: number; bundleHash: string };
export type CompositionDependencyManifest = {
  version: 1;
  root: { id: string; version: number };
  compositions: CompositionDependencyPin[];
  components: ComponentDependencyPin[];
  hash: string;
};

export const COMPOSITION_NESTING_DEPTH_LIMIT = 5;

const manifestPayload = (manifest: Omit<CompositionDependencyManifest, "hash">): Omit<CompositionDependencyManifest, "hash"> => ({
  version: 1,
  root: { ...manifest.root },
  compositions: [...manifest.compositions].sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version),
  components: [...manifest.components].sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version),
});

export const compositionDependencyManifestHash = (manifest: Omit<CompositionDependencyManifest, "hash">): string =>
  new Bun.CryptoHasher("sha256").update(canonicalJson(manifestPayload(manifest))).digest("hex");

const publicationManifestPrefix = "\u0000easy-ui-composition-manifest-v1:";

function isCompositionDependencyManifest(value: unknown): value is CompositionDependencyManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || typeof candidate.hash !== "string") return false;
  const root = candidate.root;
  if (!root || typeof root !== "object" || Array.isArray(root)) return false;
  const rootRecord = root as Record<string, unknown>;
  if (typeof rootRecord.id !== "string" || typeof rootRecord.version !== "number") return false;
  const list = (item: unknown): item is Record<string, unknown>[] => Array.isArray(item) && item.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
  if (!list(candidate.compositions) || !list(candidate.components)) return false;
  if (candidate.compositions.some((entry) => typeof entry.id !== "string" || typeof entry.name !== "string" || typeof entry.version !== "number" || typeof entry.sourceHash !== "string")) return false;
  if (candidate.components.some((entry) => typeof entry.id !== "string" || typeof entry.name !== "string" || typeof entry.version !== "number" || typeof entry.bundleHash !== "string")) return false;
  const withoutHash = { version: 1 as const, root: { id: rootRecord.id, version: rootRecord.version }, compositions: candidate.compositions as CompositionDependencyPin[], components: candidate.components as ComponentDependencyPin[] };
  return compositionDependencyManifestHash(withoutHash) === candidate.hash;
}

export function readCompositionDependencyManifest(message: string | null | undefined): CompositionDependencyManifest | null {
  if (!message?.startsWith(publicationManifestPrefix)) return null;
  try {
    const envelope = JSON.parse(message.slice(publicationManifestPrefix.length)) as { manifest?: unknown };
    if (!isCompositionDependencyManifest(envelope.manifest)) throw new Error("manifest shape or hash is invalid");
    return envelope.manifest;
  } catch {
    throw new ApiError(422, "invalid_stored_revision", "Stored composition dependency manifest is invalid");
  }
}

function readStoredManifest(
  manifestJson: string | null | undefined,
  manifestHash: string | null | undefined,
  legacyMessage: string | null | undefined,
): CompositionDependencyManifest | null {
  if (manifestJson && manifestJson !== "[]") {
    try {
      const value = JSON.parse(manifestJson) as unknown;
      if (!isCompositionDependencyManifest(value)) throw new Error("manifest shape or hash is invalid");
      if (manifestHash !== value.hash) throw new Error("manifest hash column does not match payload");
      return value;
    } catch {
      throw new ApiError(422, "invalid_stored_revision", "Stored composition dependency manifest is invalid");
    }
  }
  return readCompositionDependencyManifest(legacyMessage);
}

export const parseStoredCompositionDoc = (json: string, id: string, rev: number): CompositionDoc => {
  try { return parseCompositionDocument(JSON.parse(json)) as CompositionDoc; }
  catch { throw new ApiError(422, "invalid_stored_revision", `Stored composition revision is invalid: ${id} rev ${rev}`); }
};

type CompositionNode = {
  id: string;
  name: string;
  designSystem: string;
  version: number;
  sourceHash: string;
  doc: CompositionDoc;
  status?: string;
  storedManifest: CompositionDependencyManifest | null;
};

type CompositionRoot = Omit<CompositionNode, "storedManifest"> & { storedManifest?: CompositionDependencyManifest | null };

export type CompositionClosure = {
  docs: Record<string, CompositionDoc>;
  pins: CompositionDependencyPin[];
  componentPins: ComponentDependencyPin[];
  manifest: CompositionDependencyManifest;
};

const dependencyIssue = (message: string): never => {
  throw new ApiError(422, "validation_failed", "Composition dependency graph is invalid", {
    issues: [{ path: ["spec", "elements"], message }],
  });
};

function assertNoActiveReplacement(db: Database, kind: "component" | "composition", id: string, designSystem: string): void {
  const row = db.query(`SELECT to_kind toKind,to_id toId,to_design_system toDesignSystem
    FROM catalog_replacements
    WHERE from_kind=? AND from_id=? AND from_design_system=?`).get(kind, id, designSystem) as { toKind: string; toId: string; toDesignSystem: string } | null;
  if (row) dependencyIssue(`${kind} ${id} has an active replacement ${row.toKind}:${row.toId} in ${row.toDesignSystem}`);
}

function compositionElementRefs(doc: CompositionDoc): string[] {
  const refs: string[] = [];
  for (const [key, element] of Object.entries(doc.spec.elements)) {
    if (element.type !== COMPOSITION_TYPE) continue;
    const id = element.props.composition;
    if (typeof id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      dependencyIssue(`nested composition reference at ${key} must be a static composition slug`);
    }
    refs.push(typeof id === "string" ? id : "");
  }
  return [...new Set(refs)].sort();
}

function compositionComponentNames(doc: CompositionDoc): string[] {
  return [...new Set(Object.values(doc.spec.elements)
    .map((element) => element.type)
    .filter((type) => !hostPrimitiveNames.has(type)))].sort();
}

function publishedComposition(db: Database, id: string, version: number): CompositionNode | null {
  const row = db.query(`SELECT c.id,c.name,c.design_system designSystem,p.version,p.status,p.source_hash sourceHash,
      p.message,p.dependency_manifest_json dependencyManifestJson,p.dependency_manifest_hash dependencyManifestHash,r.doc,r.rev
    FROM compositions c
    JOIN composition_publishes p ON p.composition_id=c.id AND p.version=?
    JOIN composition_revisions r ON r.composition_id=p.composition_id AND r.rev=p.rev
    WHERE c.id=?`).get(version, id) as {
    id: string; name: string; designSystem: string; version: number; status: string; sourceHash: string; message: string | null;
    dependencyManifestJson: string | null; dependencyManifestHash: string | null; doc: string; rev: number;
  } | null;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    designSystem: row.designSystem,
    version: row.version,
    status: row.status,
    sourceHash: row.sourceHash,
    doc: parseStoredCompositionDoc(row.doc, row.id, row.rev),
    storedManifest: readStoredManifest(row.dependencyManifestJson, row.dependencyManifestHash, row.message),
  };
}

function latestPublishedComposition(db: Database, id: string): CompositionNode | null {
  const row = db.query(`SELECT c.id,c.name,c.design_system designSystem,p.version,p.status,p.source_hash sourceHash,
      p.message,p.dependency_manifest_json dependencyManifestJson,p.dependency_manifest_hash dependencyManifestHash,r.doc,r.rev
    FROM compositions c
    JOIN composition_publishes p ON p.composition_id=c.id AND p.status='active'
    JOIN composition_revisions r ON r.composition_id=p.composition_id AND r.rev=p.rev
    WHERE c.id=? AND c.deleted_at IS NULL ORDER BY p.version DESC LIMIT 1`).get(id) as {
    id: string; name: string; designSystem: string; version: number; status: string; sourceHash: string; message: string | null;
    dependencyManifestJson: string | null; dependencyManifestHash: string | null; doc: string; rev: number;
  } | null;
  if (!row) return null;
  assertNoActiveReplacement(db, "composition", id, row.designSystem);
  return {
    id: row.id,
    name: row.name,
    designSystem: row.designSystem,
    version: row.version,
    status: row.status,
    sourceHash: row.sourceHash,
    doc: parseStoredCompositionDoc(row.doc, row.id, row.rev),
    storedManifest: readStoredManifest(row.dependencyManifestJson, row.dependencyManifestHash, row.message),
  };
}

function componentPinByName(db: Database, name: string, designSystem: string): ComponentDependencyPin | null {
  const row = db.query(`SELECT c.id,c.name,cp.version,cp.bundle_hash bundleHash,cr.design_system designSystem
    FROM components c
    JOIN component_publishes cp ON cp.component_id=c.id AND cp.status='active'
    JOIN component_revisions cr ON cr.component_id=cp.component_id AND cr.rev=cp.rev
    WHERE c.name=? AND c.deleted_at IS NULL AND cr.design_system=?
    ORDER BY cp.version DESC LIMIT 1`).get(name, designSystem) as { id: string; name: string; version: number; bundleHash: string; designSystem: string } | null;
  if (row) assertNoActiveReplacement(db, "component", row.id, designSystem);
  return row ? { id: row.id, name: row.name, version: row.version, bundleHash: row.bundleHash } : null;
}

function componentPinByVersion(db: Database, pin: ComponentDependencyPin, designSystem: string): ComponentDependencyPin | null {
  const row = db.query(`SELECT c.id,c.name,cp.version,cp.bundle_hash bundleHash,cr.design_system designSystem
    FROM components c
    JOIN component_publishes cp ON cp.component_id=c.id AND cp.version=?
    JOIN component_revisions cr ON cr.component_id=cp.component_id AND cr.rev=cp.rev
    WHERE c.id=? AND cr.design_system=?`).get(pin.version, pin.id, designSystem) as { id: string; name: string; version: number; bundleHash: string; designSystem: string } | null;
  if (!row) return null;
  if (row.name !== pin.name || row.bundleHash !== pin.bundleHash) dependencyIssue(`Stored component dependency pin is stale: ${pin.id}@${pin.version}`);
  return { id: row.id, name: row.name, version: row.version, bundleHash: row.bundleHash };
}

/**
 * Resolves a composition publication into its immutable dependency closure. The root may be
 * a not-yet-published head revision; nested references always resolve to active publications
 * unless the containing publication already carries an exact manifest.
 */
export function buildCompositionDependencyManifest(db: Database, root: CompositionRoot, designSystem: string, strictComponents = isCompositionV2(root.doc)): CompositionClosure {
  const nodesByKey = new Map<string, CompositionNode>();
  const nodesById = new Map<string, CompositionNode>();
  const componentsById = new Map<string, ComponentDependencyPin>();

  const addComponent = (pin: ComponentDependencyPin): void => {
    const previous = componentsById.get(pin.id);
    if (previous && previous.version !== pin.version) dependencyIssue(`Composition dependency resolves component ${pin.id} to multiple versions (${previous.version} and ${pin.version})`);
    componentsById.set(pin.id, pin);
  };

  const visit = (node: CompositionNode, path: CompositionNode[], depth: number): void => {
    const key = `${node.id}@${node.version}`;
    const cycleAt = path.findIndex((entry) => entry.id === node.id && entry.version === node.version);
    if (cycleAt !== -1) {
      const cycle = [...path.slice(cycleAt), node].map((entry) => `${entry.id}@${entry.version}`).join(" → ");
      dependencyIssue(`composition dependency cycle: ${cycle}`);
    }
    if (depth > COMPOSITION_NESTING_DEPTH_LIMIT) {
      const chain = [...path, node].map((entry) => `${entry.id}@${entry.version}`).join(" → ");
      dependencyIssue(`composition nesting exceeds maximum depth of ${COMPOSITION_NESTING_DEPTH_LIMIT}: ${chain}`);
    }
    const previousId = nodesById.get(node.id);
    if (previousId && previousId.version !== node.version) dependencyIssue(`Composition dependency resolves ${node.id} to multiple versions (${previousId.version} and ${node.version})`);
    if (nodesByKey.has(key)) return;
    nodesByKey.set(key, node);
    nodesById.set(node.id, node);

    const pinnedCompositions = new Map<string, CompositionDependencyPin>();
    if (node.storedManifest) {
      if (node.storedManifest.root.id !== node.id || node.storedManifest.root.version !== node.version) dependencyIssue(`Stored composition dependency manifest has the wrong root for ${node.id}@${node.version}`);
      for (const pin of node.storedManifest.compositions) {
        if (node.status === "active") assertNoActiveReplacement(db, "composition", pin.id, designSystem);
        const previous = pinnedCompositions.get(pin.id);
        if (previous && previous.version !== pin.version) dependencyIssue(`Stored composition dependency manifest resolves ${pin.id} to multiple versions`);
        pinnedCompositions.set(pin.id, pin);
      }
      if (!pinnedCompositions.has(node.id)) dependencyIssue(`Stored composition dependency manifest is missing its root: ${node.id}@${node.version}`);
      for (const pin of node.storedManifest.components) {
        if (node.status === "active") assertNoActiveReplacement(db, "component", pin.id, designSystem);
        const exact = componentPinByVersion(db, pin, designSystem);
        if (!exact) dependencyIssue(`Stored component dependency pin is unavailable: ${pin.id}@${pin.version}`);
        addComponent(exact!);
      }
    }

    const childIds = compositionElementRefs(node.doc);
    for (const childId of childIds) {
      const pinned = node.storedManifest ? pinnedCompositions.get(childId) : undefined;
      if (node.storedManifest && !pinned) dependencyIssue(`Stored composition dependency manifest is missing ${childId} referenced by ${node.id}@${node.version}`);
      const child = pinned
        ? publishedComposition(db, childId, pinned.version)
        : latestPublishedComposition(db, childId);
      if (!child) dependencyIssue(`unknown or unpublished composition: ${childId}`);
      const resolvedChild = child!;
      if (resolvedChild.designSystem !== designSystem) dependencyIssue(`composition belongs to a different design system: ${resolvedChild.id} (${resolvedChild.designSystem}); expected ${designSystem}`);
      if (pinned && (resolvedChild.name !== pinned.name || resolvedChild.sourceHash !== pinned.sourceHash)) dependencyIssue(`Stored composition dependency pin is stale: ${resolvedChild.id}@${resolvedChild.version}`);
      visit(resolvedChild, [...path, node], depth + 1);
    }

    if (!node.storedManifest) {
      for (const name of compositionComponentNames(node.doc)) {
        const pin = componentPinByName(db, name, designSystem);
        if (!pin) {
          if (strictComponents) dependencyIssue(`Unknown or unpublished component type in design system '${designSystem}': ${name}`);
          continue;
        }
        addComponent(pin);
      }
    }
  };

  if (root.designSystem !== designSystem) dependencyIssue(`composition belongs to a different design system: ${root.id} (${root.designSystem}); expected ${designSystem}`);
  visit({ ...root, storedManifest: root.storedManifest ?? null }, [], 1);

  const compositions = [...nodesById.values()].map((node) => ({ id: node.id, name: node.name, version: node.version, sourceHash: node.sourceHash }));
  const components = [...componentsById.values()];
  const payload = manifestPayload({ version: 1, root: { id: root.id, version: root.version }, compositions, components });
  const manifest: CompositionDependencyManifest = { ...payload, hash: compositionDependencyManifestHash(payload) };
  const docs: Record<string, CompositionDoc> = {};
  for (const node of nodesById.values()) docs[node.id] = node.doc;
  return {
    docs,
    pins: manifest.compositions,
    componentPins: manifest.components,
    manifest,
  };
}

/** Пустышка probe-раскрытия обязательного параметра без `default` (включая типы v3). */
const placeholderForParam = (declared: CompositionDoc["params"][string]): unknown => paramPlaceholder(declared);

/**
 * Validate the publication's complete expanded tree. The probe supplies values only for
 * parameters of the root publication: a composition may intentionally expose required
 * parameters without defaults, but every nested composition invocation must still satisfy
 * its own contract. This keeps publish-time validation synchronous while exercising the exact
 * client/server expansion implementation and its depth/element/tree budgets.
 */
export function validatePublishedCompositionExpansion(
  root: CompositionRoot,
  closure: CompositionClosure,
  designSystem: string,
): void {
  const compositions: Record<string, CompositionCatalogEntry> = Object.fromEntries(
    closure.pins.map((pin) => [pin.id, {
      doc: closure.docs[pin.id]!,
      version: pin.version,
      designSystem,
      status: "active",
    } satisfies CompositionSource]),
  );
  const rootParams = Object.fromEntries(Object.entries(root.doc.params).flatMap(([name, parameter]) => {
    if (parameter.default !== undefined) return [[name, parameter.default]];
    if (parameter.required) return [[name, placeholderForParam(parameter)]];
    return [];
  }));
  const probe = {
    version: 1 as const,
    id: "composition-validation",
    name: "Composition validation",
    designSystem,
    device: "desktop" as const,
    startScreen: "composition",
    state: {},
    screens: [{
      id: "composition",
      name: "Composition",
      spec: {
        root: "composition",
        elements: {
          composition: {
            type: COMPOSITION_TYPE,
            props: { composition: root.id, ...(Object.keys(rootParams).length ? { params: rootParams } : {}) },
          },
        },
      },
    }],
  } as PrototypeDoc;
  const expanded = expandCompositions(probe, { compositions, designSystem });
  if (expanded.issues.length) {
    throw new ApiError(422, "validation_failed", "Published composition expands to an invalid tree", {
      issues: expanded.issues.map((issue) => ({ path: issue.path.split("/").filter(Boolean), message: issue.message })),
    });
  }
  const knownComponents = new Set(closure.componentPins.map((pin) => pin.name));
  const unknown = new Set<string>();
  for (const screen of expanded.doc.screens) {
    for (const element of Object.values(screen.spec.elements)) {
      if (hostPrimitiveNames.has(element.type) || knownComponents.has(element.type)) continue;
      unknown.add(element.type);
    }
  }
  if (unknown.size) {
    throw new ApiError(422, "validation_failed", "Published composition expands to an unknown component tree", {
      issues: [...unknown].sort().map((type) => ({ path: ["spec", "elements"], message: `Unknown or unpublished component type in design system '${designSystem}': ${type}` })),
    });
  }
}

export class CompositionRepo {
  constructor(private db: Database) {}

  row(id: string, includeDeleted = false): CompositionRow {
    const row = this.db.query(`SELECT * FROM compositions WHERE id=? ${includeDeleted ? "" : "AND deleted_at IS NULL"}`).get(id) as CompositionRow | null;
    if (!row) throw new ApiError(404, "not_found", "Composition not found");
    return row;
  }
  cas(id: string, baseRev: number): CompositionRow {
    const row = this.row(id);
    if (row.head_rev !== baseRev) throw new ApiError(409, "revision_conflict", "Composition revision has changed", { currentRev: row.head_rev });
    return row;
  }
  create(id: string, doc: CompositionDoc, designSystem: string, message?: string, ownerId: string | null = null) {
    return this.db.transaction(() => {
      if (this.db.query("SELECT 1 ok FROM compositions WHERE id=? OR name=?").get(id, doc.name)) throw new ApiError(409, "already_exists", "Composition id or name already exists");
      assertCanonicalRoles(this.db, doc, designSystem);
      const at = now();
      this.db.query("INSERT INTO compositions (id,name,head_rev,design_system,owner_id,deleted_at,created_at,updated_at) VALUES (?,?,1,?,?,NULL,?,?)")
        .run(id, doc.name, designSystem, ownerId, at, at);
      this.db.query("INSERT INTO composition_revisions (composition_id,rev,doc,design_system,message,author,created_at) VALUES (?,1,?,?,?,?,?)")
        .run(id, JSON.stringify(doc), designSystem, message ?? null, ownerId, at);
      return { id, rev: 1 as const };
    })();
  }
  save(id: string, doc: CompositionDoc, baseRev: number, message?: string, actorId: string | null = null) {
    return this.db.transaction(() => {
      const row = this.cas(id, baseRev);
      const clash = this.db.query("SELECT 1 ok FROM compositions WHERE name=? AND id<>?").get(doc.name, id);
      if (clash) throw new ApiError(409, "already_exists", "Composition name already exists");
      assertCanonicalRoles(this.db, doc, row.design_system, id);
      const rev = row.head_rev + 1, at = now();
      this.db.query("INSERT INTO composition_revisions (composition_id,rev,doc,design_system,message,author,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(id, rev, JSON.stringify(doc), row.design_system, message ?? null, actorId, at);
      this.db.query("UPDATE compositions SET name=?,head_rev=?,updated_at=? WHERE id=? AND deleted_at IS NULL").run(doc.name, rev, at, id);
      return { rev };
    })();
  }
  /**
   * Мягкое удаление. Композиция, закреплённая пинами, остаётся читаемой по версии:
   * FK RESTRICT на `composition_publishes` защищает неизменяемые публикации прототипов.
   */
  delete(id: string, baseRev: number, reason?: string) {
    this.db.transaction(() => {
      this.cas(id, baseRev);
      const at = now();
      this.db.query("UPDATE compositions SET deleted_at=?,delete_reason=?,updated_at=? WHERE id=? AND deleted_at IS NULL").run(at, reason?.trim() || null, at, id);
    })();
  }
  list(includeDeleted = false) {
    const rows = this.db.query(`SELECT c.*, (SELECT MAX(version) FROM composition_publishes p WHERE p.composition_id=c.id AND p.status='active') latest
      FROM compositions c ${includeDeleted ? "" : "WHERE c.deleted_at IS NULL"} ORDER BY c.updated_at DESC`).all() as (CompositionRow & { latest: number | null })[];
    return rows.map((row) => {
      const doc = this.docAt(row.id, row.head_rev);
      return {
        id: row.id, name: row.name, designSystem: row.design_system, headRev: row.head_rev,
        latestVersion: row.latest, updatedAt: row.updated_at,
        description: doc.description, params: Object.keys(doc.params), slots: doc.slots,
        ...(row.deleted_at === null ? {} : { deleted: true as const, deletedAt: row.deleted_at, reason: row.delete_reason }),
      };
    });
  }
  private docAt(id: string, rev: number): CompositionDoc {
    const row = this.db.query("SELECT doc FROM composition_revisions WHERE composition_id=? AND rev=?").get(id, rev) as { doc: string } | null;
    if (!row) throw new ApiError(404, "revision_not_found", "Composition revision not found");
    return parseStoredCompositionDoc(row.doc, id, rev);
  }
  meta(id: string, includeDeleted = false) {
    const row = this.row(id, includeDeleted);
    const versions = this.versions(id, includeDeleted);
    const active = versions.filter((version) => version.status === "active");
    return {
      id: row.id, name: row.name, designSystem: row.design_system, headRev: row.head_rev,
      versions, updatedAt: row.updated_at, publishedVersion: active.at(-1)?.version ?? null,
      doc: this.docAt(id, row.head_rev),
      ...(row.deleted_at === null ? {} : { deleted: true as const, deletedAt: row.deleted_at, reason: row.delete_reason }),
    };
  }
  revisions(id: string) {
    this.row(id);
    return (this.db.query("SELECT rev,message,created_at FROM composition_revisions WHERE composition_id=? ORDER BY rev DESC").all(id) as { rev: number; message: string | null; created_at: string }[])
      .map((row) => ({ rev: row.rev, message: row.message, createdAt: row.created_at }));
  }
  revision(id: string, rev?: number) {
    const row = this.row(id);
    const at = rev ?? row.head_rev;
    const stored = this.db.query("SELECT rev,doc,design_system,message,created_at FROM composition_revisions WHERE composition_id=? AND rev=?").get(id, at) as { rev: number; doc: string; design_system: string; message: string | null; created_at: string } | null;
    if (!stored) throw new ApiError(404, "revision_not_found", "Composition revision not found");
    return { rev: stored.rev, doc: parseStoredCompositionDoc(stored.doc, id, stored.rev), designSystem: stored.design_system, message: stored.message, createdAt: stored.created_at };
  }
  publish(id: string, baseRev: number, message?: string) {
    return this.db.transaction(() => {
      const row = this.cas(id, baseRev);
      if (this.db.query("SELECT 1 ok FROM composition_publishes WHERE composition_id=? AND rev=?").get(id, row.head_rev)) {
        throw new ApiError(409, "already_published", "This revision is already published", { currentRev: row.head_rev });
      }
      const doc = this.docAt(id, row.head_rev);
      assertCanonicalRoles(this.db, doc, row.design_system, id);
      const max = this.db.query("SELECT MAX(version) v FROM composition_publishes WHERE composition_id=?").get(id) as { v: number | null };
      const version = (max.v ?? 0) + 1;
      const closure = buildCompositionDependencyManifest(this.db, {
        id: row.id,
        name: row.name,
        designSystem: row.design_system,
        version,
        sourceHash: compositionSourceHash(doc),
        doc,
      }, row.design_system);
      if (isCompositionV2(doc)) validatePublishedCompositionExpansion({
        id: row.id,
        name: row.name,
        designSystem: row.design_system,
        version,
        sourceHash: compositionSourceHash(doc),
        doc,
      }, closure, row.design_system);
      this.db.query(`INSERT INTO composition_publishes
        (composition_id,version,rev,status,source_hash,dependency_manifest_json,dependency_manifest_hash,message,published_at)
        VALUES (?,?,?,'active',?,?,?,?,?)`)
        .run(id, version, row.head_rev, compositionSourceHash(doc), JSON.stringify(closure.manifest), closure.manifest.hash, message ?? null, now());
      return { version, rev: row.head_rev };
    })();
  }
  versions(id: string, includeDeleted = false) {
    this.row(id, includeDeleted);
    return (this.db.query("SELECT version,rev,status,status_reason,superseded_by,status_rev,source_hash,published_at FROM composition_publishes WHERE composition_id=? ORDER BY version").all(id) as {
      version: number; rev: number; status: string; status_reason: string | null; superseded_by: number | null; status_rev: number; source_hash: string; published_at: string;
    }[]).map((row) => ({ version: row.version, rev: row.rev, status: row.status, statusReason: row.status_reason, supersededBy: row.superseded_by, statusRev: row.status_rev, sourceHash: row.source_hash, publishedAt: row.published_at }));
  }
  version(id: string, version: number) {
    const row = this.db.query(`SELECT p.version,p.rev,p.status,p.status_reason,p.superseded_by,p.status_rev,p.source_hash,p.published_at,r.doc,r.design_system
      FROM composition_publishes p JOIN composition_revisions r ON r.composition_id=p.composition_id AND r.rev=p.rev
      WHERE p.composition_id=? AND p.version=?`).get(id, version) as {
      version: number; rev: number; status: string; status_reason: string | null; superseded_by: number | null; status_rev: number; source_hash: string; published_at: string; doc: string; design_system: string;
    } | null;
    if (!row) throw new ApiError(404, "version_not_found", "Composition version not found");
    return {
      version: row.version, rev: row.rev, status: row.status, statusReason: row.status_reason, supersededBy: row.superseded_by,
      statusRev: row.status_rev, sourceHash: row.source_hash, designSystem: row.design_system,
      doc: parseStoredCompositionDoc(row.doc, id, row.rev), publishedAt: row.published_at,
    };
  }
  /**
   * Ручной переход статуса версии. Валидация зеркалит компонентную (`ComponentRepo.setStatus`):
   * `superseded` требует `supersededBy` на существующую версию, не на себя и без цикла по цепочке.
   */
  setStatus(id: string, version: number, change: { status: string; reason?: string; supersededBy?: number; baseStatusRev: number }) {
    return this.db.transaction(() => {
      this.row(id);
      const current = this.db.query("SELECT status,status_rev FROM composition_publishes WHERE composition_id=? AND version=?").get(id, version) as { status: string; status_rev: number } | null;
      if (!current) throw new ApiError(404, "version_not_found", "Composition version not found");
      if (current.status_rev !== change.baseStatusRev) throw new ApiError(409, "status_conflict", "Composition version status has changed", { currentStatusRev: current.status_rev });
      if (!(TRANSITIONS[current.status] ?? []).includes(change.status)) throw new ApiError(422, "invalid_transition", `Cannot transition ${current.status} → ${change.status}`, { issues: [{ path: ["status"], message: `invalid transition from ${current.status}` }] });
      let supersededBy: number | null = null;
      if (change.status === "superseded") {
        const target = change.supersededBy;
        if (typeof target !== "number" || !Number.isInteger(target) || target < 1) throw new ApiError(422, "validation_failed", "supersededBy is required to supersede a version", { issues: [{ path: ["supersededBy"], message: "supersededBy must reference a version" }] });
        if (target === version) throw new ApiError(422, "validation_failed", "A version cannot supersede itself", { issues: [{ path: ["supersededBy"], message: "cannot supersede self" }] });
        if (!this.db.query("SELECT 1 ok FROM composition_publishes WHERE composition_id=? AND version=?").get(id, target)) throw new ApiError(422, "validation_failed", "supersededBy references a version that does not exist", { issues: [{ path: ["supersededBy"], message: `unknown version ${target}` }] });
        // Идём по цепочке superseded_by от цели: возврат к `version` означал бы цикл.
        let cursor: number | null = target; const seen = new Set<number>([version]);
        while (cursor !== null) {
          if (seen.has(cursor)) throw new ApiError(422, "validation_failed", "supersededBy would create a cycle", { issues: [{ path: ["supersededBy"], message: "cycle detected" }] });
          seen.add(cursor);
          cursor = (this.db.query("SELECT superseded_by n FROM composition_publishes WHERE composition_id=? AND version=?").get(id, cursor) as { n: number | null } | null)?.n ?? null;
        }
        supersededBy = target;
      }
      const nextRev = current.status_rev + 1;
      this.db.query("UPDATE composition_publishes SET status=?,status_reason=?,superseded_by=?,status_rev=? WHERE composition_id=? AND version=?")
        .run(change.status, change.reason?.trim() || null, supersededBy, nextRev, id, version);
      return { status: change.status, statusRev: nextRev };
    })();
  }
  /** Где композиция используется: головные ревизии прототипов (по пинам). */
  usages(id: string) {
    this.row(id, true);
    const rows = this.db.query(`SELECT p.id prototypeId,p.name,p.kind,prc.rev,prc.composition_version version
      FROM prototype_revision_compositions prc JOIN prototypes p ON p.id=prc.prototype_id AND p.head_rev=prc.rev
      WHERE prc.composition_id=? ORDER BY p.id`).all(id) as { prototypeId: string; name: string; kind: string; rev: number; version: number }[];
    const immutable = this.db.query(`SELECT pp.prototype_id prototypeId,pp.version,prc.composition_version compositionVersion
      FROM prototype_revision_compositions prc JOIN prototype_publishes pp ON pp.prototype_id=prc.prototype_id AND pp.rev=prc.rev
      WHERE prc.composition_id=? ORDER BY pp.prototype_id,pp.version`).all(id) as { prototypeId: string; version: number; compositionVersion: number }[];
    return { currentHeadUsages: rows, immutableUsages: immutable, safeToRemove: rows.length === 0 && immutable.length === 0 };
  }
}

/**
 * Разрешает композиции по их id к **последней active-публикации** — ровно как
 * `snapshotDefinitions` разрешает компоненты. Возвращает документы и пины ревизии.
 * Единственный резолвер: и save-путь, и чтение draft'а ходят сюда.
 */
export function resolveCompositionPins(db: Database, ids: readonly string[], designSystem: string): {
  docs: Record<string, CompositionDoc>;
  sources: Record<string, CompositionSource>;
  pins: CompositionDependencyPin[];
  componentPins: ComponentDependencyPin[];
  missing: { id: string; reason: string }[];
} {
  const docs: Record<string, CompositionDoc> = {};
  const sources: Record<string, CompositionSource> = {};
  const pins = new Map<string, CompositionDependencyPin>();
  const componentPins = new Map<string, ComponentDependencyPin>();
  const missing: { id: string; reason: string }[] = [];
  for (const id of [...new Set(ids)].sort()) {
    const root = latestPublishedComposition(db, id);
    if (!root) { missing.push({ id, reason: `unknown or unpublished composition: ${id}` }); continue; }
    if (root.designSystem !== designSystem) { missing.push({ id, reason: `composition belongs to a different design system: ${id} (${root.designSystem})` }); continue; }
    try {
      const closure = buildCompositionDependencyManifest(db, root, designSystem);
      for (const pin of closure.pins) {
        const previous = pins.get(pin.id);
        if (previous && previous.version !== pin.version) {
          missing.push({ id, reason: `composition dependency resolves ${pin.id} to multiple versions (${previous.version} and ${pin.version})` });
          continue;
        }
        pins.set(pin.id, pin);
        docs[pin.id] = closure.docs[pin.id]!;
        const exact = publishedComposition(db, pin.id, pin.version);
        if (!exact) {
          missing.push({ id: pin.id, reason: `composition publication is unavailable: ${pin.id}@${pin.version}` });
          continue;
        }
        sources[pin.id] = {
          doc: docs[pin.id]!,
          version: pin.version,
          designSystem: exact.designSystem,
          status: exact.status,
        };
      }
      for (const pin of closure.componentPins) {
        const previous = componentPins.get(pin.id);
        if (previous && previous.version !== pin.version) {
          missing.push({ id, reason: `composition dependency resolves component ${pin.id} to multiple versions (${previous.version} and ${pin.version})` });
          continue;
        }
        componentPins.set(pin.id, pin);
      }
    } catch (error) {
      const issue = error instanceof ApiError && Array.isArray(error.details.issues) ? error.details.issues[0] as { message?: unknown } | undefined : undefined;
      missing.push({ id, reason: typeof issue?.message === "string" ? issue.message : error instanceof ApiError ? error.message : String(error) });
    }
  }
  return {
    docs,
    sources,
    pins: [...pins.values()].sort((a, b) => a.id.localeCompare(b.id)),
    componentPins: [...componentPins.values()].sort((a, b) => a.id.localeCompare(b.id)),
    missing,
  };
}

/** Документы композиций конкретной ревизии прототипа (по её пинам). */
export function pinnedCompositionDocs(db: Database, prototypeId: string, rev: number): {
  docs: Record<string, CompositionDoc>;
  pins: (CompositionDependencyPin & { designSystem: string; status: string })[];
} {
  const rows = db.query(`SELECT c.id,c.name,c.design_system designSystem,prc.composition_version version,p.status,p.source_hash sourceHash,r.doc,p.rev
    FROM prototype_revision_compositions prc
    JOIN compositions c ON c.id=prc.composition_id
    JOIN composition_publishes p ON p.composition_id=prc.composition_id AND p.version=prc.composition_version
    JOIN composition_revisions r ON r.composition_id=p.composition_id AND r.rev=p.rev
    WHERE prc.prototype_id=? AND prc.rev=? ORDER BY c.id`).all(prototypeId, rev) as {
    id: string; name: string; designSystem: string; version: number; status: string; sourceHash: string; doc: string; rev: number;
  }[];
  const docs: Record<string, CompositionDoc> = {};
  for (const row of rows) docs[row.id] = parseStoredCompositionDoc(row.doc, row.id, row.rev);
  return { docs, pins: rows.map((row) => ({ id: row.id, name: row.name, designSystem: row.designSystem, status: row.status, version: row.version, sourceHash: row.sourceHash })) };
}
