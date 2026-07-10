export interface StorybookEntry {
  id: string;
  title: string;
  name: string;
  type: string;
}

export interface StorybookIndex {
  entries: Record<string, StorybookEntry>;
}

function parseEntry(value: unknown): StorybookEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || typeof entry.title !== "string" || typeof entry.name !== "string" || typeof entry.type !== "string") return null;
  return { id: entry.id, title: entry.title, name: entry.name, type: entry.type };
}

export function parseStorybookIndex(value: unknown): StorybookIndex | null {
  if (!value || typeof value !== "object") return null;
  const rawEntries = (value as Record<string, unknown>).entries;
  if (!rawEntries || typeof rawEntries !== "object" || Array.isArray(rawEntries)) return null;
  const entries = Object.fromEntries(Object.entries(rawEntries).flatMap(([key, raw]) => {
    const entry = parseEntry(raw);
    return entry ? [[key, entry]] : [];
  }));
  return Object.keys(entries).length ? { entries } : null;
}

export async function fetchStorybookIndex(timeoutMs = 3_000): Promise<StorybookIndex | null> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("/storybook/index.json", { signal: controller.signal });
    if (!response.ok) return null;
    return parseStorybookIndex(await response.json());
  } catch {
    return null;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}
