import type { ComponentType } from "react";
import type { z } from "zod";
import type { ComponentOwnership, ComponentScope } from "../../src/designSystems/scope";
import type { AtomicLevel, ComponentLayout } from "../../src/designSystems/types";

/** `runtimeSchemaDefaults` (§W9): хост применяет Zod-дефолты к props перед рендером. */
export type ComponentCapabilities = { typedEvents?: true; namedSlots?: true; runtimeSchemaDefaults?: true };

/**
 * Architecture metadata (план 2026-07-27, волна 2 §2.1) — additive и полностью
 * опциональная. Объявляется на `definition` в TSX и сериализуется в
 * `DefinitionMeta` (version DTO + catalog manifest) без изменения существующих полей.
 */
export type ArchitectureMetadata = {
  /** Какой частью экрана компонент владеет: primitive | section | shell | screen. */
  scope?: ComponentScope;
  /** Явное разрешение/запрет быть корнем экрана. */
  allowedAsRoot?: boolean;
  /** Slug'и продуктовых ролей, для которых компонент канонический. */
  canonicalFor?: string[];
  /** Компонент сам задаёт геометрию экрана (h-screen/100vh/fixed inset-0). */
  sourceBounded?: boolean;
  /** Обоснование владения экраном/каркасом. */
  ownership?: ComponentOwnership;
  /** Имя компонента-замены в той же дизайн-системе. */
  replacement?: string;
};

export type CustomComponentDefinition<Props extends Record<string, unknown> = Record<string, unknown>> = {
  props: z.ZodType<Props>;
  /** Legacy payloadless event names or a `Record<name, ZodSchema>` of typed payloads. */
  events?: readonly string[] | Record<string, z.ZodType>;
  slots?: string[];
  capabilities?: ComponentCapabilities;
  description: string;
  example?: Props;
  examples?: Record<string, Props>;
  /** Server-only props used for publish-time layout-neutral conformance. */
  conformanceProps?: Record<string, unknown>;
  atomicLevel?: AtomicLevel;
  layoutNeutral?: true;
  layout?: ComponentLayout;
  /** Semantic-validation metadata (additive). */
  interactive?: boolean;
  accessibleLabelProps?: string[];
  urlProps?: string[];
} & ArchitectureMetadata;

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
  examples?: Record<string, Record<string, unknown>>;
  propsJsonSchema?: unknown;
  atomicLevel?: AtomicLevel;
  layoutNeutral?: true;
  layout?: ComponentLayout;
  /** Semantic-validation metadata (additive; mirrors the definition fields). */
  interactive?: boolean;
  accessibleLabelProps?: string[];
  urlProps?: string[];
} & ArchitectureMetadata;
