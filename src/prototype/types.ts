import type { PrototypeDoc } from "./schema";

export type ValidationIssue = { path: string; pointer?: string; message: string; code?: string };
export type PrototypeValidationResult = { errors: ValidationIssue[]; warnings: ValidationIssue[] };
export type LoadedPrototype = PrototypeDoc;
