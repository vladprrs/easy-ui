import type { PrototypeDoc } from "./schema";

export type ValidationIssue = { path: string; message: string };
export type PrototypeValidationResult = { errors: ValidationIssue[]; warnings: ValidationIssue[] };
export type LoadedPrototype = PrototypeDoc;
