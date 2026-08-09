import type { PrototypeDoc } from "./schema";

/**
 * Диагностический контекст резолвера схемы (план 2026-08-08 §1, BR-01a; фидбэк §4). Приезжает
 * только на issue `component_prop_unknown` и только когда схемы резолвил сервер: клиентская
 * валидация редактора его источника не имеет.
 */
export type ComponentSchemaContext = {
  componentId: string;
  resolvedVersion: number;
  sourceHash: string | null;
  propsSchemaHash: string | null;
  catalogRevision: string | null;
  acceptedKeys: string[];
};
export type ValidationIssue = { path: string; pointer?: string; message: string; code?: string } & Partial<ComponentSchemaContext>;
export type PrototypeValidationResult = {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  /**
   * Архитектурные issue'ы, снятые `doc.architecture.exemptions` (волна 2).
   * Присутствует только когда исключение реально сработало; readiness-отчёт
   * волны 4 показывает их как `exempted`.
   */
  architecture?: { exempted: ArchitectureExemptedIssue[] };
};

export type ArchitectureExemptedIssue = {
  code: string;
  screenId: string;
  elementKey: string;
  path: string;
  message: string;
  reason: string;
  provenance?: string;
};
export type LoadedPrototype = PrototypeDoc;
