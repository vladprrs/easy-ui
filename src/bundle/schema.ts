import { z } from "zod";
import { slugSchema, ASSET_ID_PATTERN } from "../prototype/schema";

// Bundle format (ZIP export/import). One manifest describes prototype, component and
// bulk exports; the importer is unified. See docs/plans/2026-07-20-bundle-export-import.md.
//
// Guardrail: nothing under src/ imports fflate — the zip codec lives only on the server
// and in the client bundle helpers, never in this shared schema module.

// Content-addressed asset id: "asset_" + full lowercase sha256 (64 hex).
export const bundleAssetIdSchema = z.string().regex(ASSET_ID_PATTERN, "must be an asset id (asset_<64 hex>)");
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase sha256 (64 hex)");

// --- Theme content (compatible with server ThemeContent grammar) ------------
// Kept structurally faithful to server/designSystemsMeta.ts: tokens is a flat map of
// dotted keys to string|number; fonts/icons are asset-backed descriptors. Optional
// descriptor fields are tolerated leniently here so a newer server's theme still parses.
const themeTokensSchema = z.record(z.string(), z.union([z.string(), z.number()]));

const themeFontSchema = z.object({
  family: z.string(),
  src: bundleAssetIdSchema,
  weight: z.union([z.number(), z.string()]).optional(),
  style: z.string().optional(),
});

const themeIconSchema = z.object({
  name: z.string(),
  assetId: bundleAssetIdSchema,
  viewBox: z.string().optional(),
  themes: z.object({ light: bundleAssetIdSchema.optional(), dark: bundleAssetIdSchema.optional() }).optional(),
});

export const bundleThemeSchema = z.object({
  metaVersion: z.number(),
  tokens: themeTokensSchema,
  fonts: z.array(themeFontSchema),
  icons: z.array(themeIconSchema),
});

// --- Manifest ---------------------------------------------------------------

export const bundleKindSchema = z.enum(["prototype", "component", "bulk"]);

const componentPinSchema = z.object({
  id: slugSchema,
  version: z.number(),
});

const bundleSourceSchema = z.object({
  origin: z.string(),
  apiVersion: z.number(),
  renderContractVersion: z.number(),
  builtinCatalogHash: z.string(),
});

const prototypeExportedSchema = z.object({
  selector: z.enum(["draft", "version"]),
  rev: z.number(),
  version: z.number().nullable(),
});

const bundlePrototypeSchema = z.object({
  id: slugSchema,
  name: z.string(),
  designSystem: slugSchema,
  exported: prototypeExportedSchema,
  docPath: z.string(),
  componentPins: z.array(componentPinSchema),
  // Пины композиций ревизии (format 2). Отсутствуют в бандлах format 1 — отсюда default.
  compositionPins: z.array(componentPinSchema).default([]),
  assetIds: z.array(bundleAssetIdSchema),
  designSystemMetaVersion: z.number().nullable(),
});

const componentExportedSchema = z.object({
  rev: z.number(),
  version: z.number().nullable(),
});

const bundleComponentSchema = z.object({
  id: slugSchema,
  name: z.string(),
  designSystem: slugSchema,
  sourcePath: z.string(),
  sourceHash: z.string(),
  exported: componentExportedSchema,
  assetIds: z.array(bundleAssetIdSchema),
});

const compositionExportedSchema = z.object({
  rev: z.number(),
  version: z.number().nullable(),
});

// Композиция бандла (format 2). Артефакт — сам документ (`compositions/<id>.json`),
// компилировать нечего; `sourceHash` — sha256 канонического JSON документа.
const bundleCompositionSchema = z.object({
  id: slugSchema,
  name: z.string(),
  designSystem: slugSchema,
  docPath: z.string(),
  sourceHash: z.string(),
  exported: compositionExportedSchema,
});

const bundleDesignSystemSchema = z.object({
  id: slugSchema,
  name: z.string(),
  description: z.string().nullable().optional(),
  builtin: z.boolean(),
  theme: bundleThemeSchema.nullable(),
});

const bundleAssetSchema = z.object({
  id: bundleAssetIdSchema,
  sha256: sha256Schema,
  mime: z.string(),
  size: z.number(),
  originalName: z.string().nullable(),
});

/**
 * Версия формата бандла.
 * - `1` — исходный формат (прототипы, компоненты, дизайн-системы, ассеты);
 * - `2` — добавляет секцию `compositions[]` и `prototypes[].compositionPins`.
 *
 * Экспорт выставляет `2` **только** когда в бандле есть композиции: бандлы без них
 * остаются форматом `1` и читаются старым сервером. Бандл формата `2` старый сервер
 * (`z.literal(1)`) отвергает целиком — `400 invalid_bundle` до единой записи в БД.
 */
export const BUNDLE_FORMAT_VERSION_LEGACY = 1 as const;
export const BUNDLE_FORMAT_VERSION_COMPOSITIONS = 2 as const;
const bundleFormatVersionSchema = z.union([z.literal(BUNDLE_FORMAT_VERSION_LEGACY), z.literal(BUNDLE_FORMAT_VERSION_COMPOSITIONS)]);

export const bundleManifestSchema = z.object({
  formatVersion: bundleFormatVersionSchema,
  kind: bundleKindSchema,
  exportedAt: z.string(),
  source: bundleSourceSchema,
  prototypes: z.array(bundlePrototypeSchema),
  components: z.array(bundleComponentSchema),
  // Format 1 не знает композиций: default сохраняет обратную совместимость чтения.
  compositions: z.array(bundleCompositionSchema).default([]),
  designSystems: z.array(bundleDesignSystemSchema),
  assets: z.array(bundleAssetSchema),
});

// --- Import report ----------------------------------------------------------

export const importItemTypeSchema = z.enum(["asset", "designSystem", "component", "composition", "prototype"]);
export const importActionSchema = z.enum(["created", "reused", "skipped", "error"]);

const importItemSchema = z.object({
  type: importItemTypeSchema,
  id: z.string(),
  name: z.string().optional(),
  action: importActionSchema,
  detail: z.string().optional(),
  remappedTo: z.string().optional(),
  version: z.number().optional(),
  // Present when a fresh component was rejected by the reuse gate. A dry-run returns the
  // exact material an administrator must acknowledge on the subsequent apply request.
  catalogRevision: z.string().optional(),
  candidateKeys: z.array(z.string()).optional(),
  decisionId: z.string().nullable().optional(),
  reuseCode: z.enum(["component_reuse_required", "catalog_changed", "canonical_role_conflict"]).optional(),
});

const importSummarySchema = z.object({
  created: z.number(),
  reused: z.number(),
  skipped: z.number(),
  errors: z.number(),
});

export const importReportSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  ok: z.boolean(),
  items: z.array(importItemSchema),
  summary: importSummarySchema,
});

// --- Inferred types ---------------------------------------------------------

export type BundleKind = z.infer<typeof bundleKindSchema>;
export type BundleTheme = z.infer<typeof bundleThemeSchema>;
export type BundleManifest = z.infer<typeof bundleManifestSchema>;
export type BundlePrototype = z.infer<typeof bundlePrototypeSchema>;
export type BundleComponent = z.infer<typeof bundleComponentSchema>;
export type BundleComposition = z.infer<typeof bundleCompositionSchema>;
export type BundleDesignSystem = z.infer<typeof bundleDesignSystemSchema>;
export type BundleAsset = z.infer<typeof bundleAssetSchema>;
export type BundleSource = z.infer<typeof bundleSourceSchema>;
export type ImportReport = z.infer<typeof importReportSchema>;
export type ImportReportItem = z.infer<typeof importItemSchema>;
export type ImportItemType = z.infer<typeof importItemTypeSchema>;
export type ImportAction = z.infer<typeof importActionSchema>;
