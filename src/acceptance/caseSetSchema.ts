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
import { CLIP_EXPECTATION, GEOMETRY_SURFACES } from "./surfaces";

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

/** Габариты одной поверхности геометрии (план 2026-08-07 §W1a) — те же единицы, CSS px. */
const surfaceDims = z.strictObject({ width: dimensionPx, height: dimensionPx });

/**
 * Поверхности съёмки набора (план 2026-08-06 §W5 T5c). `"hug"` — историческая (и единственная до
 * волны) семантика: поверхность обжимает компонент. `"viewport"` — поверхность размером
 * `capture.viewport` со stage host'ом, на котором живёт host-примитив `Overlay`.
 */
export const CASE_SURFACES = ["hug", "viewport"] as const;
export type CaseSetSurface = (typeof CASE_SURFACES)[number];

export const caseSetCaptureSchema = z.strictObject({
  viewport: z.strictObject({ width: dimensionPx, height: dimensionPx }),
  /** Плотность пикселей съёмки; по умолчанию 2 (канон `DEFAULT_CASE_SURFACE`). */
  deviceScaleFactor: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  theme: z.enum(["light", "dark"]).optional(),
  /**
   * Поверхность съёмки (план 2026-08-06 §W5 T5c.1, строка 10 фидбэка).
   *
   * `"hug"` (дефолт **у потребителя**, не в схеме — C6/C25: `.default()` сменил бы контентный адрес
   * всех уже опубликованных наборов) — поверхность обжимает компонент, как и до волны.
   * `"viewport"` — внутрь поверхности добавляется узел точного размера `capture.viewport`, на нём
   * монтируется stage host, и host-примитив `Overlay` наконец получает якорь: модалку/шит можно
   * снять и измерить по контентной обёртке, а не по пустой сцене.
   */
  surface: z.enum(CASE_SURFACES).optional(),
});

/**
 * Per-case допуски (RFC §3.4: «per-case допуски приезжают из case-set-манифеста и хешируются в
 * `case_policy_hash`»). Значения потребляют гейты W3 (`allowPaintOverflow`/`expectedClip`) и W5a
 * (`maxRawDiffPct`); в W2 они уже входят в `case_policy_hash`, поэтому смена допуска
 * инвалидирует reuse ровно того случая, которого касается.
 */
export const CASE_POLICY_MAX_SIZE_DELTA_PX = 64;
export const CASE_POLICY_MAX_OVERFLOW_BUDGET_PX = 256;

/**
 * Побочный допуск paint-overflow (план 2026-08-06 §W3, строка 6 фидбэка): «столько краски за
 * контуром по этой стороне — это дизайн». Стороны опциональны, но объявить нужно хотя бы одну:
 * пустой объект — это не «бюджет ноль», а забытое намерение, и молча принимать его нельзя.
 * Неназванная сторона имеет бюджет 0 — декларация точечна по построению.
 */
const overflowBudgetPx = z.strictObject({
  top: z.number().int().min(0).max(CASE_POLICY_MAX_OVERFLOW_BUDGET_PX).optional(),
  right: z.number().int().min(0).max(CASE_POLICY_MAX_OVERFLOW_BUDGET_PX).optional(),
  bottom: z.number().int().min(0).max(CASE_POLICY_MAX_OVERFLOW_BUDGET_PX).optional(),
  left: z.number().int().min(0).max(CASE_POLICY_MAX_OVERFLOW_BUDGET_PX).optional(),
}).refine((value) => Object.keys(value).length > 0, "declare at least one side");

export const caseSetCasePolicySchema = z.strictObject({
  maxRawDiffPct: z.number().min(0).max(100).optional(),
  allowPaintOverflow: z.boolean().optional(),
  expectedClip: z.boolean().optional(),
  /**
   * Per-case допуск |Δw|,|Δh| к `expectedGeometry`, CSS px (W3, строка 8 фидбэка). Побеждает
   * профильный `policy.geometry.sizeDeltaPx`: профиль задаёт норму семьи, случай — исключение,
   * и наоборот быть не может. Имя — по существующей семантике `sizeDeltaPx`, а не «tolerancePx»
   * (последнее уже занято per-side смыслом в `policy.geometry.overflowPx`).
   */
  sizeDeltaPx: z.number().int().min(0).max(CASE_POLICY_MAX_SIZE_DELTA_PX).optional(),
  /**
   * Декларативный бюджет paint-overflow по сторонам (W3, строка 6). Overflow стороны в пределах
   * бюджета не блокирует вердикт; за бюджетом — блокирует ровно как раньше. Вердикт-класс
   * (`paint-overflow-*`) при этом **сохраняется в фактах**: бюджет — про «блокирует ли», а не про
   * «было ли». Вместе с `allowPaintOverflow` не объявляется (422 `case_policy_conflict`): «всё
   * можно» и «можно вот столько» — два разных намерения, и молча выбирать одно из них нельзя.
   */
  overflowBudgetPx: overflowBudgetPx.optional(),
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
 * 2. **Глубина ограничена, но больше не единицей** (план 2026-08-06 §W6). Ребёнок сам несёт
 *    опциональные `slotBindings`, поэтому «Lead Block с кнопкой внутри вложенного слота» выразим.
 *    Потолки — `CASE_SET_MAX_SLOT_DEPTH` уровней от корня случая и `CASE_SET_MAX_SLOT_NODES` узлов
 *    на случай; оба проверяет **сервер** (`slot_depth_exceeded`/`slot_nodes_exceeded`), а не схема:
 *    рекурсивный `z.lazy` даёт форму, а осмысленное сообщение с адресом узла — только обход.
 * 3. **Ключ `default` легален** (§A2a): дефолтный слот в этой кодовой базе неявный
 *    (`runtimeSpec.ts` — `slotOf(child) ?? "default"`), компоненты его не объявляют, и без него
 *    карусель из 9 детей осталась бы невыразимой. Проверки принадлежности `extracted.meta.slots` и
 *    гейт `capabilities.namedSlots` его не касаются — они про **именованные** ключи.
 */
export const CASE_SET_MAX_SLOT_CHILDREN = 12;
export const CASE_SET_MAX_SLOTS_PER_CASE = 8;
/**
 * Глубина дерева слотов, **уровнями от корня случая** (план 2026-08-06 §W6): дети случая — уровень
 * 1, их дети — 2, и так до `CASE_SET_MAX_SLOT_DEPTH`. Смысл прежних лимитов не меняется:
 * `CASE_SET_MAX_SLOT_CHILDREN` остаётся потолком **одного слота** на любом уровне, а
 * `CASE_SET_MAX_SLOTS_PER_CASE` — числом слотов одного узла.
 */
export const CASE_SET_MAX_SLOT_DEPTH = 3;
/**
 * Тотал узлов дерева слотов **на случай**. Значение равно сегодняшнему максимуму плоского случая
 * (8 слотов × 12 детей = 96), поэтому проверка строго `≤`: широкий манифест, легальный до этой
 * волны, обязан остаться легальным (триаж V13).
 */
export const CASE_SET_MAX_SLOT_NODES = CASE_SET_MAX_SLOTS_PER_CASE * CASE_SET_MAX_SLOT_CHILDREN;
/** Неявный слот `children`; в манифесте он именуется явно, в дереве съёмки — отсутствием `slot`. */
export const DEFAULT_SLOT_KEY = "default";
/** Тот же charset, что у `definition.slots` (`routes/meta.ts` JSON-схема компонента). */
export const SLOT_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const slotKey = z.string().max(32).regex(SLOT_KEY_PATTERN, "slot key must match ^[a-z0-9]+(?:-[a-z0-9]+)*$");

/**
 * **Candidate dependency overlay** (план `docs/plans/2026-08-07-migration-feedback-wave.md` §1.2,
 * ретроспектива миграции P0.3).
 *
 * До этой волны первая публикация связки «родитель + его новые дети» была невыразима: слот-ребёнок
 * адресуется парой `{type, version}`, то есть **опубликованной** версией, и лист приходилось
 * публиковать до приёмки родителя — ровно та «преждевременная публикация», которую ретроспектива
 * назвала главным дефектом миграции. Overlay объявляет карту `componentId → candidateId`: узел
 * графа, который ещё не опубликован ни разу, но у которого есть валидированный кандидат.
 *
 * Три инварианта именно схемы:
 *
 * 1. **`.optional()` без `.default()`** (C6/C25): `caseSetIdOf` хэширует `parsed.data`, и любой
 *    zod-дефолт сменил бы контентный адрес всех уже опубликованных манифестов.
 * 2. **Карта, а не список.** Ключ — `componentId`, поэтому «два кандидата на один компонент»
 *    невыразимо по построению; обратная коллизия (один `candidateId` у двух компонентов) —
 *    доменный отказ сервера `422 candidate_overlay_duplicate`.
 * 3. **Потолок судит сервер** (`422 candidate_overlay_limit`), а не `.refine()`: отказ обязан
 *    называть код, по которому агент отличит «слишком большой граф» от «манифест не разобрался».
 *
 * Имя поля **не коллидирует** с `CaptureExpected.candidateOverlay` прототипного пути
 * (`src/capture/protocol.ts`): там это эхо swap'а **опубликованных** пинов ревизии прототипа,
 * здесь — декларация неопубликованных зависимостей случая. Разные типы, разные неймспейсы,
 * пересечения кода нет (отмечено в `docs/server-api.md`).
 */
export const CASE_SET_MAX_OVERLAY_NODES = 8;

/** Формат `candidate_id` (`server/acceptance/ids.ts#CANDIDATE_ID_PATTERN`, продублирован: `src/` не импортирует `server/`). */
export const CANDIDATE_ID_PATTERN = /^cand_[0-9a-f]{64}$/;

/**
 * Ребёнок слота. Тип объявлен **вручную**: `z.strictObject` + `z.lazy` теряет инференс на цикле,
 * и экспортируемый тип обязан быть читаемым, а не `any` (триаж V13; прецедент рекурсивной схемы с
 * явной аннотацией — `server/contracts.ts` `z.lazy` c `z.ZodType`).
 *
 * Две формы (волна 2026-08-07 §W3): **пин** (`{type, version}`) — опубликованный ребёнок, и
 * **overlay** (`{overlay: "<componentId>"}`) — ребёнок, взятый из кандидата, объявленного
 * `candidateOverlay` манифеста. У overlay-формы `props` те же, что у обычного ребёнка (без них
 * зависимость была бы вставима только пустой — N4/N5), а версии нет вовсе: кандидат не
 * опубликован, и придумывать ему номер значило бы врать в `slotsHash`.
 */
export interface CaseSetSlotChildPin {
  type: string;
  version: number;
  props?: Record<string, unknown>;
  /** Собственные слоты ребёнка (план 2026-08-06 §W6). Строго `.optional()` без `.default()`. */
  slotBindings?: CaseSetSlotBindings;
}
export interface CaseSetSlotChildOverlay {
  /** `components.id` узла overlay: адресация по id, а не по имени — кандидат публикации не имеет. */
  overlay: string;
  props?: Record<string, unknown>;
  slotBindings?: CaseSetSlotBindings;
}
export type CaseSetSlotChild = CaseSetSlotChildPin | CaseSetSlotChildOverlay;
export type CaseSetSlotBindings = Record<string, CaseSetSlotChild[]>;

/** Дискриминатор форм ребёнка: наличие ключа `overlay` (обе формы — strict-объекты). */
export const isOverlaySlotChild = (child: CaseSetSlotChild): child is CaseSetSlotChildOverlay =>
  (child as CaseSetSlotChildOverlay).overlay !== undefined;

export const caseSetSlotChildSchema: z.ZodType<CaseSetSlotChild> = z.lazy(() => z.union([
  z.strictObject({
    /** Имя опубликованного компонента (`components.name` уникально глобально и не переименовывается). */
    type: z.string().min(1).max(64),
    /** Точный пин версии: обязателен по построению (см. инвариант 1). */
    version: z.number().int().positive(),
    props: z.record(z.string(), z.unknown()).optional(),
    /**
     * Вложенные слоты (§W6). Тот же самый набор ограничений формы, что и у корня случая; глубину и
     * тотал узлов судит сервер, потому что осмысленный отказ обязан назвать путь до узла.
     */
    slotBindings: caseSetSlotBindingsSchema.optional(),
  }),
  z.strictObject({
    /** Узел overlay: `componentId`, обязанный присутствовать ключом в `candidateOverlay` (§W3). */
    overlay: z.string().min(1).max(64),
    props: z.record(z.string(), z.unknown()).optional(),
    slotBindings: caseSetSlotBindingsSchema.optional(),
  }),
]));

export const caseSetSlotBindingsSchema: z.ZodType<CaseSetSlotBindings> = z.lazy(() => z
  .record(slotKey, z.array(caseSetSlotChildSchema).min(1).max(CASE_SET_MAX_SLOT_CHILDREN))
  .refine((value) => Object.keys(value).length <= CASE_SET_MAX_SLOTS_PER_CASE,
    `at most ${CASE_SET_MAX_SLOTS_PER_CASE} slots per node`));

/**
 * **Matte сравнения** (план 2026-08-06 §W4 T4a, строка 7 фидбэка).
 *
 * Капчур остаётся прозрачным (`omitBackground:true` — кадровый слой, его этот контракт не
 * трогает вовсе). Matte — декларация **сравнения**: «прежде чем мерить расхождение, положи обе
 * картинки на этот цвет». Она закрывает случай «эталон экспортирован из Figma поверх белого, а
 * кандидат снят прозрачным»: без matte каждый полупрозрачный пиксель эталона расходится с
 * кандидатом по альфе, и вердикт говорит о фоне, а не о компоненте.
 *
 * `"none"` — явное «не матировать», то же, что отсутствие поля (дефолт применяет **потребитель**,
 * `scripts/visual-diff-worker.mjs`, а не схема — C6/C25: `caseSetIdOf` хэширует `parsed.data`, и
 * zod-дефолт сменил бы контентный адрес всех уже опубликованных манифестов).
 */
export const COMPARISON_MATTE_PATTERN = /^#[0-9a-fA-F]{6}$/;

export const caseSetComparisonSchema = z.strictObject({
  matte: z.union([
    z.literal("none"),
    z.string().regex(COMPARISON_MATTE_PATTERN, "matte must be \"none\" or a #RRGGBB colour"),
  ]).optional(),
});

/**
 * **Именованные пресеты бюджета растрового текста** (план 2026-08-06 §1.2/§W4 T4b, строка 5
 * фидбэка «Timer»).
 *
 * Поле объявляет **имя** профиля, а не числа: эталон приёмки — Figma-ассет, у него нет renderer
 * fingerprint, поэтому «один шрифтовой стек на паре PNG ↔ живой капчур» недостижим, и остаётся
 * вторая ветка фидбэка — документированный scoped profile. Пороги (`maxRawDiffPct` и
 * `minEdgeResidualPct`) владеет **сервер** (`server/acceptance/gates/visual.ts`): свободные числа
 * в манифесте отняли бы у пресета его единственный смысл — официальность. Тюнинг порогов = новый
 * пресет `live-text-v2`, а не другое число под тем же именем.
 */
export const TEXT_AA_BUDGETS = ["live-text-v1"] as const;
export type TextAaBudget = (typeof TEXT_AA_BUDGETS)[number];

/**
 * **Поле краски случая по сторонам** (план `docs/plans/2026-08-08-blocker-removal-eui-br.md` §2,
 * EUI-BR-02, capability `paintCapturePaddingV1`).
 *
 * До этой волны поле было **скаляром** (`padding: 64px` со всех сторон, `src/capture/CaptureComponent.tsx`),
 * и компонент с декором, уезжающим вправо на 55 px, приходилось снимать либо с симметричным полем в
 * 4 раза больше нужного, либо с обрезанной краской (`ink clamp` ⇒ вечный `indeterminate`).
 *
 * Три инварианта именно схемы:
 *
 * 1. **Поле — per-case, а не `capture`-блок набора** (триаж раунда 2, M1). Значение в `capture`
 *    двигало бы кадр **всех** случаев набора, нарушая AC фидбэка «recapture только затронутых
 *    cases»; per-case поле входит во frame-слой ровно того случая, который его объявил.
 * 2. **Стороны обязательны все четыре.** «Забытая сторона = 0» — это не декларация, а опечатка с
 *    пиксельными последствиями: неназванная сторона обрезала бы краску молча.
 * 3. **`.optional()` без `.default()`** (C6/C25, тот же инвариант, что у `cropLineage.sourceSurface`):
 *    `caseSetIdOf` хэширует `parsed.data`, и zod-дефолт сменил бы контентный адрес **всех** уже
 *    опубликованных манифестов.
 *
 * Потолок стороны совпадает с `MAX_PAINT_MARGIN_PX` капчур-сервиса (значение продублировано: `src/`
 * не импортирует `server/`); бюджет кадра `(w+left+right)×(h+top+bottom)×dsf² ≤ 20 Мпикс` судит
 * сервер типизированным `422 capture_budget_exceeded`, а не схема — потолок стороны про форму,
 * бюджет про площадь.
 */
export const CASE_MAX_PAINT_PADDING_PX = 256;

const paintPaddingSide = z.number().int().min(0).max(CASE_MAX_PAINT_PADDING_PX);

/**
 * Потолок hint'а предзагрузки (BR-03). Само поле — **только контракт**: семантику (расширенный
 * барьер ресурсов) поставляет BR-03; здесь оно объявлено, чтобы манифест, написанный под волну,
 * не отвергался strict-схемой, и чтобы слой (`report-only`) был назван до появления потребителя.
 */
export const CASE_SET_MAX_PRELOAD_ASSETS = 64;

/**
 * **Владение геометрией узла** (план `docs/plans/2026-08-08-blocker-removal-eui-br.md` §5,
 * EUI-BR-05, capability `geometryDecorationOwnershipV1`).
 *
 * Диагностика V0-D3 показала четыре маршрута, которыми декоративный хвост тултипа доводил кейс до
 * блокера. Два из них авто-правило замера закрывает само (вложенная в контур pre-transform коробка
 * ⇒ узел прозрачен для `rootBounds` и его краска объяснена). Два оставшихся требуют **декларации**:
 * DOM неоднозначен (коробка не вложена), либо автор объявил `expectedSurfaces` по макету и получил
 * `surface-mismatch` на `paint`, который не снимается ни одним допуском.
 *
 * Форма ключа — `"<elementKey>"` либо `"<elementKey>//<суффикс elementPath>"`. Одного `elementKey`
 * мало по построению: внутренние узлы компонента собственного маркера не имеют и наследуют ключ
 * ближайшего (`ownerKey`, `src/capture/geometry.mjs`), поэтому у тултипа и пузырь, и хвост — оба
 * `pay-tooltip`. Суффикс сравнивается с **хвостом** `elementPath` (`div.bubble>i.tail`), а не
 * целиком: полный путь зависит от обёрток поверхности съёмки и ломался бы от смены сцены.
 *
 * Инварианты именно схемы:
 *
 * 1. **`role` и `participatesIn` — литералы.** Единственная выразимая декларация: «узел —
 *    декорация, участвует только в краске». Свободный набор поверхностей означал бы «участвует в
 *    layout, но не в root», то есть четвёртый способ соврать про габариты.
 * 2. **`.optional()` без `.default()`** (C6/C25, тот же инвариант, что у `paintPaddingPx`):
 *    `caseSetIdOf` хэширует `parsed.data`, и zod-дефолт сменил бы контентный адрес **всех** уже
 *    опубликованных манифестов.
 * 3. **Злоупотребление судит сервер, а не схема.** Метка на in-flow контейнере с layout-детьми —
 *    `422 geometry_ownership_invalid` гейта `audit` **по фактам замера**: схема про форму ключа,
 *    а «этот узел на самом деле держит раскладку» — утверждение о снятом кадре.
 */
export const CASE_SET_MAX_GEOMETRY_OWNERSHIP = 16;
export const GEOMETRY_OWNERSHIP_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,64}(?:\/\/[A-Za-z0-9._:#>[\]()-]{1,192})?$/;

export const caseSetGeometryOwnershipSchema = z.record(
  z.string().regex(GEOMETRY_OWNERSHIP_KEY_PATTERN, "must be \"<elementKey>\" or \"<elementKey>//<elementPath suffix>\""),
  z.strictObject({
    role: z.literal("decoration"),
    participatesIn: z.tuple([z.literal("paint")]),
  }),
).refine((value) => Object.keys(value).length > 0, "declare at least one node")
  .refine((value) => Object.keys(value).length <= CASE_SET_MAX_GEOMETRY_OWNERSHIP,
    `at most ${CASE_SET_MAX_GEOMETRY_OWNERSHIP} declared nodes per case`);

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
  /**
   * **Четыре поверхности геометрии** (план 2026-08-07 §W1a, ретроспектива миграции P0.1). Все —
   * CSS px, все `.optional()` **без** `.default()` (C6/C25: `caseSetIdOf` хэширует `parsed.data`).
   *
   * - `root` — border-box самого корневого бокса компонента (343×88 головного кейса);
   * - `layoutUnion` — union in-flow потомков, то есть ровно то, что означал `expectedGeometry`
   *   (480×88 при одной ширине поля, 558×88 при другой);
   * - `paint` — ink-bbox краски;
   * - `referenceExport` — габариты экспорта из Figma (367×88), нормализованные из device px ассета.
   *
   * Пустой объект — не «поверхностей нет», а забытое намерение: объявить нужно хотя бы одну.
   * Вместе с `expectedGeometry` не объявляется (`422 case_surface_conflict`): последнее — легаси-
   * написание `expectedSurfaces.layoutUnion`, и молча выбирать одно из двух чисел сервер не вправе.
   */
  expectedSurfaces: z.strictObject({
    root: surfaceDims.optional(),
    layoutUnion: surfaceDims.optional(),
    paint: surfaceDims.optional(),
    referenceExport: surfaceDims.optional(),
  }).refine((value) => Object.keys(value).length > 0, "declare at least one surface").optional(),
  /**
   * Поверхность, **в координатах которой** строится каноническая канва визуального сравнения.
   * Опущено — `layoutUnion`, то есть сегодняшнее поведение (дефолт применяет потребитель,
   * `server/acceptance/gates/visual.ts`, а не схема). Названная поверхность обязана быть объявлена
   * (`422 case_comparison_surface_undeclared`) — иначе канва строилась бы наугад.
   */
  comparisonSurface: z.enum(GEOMETRY_SURFACES).optional(),
  /**
   * «Корень не режет layout»: union потомков **может** превышать `root`, если по пути нет
   * эффективного клипа. Единственное значение — вариант «root-clips-layout» снят вместе со
   * сценарием. Требует объявленного `expectedSurfaces.root` (`422 case_clip_expectation_requires_root`).
   */
  clipExpectation: z.literal(CLIP_EXPECTATION).optional(),
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
  /**
   * Декларативный контракт **сравнения** случая (§W4 T4a). Уровень кейса, а не `policy.perCase`:
   * matte меняет входы диффа, а не порог вердикта, — это слой `comparison`, и его смена честно
   * даёт re-diff сохранённого кадра без пересъёмки.
   */
  comparison: caseSetComparisonSchema.optional(),
  /**
   * Именованный пресет бюджета растрового текста (§W4 T4b). Тоже уровень кейса и тоже слой
   * `comparison` (плюс `verdict`): пресет требует `edgeResidual`, которого в доволновых метриках
   * нет вовсе, поэтому его появление обязано пересчитаться через re-diff, а не через recompute по
   * сохранённым числам.
   */
  textAaBudget: z.enum(TEXT_AA_BUDGETS).optional(),
  /**
   * Поле краски случая по сторонам (BR-02, см. `CASE_MAX_PAINT_PADDING_PX`). Кадровый слой: смена
   * поля меняет сами пиксели кадра, поэтому она обязана давать пересъёмку **этого** случая — и
   * ничьего больше. Канву сравнения поле **не** двигает (блокер B3 раунда 2): comparison margin
   * остаётся comparison-owned, а кандидатский растр приводится к канве сравнения перед диффом.
   */
  paintPaddingPx: z.strictObject({
    top: paintPaddingSide,
    right: paintPaddingSide,
    bottom: paintPaddingSide,
    left: paintPaddingSide,
  }).optional(),
  /**
   * Hint предзагрузки ассетов случая (BR-03, `preloadAssets`). **Слой `report-only`**: hint не
   * освобождает сервер от обнаружения ресурсов, поэтому он не входит ни в один отпечаток — иначе
   * подсказка автора меняла бы кадр, ничего не меняя на пикселях.
   */
  preloadAssets: z.array(z.string()).max(CASE_SET_MAX_PRELOAD_ASSETS).optional(),
  /**
   * Владение геометрией узлов случая (BR-05, см. `caseSetGeometryOwnershipSchema`). Слой —
   * **`frame` + `verdict`**: декларация меняет и съёмочную интерпретацию (объявленный узел
   * перестаёт быть кандидатом в корень и выпадает из сверки поверхностей), и вердикт (краска узла
   * перестаёт блокировать). Отсутствие поля — старые отпечатки байт-в-байт (условный спред).
   */
  geometryOwnership: caseSetGeometryOwnershipSchema.optional(),
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
  /**
   * Карта неопубликованных зависимостей графа (§W3): `componentId → candidateId`. Каждый узел
   * обязан быть **задействован** деревом случая (голова рана + `slotBindings`), иначе
   * `422 candidate_overlay_unused`: молча принятый лишний узел сдвинул бы `frameFingerprint`
   * всех случаев набора без единого эффекта на пикселях.
   */
  candidateOverlay: z.record(
    z.string().min(1).max(64),
    z.string().regex(CANDIDATE_ID_PATTERN, "must be a candidate id (cand_<sha256>)"),
  ).optional(),
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
export type CaseSetComparison = z.infer<typeof caseSetComparisonSchema>;
export type CaseSetGeometryOwnership = z.infer<typeof caseSetGeometryOwnershipSchema>;
// `CaseSetSlotChild`/`CaseSetSlotBindings` объявлены выше вручную: рекурсивная схема (`z.lazy`)
// инференс не переживает, а экспортируемый тип обязан оставаться читаемым.
