/**
 * **Figma Source Package** — пакет исходников Figma как единица переноса
 * (план `docs/plans/2026-08-07-migration-feedback-wave.md` §W8, ретроспектива §10 P1.4,
 * миграция v36).
 *
 * Проблема, которую решает пакет: половина blocker'ов миграции — про доступ к источнику
 * (какой именно мастер, какие override'ы инстанса, какие runtime-листья). Сервер получал уже
 * собранный руками манифест и не мог ни проверить полноту provenance, ни назвать недостающий
 * артефакт. Пакет делает источник **проверяемым**: он несёт узлы (`nodes[]`) с их
 * `componentKey`/семантической ролью, экспорты (`exports[]`) ссылками на реестр ассетов, а также
 * явные `missing[]`/`anomalies[]`.
 *
 * Решения формы:
 *
 * 1. **Ни одного байта в таблице.** Экспорт — это `assetId` существующего реестра ассетов
 *    (`asset_<sha256>`), загруженный обычным `POST /api/assets`. Пакет хранит **манифест**, а
 *    дедупликация байтов уже решена контентным адресом ассета. Отсюда же проверка dims/SHA:
 *    объявленные числа сверяются со строкой реестра, а не с доверием к загрузчику.
 * 2. **Контентный адрес пакета** — `fsp_<sha256(канонический манифест)>`. Повторная загрузка того
 *    же пакета идемпотентна по построению (`deduplicated: true`), а смена `sourceRevision` — это
 *    **новый** пакет с новыми экспортами: инвалидация зависимых кейсов происходит через смену
 *    `referenceAssetId` (слой `comparison`), пересъёмки нет.
 * 3. **`sourcePackageId` — metadata-only** (триаж S-M11). Ссылка живёт в `figmaSchema` компонента
 *    и не входит **ни в один** отпечаток приёмки: она говорит «этот компонент собран из этого
 *    пакета», а пиксели решает эталон, у которого уже есть свой слой (`referenceAssetId`).
 *    Дифференциальный тест на неизменность отпечатков стоит в `figma-source-package.test.ts`.
 * 4. **Валидация provenance** (триаж S-m6) — три инварианта: `fileKey` пакета один на все узлы,
 *    любой упомянутый `nodeId` объявлен в `nodes[]`, `componentKey` уникален в пакете.
 *    Без них «пакет» был бы просто свалкой ссылок, и preflight `missing_exact_reference` не имел
 *    бы права ничего утверждать.
 */
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { canonicalStringify } from "../../src/capture/canonicalJson";
import { ApiError } from "../http";
import { parseFigmaStored, resolveProvenanceRaw } from "../figma";

/** Потолок экспортов одного пакета (`limits.sourcePackageMaxExports`). */
export const SOURCE_PACKAGE_MAX_EXPORTS = 256;
/** Узлов в пакете: экспортируется не каждый узел, поэтому потолок выше экспортного. */
export const SOURCE_PACKAGE_MAX_NODES = 1024;

export const SOURCE_PACKAGE_ID_PATTERN = /^fsp_[0-9a-f]{64}$/;
export const isSourcePackageId = (value: string): boolean => SOURCE_PACKAGE_ID_PATTERN.test(value);

/**
 * Kill-switch волны (§W8): `EASYUI_SOURCE_PACKAGE_DISABLED=1` гасит **обе** половины фичи —
 * набор `/api/figma-source-packages*` отвечает 404 и новые ссылки `figma.sourcePackageId`
 * отвергаются (422 `source_package_disabled`). Уже записанные ссылки читаются как есть: они
 * metadata-only и ничему не мешают.
 *
 * Rollback-window миграции v36: пока откат образа возможен без восстановления тома — пакеты не
 * загружать и `sourcePackageId` не проставлять (старый образ о таблице не знает, а ссылка на
 * несуществующую строку пережила бы откат немой).
 */
export const sourcePackageEnabled = (raw: string | undefined = process.env.EASYUI_SOURCE_PACKAGE_DISABLED): boolean =>
  raw !== "1";

// ──────────────────────────────── манифест ────────────────────────────────

/** Тот же url-safe формат, что у `figmaSchema` — provenance одна на продукт. */
const fileKey = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "fileKey must be url-safe");
const nodeId = z.string().min(1).max(64).regex(/^[A-Za-z0-9:._-]+$/, "nodeId must be safe");
const componentKey = z.string().min(1).max(128).regex(/^[A-Za-z0-9:._-]+$/, "componentKey must be safe");
const shortText = z.string().min(1).max(200);
const dimensionPx = z.number().int().positive().max(16384);

/**
 * Роль узла в пакете — **семантическая**, а не техническая: именно она едет сигналом ранжирования
 * в reuse-search (триаж S-M6) вместе с `componentKey`. Свободная строка намеренно: словарь ролей
 * живёт в `docs/canonical-roles.md` и его расширение не должно требовать миграции пакетов.
 */
const semanticRole = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/, "role must be a slug");

export const sourcePackageNodeSchema = z.strictObject({
  nodeId,
  /** Имя узла в Figma — для человека в аудите. */
  name: shortText.optional(),
  /** Ключ компонента/мастера Figma: стабильная идентичность между файлами и ревизиями. */
  componentKey: componentKey.optional(),
  role: semanticRole.optional(),
  kind: z.enum(["component", "componentSet", "instance", "frame", "text", "vector", "other"]).optional(),
  /** Узел из другого файла (мульти-документный lineage). Опущен — файл пакета. */
  fileKey: fileKey.optional(),
});

export const sourcePackageExportSchema = z.strictObject({
  nodeId,
  /** Ассет реестра (`POST /api/assets`); байты в пакете не передаются никогда. */
  assetId: z.string().regex(/^asset_[0-9a-f]{64}$/, "must be an asset id"),
  width: dimensionPx,
  height: dimensionPx,
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "must be a sha256 hex digest"),
  /** Масштаб экспорта (`1x`/`2x`/`3x`) — provenance, в проверки не входит. */
  scale: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
});

/** Роль недостающего артефакта. `exact-reference` — вход preflight'а (§W8). */
export const SOURCE_PACKAGE_MISSING_ROLES = [
  "exact-reference", "instance-override", "runtime-leaf", "raw-reference", "text-run", "other",
] as const;

export const sourcePackageMissingSchema = z.strictObject({
  role: z.enum(SOURCE_PACKAGE_MISSING_ROLES),
  nodeId: nodeId.optional(),
  componentKey: componentKey.optional(),
  note: shortText.optional(),
});

export const sourcePackageManifestSchema = z.strictObject({
  designSystem: z.string().min(1).max(64),
  fileKey,
  /** Ревизия документа Figma: её смена — **новый** пакет, а не правка старого. */
  sourceRevision: z.string().min(1).max(128),
  nodes: z.array(sourcePackageNodeSchema).min(1).max(SOURCE_PACKAGE_MAX_NODES),
  exports: z.array(sourcePackageExportSchema).max(SOURCE_PACKAGE_MAX_EXPORTS).optional(),
  /** Маппинг свойств инстанса: `nodeId` → имя свойства → значение. */
  instanceProperties: z.array(z.strictObject({
    nodeId, name: shortText, value: z.union([z.string().max(200), z.number(), z.boolean()]),
  })).max(1024).optional(),
  textRuns: z.array(z.strictObject({ nodeId, text: z.string().max(2000), style: shortText.optional() })).max(1024).optional(),
  effects: z.array(z.strictObject({ nodeId, kind: shortText, value: z.string().max(500).optional() })).max(1024).optional(),
  usageContexts: z.array(z.strictObject({ nodeId, context: shortText })).max(1024).optional(),
  missing: z.array(sourcePackageMissingSchema).max(256).optional(),
  anomalies: z.array(z.strictObject({ nodeId: nodeId.optional(), code: shortText, note: shortText.optional() })).max(256).optional(),
});

export type SourcePackageManifest = z.infer<typeof sourcePackageManifestSchema>;
export type SourcePackageNode = z.infer<typeof sourcePackageNodeSchema>;

const sha256Of = (value: string): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");

/**
 * Контентный адрес пакета. Хэшируется **разобранный** манифест (`parsed.data`), поэтому
 * форматирование запроса и порядок ключей на адрес не влияют, а любое смысловое отличие даёт
 * другой пакет.
 */
export const sourcePackageIdOf = (manifest: SourcePackageManifest): string =>
  `fsp_${sha256Of(canonicalStringify(manifest))}`;

// ─────────────────────────────── валидация ────────────────────────────────

type AssetRow = { sha256: string; width: number | null; height: number | null };

/**
 * Проверки, которые невозможно выразить схемой: согласованность provenance (триаж S-m6) и
 * сверка объявленных dims/SHA с реестром ассетов.
 *
 * Порядок отказов — от дешёвого к дорогому и от структуры к байтам: сначала «пакет сам себе
 * противоречит», потом «пакет противоречит реестру». Иначе автор чинил бы SHA у экспорта, узел
 * которого он вообще забыл объявить.
 */
export function validateSourcePackage(db: Database, manifest: SourcePackageManifest): void {
  const fail = (code: string, message: string, path: (string | number)[]): never => {
    throw new ApiError(422, code, message, { issues: [{ path, message }] });
  };

  const byNode = new Map<string, SourcePackageNode>();
  const keys = new Set<string>();
  manifest.nodes.forEach((node, index) => {
    if (byNode.has(node.nodeId)) fail("source_package_duplicate_node", `nodeId is declared twice: ${node.nodeId}`, ["nodes", index, "nodeId"]);
    byNode.set(node.nodeId, node);
    // `fileKey` узла — только для мульти-документного lineage; совпадение с пакетным ключом
    // объявлять не запрещено, но **расхождение** с ним у узла без собственного ключа означало бы
    // пакет, склеенный из двух документов молча.
    if (node.componentKey !== undefined) {
      if (keys.has(node.componentKey)) fail("source_package_duplicate_component_key", `componentKey is declared twice: ${node.componentKey}`, ["nodes", index, "componentKey"]);
      keys.add(node.componentKey);
    }
  });

  // Любой упомянутый где-либо узел обязан быть объявлен: иначе `missing[]` и экспорты говорили бы
  // о частях документа, о которых пакет ничего не знает, а preflight ссылался бы в пустоту.
  const requireDeclared = (id: string, path: (string | number)[]): void => {
    if (!byNode.has(id)) fail("source_package_node_not_declared", `nodeId is not declared in nodes[]: ${id}`, path);
  };

  const exportedNodes = new Set<string>();
  (manifest.exports ?? []).forEach((entry, index) => {
    requireDeclared(entry.nodeId, ["exports", index, "nodeId"]);
    if (exportedNodes.has(entry.nodeId)) fail("source_package_duplicate_node", `nodeId is exported twice: ${entry.nodeId}`, ["exports", index, "nodeId"]);
    exportedNodes.add(entry.nodeId);
    const row = db.query("SELECT sha256, width, height FROM assets WHERE id=?").get(entry.assetId) as AssetRow | null;
    if (row === null) fail("asset_not_found", `unknown asset: ${entry.assetId}`, ["exports", index, "assetId"]);
    // Ассет контентно-адресован, поэтому «объявленный SHA» проверяется против самих байтов, а не
    // против другого объявления: `asset_<sha256>` и есть их хэш.
    if (row!.sha256 !== entry.sha256) {
      fail("source_package_export_sha_mismatch", `declared sha256 does not match the asset bytes: ${entry.assetId}`, ["exports", index, "sha256"]);
    }
    if (row!.width !== entry.width || row!.height !== entry.height) {
      fail("source_package_export_dimension_mismatch",
        `declared dimensions ${entry.width}×${entry.height} do not match the asset (${row!.width ?? "?"}×${row!.height ?? "?"})`,
        ["exports", index, "width"]);
    }
  });

  (manifest.instanceProperties ?? []).forEach((entry, index) => requireDeclared(entry.nodeId, ["instanceProperties", index, "nodeId"]));
  (manifest.textRuns ?? []).forEach((entry, index) => requireDeclared(entry.nodeId, ["textRuns", index, "nodeId"]));
  (manifest.effects ?? []).forEach((entry, index) => requireDeclared(entry.nodeId, ["effects", index, "nodeId"]));
  (manifest.usageContexts ?? []).forEach((entry, index) => requireDeclared(entry.nodeId, ["usageContexts", index, "nodeId"]));
  (manifest.missing ?? []).forEach((entry, index) => {
    if (entry.nodeId !== undefined) requireDeclared(entry.nodeId, ["missing", index, "nodeId"]);
    if (entry.componentKey !== undefined && !keys.has(entry.componentKey)) {
      fail("source_package_component_key_not_declared", `componentKey is not declared in nodes[]: ${entry.componentKey}`, ["missing", index, "componentKey"]);
    }
  });
  (manifest.anomalies ?? []).forEach((entry, index) => {
    if (entry.nodeId !== undefined) requireDeclared(entry.nodeId, ["anomalies", index, "nodeId"]);
  });
}

// ──────────────────────────────── хранилище ───────────────────────────────

export interface SourcePackageRow {
  package_id: string;
  design_system: string;
  file_key: string;
  source_revision: string;
  manifest_json: string;
  export_count: number;
  created_by: string;
  created_at: string;
}

export class SourcePackageRepo {
  constructor(private db: Database) {}

  get(packageId: string): SourcePackageRow | null {
    return this.db.query("SELECT * FROM figma_source_packages WHERE package_id=?").get(packageId) as SourcePackageRow | null;
  }

  list(designSystem: string, options: { fileKey?: string; limit?: number } = {}): SourcePackageRow[] {
    const limit = options.limit ?? 20;
    return (options.fileKey === undefined
      ? this.db.query("SELECT * FROM figma_source_packages WHERE design_system=? ORDER BY created_at DESC, package_id DESC LIMIT ?").all(designSystem, limit)
      : this.db.query("SELECT * FROM figma_source_packages WHERE design_system=? AND file_key=? ORDER BY created_at DESC, package_id DESC LIMIT ?").all(designSystem, options.fileKey, limit)
    ) as SourcePackageRow[];
  }

  /**
   * Идемпотентная запись: контентный адрес уже вычислен, поэтому повтор того же пакета возвращает
   * существующую строку нетронутой (`deduplicated: true`) — включая её `created_by`/`created_at`.
   */
  insert(manifest: SourcePackageManifest, createdBy: string): { row: SourcePackageRow; deduplicated: boolean } {
    const packageId = sourcePackageIdOf(manifest);
    const existing = this.get(packageId);
    if (existing !== null) return { row: existing, deduplicated: true };
    this.db.query(`INSERT INTO figma_source_packages
      (package_id,design_system,file_key,source_revision,manifest_json,export_count,created_by,created_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(packageId, manifest.designSystem, manifest.fileKey, manifest.sourceRevision,
        canonicalStringify(manifest), (manifest.exports ?? []).length, createdBy, new Date().toISOString());
    return { row: this.get(packageId)!, deduplicated: false };
  }
}

export function manifestOfRow(row: SourcePackageRow): SourcePackageManifest {
  return sourcePackageManifestSchema.parse(JSON.parse(row.manifest_json));
}

export function sourcePackageView(row: SourcePackageRow): Record<string, unknown> {
  return {
    packageId: row.package_id,
    designSystem: row.design_system,
    fileKey: row.file_key,
    sourceRevision: row.source_revision,
    exportCount: row.export_count,
    createdBy: row.created_by,
    createdAt: row.created_at,
    manifest: JSON.parse(row.manifest_json),
  };
}

// ─────────────────── preflight `missing_exact_reference` ──────────────────

/**
 * Предупреждение префлайта (§W8): пакет объявил, что для узла компонента **нет** точного
 * экспорта. Это не блокер (решение оркестратора волны): пакет описывает состояние источника, а
 * не корректность компонента, и 422 здесь запретил бы публиковать компонент из-за чужой дыры в
 * Figma. Зато агент узнаёт о дыре **до** сборки case set'а, а не по проваленному сравнению.
 *
 * Правило совпадения — узел или ключ компонента: `missing[]` с ролью `exact-reference`,
 * чей `nodeId` перечислен в provenance компонента (или чей `componentKey` принадлежит такому узлу).
 */
export function missingExactReferenceWarnings(db: Database, componentId: string, rev: number): string[] {
  const figma = parseFigmaStored(resolveProvenanceRaw(db, componentId, rev));
  if (figma?.sourcePackageId === undefined) return [];
  const row = new SourcePackageRepo(db).get(figma.sourcePackageId);
  if (row === null) return [];
  let manifest: SourcePackageManifest;
  try { manifest = manifestOfRow(row); } catch { return []; }
  // Узлы компонента — primary-документ плюс мульти-источники (`figmaSchema.sources`).
  const nodes = new Set<string>([...figma.nodeIds, ...(figma.sources ?? []).flatMap((source) => source.nodeIds)]);
  const keysOfNodes = new Set<string>();
  for (const node of manifest.nodes) if (nodes.has(node.nodeId) && node.componentKey !== undefined) keysOfNodes.add(node.componentKey);
  const warnings: string[] = [];
  for (const entry of manifest.missing ?? []) {
    if (entry.role !== "exact-reference") continue;
    const hitsNode = entry.nodeId !== undefined && nodes.has(entry.nodeId);
    const hitsKey = entry.componentKey !== undefined && keysOfNodes.has(entry.componentKey);
    if (!hitsNode && !hitsKey) continue;
    const subject = entry.nodeId ?? entry.componentKey ?? "?";
    warnings.push(`missing_exact_reference: source package ${row.package_id} declares no exact reference export for ${subject}${entry.note === undefined ? "" : ` (${entry.note})`}; acceptance of this node will compare against an approximate reference`);
  }
  return warnings.sort();
}

// ───────────────── сигналы reuse-search (триаж S-M6) ──────────────────────

/**
 * Сигнатура источника артефакта: ключи компонентов Figma и семантические роли его узлов.
 * Форму владеет ядро матчера (`server/catalog/matcher.ts`) — оно её потребляет и держит закрытый
 * список импортов; здесь тип только реэкспортируется, чтобы у потребителей был один адрес.
 */
export type { SourceSignature } from "../catalog/matcher";
import type { SourceSignature } from "../catalog/matcher";

/** Проекция узлов пакета на набор `nodeIds`: то, что знает про эти узлы источник. */
export function sourceSignatureOf(manifest: SourcePackageManifest, nodeIds: readonly string[]): SourceSignature | undefined {
  const wanted = new Set(nodeIds);
  const componentKeys = new Set<string>();
  const roles = new Set<string>();
  for (const node of manifest.nodes) {
    if (!wanted.has(node.nodeId)) continue;
    if (node.componentKey !== undefined) componentKeys.add(node.componentKey);
    if (node.role !== undefined) roles.add(node.role);
  }
  if (componentKeys.size === 0 && roles.size === 0) return undefined;
  return { componentKeys: [...componentKeys].sort(), roles: [...roles].sort() };
}

/**
 * Разбор одного пакета из БД в манифест — общий вход для корпуса и роутов. `null` на битой строке:
 * ранжирование обязано деградировать до «сигнала нет», а не ронять поиск кандидатов.
 */
export function manifestById(db: Database, packageId: string): SourcePackageManifest | null {
  const row = new SourcePackageRepo(db).get(packageId);
  if (row === null) return null;
  try { return manifestOfRow(row); } catch { return null; }
}

// ───────────────────────── case-set skeleton ──────────────────────────────

export interface SkeletonOptions {
  componentId: string;
  viewport?: { width: number; height: number };
  deviceScaleFactor?: 1 | 2 | 3;
  theme?: "light" | "dark";
  /** Ограничить скелет подмножеством узлов пакета (по умолчанию — все экспортированные). */
  nodeIds?: readonly string[];
}

/**
 * Черновик case-set-манифеста из пакета (§W8). **Не сохраняется**: сервер отдаёт его как есть,
 * а автор дописывает `props` и правит ожидания. Скелет заполняет ровно то, что пакет знает
 * достоверно — эталон (`referenceAssetId`) и его габариты (`expectedSurfaces.referenceExport`,
 * синергия с W1), — и не выдумывает ни `props`, ни `expectedGeometry`.
 *
 * Инвариант (гейт наоборот): результат обязан проходить `caseSetManifestSchema`; тест на это
 * стоит в `figma-source-package.test.ts`.
 */
export function caseSetSkeletonOf(manifest: SourcePackageManifest, options: SkeletonOptions): Record<string, unknown> {
  const wanted = options.nodeIds === undefined ? undefined : new Set(options.nodeIds);
  const exports = (manifest.exports ?? []).filter((entry) => wanted === undefined || wanted.has(entry.nodeId));
  if (exports.length === 0) {
    throw new ApiError(422, "source_package_no_exports", "The source package carries no export for the requested nodes", {
      issues: [{ path: ["nodeIds"], message: "no matching export in the package" }],
    });
  }
  const nodeById = new Map(manifest.nodes.map((node) => [node.nodeId, node]));
  // Идентификатор случая обязан пройти `^[A-Za-z0-9._-]{1,64}$`: `nodeId` Figma содержит `:`.
  // Коллизии разводятся суффиксом — два узла с одной ролью законны, а `duplicate case id` был бы
  // отказом схемы на скелете, который сервер же и породил.
  const used = new Set<string>();
  const caseIdOf = (raw: string): string => {
    const base = (raw.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 56) || "case");
    let id = base;
    for (let index = 2; used.has(id); index += 1) id = `${base}-${index}`;
    used.add(id);
    return id;
  };
  // Габариты ассета — device px; поверхность `referenceExport` объявляется в CSS px, поэтому
  // объявленный масштаб экспорта снимается здесь, а не остаётся ловушкой для автора.
  const cssPx = (value: number, scale: 1 | 2 | 3 | undefined): number => Math.max(1, Math.round(value / (scale ?? 1)));
  const widest = exports.reduce((max, entry) => Math.max(max, cssPx(entry.width, entry.scale)), 0);
  const tallest = exports.reduce((max, entry) => Math.max(max, cssPx(entry.height, entry.scale)), 0);
  return {
    manifestVersion: 1,
    componentId: options.componentId,
    source: { fileKey: manifest.fileKey },
    capture: {
      viewport: options.viewport ?? { width: Math.max(widest, 1), height: Math.max(tallest, 1) },
      ...(options.deviceScaleFactor === undefined ? {} : { deviceScaleFactor: options.deviceScaleFactor }),
      ...(options.theme === undefined ? {} : { theme: options.theme }),
    },
    cases: exports.map((entry) => {
      const node = nodeById.get(entry.nodeId);
      return {
        id: caseIdOf(node?.role ?? node?.name ?? entry.nodeId),
        props: {},
        referenceAssetId: entry.assetId,
        // Габариты экспорта — единственная поверхность, которую пакет знает точно.
        expectedSurfaces: { referenceExport: { width: cssPx(entry.width, entry.scale), height: cssPx(entry.height, entry.scale) } },
      };
    }),
  };
}
