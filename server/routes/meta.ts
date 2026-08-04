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
import { GEOMETRY_RECT_LIMIT, MAX_QUEUE } from "../screenshot/service";
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
  CASE_SET_MAX_EXPECTED_TUPLES,
} from "../../src/acceptance/caseSetSchema";

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
    },
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
