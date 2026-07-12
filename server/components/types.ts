import type { ComponentType } from "react";
import type { z } from "zod";
import type { AtomicLevel } from "../../src/designSystems/types";

export type ComponentCapabilities = { typedEvents?: true; namedSlots?: true };

export type CustomComponentDefinition<Props extends Record<string, unknown> = Record<string, unknown>> = {
  props: z.ZodType<Props>;
  /** Legacy payloadless event names or a `Record<name, ZodSchema>` of typed payloads. */
  events?: readonly string[] | Record<string, z.ZodType>;
  slots?: string[];
  capabilities?: ComponentCapabilities;
  description: string;
  example?: Props;
  atomicLevel?: AtomicLevel;
  /** Semantic-validation metadata (additive). */
  interactive?: boolean;
  accessibleLabelProps?: string[];
  urlProps?: string[];
};

export type CustomComponentModule<Props extends Record<string, unknown> = Record<string, unknown>> = {
  definition: CustomComponentDefinition<Props>;
  default: ComponentType<Props>;
};

export type DefinitionMeta = {
  events: string[];
  /** Canonical JSON Schema per event that declares a typed payload (additive). */
  eventPayloads?: Record<string, unknown>;
  slots: string[];
  capabilities?: ComponentCapabilities;
  description: string;
  example?: Record<string, unknown>;
  propsJsonSchema?: unknown;
  atomicLevel?: AtomicLevel;
  /** Semantic-validation metadata (additive; mirrors the definition fields). */
  interactive?: boolean;
  accessibleLabelProps?: string[];
  urlProps?: string[];
};
