/**
 * Единственный источник размеров устройств (WF-3, «Сквозные решения» п.5).
 *
 * Разделяет три независимых понятия:
 * 1. `canonicalViewport` — канонический viewport прототипа: размеры капчера и
 *    валидации. Неприкосновенен: декоративный bezel/статусбар живёт вне него.
 *    Desktop — auto-height (`null`): семантика capture не меняется.
 * 2. `previewNativeWidth` / `previewTile` — размеры превью-тайлов
 *    (CJM, лента редактора, галерея): native-ширина рендера до масштабирования
 *    и габариты самого тайла.
 * 3. `playerDesktopMinStageHeight` — player-only минимальная высота стейджа для
 *    desktop-прототипов. На канонический viewport и капчер не влияет.
 */

export type DeviceKind = "mobile" | "tablet" | "desktop";

export interface Viewport {
  width: number;
  height: number;
}

/**
 * 1. Канонический viewport per device. Источник истины для capture-shell,
 * серверного скриншот-механизма и валидации. Desktop = `null` (auto-height).
 */
export const canonicalViewport = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 834, height: 1112 },
  desktop: null,
} as const satisfies Record<DeviceKind, Viewport | null>;

/**
 * 2а. Native-ширина рендера экрана в превью-тайлах до масштабирования.
 * Для mobile/tablet совпадает с шириной канонического viewport; desktop
 * (auto-height) рендерится в превью на условной ширине 1280.
 */
export const previewNativeWidth = {
  mobile: canonicalViewport.mobile.width,
  tablet: canonicalViewport.tablet.width,
  desktop: 1280,
} as const satisfies Record<DeviceKind, number>;

/**
 * 2б. Габариты превью-тайла (CJM / лента редактора): ширина тайла, cap
 * высоты для auto-height экранов и fallback-высота до первого замера.
 */
export const previewTile = {
  width: 280,
  heightCap: 420,
  fallbackHeight: 360,
} as const;

/**
 * 2в. Тайл ленты редактора (W2-1): компактнее CJM-превью — cap высоты
 * ~180px, чтобы канвас и инспектор получали приоритет высоты в редакторе.
 * На канонический viewport и капчер не влияет.
 */
export const editorStripTile = {
  width: 280,
  heightCap: 180,
  fallbackHeight: 180,
} as const;

/**
 * 3. Player-only: минимальная высота стейджа плеера для desktop-прототипов
 * (auto-height). Потребляется лэйаутом плеера (W1-1); канонический viewport
 * и капчер не затрагивает.
 */
export const playerDesktopMinStageHeight = 720;
