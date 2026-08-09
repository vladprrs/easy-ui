import type { Database } from "bun:sqlite";
import { canonicalStringify } from "../../src/capture/canonicalJson";
import { COMPOSITION_KEY_SEPARATOR } from "../../src/catalog/hostPrimitives/composition.definition";
import { hostPrimitiveNames } from "../../src/catalog/hostPrimitives/definitions";
import type { PrototypeDoc } from "../../src/prototype/schema";
import { docSurfaces, surfaceDesignSystem, surfaceOf } from "../../src/prototype/surfaces";
import { latestDesignSystemMetaVersion, requireActiveDesignSystem } from "../designSystems";
import { ApiError } from "../http";
import { currentCatalogRevision } from "../migrationRunner";
import type { ComponentDependencyPin } from "../repos/compositions";

/**
 * BR-01b (план `docs/plans/2026-08-08-blocker-removal-eui-br.md` §1) — **единый**
 * `ResolvedComponentGraph`.
 *
 * До волны схема опубликованного компонента добывалась четырьмя независимыми путями (save-SQL,
 * `pins()`/`headPin()` read-путей, `definition_meta` каталога, preview-tree). Каждый из них имел
 * собственный фильтр дизайн-системы, собственную трактовку composition-пина и собственное
 * представление о «голове» — отсюда 422 фидбэка §4 и расхождение версий между save, status и snap.
 *
 * Этот модуль — единственное место, где принимается решение «какая публикация компонента
 * относится к этому элементу документа». Потребители (`snapshotDefinitions`, readiness,
 * `PrototypeRepo.pins/bundleReadiness/screenRenderStatus`, screenshot-сервис) резолв **не
 * повторяют**, а читают. Материализация исходника и импорт модуля остаются у
 * `snapshotDefinitions`: граф — чистое SQL-решение без ФС и без async.
 *
 * Kill-switch — тот же `EASYUI_SCHEMA_RESOLVER_V2_DISABLED` (BR-01a): при `=1` граф повторяет
 * доволновую семантику byte-for-byte (пин композиции по имени на весь документ, голова без
 * фильтра ДС, без диагностического контекста схемы).
 */

export type ComponentOrigin = "head-active" | "pinned" | "composition-pin";

/** Вход ключа кэша схемы — ровно контракт фидбэка §4 (порядок полей канонизирован хэшером). */
export type SchemaCacheKeyInput = {
  designSystemId: string;
  designSystemMetaVersion: number | null;
  catalogRevision: string | null;
  componentId: string;
  componentVersion: number;
  sourceHash: string | null;
  propsSchemaHash: string | null;
};

/** `sha256` канонизированного контракта §4 — стабильный ключ кэша/сверки между путями. */
export function schemaCacheKeyOf(input: SchemaCacheKeyInput): string {
  return new Bun.CryptoHasher("sha256").update(canonicalStringify({
    designSystemId: input.designSystemId,
    designSystemMetaVersion: input.designSystemMetaVersion,
    catalogRevision: input.catalogRevision,
    componentId: input.componentId,
    componentVersion: input.componentVersion,
    sourceHash: input.sourceHash,
    propsSchemaHash: input.propsSchemaHash,
  })).digest("hex");
}

/** `propsSchemaHash` — sha256 канонизированного `definition_meta.propsJsonSchema`; `null` при отсутствии. */
export function propsSchemaHashOf(definitionMeta: string | null): string | null {
  if (!definitionMeta) return null;
  try {
    const meta = JSON.parse(definitionMeta) as { propsJsonSchema?: unknown };
    if (meta.propsJsonSchema === undefined || meta.propsJsonSchema === null) return null;
    return new Bun.CryptoHasher("sha256").update(canonicalStringify(meta.propsJsonSchema)).digest("hex");
  } catch { return null; }
}

/** Ключи, которые схема props компонента действительно принимает (`acceptedKeys` фидбэка §4). */
export function acceptedPropKeys(definitionMeta: string | null, propsSchema?: unknown): string[] {
  const fromJsonSchema = (() => {
    if (!definitionMeta) return null;
    try {
      const meta = JSON.parse(definitionMeta) as { propsJsonSchema?: unknown };
      const schema = meta.propsJsonSchema;
      if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
      const properties = (schema as { properties?: unknown }).properties;
      if (!properties || typeof properties !== "object" || Array.isArray(properties)) return null;
      return Object.keys(properties as Record<string, unknown>).sort();
    } catch { return null; }
  })();
  if (fromJsonSchema) return fromJsonSchema;
  // Фолбэк — живая zod-схема, по которой валидация и отвергла prop (у неё shape есть всегда,
  // когда определение объявлено объектом; иначе честный пустой список).
  const shape = (propsSchema as { shape?: unknown } | undefined)?.shape;
  if (shape && typeof shape === "object" && !Array.isArray(shape)) return Object.keys(shape as Record<string, unknown>).sort();
  return [];
}

/**
 * `422 component_pin_conflict` (BR-01a): один тип нужен документу в двух версиях — раскрытие
 * композиции пинует @M, авторский элемент вне композиции требует активную @N. Карта определений
 * name-keyed (`components.name` глобально UNIQUE), двух схем одного имени в ней не выразить,
 * поэтому единственный честный исход — типизированный отказ с обеими версиями и путями.
 */
export const COMPONENT_PIN_CONFLICT_CODE = "component_pin_conflict";

/**
 * Kill-switch BR-01a/BR-01b: `EASYUI_SCHEMA_RESOLVER_V2_DISABLED=1` возвращает резолвер в
 * доволновое состояние byte-for-byte. Env читается по месту вызова (прецедент
 * `sourcePackageEnabled`), поэтому переключение не требует рестарта процесса.
 */
export const schemaResolverV2Enabled = (raw: string | undefined = process.env.EASYUI_SCHEMA_RESOLVER_V2_DISABLED): boolean =>
  raw !== "1";

/** Версия контракта резолвера схемы, публикуемая в `/api/capabilities` (фидбэк §4). */
export const PROTOTYPE_SCHEMA_RESOLVER_VERSION = 2;
export const LEGACY_PROTOTYPE_SCHEMA_RESOLVER_VERSION = 1;

/** Строка публикации — единственная форма, из которой резолвер строит узел графа. */
export type PublishRow = {
  id: string; name: string; version: number; rev: number;
  bundleHash: string; source: string; sourceHash: string | null; definitionMeta: string | null;
};

/**
 * Узел графа: «этот тип на этой поверхности документа резолвится в эту публикацию».
 *
 * `catalogRevision` и `cacheKey` — **ленивые** (getter'ы): ревизия каталога это полный скан
 * каталога, нужный только диагностике отвергнутого prop'а и сверке ключей, и платить за неё
 * на каждом save было бы платой за диагностику, которой в норме нет.
 */
export interface ResolvedComponentNode {
  componentId: string;
  name: string;
  version: number;
  rev: number;
  designSystem: string;
  bundleHash: string;
  source: string;
  sourceHash: string | null;
  propsSchemaHash: string | null;
  definitionMeta: string | null;
  designSystemMetaVersion: number | null;
  origin: ComponentOrigin;
  /** Ревизия каталога на момент резолва (ленивая). */
  readonly catalogRevision: string | null;
  /** Ключ кэша схемы — контракт фидбэка §4 (ленивый). */
  readonly cacheKey: string;
}

/** Элемент документа → узел графа. Ключ — JSON-pointer элемента (как в issue'ах валидации). */
export interface ResolvedElement {
  path: string;
  screenId: string;
  elementKey: string;
  type: string;
  surfaceId: string;
  node: ResolvedComponentNode;
}

export interface ResolvedComponentGraph {
  /** Поверхности документа в их порядке; в каждой — имена типов в отсортированном порядке. */
  surfaces: { surfaceId: string; designSystem: string; nodes: ResolvedComponentNode[] }[];
  /** Все узлы в порядке резолва (порядок пинов ревизии). */
  nodes: ResolvedComponentNode[];
  /** Узел по имени типа (`components.name` глобально UNIQUE). */
  byName: Map<string, ResolvedComponentNode>;
  byNameBySurface: Map<string, Map<string, ResolvedComponentNode>>;
  /** Per-element резолв (фидбэк §4: «per-element `{componentId, version, …}`»). */
  elements: ResolvedElement[];
  /** Корень материализации, объявленный вызывающим (`snapshotDefinitions`); граф ФС не трогает. */
  dataDir: string | null;
}

// --- Пины композиций --------------------------------------------------------

/**
 * Компонентные пины манифеста композиции, привязанные к **раскрытому** документу.
 * WeakMap живёт здесь (а не в `validation.ts`), потому что читает их именно резолвер;
 * `expandPrototypeForSave` только регистрирует.
 */
const compositionComponentPins = new WeakMap<object, Map<string, ComponentDependencyPin>>();

export function rememberCompositionComponentPins(doc: PrototypeDoc, pins: ComponentDependencyPin[]): void {
  if (!pins.length) return;
  compositionComponentPins.set(doc, new Map(pins.map((pin) => [pin.name, pin])));
}

export function compositionComponentPinsOf(doc: PrototypeDoc): Map<string, ComponentDependencyPin> | undefined {
  return compositionComponentPins.get(doc);
}

// --- SQL резолва ------------------------------------------------------------

const PUBLISH_COLUMNS = "c.id,c.name,cp.version,cp.rev,cp.bundle_hash bundleHash,cr.source,cp.source_hash sourceHash,cp.definition_meta definitionMeta";

export function pinnedPublishRow(db: Database, pin: { id: string; version: number }, designSystem: string): PublishRow | null {
  return db.query(`SELECT ${PUBLISH_COLUMNS}
      FROM components c JOIN component_publishes cp ON cp.component_id=c.id AND cp.version=?
      JOIN component_revisions cr ON cr.component_id=cp.component_id AND cr.rev=cp.rev
      WHERE c.id=? AND cr.design_system=?`).get(pin.version, pin.id, designSystem) as PublishRow | null;
}

export function activePublishRow(db: Database, name: string, designSystem: string): PublishRow | null {
  return db.query(`SELECT ${PUBLISH_COLUMNS}
      FROM components c JOIN component_publishes cp ON cp.component_id=c.id AND cp.status='active'
      JOIN component_revisions cr ON cr.component_id=cp.component_id AND cr.rev=cp.rev
      WHERE c.name=? AND cr.design_system=? AND c.deleted_at IS NULL ORDER BY cp.version DESC LIMIT 1`)
    .get(name, designSystem) as PublishRow | null;
}

/**
 * Голова компонента для `track:"head"` (P2.3) — **та версия, которую резолвер запишет в пины**.
 *
 * BR-01a (H4): голова резолвится в той же дизайн-системе, что закреплённая версия — тем же
 * фильтром `cr.design_system`, что и save-путь. Без него перенос компонента в другую ДС +
 * publish разводил два пути: save видел последнюю версию своей ДС, а трекающий документ
 * перескакивал на версию чужой.
 *
 * BR-01b: fallback на предыдущую active при **успешно разрешённой** новой запрещён — если строка
 * головы найдена, возвращается именно она; `null` означает «active-публикации нет вовсе», и
 * только тогда потребитель остаётся на пине ревизии.
 */
export function resolveHeadPublish(db: Database, pin: { id: string; version: number }): { version: number; bundleHash: string; status: string } | null {
  if (!schemaResolverV2Enabled()) {
    return db.query("SELECT version,bundle_hash bundleHash,status FROM component_publishes WHERE component_id=? AND status='active' ORDER BY version DESC LIMIT 1")
      .get(pin.id) as { version: number; bundleHash: string; status: string } | null;
  }
  return db.query(`SELECT cp.version,cp.bundle_hash bundleHash,cp.status
      FROM component_publishes cp JOIN component_revisions cr ON cr.component_id=cp.component_id AND cr.rev=cp.rev
      WHERE cp.component_id=?1 AND cp.status='active'
        AND cr.design_system=(SELECT cr0.design_system FROM component_publishes cp0
          JOIN component_revisions cr0 ON cr0.component_id=cp0.component_id AND cr0.rev=cp0.rev
          WHERE cp0.component_id=?1 AND cp0.version=?2)
      ORDER BY cp.version DESC LIMIT 1`).get(pin.id, pin.version) as { version: number; bundleHash: string; status: string } | null;
}

/**
 * Факты схемы конкретной публикации — деривация BR-01a для полей ответов BR-01b
 * (`resolvedVersion`/`sourceHash`/`propsSchemaHash`). Один SQL, тот же, что у резолва графа.
 */
export type PinSchemaFacts = {
  resolvedVersion: number;
  rev: number;
  designSystem: string;
  sourceHash: string | null;
  propsSchemaHash: string | null;
};

export function pinSchemaFacts(db: Database, componentId: string, version: number): PinSchemaFacts | null {
  const row = db.query(`SELECT cp.version,cp.rev,cp.source_hash sourceHash,cp.definition_meta definitionMeta,cr.design_system designSystem
      FROM component_publishes cp JOIN component_revisions cr ON cr.component_id=cp.component_id AND cr.rev=cp.rev
      WHERE cp.component_id=? AND cp.version=?`)
    .get(componentId, version) as { version: number; rev: number; sourceHash: string | null; definitionMeta: string | null; designSystem: string } | null;
  if (!row) return null;
  return {
    resolvedVersion: row.version,
    rev: row.rev,
    designSystem: row.designSystem,
    sourceHash: row.sourceHash ?? null,
    propsSchemaHash: propsSchemaHashOf(row.definitionMeta),
  };
}

/**
 * Поля ответов BR-01b одним спредом: `{resolvedVersion, sourceHash, propsSchemaHash}` при
 * включённом резолвере v2 и **пустой объект** при поднятом kill-switch'е (доволновой ответ
 * byte-for-byte). Компонент без строки публикации полей не получает — врать нечем.
 */
export function resolvedSchemaFields(db: Database, componentId: string, version: number):
  { resolvedVersion: number; sourceHash: string | null; propsSchemaHash: string | null } | Record<string, never> {
  if (!schemaResolverV2Enabled()) return {};
  const facts = pinSchemaFacts(db, componentId, version);
  if (!facts) return {};
  return { resolvedVersion: facts.resolvedVersion, sourceHash: facts.sourceHash, propsSchemaHash: facts.propsSchemaHash };
}

// --- Граф -------------------------------------------------------------------

export interface ResolveGraphOptions {
  /**
   * Компонентные пины манифеста композиции. По умолчанию берутся из регистрации
   * `expandPrototypeForSave` (WeakMap по раскрытому документу).
   */
  expansion?: { componentPins?: ComponentDependencyPin[] };
  /** Корень материализации исходников — прокидывается потребителю в `graph.dataDir`. */
  dataDir?: string;
}

/** Узел графа с ленивыми `catalogRevision`/`cacheKey`. */
function nodeOf(row: PublishRow, context: {
  designSystem: string;
  designSystemMetaVersion: number | null;
  origin: ComponentOrigin;
  readCatalogRevision: () => string | null;
}): ResolvedComponentNode {
  const node = {
    componentId: row.id,
    name: row.name,
    version: row.version,
    rev: row.rev,
    designSystem: context.designSystem,
    bundleHash: row.bundleHash,
    source: row.source,
    sourceHash: row.sourceHash ?? null,
    propsSchemaHash: propsSchemaHashOf(row.definitionMeta),
    definitionMeta: row.definitionMeta,
    designSystemMetaVersion: context.designSystemMetaVersion,
    origin: context.origin,
  } as ResolvedComponentNode;
  Object.defineProperty(node, "catalogRevision", { enumerable: true, configurable: true, get: context.readCatalogRevision });
  let cacheKey: string | undefined;
  Object.defineProperty(node, "cacheKey", {
    enumerable: true, configurable: true,
    get: () => (cacheKey ??= schemaCacheKeyOf({
      designSystemId: node.designSystem,
      designSystemMetaVersion: node.designSystemMetaVersion,
      catalogRevision: node.catalogRevision,
      componentId: node.componentId,
      componentVersion: node.version,
      sourceHash: node.sourceHash,
      propsSchemaHash: node.propsSchemaHash,
    })),
  });
  return node;
}

/**
 * Резолв всех custom-типов документа (уже **раскрытого**, если в нём были композиции).
 *
 * Порядок обхода и SQL — те же, что были в `snapshotDefinitions` до BR-01b: поверхности в
 * порядке документа, внутри поверхности имена типов отсортированы, первый резолв имени
 * определяет пин ревизии. Это условие byte-for-byte совместимости пинов и `componentManifestHash`.
 */
export function resolveComponentGraph(db: Database, doc: PrototypeDoc, options: ResolveGraphOptions = {}): ResolvedComponentGraph {
  const resolverV2 = schemaResolverV2Enabled();
  const compositionPins = options.expansion?.componentPins
    ? new Map(options.expansion.componentPins.map((pin) => [pin.name, pin]))
    : compositionComponentPinsOf(doc);
  const surfaces = docSurfaces(doc);

  let catalogRevisionCache: string | null | undefined;
  const readCatalogRevision = (): string | null => {
    if (catalogRevisionCache === undefined) { try { catalogRevisionCache = currentCatalogRevision(db); } catch { catalogRevisionCache = null; } }
    return catalogRevisionCache;
  };
  const metaVersions = new Map<string, number | null>();
  const readMetaVersion = (systemId: string): number | null => {
    if (!metaVersions.has(systemId)) metaVersions.set(systemId, latestDesignSystemMetaVersion(db, systemId));
    return metaVersions.get(systemId)!;
  };

  const graph: ResolvedComponentGraph = {
    surfaces: [], nodes: [], byName: new Map(), byNameBySurface: new Map(), elements: [],
    dataDir: options.dataDir ?? null,
  };
  const seenComponentIds = new Set<string>();

  for (const surface of surfaces) {
    const designSystem = surfaceDesignSystem(surface, doc) ?? doc.designSystem;
    const builtin = requireActiveDesignSystem(db, designSystem, ["designSystem"]).definitions;
    const screens = doc.screens.filter((screen) => surfaceOf(doc, screen.id).id === surface.id);
    // H1: элементы, **порождённые раскрытием композиции** (ключ вида `<host>$<inner>`), и
    // авторские — разные множества. Пин композиции легитимен только для первых: по имени он бы
    // навязал схему манифеста всему документу, включая элементы, которых композиция не создавала.
    const usage = new Map<string, { expanded: string[]; authored: string[]; elements: { path: string; screenId: string; elementKey: string }[] }>();
    for (const screen of screens) {
      const screenIndex = doc.screens.indexOf(screen);
      for (const [key, element] of Object.entries(screen.spec.elements)) {
        if (Object.hasOwn(builtin, element.type) || hostPrimitiveNames.has(element.type)) continue;
        const entry = usage.get(element.type) ?? { expanded: [], authored: [], elements: [] };
        const path = `/screens/${screenIndex}/spec/elements/${key}`;
        (key.includes(COMPOSITION_KEY_SEPARATOR) ? entry.expanded : entry.authored).push(path);
        entry.elements.push({ path, screenId: screen.id, elementKey: key });
        usage.set(element.type, entry);
      }
    }
    const surfaceNodes: ResolvedComponentNode[] = [];
    const byName = new Map<string, ResolvedComponentNode>();
    for (const name of [...usage.keys()].sort()) {
      const pinned = compositionPins?.get(name);
      const use = usage.get(name)!;
      // Доволновое поведение: пин по имени применяется ко всему документу.
      const usePin = pinned !== undefined && (!resolverV2 || use.expanded.length > 0);
      let origin: ComponentOrigin = usePin ? "composition-pin" : "head-active";
      let row = usePin ? pinnedPublishRow(db, pinned!, designSystem) : activePublishRow(db, name, designSystem);
      if (resolverV2 && usePin && use.authored.length > 0) {
        const active = activePublishRow(db, name, designSystem);
        // Компонент без active-публикации в этой ДС резолвится пином: «нет головы» не повод
        // отказать документу, который раньше сохранялся (деградацию видит гейт `pins`).
        if (active && row && active.version !== row.version) {
          throw new ApiError(422, COMPONENT_PIN_CONFLICT_CODE,
            `Component '${name}' is required in two versions by the same document: the composition pins v${row.version}, an authored element resolves the active v${active.version}`,
            { componentId: row.id, componentName: name,
              issues: [
                ...use.expanded.map((path) => ({ path, message: `composition-expanded element requires ${name}@${row!.version} (composition pin)` })),
                ...use.authored.map((path) => ({ path, message: `authored element resolves ${name}@${active.version} (active publication)` })),
              ] });
        }
        if (active && !row) { row = active; origin = "head-active"; }
      }
      if (!row) {
        throw new ApiError(422, "validation_failed", "Prototype document is invalid",
          { issues: [{ path: ["screens"], message: `Unknown or unpublished component type in design system '${designSystem}': ${name}` }] });
      }
      const node = nodeOf(row, { designSystem, designSystemMetaVersion: readMetaVersion(designSystem), origin, readCatalogRevision });
      surfaceNodes.push(node);
      byName.set(name, node);
      if (!graph.byName.has(name)) graph.byName.set(name, node);
      if (!seenComponentIds.has(node.componentId)) { seenComponentIds.add(node.componentId); graph.nodes.push(node); }
      for (const element of use.elements) graph.elements.push({ ...element, type: name, surfaceId: surface.id, node });
    }
    graph.surfaces.push({ surfaceId: surface.id, designSystem, nodes: surfaceNodes });
    graph.byNameBySurface.set(surface.id, byName);
  }
  return graph;
}
