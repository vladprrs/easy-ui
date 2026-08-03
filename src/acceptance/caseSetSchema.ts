/**
 * Схема case-set-манифеста — общий контракт сервера, клиента и драйвера
 * (план `docs/plans/2026-08-03-family-acceptance-and-composition-v3.md` §5 W2, амендмент A2;
 * RFC `docs/plans/2026-08-02-candidate-acceptance-pipeline-rfc.md` §3.3/§3.4; фидбэк §10 «Verification matrix»).
 *
 * Манифест — **сущность продукта**, а не ассет: сервер валидирует его целиком (`server/acceptance/caseSets.ts`),
 * хранит в `component_case_sets` и адресует контентно (`cset_` + sha256 канонизованного манифеста).
 *
 * Три инварианта, которые держит именно схема:
 *
 * 1. **`manifestVersion: 1` и strict-объекты.** Неизвестное поле — отказ, а не молчаливое
 *    игнорирование: манифест на 49 случаев с опечаткой в имени поля иначе прошёл бы приёмку с
 *    другой семантикой. Поля геометрии/readiness расширяются волнами W3/W4 **аддитивно**, поэтому
 *    ранние наборы не перевыпускаются (триаж R2-15).
 * 2. **Charset `case.id`.** `^[A-Za-z0-9._-]{1,64}$` — тот же, что `CASE_NAME_PATTERN` раннера:
 *    из `caseId` строятся имена записей evidence-архива и клиентского кэша (защита от zip-slip,
 *    план §9 «Риски»).
 * 3. **Никаких байтов.** Эталон — `referenceAssetId` реестра ассетов (`asset_<sha256>`),
 *    существование проверяет сервер (`422 asset_not_found`); дедуп эталонов — по sha реестра.
 */
import { z } from "zod";

/** Единственная поддерживаемая версия манифеста. Новая версия = новое значение литерала. */
export const CASE_SET_MANIFEST_VERSION = 1;

/** Charset имён случаев: совпадает с `CASE_NAME_PATTERN` в `server/acceptance/cases.ts`. */
export const CASE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Идентификатор ассета реестра (`server/figma.ts` — тот же формат). */
export const REFERENCE_ASSET_ID_PATTERN = /^asset_[0-9a-f]{64}$/;

/** `cset_` + sha256 канонизованного манифеста (контентная адресация, повтор идемпотентен). */
export const CASE_SET_ID_PATTERN = /^cset_[0-9a-f]{64}$/;
export const isCaseSetId = (value: string): boolean => CASE_SET_ID_PATTERN.test(value);

/**
 * Абсолютный потолок массива `cases` — защита парсера от гигантского тела, а не продуктовый лимит.
 * Продуктовый потолок — `acceptanceMaxCasesPerRun` (реестр политик сервера): он проверяется после
 * схемы и отдаёт `422 case_set_too_large`, поэтому лимит остаётся в одном месте и меняется без
 * правки общей схемы.
 */
export const CASE_SET_MAX_CASES = 512;
/** Потолок измерений покрытия и значений в измерении: coverage строит декартово произведение. */
export const CASE_SET_MAX_DIMENSIONS = 8;
export const CASE_SET_MAX_DIMENSION_VALUES = 32;

const caseId = z.string().regex(CASE_ID_PATTERN, "case id must match ^[A-Za-z0-9._-]{1,64}$");
const dimensionName = z.string().regex(/^[A-Za-z0-9._-]{1,48}$/, "dimension name must match ^[A-Za-z0-9._-]{1,48}$");
const dimensionValue = z.string().regex(/^[A-Za-z0-9._-]{1,48}$/, "dimension value must match ^[A-Za-z0-9._-]{1,48}$");

/** Тот же url-safe формат, что у `figmaSchema` (`server/figma.ts`) — provenance одна на продукт. */
const figmaFileKey = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "fileKey must be url-safe");
const figmaNodeId = z.string().min(1).max(64).regex(/^[A-Za-z0-9:._-]+$/, "nodeId must be safe");

/** Габариты в CSS px: целые, положительные, в пределах разумного холста капчура. */
const dimensionPx = z.number().int().positive().max(8192);

export const caseSetCaptureSchema = z.strictObject({
  viewport: z.strictObject({ width: dimensionPx, height: dimensionPx }),
  /** Плотность пикселей съёмки; по умолчанию 2 (канон `DEFAULT_CASE_SURFACE`). */
  deviceScaleFactor: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  theme: z.enum(["light", "dark"]).optional(),
});

/**
 * Per-case допуски (RFC §3.4: «per-case допуски приезжают из case-set-манифеста и хешируются в
 * `case_policy_hash`»). Значения потребляют гейты W3 (`allowPaintOverflow`/`expectedClip`) и W5a
 * (`maxRawDiffPct`); в W2 они уже входят в `case_policy_hash`, поэтому смена допуска
 * инвалидирует reuse ровно того случая, которого касается.
 */
export const caseSetCasePolicySchema = z.strictObject({
  maxRawDiffPct: z.number().min(0).max(100).optional(),
  allowPaintOverflow: z.boolean().optional(),
  expectedClip: z.boolean().optional(),
});

/**
 * `cropLineage` (§19.5 фидбэка): происхождение эталона — прямоугольник внутри родительского
 * узла Figma. Нужен нормализации размеров в W5a (crop эталона до кадра случая), поэтому
 * записывается уже сейчас: перевыпускать манифесты семейств ради одного поля недопустимо.
 */
export const caseSetCropLineageSchema = z.strictObject({
  parentNodeId: figmaNodeId.optional(),
  /** `[x, y, width, height]` в пикселях эталона: x/y ≥ 0, width/height > 0. */
  rect: z.tuple([
    z.number().min(0).max(1e6),
    z.number().min(0).max(1e6),
    z.number().gt(0).max(1e6),
    z.number().gt(0).max(1e6),
  ]),
});

export const caseSetCaseSchema = z.strictObject({
  id: caseId,
  props: z.record(z.string(), z.unknown()),
  referenceAssetId: z.string().regex(REFERENCE_ASSET_ID_PATTERN, "must be an asset id").optional(),
  expectedGeometry: z.strictObject({ width: dimensionPx, height: dimensionPx }).optional(),
  cropLineage: caseSetCropLineageSchema.optional(),
  /**
   * Явный алиас: случай с теми же props, что у цели, снимается один раз и наследует вердикт
   * (D10). Без `aliasOf` дубликат props — отказ `422 duplicate_case_props`, иначе матрица тихо
   * платила бы за одинаковые кадры.
   */
  aliasOf: caseId.optional(),
  /** Координаты случая в измерениях семьи (`dimensions`) — вход coverage и variant family (W5b). */
  dims: z.record(dimensionName, dimensionValue).optional(),
});

export const caseSetManifestSchema = z.strictObject({
  manifestVersion: z.literal(CASE_SET_MANIFEST_VERSION),
  componentId: z.string().min(1).max(64),
  source: z.strictObject({
    fileKey: figmaFileKey,
    componentSetNodeId: figmaNodeId.optional(),
  }).optional(),
  capture: caseSetCaptureSchema,
  dimensions: z.record(dimensionName, z.array(dimensionValue).min(1).max(CASE_SET_MAX_DIMENSION_VALUES))
    .refine((value) => Object.keys(value).length <= CASE_SET_MAX_DIMENSIONS, `at most ${CASE_SET_MAX_DIMENSIONS} dimensions`)
    .optional(),
  /** Намерение «набор бессмысленен без визуального гейта»; потребляется W5a, хранится с W2. */
  requireVisual: z.boolean().optional(),
  policy: z.strictObject({
    profile: z.enum(["default-v1", "pixel-strict-v1"]).optional(),
    perCase: z.record(caseId, caseSetCasePolicySchema).optional(),
  }).optional(),
  cases: z.array(caseSetCaseSchema).min(1).max(CASE_SET_MAX_CASES),
});

export type CaseSetManifest = z.infer<typeof caseSetManifestSchema>;
export type CaseSetCase = z.infer<typeof caseSetCaseSchema>;
export type CaseSetCapture = z.infer<typeof caseSetCaptureSchema>;
export type CaseSetCasePolicy = z.infer<typeof caseSetCasePolicySchema>;
