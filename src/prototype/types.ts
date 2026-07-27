import type { PrototypeDoc } from "./schema";

export type ValidationIssue = { path: string; pointer?: string; message: string; code?: string };
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
