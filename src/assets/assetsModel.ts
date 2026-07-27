/**
 * Чистая модель Asset Workbench (волна 7.4, фидбэк §9).
 *
 * Что здесь ТОЧНО, а что ЭВРИСТИКА — это различие вынесено в UI и в тесты:
 *  · точно: MIME, размер в байтах, серверные width/height, usage-граф (пины БД),
 *    «неиспользуемый» (все четыре счётчика usage = 0), идентичность байтов
 *    (ассеты контент-адресуемы по sha256, поэтому равный id ⇒ равные байты);
 *  · эвристика: «тот же файл под другим id» (по имени/размерам — сервер не даёт
 *    ничего сильнее без перцептивного хеша, который вырезан из плана) и
 *    «растровый ассет при наличии SVG с похожим именем».
 */
import type { AssetListItem } from "../api/assetsApi";

export const RASTER_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
export const SVG_MIME = "image/svg+xml";

export const isRaster = (mime: string) => RASTER_MIMES.has(mime);
export const isSvg = (mime: string) => mime === SVG_MIME;
export const isImage = (mime: string) => isRaster(mime) || isSvg(mime);

export const usageTotal = (asset: Pick<AssetListItem, "usage">) =>
  asset.usage.prototypes + asset.usage.components + asset.usage.visualReferences + asset.usage.visualRuns;

export const isUnused = (asset: Pick<AssetListItem, "usage">) => usageTotal(asset) === 0;

/** sha256-хвост id: `asset_<64 hex>` → `ab12cd34…9f0e`. Полный id остаётся в copy-to-clipboard. */
export function shortAssetId(id: string): string {
  const sha = id.startsWith("asset_") ? id.slice("asset_".length) : id;
  return sha.length <= 16 ? sha : `${sha.slice(0, 8)}…${sha.slice(-4)}`;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} КБ`;
  return `${(size / (1024 * 1024)).toFixed(1)} МБ`;
}

/** Нормализованная основа имени файла: без пути, без расширения, регистр/разделители сглажены. */
export function baseNameKey(originalName: string | null | undefined): string | null {
  if (!originalName) return null;
  const file = originalName.split(/[\\/]/).pop() ?? "";
  const stem = file.replace(/\.[a-z0-9]+$/i, "");
  const key = stem.toLowerCase().replace(/[\s_@.-]+/g, "-").replace(/^-+|-+$/g, "");
  return key || null;
}

export interface MimeFacet { mime: string; count: number }

export function mimeFacets(assets: AssetListItem[]): MimeFacet[] {
  const counts = new Map<string, number>();
  for (const asset of assets) counts.set(asset.mime, (counts.get(asset.mime) ?? 0) + 1);
  return [...counts].map(([mime, count]) => ({ mime, count })).sort((a, b) => b.count - a.count || a.mime.localeCompare(b.mime));
}

export interface AssetFilters { query: string; mime: string | null; unusedOnly: boolean }
export const EMPTY_FILTERS: AssetFilters = { query: "", mime: null, unusedOnly: false };

/**
 * Поиск по префиксу id (с `asset_` или без) плюс подстрока в исходном имени —
 * имя единственный человекочитаемый якорь у непрозрачных `asset_<sha>`.
 */
export function matchesAssetQuery(asset: AssetListItem, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return true;
  const sha = asset.id.slice("asset_".length);
  const needle = query.startsWith("asset_") ? query.slice("asset_".length) : query;
  if (needle && sha.startsWith(needle)) return true;
  return (asset.originalName ?? "").toLowerCase().includes(query);
}

export function filterAssets(assets: AssetListItem[], filters: AssetFilters): AssetListItem[] {
  return assets.filter((asset) => {
    if (filters.mime && asset.mime !== filters.mime) return false;
    if (filters.unusedOnly && !isUnused(asset)) return false;
    return matchesAssetQuery(asset, filters.query);
  });
}

/**
 * ЭВРИСТИКА «тот же файл под другим id». Точные дубликаты невозможны по построению
 * (content addressing), поэтому группируем кандидатов по совпадающей основе имени —
 * это признак повторной загрузки пережатого/подправленного файла, не доказательство.
 */
export interface SameImageCandidateGroup { key: string; assets: AssetListItem[] }

export function sameImageCandidates(assets: AssetListItem[]): SameImageCandidateGroup[] {
  const groups = new Map<string, AssetListItem[]>();
  for (const asset of assets) {
    const key = baseNameKey(asset.originalName);
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.push(asset); else groups.set(key, [asset]);
  }
  return [...groups]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({ key, assets: [...group].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) }))
    .sort((a, b) => b.assets.length - a.assets.length || a.key.localeCompare(b.key));
}

/**
 * ЭВРИСТИКА «растр при живом SVG»: растровый ассет, у которого есть SVG с той же основой
 * имени. Ни имя, ни usage-счётчики не доказывают, что это одна и та же картинка.
 */
export interface RasterOverSvgWarning { rasterId: string; svgIds: string[]; key: string }

export function rasterOverSvgWarnings(assets: AssetListItem[]): RasterOverSvgWarning[] {
  const svgByKey = new Map<string, string[]>();
  for (const asset of assets) {
    const key = baseNameKey(asset.originalName);
    if (!key || !isSvg(asset.mime)) continue;
    const ids = svgByKey.get(key);
    if (ids) ids.push(asset.id); else svgByKey.set(key, [asset.id]);
  }
  const warnings: RasterOverSvgWarning[] = [];
  for (const asset of assets) {
    const key = baseNameKey(asset.originalName);
    if (!key || !isRaster(asset.mime)) continue;
    const svgIds = svgByKey.get(key);
    if (svgIds?.length) warnings.push({ rasterId: asset.id, svgIds: [...svgIds], key });
  }
  return warnings;
}

export function warningsByRasterId(warnings: RasterOverSvgWarning[]): Map<string, RasterOverSvgWarning> {
  return new Map(warnings.map((warning) => [warning.rasterId, warning]));
}
