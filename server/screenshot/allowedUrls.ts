import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Reads the SPA build's entry file name as a stable rendererBuild id, or null. */
export function rendererBuildFrom(serveDist: string | undefined): string | null {
  if (!serveDist) return null;
  try {
    const manifest = JSON.parse(readFileSync(resolve(serveDist, ".vite/manifest.json"), "utf8")) as Record<string, { file?: string; isEntry?: boolean }>;
    const entry = Object.values(manifest).find((e) => e.isEntry && e.file);
    return entry?.file ?? null;
  } catch { return null; }
}

/**
 * Transitive SPA static allowlist. Primary path: enumerate every emitted
 * `file`/`css` from the Vite manifest (exact paths). Plus `/index.html` and a
 * `/fonts/` directory scan. Falls back to `/assets/` + `/fonts/` prefix entries
 * when no manifest is present. All entries are GET-only static.
 */
export function buildStaticAllowedUrls(serveDist: string | undefined): string[] {
  if (!serveDist) return [];
  const out = new Set<string>(["/index.html"]);
  let manifestOk = false;
  try {
    const manifest = JSON.parse(readFileSync(resolve(serveDist, ".vite/manifest.json"), "utf8")) as Record<string, { file?: string; css?: string[] }>;
    for (const entry of Object.values(manifest)) {
      if (entry.file) out.add(`/${entry.file}`);
      for (const css of entry.css ?? []) out.add(`/${css}`);
    }
    manifestOk = true;
  } catch { /* fall through to prefixes */ }
  if (!manifestOk) out.add("/assets/");
  // Fonts are emitted outside the JS manifest; scan the directory (or fall back to a prefix).
  try {
    for (const rel of walkFiles(resolve(serveDist, "fonts"))) out.add(`/fonts/${rel}`);
  } catch { out.add("/fonts/"); }
  return [...out];
}

function walkFiles(dir: string, base = ""): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...walkFiles(resolve(dir, entry.name), rel));
    else result.push(rel);
  }
  return result;
}
