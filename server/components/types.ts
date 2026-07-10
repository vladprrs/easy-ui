import type { ComponentType } from "react";
import type { z } from "zod";

export type CustomComponentDefinition<Props extends Record<string, unknown> = Record<string, unknown>> = {
  props: z.ZodType<Props>;
  events?: string[];
  slots?: string[];
  description: string;
  example?: Props;
};

export type CustomComponentModule<Props extends Record<string, unknown> = Record<string, unknown>> = {
  definition: CustomComponentDefinition<Props>;
  default: ComponentType<Props>;
};

export type DefinitionMeta = {
  events: string[];
  slots: string[];
  description: string;
  example?: Record<string, unknown>;
  propsJsonSchema?: unknown;
};
