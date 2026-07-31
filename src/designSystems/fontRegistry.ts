import type { ThemeContent } from "../api/client";
import { serializeFontFaceCss } from "./theme";

// Единственный владелец @font-face для инлайн-превью библиотеки: один <style> на пару
// designSystem@metaVersion, refcount по числу живых превью. Документный ThemeStyle работает в
// tokens-only режиме, поэтому дублей с ним нет.

/** `<style data-eui-fonts="yandex-pay@7">`. */
export function fontRegistryKey(designSystem: string, metaVersion: number | null | undefined): string {
  return `${designSystem}@${metaVersion ?? "head"}`;
}

interface FontRecord { count: number; style: HTMLStyleElement | null }

const records = new Map<string, FontRecord>();

function normalizeFamily(family: string): string {
  return family.trim().replace(/^["']|["']$/g, "").toLowerCase();
}

/** Семейства, уже доступные документу (в т.ч. объявленные CSS хрома). */
function documentFamilies(): Set<string> {
  const families = new Set<string>();
  const fonts: FontFaceSet | undefined = typeof document === "undefined" ? undefined : document.fonts;
  if (!fonts) return families;
  try {
    fonts.forEach((face) => families.add(normalizeFamily(face.family)));
  } catch {
    // FontFaceSet без итератора (старый jsdom) — считаем, что документ ничего не объявляет.
  }
  return families;
}

/**
 * Регистрирует @font-face темы и возвращает идемпотентный release.
 * Семейство, уже доступное документу, пропускается: тема yandex-pay переобъявляет "YS Text",
 * которым набран сам хром, и страница целиком перекачала бы те же байты по /api/assets/*.
 */
export function acquireThemeFonts(designSystem: string, metaVersion: number | null | undefined, content: ThemeContent): () => void {
  const key = fontRegistryKey(designSystem, metaVersion);
  let record = records.get(key);
  if (!record) {
    const existing = documentFamilies();
    const fonts = content.fonts.filter((font) => !existing.has(normalizeFamily(font.family)));
    const css = serializeFontFaceCss(fonts);
    let style: HTMLStyleElement | null = null;
    if (css) {
      style = document.createElement("style");
      style.dataset.euiFonts = key;
      style.textContent = css;
      document.head.append(style);
    }
    record = { count: 0, style };
    records.set(key, record);
  }
  record.count += 1;

  let released = false;
  const owned = record;
  return () => {
    if (released) return;
    released = true;
    owned.count -= 1;
    if (owned.count > 0) return;
    owned.style?.remove();
    if (records.get(key) === owned) records.delete(key);
  };
}

export function resetFontRegistryForTests(): void {
  for (const record of records.values()) record.style?.remove();
  records.clear();
}
