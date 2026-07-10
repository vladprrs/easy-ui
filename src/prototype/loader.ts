import { prototypeDocSchema } from "./schema";
import { validatePrototype } from "./validate";
import type { LoadedPrototype } from "./types";

const modules = import.meta.glob("/prototypes/*.json", { eager: true, import: "default" }) as Record<string, unknown>;

export const prototypes: LoadedPrototype[] = Object.entries(modules).flatMap(([filename, value]) => {
  const parsed = prototypeDocSchema.safeParse(value);
  if (!parsed.success) {
    if (import.meta.env.DEV) console.error(`[prototype] ${filename}: invalid document`, parsed.error.issues);
    return [];
  }
  const result = validatePrototype(parsed.data);
  if (result.errors.length) {
    if (import.meta.env.DEV) console.error(`[prototype] ${filename}: semantic validation failed`, result.errors);
    return [];
  }
  if (import.meta.env.DEV && result.warnings.length) console.warn(`[prototype] ${filename}: warnings`, result.warnings);
  return [parsed.data];
});

export const prototypesById = new Map(prototypes.map((prototype) => [prototype.id, prototype]));
