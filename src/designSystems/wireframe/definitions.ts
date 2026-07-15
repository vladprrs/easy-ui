import { z } from "zod";
import { hotspotDefinition } from "../../catalog/hotspot.definition";
import { normalizeDefinitions, type ComponentDefinition } from "../../catalog/normalize";

export const wireframeSourceDefinitions = {
  Box: {
    props: z.strictObject({ label: z.string().optional() }),
    slots: ["default"],
    description: "Dashed wireframe container for grouping content.",
    example: { label: "Content region" },
    atomicLevel: "atom",
    layoutNeutral: true,
  },
  Stack: {
    props: z.strictObject({ gap: z.enum(["none", "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"]).default("md") }),
    slots: ["default"],
    description: "Vertical layout for wireframe elements.",
    example: { gap: "md" },
    atomicLevel: "atom",
    layoutNeutral: true,
    layout: { version: 1, spacing: ["gap"], flow: { kind: "flex", direction: "vertical" } },
  },
  Grid: {
    props: z.strictObject({ columns: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(2) }),
    slots: ["default"],
    description: "Responsive-looking schematic column layout.",
    example: { columns: 2 },
    atomicLevel: "atom",
    layoutNeutral: true,
  },
  Heading: {
    props: z.strictObject({ text: z.string(), level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(2) }),
    description: "Wireframe heading text.",
    example: { text: "Page heading", level: 2 },
    atomicLevel: "atom",
  },
  Text: {
    props: z.strictObject({ text: z.string() }),
    description: "Wireframe body copy.",
    example: { text: "Placeholder content for the interface." },
    atomicLevel: "atom",
  },
  Image: {
    props: z.strictObject({ alt: z.string().min(1), label: z.string().default("Image") }),
    description: "Schematic image placeholder with a diagonal cross.",
    example: { alt: "Image placeholder", label: "IMAGE" },
    atomicLevel: "atom",
  },
  Button: {
    props: z.strictObject({ label: z.string(), disabled: z.boolean().default(false) }),
    events: ["press"],
    description: "Low-fidelity action button.",
    example: { label: "Continue", disabled: false },
    atomicLevel: "atom",
  },
  Input: {
    props: z.strictObject({ label: z.string(), value: z.string().optional(), placeholder: z.string().optional(), disabled: z.boolean().default(false) }),
    events: ["change"],
    description: "Low-fidelity single-line text input.",
    example: { label: "Name", value: "", placeholder: "Enter text", disabled: false },
    atomicLevel: "atom",
  },
  Checkbox: {
    props: z.strictObject({ label: z.string(), checked: z.boolean().default(false), disabled: z.boolean().default(false) }),
    events: ["change"],
    description: "Low-fidelity checkbox control.",
    example: { label: "Remember choice", checked: false, disabled: false },
    atomicLevel: "atom",
  },
  Hotspot: {
    ...hotspotDefinition,
    example: { x: 0, y: 0, width: 40, height: 40, ariaLabel: "Interactive hotspot" },
    atomicLevel: "atom",
  },
  Select: {
    props: z.strictObject({
      label: z.string(),
      value: z.string().optional(),
      options: z.array(z.strictObject({ label: z.string(), value: z.string() })).min(1),
      disabled: z.boolean().default(false),
    }),
    events: ["change"],
    description: "Low-fidelity option picker.",
    example: { label: "Priority", value: "medium", options: [{ label: "Low", value: "low" }, { label: "Medium", value: "medium" }], disabled: false },
    atomicLevel: "molecule",
  },
  Card: {
    props: z.strictObject({ title: z.string().optional() }),
    slots: ["default"],
    description: "Dashed wireframe card with an optional title.",
    example: { title: "Card title" },
    atomicLevel: "organism",
  },
} as const satisfies Record<string, ComponentDefinition>;

export const wireframeDefinitions = normalizeDefinitions(wireframeSourceDefinitions);
