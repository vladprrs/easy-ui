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

export const FLOWS_LIMIT = 12;
export const FLOW_STEPS_LIMIT = 50;
export const FLOW_TOTAL_STEPS_LIMIT = 200;

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

const elementSchema = z.strictObject({
  type: z.string().min(1),
  props: z.record(z.string(), z.unknown()),
  children: z.array(z.string()).optional(),
  visible: z.unknown().optional(),
  on: z.record(z.string(), z.union([actionSchema, z.array(actionSchema).min(1)])).optional(),
  repeat: repeatSchema.optional(),
  // Named-slot placement: routes this child into a parent custom component's slot
  // (see validate.ts — parent must be a custom component with capabilities.namedSlots).
  slot: slugSchema.optional(),
});

const specSchema = z.strictObject({
  root: z.string().min(1),
  elements: z.record(z.string(), elementSchema),
});

const screenSchema = z.strictObject({
  id: slugSchema,
  name: z.string().min(1),
  note: z.string().trim().min(1).max(500).optional(),
  stateOverrides: z.record(z.string(), jsonValueSchema).optional(),
  canvas: z.strictObject({ width: z.number().positive(), height: z.number().positive() }).optional(),
  spec: specSchema,
});

const flowStepSchema = z.strictObject({
  screenId: slugSchema,
  note: z.string().trim().min(1).max(500).optional(),
});

const flowSchema = z.strictObject({
  id: slugSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  steps: z.array(flowStepSchema).min(1).max(FLOW_STEPS_LIMIT),
});

const prototypeDocShape = {
  version: z.literal(1),
  id: slugSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  device: z.enum(["mobile", "tablet", "desktop"]).default("desktop"),
  startScreen: slugSchema,
  state: z.record(z.string(), jsonValueSchema),
  screens: z.array(screenSchema).min(1),
  flows: z.array(flowSchema).min(1).max(FLOWS_LIMIT).optional(),
} as const;

const refinePrototypeDoc = <T extends {
  screens: { id: string }[];
  startScreen: string;
  flows?: { id: string; steps: { screenId: string }[] }[];
}>(doc:T, context:z.RefinementCtx) => {
  const ids = new Set<string>();
  doc.screens.forEach((screen, index) => {
    if (ids.has(screen.id)) context.addIssue({ code: "custom", path: ["screens", index, "id"], message: "screen id must be unique" });
    ids.add(screen.id);
  });
  if (!ids.has(doc.startScreen)) context.addIssue({ code: "custom", path: ["startScreen"], message: "startScreen must reference an existing screen" });

  if (!doc.flows) return;
  const flowIds = new Set<string>();
  let totalSteps = 0;
  doc.flows.forEach((flow, flowIndex) => {
    if (flowIds.has(flow.id)) context.addIssue({ code: "custom", path: ["flows", flowIndex, "id"], message: "flow id must be unique" });
    flowIds.add(flow.id);
    totalSteps += flow.steps.length;
    flow.steps.forEach((step, stepIndex) => {
      if (!ids.has(step.screenId)) context.addIssue({ code: "custom", path: ["flows", flowIndex, "steps", stepIndex, "screenId"], message: "flow step must reference an existing screen" });
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
  ...prototypeDocShape,
  designSystem: slugSchema,
}).superRefine(refinePrototypeDoc);

/** Tolerant parser for immutable legacy rows that predate the designSystem field. */
export const storedPrototypeDocSchema = z.strictObject({
  ...prototypeDocShape,
  designSystem: slugSchema.default("shadcn"),
}).superRefine(refinePrototypeDoc);

// Compatibility export for frontend-authored fixtures. Server write paths use
// inputPrototypeDocSchema explicitly; stored reads use storedPrototypeDocSchema.
export const prototypeDocSchema = storedPrototypeDocSchema;

export type PrototypeDoc = z.output<typeof storedPrototypeDocSchema>;
export type Flow = z.output<typeof flowSchema>;
export type FlowStep = z.output<typeof flowStepSchema>;
