import { prototypeDocSchema } from "./schema";
import { getPrototypeDraft, getPrototypeVersion, listPrototypes, type PrototypeDraft, type PrototypeSummary, type PrototypeVersion } from "../api/client";

export class InvalidPrototypeResponseError extends Error {
  readonly issues: unknown[];
  constructor(issues: unknown[]) {
    super("API returned an invalid prototype document");
    this.name = "InvalidPrototypeResponseError";
    this.issues = issues;
  }
}

function validateDoc<T extends PrototypeDraft | PrototypeVersion>(response: T): T {
  const parsed = prototypeDocSchema.safeParse(response.doc);
  if (!parsed.success) {
    throw new InvalidPrototypeResponseError(parsed.error.issues);
  }
  return { ...response, doc: parsed.data };
}

export const loadPrototypeList = (signal?: AbortSignal): Promise<PrototypeSummary[]> => listPrototypes(signal);
export const loadPrototypeDraft = async (id: string, signal?: AbortSignal): Promise<PrototypeDraft> => validateDoc(await getPrototypeDraft(id, signal));
export const loadPrototypeVersion = async (id: string, version: number, signal?: AbortSignal): Promise<PrototypeVersion> => validateDoc(await getPrototypeVersion(id, version, signal));
