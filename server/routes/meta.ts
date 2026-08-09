import { readFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { prototypeActionSchemas } from "../../src/catalog/actions";
import { atomicLevels } from "../../src/designSystems/types";
import { COMPONENT_SCOPES } from "../../src/designSystems/scope";
import { layoutSpacingProps, spaceTokens } from "../../src/designSystems/types";
import { resolveSpacingScale } from "../../src/designSystems/spacingScale";
import {
  inputPrototypeDocSchema,
  ASSET_ID_PATTERN,
  COMPUTED_ENTRIES_LIMIT,
  COMPUTED_FIELDS_LIMIT,
  COMPUTED_OPS,
  COMPUTED_TERMS_LIMIT,
  FLOWS_LIMIT,
  FLOW_STEPS_LIMIT,
  FLOW_TOTAL_STEPS_LIMIT,
  FLOW_DEPTH_LIMIT,
  SURFACES_LIMIT,
} from "../../src/prototype/schema";
import { surfacesWriteEnabled } from "./prototypes";
import { compositionV3WriteEnabled } from "./compositions";
import { ELEMENTS_PER_SCREEN_LIMIT, REPEAT_ELEMENT_LIMIT, REPEAT_RENDER_COST_BUDGET, TREE_DEPTH_LIMIT } from "../../src/prototype/validate";
import { MAX_ASSET_BYTES } from "../assets/validate";
import { listActiveDesignSystems } from "../designSystems";
import { getLatestDesignSystemContent } from "../designSystems";
import { ApiError, json, MAX_JSON_BODY_BYTES, noStore } from "../http";
import { GEOMETRY_RECT_LIMIT, MAX_PAINT_MARGIN_PX, MAX_QUEUE } from "../screenshot/service";
import { rendererReport } from "../capture/renderer";
import { DEFAULT_REUSE_GATE_MODE, type ReuseGateMode } from "../catalog/gate";
import { CALIBRATED_POLICY } from "../catalog/policy";
import { VALIDATE_GLOBAL_CONCURRENT, VALIDATE_USER_CONCURRENT } from "../components/validate";
import { CANDIDATE_CACHE_MAX_BYTES, CANDIDATE_CACHE_TTL_MS } from "../components/candidates";
import {
  ACCEPTANCE_POLICIES, DEFAULT_ACCEPTANCE_POLICY_ID, PROMOTION_POLICY_PROFILES, acceptanceCaseTtlHours,
  acceptanceMaxCasesPerRun, evidenceMaxBytes,
} from "../acceptance/policies";
import {
  CASE_SET_MANIFEST_VERSION, CASE_SET_MAX_CASES, CASE_SET_MAX_DIMENSION_VALUES, CASE_SET_MAX_DIMENSIONS,
  CASE_SET_MAX_EXPECTED_TUPLES, CASE_SET_MAX_OVERLAY_NODES, CASE_SET_MAX_SLOTS_PER_CASE, CASE_SET_MAX_SLOT_CHILDREN,
  CASE_SET_MAX_SLOT_DEPTH, CASE_SET_MAX_SLOT_NODES,
  CASE_POLICY_MAX_OVERFLOW_BUDGET_PX, CASE_POLICY_MAX_SIZE_DELTA_PX, CASE_SET_MAX_PRELOAD_ASSETS,
} from "../../src/acceptance/caseSetSchema";
import { GEOMETRY_SURFACES } from "../../src/acceptance/surfaces";
import { candidateOverlayEnabled } from "../acceptance/caseSets";
import { acceptanceResumeEnabled } from "../acceptance/orchestrator";
import { blockerFingerprintEnabled } from "../acceptance/disposition";
import { geometrySurfacesEnabled } from "../acceptance/gates/geometry2";
import { suggestedPolicyEnabled } from "../acceptance/suggest";
import { CAPTURE_FRAME_BUDGET_MPX, captureV4Enabled } from "../capture/captureV4";
import { RESOURCE_BARRIER_DISABLED, resourceBarrierPolicyVersion, resourceBarrierV4Enabled } from "../capture/resourceBarrier";
import { LEGACY_PROTOTYPE_SCHEMA_RESOLVER_VERSION, PROTOTYPE_SCHEMA_RESOLVER_VERSION, schemaResolverV2Enabled } from "../validation";
import { RESOURCE_BARRIER_MAX_BUDGET_MS, RESOURCE_BARRIER_MAX_RESOURCES } from "../../src/capture/readinessPolicy";
import { runtimeDefaultsDisabled } from "../components/runtimeDefaults";
import { GEOMETRY_CONTRACT_VERSION } from "../../src/capture/geometry.mjs";
import { TEXT_AA_PRESETS } from "../acceptance/gates/visual";
import { prototypeCandidateOverlayMax } from "./screenshots";
import { impactedSnapEnabled, SNAP_PLAN_MAX_SCREENS } from "../prototypes/screenFrames";
import { MIGRATION_COMMIT_PHASE_TIMEOUT_MS, migrationCommitEnabled } from "../migration/commit";
import { SOURCE_PACKAGE_MAX_EXPORTS, sourcePackageEnabled } from "../figma/sourcePackage";

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

/**
 * Фаза reuse-гейта — часть discovery, а не деталь деплоя (план 2026-07-31 §3.5/§5, T9).
 *
 * Агент обязан узнать **до** `POST /api/components`, обязателен ли `intent` и будет ли
 * совпадение блокировать создание: в `shadow` тот же запрос без `intent` проходит с
 * предупреждением, в `enforce` — падает с `400 invalid_request`. Без этого поля единственный
 * способ выяснить фазу — сломать собственный create.
 *
 * Режим **не читается из env здесь**: он приезжает параметром из `HandlerOptions`
 * (`server/main.ts` резолвит `REUSE_GATE` ровно один раз, на входе процесса). Повторное чтение
 * env внутри роута сделало бы discovery и гейт двумя источниками истины, а тесты в общем
 * процессе `bun test` мутировали бы друг другу глобальный env.
 */
export function capabilities(db: Database, reuseGateMode: ReuseGateMode = DEFAULT_REUSE_GATE_MODE, options: { validateDisabled?: boolean; acceptanceDisabled?: boolean; spacingResolverV2Disabled?: boolean; acceptanceMatrix?: boolean } = {}): JsonObject {
  const systems = listActiveDesignSystems(db);
  return {
    apiVersion: 1,
    documentVersion: 1,
    layoutContractVersion: 1,
    actions: Object.keys(prototypeActionSchemas),
    directives: [...CAPABILITY_DIRECTIVES],
    paramSources: [...CAPABILITY_PARAM_SOURCES],
    conditions: [...CAPABILITY_CONDITIONS],
    // Закрытый набор операций `doc.computed` (план 2026-08-02, D2/D12). Импорт из места
    // энфорса (`src/prototype/schema`), чтобы discovery не разъезжалось со схемой.
    computedOps: [...COMPUTED_OPS],
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
      // Глубина дерева сценариев (`flow.parentId`); корень считается уровнем 1.
      flowDepth: FLOW_DEPTH_LIMIT,
      compositionDepth: 5,
      // P8: троттлинг и гигиена validate-префлайта — публикуются, чтобы агент до вызова
      // знал про 429 и про срок жизни candidate-кэша.
      validateUserConcurrent: VALIDATE_USER_CONCURRENT,
      validateGlobalConcurrent: VALIDATE_GLOBAL_CONCURRENT,
      validateCacheTtlHours: CANDIDATE_CACHE_TTL_MS / (60 * 60 * 1000),
      validateCacheMiB: CANDIDATE_CACHE_MAX_BYTES / (1024 * 1024),
      // `doc.computed`: записей в объекте, полей в `sumProduct`, термов в `add`.
      computedEntries: COMPUTED_ENTRIES_LIMIT,
      computedFields: COMPUTED_FIELDS_LIMIT,
      computedTerms: COMPUTED_TERMS_LIMIT,
      // Матричная приёмка (план 2026-08-03 §5 W1a): ёмкость одного рана, TTL кэша случаев и
      // потолок байт evidence. Агент планирует набор до постановки, а не ловит 422 постфактум.
      acceptanceMaxCasesPerRun,
      acceptanceMaxJobsPerRun: ACCEPTANCE_POLICIES[DEFAULT_ACCEPTANCE_POLICY_ID].maxJobsPerRun,
      acceptanceCaseTtlHours,
      evidenceMaxBytes,
      // Case-set-манифест (план 2026-08-04 §W6, P1-7): все потолки, которые может нарушить
      // манифест семьи, — здесь, а не в чужой голове. `caseSetMaxDimensionValues` ≥
      // `acceptanceMaxCasesPerRun` by design: ось, которая **уже** не помещается в ран, не должна
      // дополнительно упираться в лимит схемы (ровно это шардировало семью из 49 состояний).
      // `caseSetMaxExpectedTuples` — потолок декартова произведения `dimensions` (C5/C16):
      // произведение считается перемножением длин до материализации, превышение — 422
      // `case_set_coverage_too_large`.
      caseSetMaxCases: CASE_SET_MAX_CASES,
      caseSetMaxDimensions: CASE_SET_MAX_DIMENSIONS,
      caseSetMaxDimensionValues: CASE_SET_MAX_DIMENSION_VALUES,
      caseSetMaxExpectedTuples: CASE_SET_MAX_EXPECTED_TUPLES,
      caseSetManifestVersion: CASE_SET_MANIFEST_VERSION,
      // Слот-биндинги случая (план 2026-08-05 §A1/§A9): детей на один слот и слотов на случай.
      // Потолок детей выведен из продуктового требования (карусель способов оплаты — 9 детей),
      // а не из круглого числа; кардинальность слота **не** валидируется сервером (это свойство
      // компонента, а не набора), поэтому лимит схемы — единственный объявленный потолок.
      caseSetMaxSlotChildren: CASE_SET_MAX_SLOT_CHILDREN,
      caseSetMaxSlotsPerCase: CASE_SET_MAX_SLOTS_PER_CASE,
      // Вложенные слоты (план 2026-08-06 §W6): уровней от корня случая и узлов на случай целиком.
      // Смысл двух лимитов выше не меняется — `caseSetMaxSlotChildren` остаётся потолком одного
      // слота на любом уровне, а тотал 96 равен прежнему максимуму 8×12, поэтому граничный
      // плоский манифест остаётся валидным.
      caseSetMaxSlotDepth: CASE_SET_MAX_SLOT_DEPTH,
      caseSetMaxSlotNodes: CASE_SET_MAX_SLOT_NODES,
      // Per-case вердиктные допуски (план 2026-08-06 §W3): потолки схемы, драйвер читает их
      // отсюда (фолбэк на локальные дефолты в старых сборках).
      caseSetMaxCaseSizeDeltaPx: CASE_POLICY_MAX_SIZE_DELTA_PX,
      caseSetMaxCaseOverflowBudgetPx: CASE_POLICY_MAX_OVERFLOW_BUDGET_PX,
      // Подмен кандидатов на один прототипный кадр (§B1): overlay — точечная проверка ревизии
      // уже опубликованного компонента в композиции, а не способ собрать кадр из черновиков.
      prototypeCandidateOverlayMax,
      // Узлов candidate dependency overlay в одном case-set-манифесте (план 2026-08-07 §W3).
      // Не путать с `prototypeCandidateOverlayMax`: тот про **swap опубликованных** пинов
      // прототипного кадра, этот — про неопубликованные зависимости приёмочного графа.
      caseSetMaxOverlayNodes: CASE_SET_MAX_OVERLAY_NODES,
      // Экранов в одном плане импакт-съёмки (план 2026-08-07 §W5). Потолок объявлен, потому что
      // план стоит раскрытия композиций и резолва темы на каждый экран; 256 — с шестикратным
      // запасом к крупнейшей известной галерее миграции YP v2 (43 экрана).
      snapPlanMaxScreens: SNAP_PLAN_MAX_SCREENS,
      // Потолок жизни одной фазы саги миграционного коммита (план 2026-08-07 §W4). Периодических
      // таймеров в сервере нет: фаза, простоявшая дольше, переводится в `needs-<фаза>` sweep'ом на
      // старте процесса и на каждом запросе к `/api/migration-commits*`. Драйвер-poller обязан
      // знать этот срок, чтобы отличать «фаза ещё идёт» от «сага зависла».
      migrationCommitPhaseTimeoutMs: MIGRATION_COMMIT_PHASE_TIMEOUT_MS,
      // Экспортов в одном пакете исходников Figma (план 2026-08-07 §W8). Пакет — это манифест, а
      // не байты (экспорты ссылаются на реестр ассетов), но каждый экспорт стоит сверки dims/SHA
      // против реестра, поэтому потолок объявлен, а не выведен из размера тела.
      sourcePackageMaxExports: SOURCE_PACKAGE_MAX_EXPORTS,
      // Барьер ресурсов (план 2026-08-07 §W2/§1.5): потолок манифеста одной страницы и **суммарный**
      // бюджет фазы. Публикуются вместе, потому что отвечают на разные вопросы автора: 256 —
      // когда кадр отвергнут `resource_manifest_overflow` (страница с data-URI-ковром), 8000 —
      // сколько барьер имеет права стоить, прежде чем поднимет `resource_barrier_timeout` (и
      // почему это меньше `JOB_DEADLINE_MS`: типизированный отказ обязан доехать наружу).
      // Оба числа — свойство политики v3, поэтому объявлены **независимо** от kill-switch'а:
      // выключенный барьер меняет версию политики (`acceptance.readinessPolicyVersion`), а не
      // потолки, которыми он исполняется.
      // Поле краски по сторонам (BR-02, план 2026-08-08 §2): потолок **одной стороны** (тот же, что
      // у скалярного `paintMargin`) и бюджет площади кадра `(w+left+right)×(h+top+bottom)×dsf²`.
      // Два числа отвечают на разные вопросы автора: первое — «сколько можно объявить по стороне»,
      // второе — «почему 256 по кругу при dsf 3 отвергнуто» (`422 capture_budget_exceeded`).
      captureMaxPaintPaddingPx: MAX_PAINT_MARGIN_PX,
      captureFrameBudgetMpx: CAPTURE_FRAME_BUDGET_MPX,
      // Hint предзагрузки ассетов случая (BR-03): потолок массива `cases[].preloadAssets`.
      caseSetMaxPreloadAssets: CASE_SET_MAX_PRELOAD_ASSETS,
      resourceBarrierMaxResources: RESOURCE_BARRIER_MAX_RESOURCES,
      resourceBarrierBudgetMs: RESOURCE_BARRIER_MAX_BUDGET_MS,
      // `doc.surfaces`: сколько поверхностей несёт документ (v1 — ровно две).
      // Импорт из места энфорса (`src/prototype/schema`), канон docs/server-api.md#capabilities.
      surfaces: SURFACES_LIMIT,
    },
    designSystems: systems.map((system) => system.id),
    resolvedSpaceScales: Object.fromEntries(systems.map((system) => {
      const theme = getLatestDesignSystemContent(db, system.id);
      // Резолвер — свойство самой версии темы (миграция v23): discovery обязан показывать ту же
      // шкалу, что применит рендер, а не результат текущего дефолта.
      return [system.id, resolveSpacingScale(system.id, theme.tokens, theme.spacingResolver)];
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
      componentReuseGate: true,
      compositionV2: true,
      catalogMigration: true,
      // Kill-switch P8: env резолвится один раз на входе процесса (`startServer`), флаг
      // приезжает сюда параметром — как и reuseGateMode, env из роута не перечитывается.
      componentValidate: options.validateDisabled !== true,
      // P1b: geometry-probe компонентной поверхности и draft-preview head-ревизии.
      // Draft-preview гаснет тем же kill-switch'ем P8: постановка джобы собирает candidate-bundle.
      componentGeometry: true,
      // W3: геометрия 2.0 — `probe:"paint"` на candidate-пути приёмки и боевой гейт `geometry`
      // (layout/paint/overflow с названными источниками).
      geometryPaint: true,
      // W4: readiness капчура — декларативная политика + доказательство (`themeResources` — вход
      // импакт-анализа W6) + обязательный гейт `readiness` в обоих профилях приёмки.
      captureReadiness: true,
      componentDraftPreview: options.validateDisabled !== true,
      // P2 (план 2026-08-02): `track: "head"` в lifecycle-роуте — служебный прототип
      // резолвит компонентные пины на последние active-публикации без пересохранения.
      prototypeHeadTracking: true,
      // P9: readiness-отчёт несёт `profile` (product|service).
      readinessProfile: true,
      // P6 (план 2026-08-02): PATCH темы умеет `dryRun` (валидация + дифф + resolvedSpaceScale
      // без записи) и no-op-детекцию (идентичная тема версию не создаёт).
      themeDryRun: true,
      // P6.2: sparse-операции `addTokens`/`addFonts`/`addIcons` поверх baseVersion (appendOnly).
      themeSparseOps: true,
      // P6.3: новые версии темы пишутся с резолвером spacing-шкалы 2 (мердж на базовую шкалу DS
      // + наследование выпавших `space.*`); false при EASYUI_THEME_RESOLVER_V2_DISABLED=1.
      // Существующие версии в любом случае резолвятся своим записанным резолвером.
      themeSpacingResolverV2: options.spacingResolverV2Disabled !== true,
      // RFC candidate-acceptance R1: POST /api/components/:id/promote — приёмка
      // провалидированной head-ревизии одной командой (auto-supersede прочих active).
      // false при EASYUI_ACCEPTANCE_DISABLED=1; publish при этом продолжает работать.
      acceptancePromote: options.acceptanceDisabled !== true,
      // План 2026-08-03 §5 W1a: матричная приёмка кандидата (durable-кандидаты, раны, гейты,
      // evidence). Все три флага — одно и то же `EASYUI_ACCEPTANCE_MATRIX=1`, но разнесены по
      // подсистемам намеренно: W2+ включает case-set'ы и импакт отдельными ручками, и агент
      // должен проверять именно ту, которую собирается звать, а не «приёмку вообще».
      // RFC candidate-acceptance R3a: `PUT /api/components/:id/provenance` — правка ссылки на
      // Figma без новой ревизии и версии. Kill-switch'а нет намеренно: ручка не запускает ни
      // сборок, ни ранов, а её выключение оставило бы агента без единственного способа
      // отредактировать provenance опубликованной версии.
      acceptanceProvenance: true,
      acceptanceMatrix: options.acceptanceMatrix === true,
      acceptanceCandidates: options.acceptanceMatrix === true,
      acceptanceRuns: options.acceptanceMatrix === true,
      // План 2026-08-04 §W6 (C23): `POST /api/components/:id/case-sets/validate` — dry-run
      // манифеста без записи. Отдельный флаг, а не вывод из `acceptanceMatrix`: клиент обязан
      // проверять именно ту ручку, которую зовёт, — старая сборка с включённой матрицей ответит
      // на неё 404, и молчаливый фолбэк на мутирующий PUT был бы худшим из возможных исходов.
      caseSetValidate: options.acceptanceMatrix === true,
      // План 2026-08-04 §W7 (C23): promote принимает `acceptanceRunIds[]` — набор ранов
      // шардированной семьи. Отдельный флаг: старая сборка с включённой матрицей ответит на
      // массив `400 Unknown field: acceptanceRunIds`, и клиент обязан узнать это до мутации, а
      // не по коду ошибки уже отправленного promote.
      acceptanceMultiRunPromote: options.acceptanceMatrix === true,
      // План 2026-08-04 §W8 (C23): `GET /api/acceptance-runs/:runId?view=summary` — компактная
      // сводка рана. Флаг отдельный, потому что деградация тут молчаливая: сервер до этой волны
      // просто игнорирует незнакомый query и отдаёт полный ран на 1800 строк. Клиент обязан и
      // проверить флаг, и убедиться в маркере `view:"summary"` в теле ответа.
      acceptanceSummaryView: options.acceptanceMatrix === true,
      // План 2026-08-05 §A9: case-set-манифест принимает `cases[].slotBindings` — детей именованных
      // и default-слота с точным пином версии. Отдельный флаг по тому же правилу, что и
      // `caseSetValidate`: сборка до этой волны с включённой матрицей отвергнет манифест со
      // `slotBindings` как `422 validation_failed` (strictObject), и клиент обязан узнать это до
      // публикации набора, а не по коду ошибки уже отправленного PUT.
      caseSetSlotBindings: options.acceptanceMatrix === true,
      // План 2026-08-05 §B3: `candidateOverrides` у прототипной съёмки — подмена пина
      // опубликованного компонента бандлом кандидата. Гаснет **двумя** ключами, ровно как ручка
      // (`routes/screenshots.ts`): без матричной приёмки кандидатов не существует, а
      // `EASYUI_VALIDATE_DISABLED` гасит сборку candidate-бандла целиком (аргумент draft-preview).
      prototypeCandidateOverlay: options.acceptanceMatrix === true && options.validateDisabled !== true,
      // План 2026-08-02 (computed-state): top-level `doc.computed` — производные значения
      // стейта, read-only, читаются обычным `$state` по bare-ключу. Набор операций —
      // в `computedOps`, лимиты — в `limits.computed*`.
      computed: true,
      // План 2026-08-02 (multi-surface-flows): формат `doc.surfaces` + `screen.surface` +
      // `step.companions` поддержан кодом — stored-документы с поверхностями читаются всегда.
      surfaces: true,
      // Write-политика той же фичи (kill-switch D16, `EASYUI_SURFACES=1`): false → сохранение
      // документа с `surfaces` отвечает `422 surfaces_disabled`. Разнесено с `surfaces`
      // намеренно: поддержка кода и разрешение записи — разные вопросы для агента.
      surfacesWrite: surfacesWriteEnabled(),
      // План 2026-08-03 W8a: запись композиций `version: 3` (типизированные параметры,
      // `when`/`$switch`) разрешена kill-switch'ем D9 `EASYUI_COMPOSITION_V3=1`; иначе
      // create/save отвечает `422 composition_v3_disabled`. Чтение и раскрытие уже
      // сохранённых v3 работают независимо от флага.
      compositionV3: compositionV3WriteEnabled(),
      // План 2026-08-03 W8g: `POST /api/compositions/analyze` (вердикт composition |
      // extend-component | needs-ownership-component) и `POST /api/compositions/:id/preview-tree`
      // (инструментированный прогон раскрытия). Обе ручки ничего не пишут и **не** зависят от
      // kill-switch'а v3: выбор «композиция или TSX» надо делать до включения записи.
      compositionAnalyze: true,
      // ── План 2026-08-06 (feedback-3), волны W1–W6. Флаги по правилу caseSetValidate: клиент
      // обязан проверить именно ту возможность, которую собирается использовать, — старая сборка
      // отвергнет новое поле схемы как strictObject/unrecognized_keys до всякой семантики. ──
      // W1: `figma.sources[]` — дополнительные Figma-документы lineage (primary остаётся один).
      figmaMultiSource: true,
      // W2: layout bounds v2 (живой текст + нисходящий clip-стек); версия контракта измерения —
      // в `acceptance.geometryContractVersion`, её смена инвалидирует кадры (frame-слой).
      geometryContractV2: true,
      // W3: per-case вердиктные допуски `policy.perCase.sizeDeltaPx`/`overflowBudgetPx`
      // (потолки — `limits.caseSetMaxCase*`); пересчитываются recompute без пересъёмки.
      geometryCaseTolerances: options.acceptanceMatrix === true,
      // W4: `cases[].comparison.matte` — матирование обеих картинок до метрик (comparison-слой).
      comparisonMatte: options.acceptanceMatrix === true,
      // W6: вложенные `slotBindings` (лимиты — `limits.caseSetMaxSlotDepth/Nodes`).
      nestedSlotBindings: options.acceptanceMatrix === true,
      // W5: Overlay v2 (maxHeight у всех placement + prop `scroll`) и composition-токены
      // `sizing.maxHeight:"viewport"`/`scroll` — свойство кода, не kill-switch.
      overlayScrollOwnership: true,
      // W5: `capture.surface:"viewport"` в case-set (внутренний stage-бокс, overlay-aware root,
      // paintMargin 16, две ветки канвы сравнения).
      captureViewportSurface: options.acceptanceMatrix === true,
      // ── План 2026-08-07 (ретроспектива миграции YP v2) ──
      // §W1a: четыре поверхности геометрии случая (`expectedSurfaces`/`comparisonSurface`/
      // `clipExpectation`) и per-surface вердикты (`divergingSurfaces[]`, класс `surface-mismatch`).
      // Список поверхностей — `acceptance.comparisonSurfaces`; версия контракта измерения при этом
      // **остаётся 2** (замеры аддитивны, кадры не инвалидируются — §1.1). false — при
      // `EASYUI_GEOMETRY_SURFACES_DISABLED=1`: вердикт целиком откатывается на легаси-ветку, и
      // манифест с `expectedSurfaces` перестаёт что-либо менять в оценке.
      geometrySurfacesV3: options.acceptanceMatrix === true && geometrySurfacesEnabled(),
      // §W2: детерминированный барьер ресурсов — readiness v3 у обоих профилей приёмки, режима
      // `reference` и опт-ина галерейной джобы (`readiness:"barrier"`). Матричной приёмкой **не**
      // гейтится: опт-ин живёт на прототипной screenshot-ручке. false — при
      // `EASYUI_RESOURCE_BARRIER_DISABLED=1`, и тогда каждый профиль возвращается в **свою**
      // доволновую политику (default→v1, strict→v2, reference→v2), а параметр `readiness:"barrier"`
      // остаётся валидным no-op'ом. Исполняемая версия политики — `acceptance.readinessPolicyVersion`.
      resourceBarrier: !RESOURCE_BARRIER_DISABLED,
      // §W3: `candidateOverlay` в case-set-манифесте + overlay-форма slot-ребёнка — единственная
      // durable-поверхность приёмки графа неопубликованных зависимостей (потолок узлов —
      // `limits.caseSetMaxOverlayNodes`). Гаснет матрицей (без неё кандидатов нет) и собственным
      // `EASYUI_CANDIDATE_OVERLAY_DISABLED=1` (манифест с overlay — `422 candidate_overlay_disabled`).
      candidateDependencyOverlay: options.acceptanceMatrix === true && candidateOverlayEnabled(),
      // BR-06 (план 2026-08-08 §6): `POST /api/acceptance-runs/:runId/resume` — продолжение
      // остановленного рана **новым** раном с lineage (`resumedFromRunId`/`attempt`) и переносом
      // завершённых structural-гейтов по совпавшим per-gate отпечаткам. Гейтится матричной
      // приёмкой (без неё acceptance-ручек нет вовсе) **и** собственным kill-switch'ем
      // `EASYUI_ACCEPTANCE_RESUME_DISABLED=1`; false — ручка отвечает `409 acceptance_resume_disabled`.
      // Наблюдаемость волны (причина падения случая, шов allocate-renderer, circuit breaker)
      // этим флагом **не** управляется: это фиксы дефектов, а не фича.
      acceptanceResumeV1: options.acceptanceMatrix === true && acceptanceResumeEnabled(),
      // BR-10a (план 2026-08-08 §10): `blockerFingerprint` терминального рана и read-only
      // `GET /api/acceptance-runs/:runId/retry-disposition`. Гейтится матричной приёмкой (без неё
      // ранов нет вовсе) **и** собственным `EASYUI_BLOCKER_FINGERPRINT_DISABLED=1`; false — ручка
      // отвечает 404, а поле исчезает из представления рана и из манифеста evidence. Отпечаток
      // ничего не меняет в вердиктах и отпечатках случаев: слой полностью read-only.
      blockerFingerprintV1: options.acceptanceMatrix === true && blockerFingerprintEnabled(),
      // §W5: `POST /api/prototypes/:id/snap-plan` — импакт-план галерейной съёмки (какие экраны
      // снимать и почему, какие переиспользуются с доказательством). Матричной приёмкой **не**
      // гейтится: галерея к ней не относится. false — при `EASYUI_IMPACTED_SNAP_DISABLED=1`, и
      // тогда ручка отвечает 404, а кадры не пишутся вовсе (потолок плана — `limits.snapPlanMaxScreens`).
      impactedSnap: impactedSnapEnabled(),
      // §W4: `POST /api/migration-commits` — resumable серверная сага миграционного коммита
      // (preflight → promote → gallery-save → verify → impacted-regression → audit). Гейтится
      // матричной приёмкой (как остальная приёмка) **и** собственным kill-switch'ем
      // `EASYUI_MIGRATION_COMMIT_DISABLED=1`; false — набор ручек отвечает 404. Честная граница:
      // сервер закрывает серверный хвост, агентские контрольные документы координатора он не пишет.
      migrationCommit: options.acceptanceMatrix === true && migrationCommitEnabled(),
      // §W7: типизированная причина + `suggestedPolicy` в отчёте рана и advisory-предупреждения
      // `policy_exception_stale`. Слой **report-only**: ни вердикт, ни promote от флага не зависят,
      // поэтому его отсутствие безопасно — но клиент, который строит из предложения манифест, обязан
      // знать, придёт оно или нет. false — при `EASYUI_SUGGESTED_POLICY_DISABLED=1` (гаснут обе
      // производные сразу) либо без матричной приёмки (отчётов рана попросту нет).
      suggestedPolicy: options.acceptanceMatrix === true && suggestedPolicyEnabled(),
      // §W8: `/api/figma-source-packages*` — пакет исходников как единица переноса из Figma
      // (потолок экспортов — `limits.sourcePackageMaxExports`) и ссылка `figma.sourcePackageId`.
      // Матрицей не гейтится (пакет — provenance, а не приёмка); false — при
      // `EASYUI_SOURCE_PACKAGE_DISABLED=1`: ручки отвечают 404, ссылка — `422 source_package_disabled`.
      figmaSourcePackage: sourcePackageEnabled(),
      // §W9: хост применяет Zod-дефолты схемы к props компонента, объявившего
      // `definition.capabilities.runtimeSchemaDefaults`. Флаг discovery отвечает **не** «умеет ли
      // образ», а «применяются ли дефолты прямо сейчас»: `EASYUI_RUNTIME_DEFAULTS_DISABLED=1` —
      // аварийный render-affecting kill-switch (в отпечатки он не входит сознательно), и приёмка
      // флагнутых семей при нём недействительна (`runtime_defaults_disabled` в accept-status).
      runtimeSchemaDefaults: !runtimeDefaultsDisabled(),
      // §W10: сводка подавленного инфраструктурного шума капчура — `quality.suppressedCount` и
      // `console.suppressed[{signature,count}]` в receipt. Свойство кода, kill-switch'а нет:
      // блок аддитивен, а сами capture-маршруты SPA вынесены из-под `AuthProvider`, поэтому
      // источник шума удалён, а не подавлен.
      captureNoiseSummary: true,
      /**
       * BR-01a (план 2026-08-08 §1): один резолвер схемы published component на save и readiness —
       * пины композиции применяются только к элементам её раскрытия, `track:head` резолвит голову
       * в дизайн-системе закреплённой версии, неизвестный prop отвечает типизированным
       * `component_prop_unknown` с фактически применённой схемой. Матрицей не гейтится: путь
       * save/readiness к приёмке не относится. false — при `EASYUI_SCHEMA_RESOLVER_V2_DISABLED=1`,
       * и тогда `prototypeSchemaResolverVersion` честно откатывается на доволновую 1.
       */
      prototypeSchemaResolverV2: schemaResolverV2Enabled(),
      /**
       * BR-02 (план 2026-08-08 §2): `cases[].paintPaddingPx` — поле краски **по сторонам**, кадровый
       * слой ровно того случая, который его объявил (`limits.captureMaxPaintPaddingPx`,
       * `limits.captureFrameBudgetMpx`). Матрицей **не** гейтится: поле едет и по прототипному
       * capture-пути, а не только по приёмочному. false — при `EASYUI_CAPTURE_V4_DISABLED=1`, и
       * тогда манифест с полем отвечает `422 capture_padding_disabled`, а кадр снимается скаляром.
       */
      paintCapturePaddingV1: captureV4Enabled(),
      /**
       * BR-04 (план 2026-08-08 §4): объявленная канва сравнения сводится **точно** (delta 0, без
       * неявного zero-pad до `max(ref, cand)`), бюджет судится по поверхности сравнения
       * (`rawDiffPctOfSurface`), а эталон не того масштаба называется `reference_scale_mismatch`
       * вместо молчаливого `pass`. Общий тумблер с BR-02 — одна зона (кадр ↔ канва) и одно окно
       * re-diff'а; false — при `EASYUI_CAPTURE_V4_DISABLED=1` (доволновая семантика byte-for-byte).
       */
      exactContentHugCanvasV1: captureV4Enabled(),
      /**
       * BR-03 (план 2026-08-08 §3): полный registry-resource barrier — фаза `registry` до первого
       * манифеста (реестр иконок темы), каналы `img-srcset`/псевдоэлементы/`font`/`icon-registry`,
       * ожидаемый манифест ассетов кандидата, пер-ресурсные записи контракта §6 и сужение вердикта
       * до `indeterminate` с `resource_barrier_incomplete` — **только** на барьерных причинах.
       * Матрицей **не** гейтится: барьер исполняется и на опт-ине галерейной джобы. Гаснет под
       * **обоими** свитчами — `EASYUI_RESOURCE_BARRIER_DISABLED=1` (барьера нет вовсе) и
       * `EASYUI_RESOURCE_BARRIER_V4_DISABLED=1` (барьер по v3 byte-for-byte).
       */
      resourceBarrierV4: resourceBarrierV4Enabled(),
      /**
       * Фактическая версия политики барьера — **число**, а не факт: клиенту нужно знать, чем этот
       * инстанс снимает кадры прямо сейчас. `4` — волна активна, `3` — под v4-свитчём, доволновое
       * значение дефолтного профиля (`1`) — при выключенном барьере целиком. Пара с
       * `acceptance.readinessPolicyVersion`, которая говорит то же самое о профиле приёмки.
       */
      resourceBarrierPolicyVersion: resourceBarrierPolicyVersion(),
      /**
       * Версия контракта резолвера (фидбэк §4) — **число**, а не факт существования: клиенту нужно
       * знать, по какому контракту этот инстанс отвечает прямо сейчас, а не что умеет образ.
       */
      prototypeSchemaResolverVersion: schemaResolverV2Enabled() ? PROTOTYPE_SCHEMA_RESOLVER_VERSION : LEGACY_PROTOTYPE_SCHEMA_RESOLVER_VERSION,
      // §W6b: версия схемы агентской квитанции драйвера (`envelope: {schemaVersion, command, ok,
      // summary, items, artifacts, warnings, nextActions}`) — число, а не булев флаг: конверт
      // печатается всегда, и клиенту нужна его **форма**, а не факт существования. Растёт только
      // при несовместимом изменении конверта; поля внутри `summary` добавляются аддитивно.
      // Контракт per-verb `summary` описан в `.claude/skills/author/SKILL.md`.
      receiptEnvelopeVersion: 1,
    },
    // W4: именованные пресеты live-text AA-бюджета — значения объявляет сервер, автор манифеста
    // выбирает только имя (`cases[].textAaBudget`). Пороги видны для воспроизводимости вердикта.
    textAaPresets: Object.fromEntries(Object.entries(TEXT_AA_PRESETS).map(([name, preset]) => [
      name, { maxRawDiffPct: preset.maxRawDiffPct, minEdgeResidualPct: preset.minEdgeResidualPct },
    ])),
    /**
     * Политики приёмки (план 2026-08-04 W3, D-A). `policyProfiles` — что примет
     * `POST /acceptance-runs` в `policy` (иначе `422 unknown_policy_profile`);
     * `promotionPolicyProfiles` — под каким профилем полученный вердикт допускает публикацию
     * (иначе `422 acceptance_policy_mismatch` на promote). Сегодня множества совпадают, и
     * различать их обязан клиент, а не догадка: пересечение задано конфигурацией сервера, а не
     * инвариантом кода.
     */
    acceptance: {
      policyProfiles: Object.keys(ACCEPTANCE_POLICIES),
      defaultPolicyProfile: DEFAULT_ACCEPTANCE_POLICY_ID,
      promotionPolicyProfiles: [...PROMOTION_POLICY_PROFILES],
      // План 2026-08-06 §1.3: версия контракта измерения геометрии — кадровый вход
      // frameFingerprint; её смена = полная пересъёмка затронутых наборов.
      geometryContractVersion: GEOMETRY_CONTRACT_VERSION,
      // План 2026-08-07 §W1a: какие поверхности геометрии принимает `expectedSurfaces`/
      // `comparisonSurface` случая. Порядок — тот же, что у `divergingSurfaces[]` вердикта:
      // от «что построил браузер» к «что прислал дизайнер». Все габариты объявляются в CSS px.
      comparisonSurfaces: [...GEOMETRY_SURFACES],
      /**
       * План 2026-08-07 §W2/§1.5: версия readiness-политики **дефолтного профиля приёмки** — та,
       * которой этот инстанс реально снимает кадры, а не та, которую умеет код. `3` — строгая
       * политика плюс барьер ресурсов; при `EASYUI_RESOURCE_BARRIER_DISABLED=1` здесь честно
       * появляется доволновое значение профиля (`default-v1` → `1`), потому что профили
       * откатываются каждый в своё (`pixel-strict-v1` → `2`), и одно число на всех соврало бы.
       * Пара с `features.resourceBarrier`: флаг говорит «барьер включён», версия — «чем снято».
       */
      readinessPolicyVersion: ACCEPTANCE_POLICIES[DEFAULT_ACCEPTANCE_POLICY_ID].readiness.version,
    },
    // План renderer-contract-2 §5 R1: чем именно эта сборка рисует кадры. Агент (и приёмка
    // прода) обязаны иметь возможность сверить отпечаток с тем, что приехало в результате джобы,
    // не заглядывая внутрь образа.
    renderer: rendererReport(),
    reuseGate: {
      mode: reuseGateMode,
      // Единственное правило фазы, наблюдаемое клиентом: `intent` обязателен ровно в `enforce`
      // (`server/contracts.ts` — reuseIntentSchema применяется по режиму).
      intentRequired: reuseGateMode === "enforce",
      // Версия политики матчинга: score корпус-относителен, и без неё решение гейта
      // невоспроизводимо задним числом (план §3.3). Совпадает с `policyVersion` в
      // `/api/catalog/candidates` и в аудит-записях.
      policyVersion: CALIBRATED_POLICY.policyVersion,
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
      // Architecture metadata (волна 2): все поля опциональны; архитектурные lint-правила
      // прототипа смотрят только на явно объявленные значения.
      scope: { enum: [...COMPONENT_SCOPES], $comment: "Какой частью экрана компонент владеет: primitive | section | shell | screen." },
      allowedAsRoot: { type: "boolean", $comment: "false запрещает использовать компонент в корневой позиции экрана." },
      canonicalFor: { type: "array", maxItems: 12, items: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }, $comment: "Slug'и продуктовых ролей, для которых компонент — канонический выбор." },
      sourceBounded: { type: "boolean", $comment: "Компонент не должен сам задавать геометрию экрана; publish сканирует исходник только при true." },
      ownership: {
        type: "object", additionalProperties: false, required: ["reason"],
        properties: { reason: { type: "string", maxLength: 500 }, provenance: { type: "string", maxLength: 500 } },
        $comment: "Обоснование владения экраном/каркасом; обязательно для scope shell/screen (иначе publish-warning).",
      },
      replacement: { type: "string", maxLength: 64, $comment: "Имя компонента-замены в той же дизайн-системе." },
    },
  };
}

const openapiUrl = new URL("../openapi.json", import.meta.url);
let cachedOpenapi: string | null = null;
let cachedPrototypeDocumentSchema: string | null = null;
let cachedComponentDefinitionSchema: string | null = null;

const jsonText = (body: string): Response =>
  new Response(body, { headers: { "content-type": "application/json; charset=utf-8", ...noStore } });

/**
 * Handles /api/openapi.json, /api/schemas/*, /api/capabilities; null when the path is not a meta route.
 *
 * `reuseGateMode` едет от `HandlerOptions` (`server/main.ts`). Дефолт здесь существует только
 * ради вызывающих, которым фаза не важна (схемы и OpenAPI её не касаются).
 */
export function routeMeta(request: Request, db: Database, segments: string[], reuseGateMode: ReuseGateMode = DEFAULT_REUSE_GATE_MODE, options: { validateDisabled?: boolean; acceptanceDisabled?: boolean; spacingResolverV2Disabled?: boolean; acceptanceMatrix?: boolean } = {}): Response | null {
  const requireGet = () => { if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed"); };
  if (segments[0] === "openapi.json" && segments.length === 1) {
    requireGet();
    cachedOpenapi ??= readFileSync(openapiUrl, "utf8");
    return jsonText(cachedOpenapi);
  }
  if (segments[0] === "capabilities" && segments.length === 1) {
    requireGet();
    return json(capabilities(db, reuseGateMode, options), 200, noStore);
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
