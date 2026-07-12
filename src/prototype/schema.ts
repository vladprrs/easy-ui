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

export const prototypeDocSchema = z.strictObject({
  version: z.literal(1),
  id: slugSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  designSystem: slugSchema.default("shadcn"),
  device: z.enum(["mobile", "tablet", "desktop"]).default("desktop"),
  startScreen: slugSchema,
  state: z.record(z.string(), jsonValueSchema),
  screens: z.array(screenSchema).min(1),
}).superRefine((doc, context) => {
  const ids = new Set<string>();
  doc.screens.forEach((screen, index) => {
    if (ids.has(screen.id)) context.addIssue({ code: "custom", path: ["screens", index, "id"], message: "screen id must be unique" });
    ids.add(screen.id);
  });
  if (!ids.has(doc.startScreen)) context.addIssue({ code: "custom", path: ["startScreen"], message: "startScreen must reference an existing screen" });
});

export type PrototypeDoc = z.output<typeof prototypeDocSchema>;
