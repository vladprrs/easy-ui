import { z } from "zod";

export const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a slug");

const actionSchema = z.strictObject({
  action: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
  preventDefault: z.boolean().optional(),
});

const elementSchema = z.strictObject({
  type: z.string().min(1),
  props: z.record(z.string(), z.unknown()),
  children: z.array(z.string()).optional(),
  visible: z.unknown().optional(),
  on: z.record(z.string(), z.union([actionSchema, z.array(actionSchema).min(1)])).optional(),
});

const specSchema = z.strictObject({
  root: z.string().min(1),
  elements: z.record(z.string(), elementSchema),
});

const screenSchema = z.strictObject({
  id: slugSchema,
  name: z.string().min(1),
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
  state: z.record(z.string(), z.unknown()),
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
