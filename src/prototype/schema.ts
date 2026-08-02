import { z } from "zod";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

export const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a slug");

export const FLOWS_LIMIT = 24;
export const FLOW_STEPS_LIMIT = 50;
export const FLOW_TOTAL_STEPS_LIMIT = 320;
/**
 * Максимальная глубина дерева сценариев (`flow.parentId`), **корень = уровень 1**.
 * Значение уезжает в публичный `/api/capabilities` как `limits.flowDepth`.
 */
export const FLOW_DEPTH_LIMIT = 4;

export const REGION_KINDS = ["statusBar", "header", "footer"] as const;
export type RegionKind = (typeof REGION_KINDS)[number];

// Content-addressed asset id: "asset_" + full lowercase sha256 (64 hex). Referenced from URL
// props via the {"$asset": "asset_<sha256>"} directive, which resolves to /api/assets/<id>.
export const ASSET_ID_PATTERN = /^asset_[0-9a-f]{64}$/;
export const isAssetId = (value: unknown): value is string => typeof value === "string" && ASSET_ID_PATTERN.test(value);

const actionSchema = z.strictObject({
  action: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
  preventDefault: z.boolean().optional(),
  // Custom-component-only conditional guard; grammar validated in validate.ts.
  $if: z.unknown().optional(),
});

const repeatSchema = z.strictObject({
  statePath: z.string().startsWith("/"),
  key: z.string().min(1).optional(),
});

export const elementSchema = z.strictObject({
  type: z.string().min(1),
  props: z.record(z.string(), z.unknown()),
  children: z.array(z.string()).optional(),
  visible: z.unknown().optional(),
  on: z.record(z.string(), z.union([actionSchema, z.array(actionSchema).min(1)])).optional(),
  repeat: repeatSchema.optional(),
  region: z.enum(REGION_KINDS).optional(),
  // Named-slot placement: routes this child into a parent custom component's slot
  // (see validate.ts — parent must be a custom component with capabilities.namedSlots).
  slot: slugSchema.optional(),
});

/**
 * Ключ элемента в **авторском** документе (волна 5, M5). `$` зарезервирован под
 * разделитель раскрытых композиций (`<hostKey>$<innerKey>`), поэтому запрещён на
 * входе — так коллизии ключей после раскрытия исключены по построению.
 * Ключи доезжают до `__euiKey` → `data-eui-key` (geometry, misclick-подсветка),
 * контракт зафиксирован в `docs/prototype-format.md`.
 */
export const authoredElementKeySchema = z.string().min(1)
  .refine((key) => !key.includes("$"), "element key must not contain '$' (reserved for composition expansion)");

const storedSpecSchema = z.strictObject({
  root: z.string().min(1),
  elements: z.record(z.string(), elementSchema),
});

/** Строгая спека для входных документов: ключи элементов без `$`. */
export const authoredSpecSchema = z.strictObject({
  root: z.string().min(1),
  elements: z.record(authoredElementKeySchema, elementSchema),
});

const screenShape = <S extends z.ZodType>(spec: S) => ({
  id: slugSchema,
  name: z.string().min(1),
  note: z.string().trim().min(1).max(500).optional(),
  stateOverrides: z.record(z.string(), jsonValueSchema).optional(),
  canvas: z.strictObject({ width: z.number().positive(), height: z.number().positive() }).optional(),
  spec,
});

const screenSchema = z.strictObject(screenShape(storedSpecSchema));
const authoredScreenSchema = z.strictObject(screenShape(authoredSpecSchema));

const flowStepSchema = z.strictObject({
  screenId: slugSchema,
  note: z.string().trim().min(1).max(500).optional(),
});

/**
 * Общая форма флоу. `parentId` — аддитивное поле иерархии сценариев (план
 * `docs/plans/2026-07-29-scrn-gallery-ux.md` §4/T0): присутствует в обеих ветках,
 * а правила иерархии (существование родителя, порядок, глубина) — только во входной
 * (`refinePrototypeDocAuthoring`), чтобы откат образа читал документы без потерь.
 * Обе ветки — `strictObject`: `looseObject` добавил бы индексную сигнатуру и
 * убил бы excess-property-проверки на литералах флоу по всему репозиторию.
 */
const flowShape = <Steps extends z.ZodType>(steps: Steps) => ({
  id: slugSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  parentId: slugSchema.optional(),
  steps,
}) as const;

/** Входная ветка: авторские лимиты `.max()` живут только здесь. */
const inputFlowSchema = z.strictObject(flowShape(z.array(flowStepSchema).min(1).max(FLOW_STEPS_LIMIT)));
/** Stored-ветка: те же поля, но без авторских лимитов — иначе откат образа ломает чтение. */
const storedFlowSchema = z.strictObject(flowShape(z.array(flowStepSchema).min(1)));

/**
 * Идентификаторы архитектурных lint-правил (`src/prototype/architectureLints.ts`).
 * Живут здесь, потому что документ ссылается на них в `architecture.exemptions`;
 * `architectureLints.ts` реэкспортирует список как `architectureLintCodes`.
 */
export const ARCHITECTURE_LINT_CODES = [
  "arch/monolith-root",
  "arch/root-not-allowed",
  "arch/screen-scope-nested",
  "arch/region-owns-page",
  "arch/ownership-unexplained",
  "arch/bounded-as-owner",
] as const;
export type ArchitectureLintCode = (typeof ARCHITECTURE_LINT_CODES)[number];

export const ARCHITECTURE_EXEMPTIONS_LIMIT = 200;
export const ARCHITECTURE_EXEMPTION_REASON_MIN = 8;

/**
 * Именованное исключение из архитектурного правила. Снимает warning с конкретного
 * экрана (и, опционально, элемента) и попадает в readiness-отчёт как `exempted`.
 */
const architectureExemptionSchema = z.strictObject({
  rule: z.enum(ARCHITECTURE_LINT_CODES),
  screenId: slugSchema,
  elementKey: z.string().min(1).max(200).optional(),
  reason: z.string().trim().min(ARCHITECTURE_EXEMPTION_REASON_MIN).max(500),
  provenance: z.string().trim().min(1).max(500).optional(),
});

const architectureSchema = z.strictObject({
  exemptions: z.array(architectureExemptionSchema).max(ARCHITECTURE_EXEMPTIONS_LIMIT).optional(),
});

/** Лимиты `doc.computed` (план `docs/plans/2026-08-02-computed-state.md`, D5/D12). */
export const COMPUTED_ENTRIES_LIMIT = 20;
export const COMPUTED_FIELDS_LIMIT = 4;
export const COMPUTED_TERMS_LIMIT = 8;

/**
 * Ключ computed-значения — **bare**, как в `doc.state` (D1). Первая буква исключает
 * `__proto__`/`_viewer` и `~`-эскейпы по построению, поэтому коллизии и запрет записи
 * сравниваются ключ-с-ключом без спецслучаев.
 */
const computedKeySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "computed key must match ^[A-Za-z][A-Za-z0-9_-]*$");
/** Источник — абсолютный пойнтер в plain state (безопасность пойнтера проверяет validate.ts). */
const computedFromSchema = z.string().startsWith("/");
/** Поле item — относительный путь (`price`, `a/b`). */
const computedFieldSchema = z.string().min(1);

/**
 * Закрытый набор операций v1 (D2). Только **входная** ветка: stored-запись —
 * `z.unknown()`, её форму разбирает оборонительный `evaluateComputed`
 * (`src/prototype/computed.ts`), иначе документ, сохранённый более новой версией,
 * ронял бы чтение ревизии.
 */
const inputComputedEntrySchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("count"), from: computedFromSchema }),
  z.strictObject({ op: z.literal("sum"), from: computedFromSchema, field: computedFieldSchema.optional() }),
  z.strictObject({
    op: z.literal("sumProduct"),
    from: computedFromSchema,
    fields: z.array(computedFieldSchema).min(2).max(COMPUTED_FIELDS_LIMIT),
  }),
  z.strictObject({
    op: z.literal("add"),
    // Терм: абсолютный пойнтер (plain state или **ранее объявленный** computed-ключ —
    // порядок проверяет validate.ts) либо числовой литерал (отрицательный = скидка).
    terms: z.array(z.union([z.string().startsWith("/"), z.number()])).min(2).max(COMPUTED_TERMS_LIMIT),
  }),
]);

const inputComputedSchema = z.record(computedKeySchema, inputComputedEntrySchema)
  .describe("Производные значения стейта: ключ → операция (count/sum/sumProduct/add). Read-only, читаются как обычный $state по bare-ключу.");
/**
 * Stored-ветка: без формы записи вовсе — см. комментарий к `inputComputedEntrySchema`.
 * `.nullable()` — по той же причине: `computed: null`, записанный более новой версией,
 * не должен ронять чтение ревизии (422 на каждом открытии прототипа).
 */
const storedComputedSchema = z.record(z.string(), z.unknown()).nullable()
  .describe("Производные значения стейта (stored-ветка: форма записи не проверяется).");

/** Порядок операций для `/api/capabilities.limits`/`features` (D12): импорт из места энфорса. */
export const COMPUTED_OPS = ["count", "sum", "sumProduct", "add"] as const satisfies readonly z.output<typeof inputComputedEntrySchema>["op"][];

const prototypeDocShape = <S extends z.ZodType, F extends z.ZodType, C extends z.ZodType>(screens: S, flows: F, computed: C) => ({
  version: z.literal(1),
  id: slugSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  device: z.enum(["mobile", "tablet", "desktop"]).default("desktop"),
  startScreen: slugSchema,
  state: z.record(z.string(), jsonValueSchema),
  /** Производные значения стейта (аддитивно, read-only); формат — `src/prototype/computed.ts`. */
  computed: computed.optional(),
  screens,
  flows: flows.optional(),
  /** Архитектурные исключения (волна 2): аддитивно, документ без поля ведёт себя как раньше. */
  architecture: architectureSchema.optional(),
}) as const;

type RefinableDoc = {
  screens: { id: string }[];
  startScreen: string;
  flows?: { id: string; parentId?: string; steps: { screenId: string }[] }[];
  /** `null` возможен только в stored-ветке (см. `storedComputedSchema`). */
  computed?: Record<string, unknown> | null;
};

/**
 * Структурные инварианты — исполняются **обеими** ветками, потому что на них
 * напрямую опирается код: уникальность `screen.id`, существование `startScreen`
 * и `step.screenId`, уникальность `flow.id`.
 */
const refinePrototypeDocStructure = <T extends RefinableDoc>(doc: T, context: z.RefinementCtx) => {
  const ids = new Set<string>();
  doc.screens.forEach((screen, index) => {
    if (ids.has(screen.id)) context.addIssue({ code: "custom", path: ["screens", index, "id"], message: "screen id must be unique" });
    ids.add(screen.id);
  });
  if (!ids.has(doc.startScreen)) context.addIssue({ code: "custom", path: ["startScreen"], message: "startScreen must reference an existing screen" });

  if (!doc.flows) return;
  const flowIds = new Set<string>();
  doc.flows.forEach((flow, flowIndex) => {
    if (flowIds.has(flow.id)) context.addIssue({ code: "custom", path: ["flows", flowIndex, "id"], message: "flow id must be unique" });
    flowIds.add(flow.id);
    flow.steps.forEach((step, stepIndex) => {
      if (!ids.has(step.screenId)) context.addIssue({ code: "custom", path: ["flows", flowIndex, "steps", stepIndex, "screenId"], message: "flow step must reference an existing screen" });
    });
  });
};

/**
 * Иерархия сценариев (`flow.parentId`), план §7/T1. Единственное нормативное правило
 * порядка — **родитель объявлен раньше ребёнка**: оно же даёт ацикличность (отношение
 * `parent: i → j < i` — лес по построению) и позволяет посчитать глубину одним проходом,
 * поэтому отдельных проверок на цикл и самоссылку нет (самоссылка = нарушение порядка).
 *
 * Defensive: висячий `parentId` трактуется как корень (второй issue про глубину не
 * добавляется), карта `id → index` фиксирует **первое** вхождение (дубликаты `id`
 * репортит структурная ветка), а при нарушении порядка глубина поддерева не считается
 * вовсе (`null`) — чтобы не сыпать производными issue'ами.
 */
const refineFlowHierarchy = (flows: NonNullable<RefinableDoc["flows"]>, context: z.RefinementCtx) => {
  const indexById = new Map<string, number>();
  flows.forEach((flow, index) => { if (!indexById.has(flow.id)) indexById.set(flow.id, index); });

  if (flows[0]?.parentId !== undefined) {
    context.addIssue({ code: "custom", path: ["flows", 0, "parentId"], message: "the first flow must be a root flow" });
  }

  const depths: (number | null)[] = [];
  flows.forEach((flow, index) => {
    if (flow.parentId === undefined) { depths.push(1); return; }
    const parentIndex = indexById.get(flow.parentId);
    if (parentIndex === undefined) {
      context.addIssue({ code: "custom", path: ["flows", index, "parentId"], message: "flow parentId must reference an existing flow" });
      depths.push(1);
      return;
    }
    if (parentIndex >= index) {
      context.addIssue({ code: "custom", path: ["flows", index, "parentId"], message: "flow parent must be declared before the flow" });
      depths.push(null);
      return;
    }
    const parentDepth = depths[parentIndex]!;
    if (parentDepth === null) { depths.push(null); return; }
    const depth = parentDepth + 1;
    depths.push(depth);
    if (depth > FLOW_DEPTH_LIMIT) {
      context.addIssue({ code: "custom", path: ["flows", index, "parentId"], message: `flow nesting exceeds the depth limit of ${FLOW_DEPTH_LIMIT}` });
    }
  });
};

/**
 * Авторские правила — **только входная ветка** (план §4). Stored-парс их не исполняет,
 * чтобы откат образа на предыдущую версию читал, сохранял и восстанавливал документы
 * без потерь: правила геометрии дорожек и лимиты — вопрос авторинга, не чтения.
 */
const refinePrototypeDocAuthoring = <T extends RefinableDoc>(doc: T, context: z.RefinementCtx) => {
  // До early-return по flows: счётчик записей computed — авторский лимит (D5).
  if (doc.computed != null && Object.keys(doc.computed).length > COMPUTED_ENTRIES_LIMIT) {
    context.addIssue({ code: "custom", path: ["computed"], message: `computed exceeds the limit of ${COMPUTED_ENTRIES_LIMIT} entries` });
  }

  if (!doc.flows) return;
  refineFlowHierarchy(doc.flows, context);
  let totalSteps = 0;
  doc.flows.forEach((flow, flowIndex) => {
    totalSteps += flow.steps.length;
    flow.steps.forEach((step, stepIndex) => {
      if (stepIndex > 0 && step.screenId === flow.steps[stepIndex - 1]!.screenId) {
        context.addIssue({ code: "custom", path: ["flows", flowIndex, "steps", stepIndex, "screenId"], message: "adjacent flow steps must reference different screens" });
      }
    });
  });
  if (totalSteps > FLOW_TOTAL_STEPS_LIMIT) context.addIssue({ code: "custom", path: ["flows"], message: `flows exceed the total limit of ${FLOW_TOTAL_STEPS_LIMIT} steps` });

  const main = doc.flows[0];
  if (!main) return;
  if (main.steps[0]?.screenId !== doc.startScreen) {
    context.addIssue({ code: "custom", path: ["flows", 0, "steps", 0, "screenId"], message: "main flow must start at startScreen" });
  }
  const mainIndexes = new Map<string, number>();
  main.steps.forEach((step, stepIndex) => {
    if (mainIndexes.has(step.screenId)) {
      context.addIssue({ code: "custom", path: ["flows", 0, "steps", stepIndex, "screenId"], message: "screen ids in the main flow must be unique" });
    } else {
      mainIndexes.set(step.screenId, stepIndex);
    }
  });
  doc.flows.forEach((flow, flowIndex) => {
    // План §3: дочерний флоу (`parentId`) — выборка экранов, а не заякоренная в
    // главную линию ветка, поэтому геометрическое правило дорожек на него не действует.
    if (flow.parentId !== undefined) return;
    for (let stepIndex = 1; stepIndex < flow.steps.length; stepIndex += 1) {
      const previousMainIndex = mainIndexes.get(flow.steps[stepIndex - 1]!.screenId);
      const currentMainIndex = mainIndexes.get(flow.steps[stepIndex]!.screenId);
      if (previousMainIndex !== undefined && currentMainIndex !== undefined && currentMainIndex !== previousMainIndex + 1) {
        context.addIssue({
          code: "custom",
          path: ["flows", flowIndex, "steps", stepIndex, "screenId"],
          message: "adjacent main-flow anchors must be consecutive in the forward direction",
        });
      }
    }
  });
};

/** Strict schema for create/save inputs. New revisions must choose a design system explicitly. */
export const inputPrototypeDocSchema = z.strictObject({
  ...prototypeDocShape(z.array(authoredScreenSchema).min(1), z.array(inputFlowSchema).min(1).max(FLOWS_LIMIT), inputComputedSchema),
  designSystem: slugSchema,
}).superRefine(refinePrototypeDocStructure).superRefine(refinePrototypeDocAuthoring);

/**
 * Tolerant parser for immutable legacy rows that predate the designSystem field.
 * Ключи элементов здесь **не** ограничены: уже сохранённые документы должны читаться,
 * а раскрытый документ (ключи `<hostKey>$<inner>`) валиден для этого парсера.
 */
export const storedPrototypeDocSchema = z.strictObject({
  ...prototypeDocShape(z.array(screenSchema).min(1), z.array(storedFlowSchema).min(1), storedComputedSchema),
  designSystem: slugSchema.default("shadcn"),
}).superRefine(refinePrototypeDocStructure);

// Compatibility export for frontend-authored fixtures. Server write paths use
// inputPrototypeDocSchema explicitly; stored reads use storedPrototypeDocSchema.
export const prototypeDocSchema = storedPrototypeDocSchema;

export type PrototypeDoc = z.output<typeof storedPrototypeDocSchema>;
export type ArchitectureExemption = z.output<typeof architectureExemptionSchema>;
/** Публичный тип флоу выводится из **строгой input-схемы** — иначе литералы флоу по репозиторию теряют excess-property-проверки. */
export type Flow = z.output<typeof inputFlowSchema>;
/** Публичные типы computed — из **строгой input-ветки** (прецедент `Flow`). */
export type ComputedEntry = z.output<typeof inputComputedEntrySchema>;
export type ComputedSpec = z.output<typeof inputComputedSchema>;
export type FlowStep = z.output<typeof flowStepSchema>;
