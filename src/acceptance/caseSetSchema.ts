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
/**
 * Потолок измерений покрытия и значений в измерении.
 *
 * `CASE_SET_MAX_DIMENSION_VALUES` = 64 (план 2026-08-04 §W6, P1-7): 32 было **ниже**
 * `acceptanceMaxCasesPerRun`, поэтому семья из 49 состояний с одной канонической осью не
 * помещалась в один манифест и её шардировали руками — шардирование, которого продукт не просил.
 * Инвариант «≥ acceptanceMaxCasesPerRun» проверяет серверный тест (`server/acceptance/caseSets.test.ts`):
 * схема — общий с клиентом модуль и server-код не импортирует.
 */
export const CASE_SET_MAX_DIMENSIONS = 8;
export const CASE_SET_MAX_DIMENSION_VALUES = 64;

/**
 * Потолок **декартова произведения** измерений (C5/C16). Одних поосевых лимитов мало: 8 осей по 64
 * значения — это 2.8·10^14 tuples, и `coverageOf` материализовал бы их `flatMap`'ом до любой
 * проверки, то есть манифест на две страницы убивал бы процесс. Произведение считается
 * **перемножением длин** до материализации; превышение — `422 case_set_coverage_too_large`.
 */
export const CASE_SET_MAX_EXPECTED_TUPLES = 4096;

/**
 * Сколько незакрытых ячеек уезжает в ответ. Полный список при 4096 ожидаемых tuples — это мегабайты
 * JSON в ответе на PUT; ответ несёт первые `COVERAGE_MISSING_TUPLES_LIMIT` и флаг `truncated`,
 * а полное число — в `missingCount`.
 */
export const COVERAGE_MISSING_TUPLES_LIMIT = 64;

/**
 * Размер декартова произведения объявленных измерений — перемножением длин, без материализации.
 * Возвращает `0` для набора без `dimensions` (тривиальное покрытие, фиктивное произведение по
 * неполной Figma-матрице не выдумывается) и `Infinity`, если произведение переполняет число.
 */
export function expectedTuplesOf(dimensions: Record<string, string[]> | undefined): number {
  if (!dimensions) return 0;
  const names = Object.keys(dimensions);
  if (names.length === 0) return 0;
  let product = 1;
  for (const name of names) {
    product *= dimensions[name]!.length;
    if (!Number.isFinite(product)) return Infinity;
  }
  return product;
}

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
 * Поверхность эталона (план 2026-08-04 §W5, фидбэк «P1. Padded paint reference и root geometry»).
 *
 * - `"paint"` — ассет **уже** является канонической paint-канвой случая (прозрачный фон + поле
 *   `margin` вокруг компонента). Это сегодняшнее — и единственное до W5 — поведение, поэтому оно
 *   же дефолт **в потребителе**: манифест без поля сравнивается ровно как раньше.
 * - `"content-hug"` — ассет обрезан по содержимому (штатный экспорт Figma-узла). Сервер сам
 *   строит из него каноническую канву: паддит прозрачным до `expectedGeometry + 2×margin` и
 *   размещает по `referencePlacement`. Ровно это избавляет автора от ручного PNG-паддинга,
 *   ради которого он раньше подсматривал размеры канвы в упавшем ране.
 */
export const REFERENCE_SURFACES = ["content-hug", "paint"] as const;
export type ReferenceSurface = (typeof REFERENCE_SURFACES)[number];

/**
 * Поверхность, **в координатах которой** записан `cropLineage.rect`, то есть та, которой ассет
 * является физически.
 *
 * - `"figma-node"` — ассет это экспорт родительского узла целиком, и `rect` надо применить, чтобы
 *   получить эталон случая (сегодняшняя семантика; она же дефолт при отсутствии поля).
 * - `"content-hug"` / `"paint"` — ассет **уже** вырезан, и `rect` остаётся только provenance'ом.
 *   Повторное применение — та самая ловушка фидбэка, превращавшая `136×32` в `116×12`.
 */
export const CROP_SOURCE_SURFACES = ["figma-node", "content-hug", "paint"] as const;
export type CropSourceSurface = (typeof CROP_SOURCE_SURFACES)[number];

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
  /**
   * Строго `.optional()` **без** `.default()` (C6/C25): `caseSetIdOf` хэширует `parsed.data`, и
   * zod-дефолт сменил бы контентный адрес всех уже опубликованных манифестов. Дефолт
   * (`"figma-node"`) применяет потребитель — `server/acceptance/gates/visual.ts`.
   */
  sourceSurface: z.enum(CROP_SOURCE_SURFACES).optional(),
});

/**
 * **Слот-биндинги случая** (план `docs/plans/2026-08-05-slot-acceptance.md` §A1).
 *
 * До этого приёмочный контур умел ровно одно — рендерить кандидата с **пустыми слотами**: манифест
 * описывал только собственные props, поэтому два состояния Figma, отличающиеся содержимым слота,
 * приезжали на сервер с одинаковыми props и схлопывались в `422 duplicate_case_props`. Биндинги
 * описывают, чем набивается слот, и делают эти два состояния двумя разными кадрами.
 *
 * Инварианты именно схемы:
 *
 * 1. **Пин точный и обязательный** (`version`). Ребёнок — уже опубликованный компонент, и «последняя
 *    активная версия» сделала бы кадр случая зависящим от чужих публикаций: набор контентно
 *    адресован, а его смысл молча уезжал бы. `bundleHash` в манифесте **нет** — он резолвится
 *    сервером из иммутабельной строки публикации (§A1), иначе клиент диктовал бы байты.
 * 2. **Глубина 1.** `strictObject` ребёнка не знает поля вложенных слотов, поэтому дерево глубже
 *    одного уровня — отказ схемы, а не тихо игнорируемое поле.
 * 3. **Ключ `default` легален** (§A2a): дефолтный слот в этой кодовой базе неявный
 *    (`runtimeSpec.ts` — `slotOf(child) ?? "default"`), компоненты его не объявляют, и без него
 *    карусель из 9 детей осталась бы невыразимой. Проверки принадлежности `extracted.meta.slots` и
 *    гейт `capabilities.namedSlots` его не касаются — они про **именованные** ключи.
 */
export const CASE_SET_MAX_SLOT_CHILDREN = 12;
export const CASE_SET_MAX_SLOTS_PER_CASE = 8;
/** Неявный слот `children`; в манифесте он именуется явно, в дереве съёмки — отсутствием `slot`. */
export const DEFAULT_SLOT_KEY = "default";
/** Тот же charset, что у `definition.slots` (`routes/meta.ts` JSON-схема компонента). */
export const SLOT_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const slotKey = z.string().max(32).regex(SLOT_KEY_PATTERN, "slot key must match ^[a-z0-9]+(?:-[a-z0-9]+)*$");

export const caseSetSlotChildSchema = z.strictObject({
  /** Имя опубликованного компонента (`components.name` уникально глобально и не переименовывается). */
  type: z.string().min(1).max(64),
  /** Точный пин версии: обязателен по построению (см. инвариант 1). */
  version: z.number().int().positive(),
  props: z.record(z.string(), z.unknown()).optional(),
});

export const caseSetSlotBindingsSchema = z
  .record(slotKey, z.array(caseSetSlotChildSchema).min(1).max(CASE_SET_MAX_SLOT_CHILDREN))
  .refine((value) => Object.keys(value).length <= CASE_SET_MAX_SLOTS_PER_CASE,
    `at most ${CASE_SET_MAX_SLOTS_PER_CASE} slots per case`);

export const caseSetCaseSchema = z.strictObject({
  id: caseId,
  props: z.record(z.string(), z.unknown()),
  referenceAssetId: z.string().regex(REFERENCE_ASSET_ID_PATTERN, "must be an asset id").optional(),
  /**
   * **Габариты layout-корня** компонента в CSS px — не размер канвы сравнения. Две величины
   * разного смысла: эталон приезжает padded (`layout + 2×margin`), а `expectedGeometry` судит
   * геометрия против настоящего root'а. Ровно эта путаница роняла `pay-card-button` 12/12
   * (фидбэк P1); теперь она хотя бы называется по-разному и ловится warning'ом при PUT.
   */
  expectedGeometry: z.strictObject({ width: dimensionPx, height: dimensionPx }).optional(),
  cropLineage: caseSetCropLineageSchema.optional(),
  /** Чем является ассет эталона. Дефолт (`"paint"`) — в потребителе, не в схеме (C6/C25). */
  referenceSurface: z.enum(REFERENCE_SURFACES).optional(),
  /**
   * Смещение content-hug эталона внутри канонической канвы, в **пикселях канвы** (device px).
   * Опущено — сервер берёт `margin × deviceScaleFactor`, то есть ровно то место, куда кладёт
   * компонент сама paint-съёмка. Значение имеет смысл только при `referenceSurface:"content-hug"`.
   */
  referencePlacement: z.strictObject({
    x: z.number().int().min(0).max(8192),
    y: z.number().int().min(0).max(8192),
  }).optional(),
  /**
   * Явный алиас: случай с теми же props, что у цели, снимается один раз и наследует вердикт
   * (D10). Без `aliasOf` дубликат props — отказ `422 duplicate_case_props`, иначе матрица тихо
   * платила бы за одинаковые кадры.
   */
  aliasOf: caseId.optional(),
  /** Координаты случая в измерениях семьи (`dimensions`) — вход coverage и variant family (W5b). */
  dims: z.record(dimensionName, dimensionValue).optional(),
  /**
   * Содержимое слотов случая (§A1). Строго `.optional()` **без** `.default()` (C6/C25, тот же
   * инвариант, что у `cropLineage.sourceSurface`): `caseSetIdOf` хэширует `parsed.data`, и любой
   * zod-дефолт сменил бы контентный адрес **всех** уже опубликованных манифестов.
   */
  slotBindings: caseSetSlotBindingsSchema.optional(),
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
export type CaseSetSlotChild = z.infer<typeof caseSetSlotChildSchema>;
export type CaseSetSlotBindings = z.infer<typeof caseSetSlotBindingsSchema>;
