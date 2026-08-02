import type { DeviceKind, Surface } from "./schema";

/**
 * Чтение `doc.surfaces` (план `docs/plans/2026-08-02-multi-surface-flows.md`, D4).
 *
 * Модуль **оборонительный по построению**: его вызывают плеер и капчер на stored-документах,
 * которые могли быть записаны более новой версией формата (или прочитаны после отката образа).
 * Поэтому ни одна функция здесь не бросает и не полагается на инварианты валидации: любой
 * сюрприз (нет `surfaces`, экран без тега, неизвестный id) деградирует до **primary** —
 * `surfaces[0]` либо синтетической поверхности из скаляров документа (D3: они равны primary).
 */

/** Id синтетической primary-поверхности документа без `surfaces`. */
export const SYNTHETIC_PRIMARY_SURFACE_ID = "primary";

/** Минимальная форма документа, достаточная для резолва поверхностей (обе ветки схемы). */
export type SurfaceAwareDoc = {
  device?: DeviceKind;
  designSystem?: string;
  startScreen: string;
  surfaces?: readonly Surface[];
  screens: readonly { id: string; surface?: string }[];
};

const syntheticPrimary = (doc: SurfaceAwareDoc): Surface => ({
  id: SYNTHETIC_PRIMARY_SURFACE_ID,
  name: SYNTHETIC_PRIMARY_SURFACE_ID,
  device: doc.device ?? "desktop",
  startScreen: doc.startScreen,
  ...(doc.designSystem === undefined ? {} : { designSystem: doc.designSystem }),
});

/** true — документ авторски мульти-поверхностный (есть непустой `surfaces`). */
export const hasSurfaces = (doc: SurfaceAwareDoc): boolean => Boolean(doc.surfaces?.length);

/**
 * Нормализованный список поверхностей: сам `doc.surfaces`, а для обычного документа —
 * одна синтетическая primary. Возвращает **непустой** массив всегда.
 */
export function docSurfaces(doc: SurfaceAwareDoc): Surface[] {
  return doc.surfaces?.length ? [...doc.surfaces] : [syntheticPrimary(doc)];
}

/** Primary-поверхность (`surfaces[0]`) — по ней меряют документ непереведённые читатели (D3). */
export const primarySurface = (doc: SurfaceAwareDoc): Surface => docSurfaces(doc)[0]!;

/** Поверхность по id; `undefined` — неизвестный id (в том числе на stored-данных). */
export function surfaceById(doc: SurfaceAwareDoc, surfaceId: string | undefined): Surface | undefined {
  if (surfaceId === undefined) return undefined;
  return docSurfaces(doc).find((surface) => surface.id === surfaceId);
}

/**
 * Поверхность экрана. Фолбэк на primary — при отсутствии `surfaces`, отсутствии тега,
 * неизвестном id и неизвестном экране: у любого экрана всегда есть поверхность.
 */
export function surfaceOf(doc: SurfaceAwareDoc, screenId: string): Surface {
  const screen = doc.screens.find((candidate) => candidate.id === screenId);
  return surfaceById(doc, screen?.surface) ?? primarySurface(doc);
}

/** ДС поверхности: собственная либо ДС документа (D3 — дефолт равен ДС primary). */
export const surfaceDesignSystem = (surface: Surface, doc: SurfaceAwareDoc): string | undefined =>
  surface.designSystem ?? doc.designSystem;

/** Экраны поверхности в порядке документа. */
export const screensOfSurface = (doc: SurfaceAwareDoc, surfaceId: string): string[] =>
  doc.screens.filter((screen) => surfaceOf(doc, screen.id).id === surfaceId).map((screen) => screen.id);

/**
 * Разбор `step.companions` (D5) для читателей: возвращает только записи, которые
 * действительно резолвятся на этом документе. Неизвестные поверхности/экраны и записи про
 * собственную поверхность шага игнорируются — валидация их не пропускает, но stored-документ
 * мог быть записан другой версией формата.
 */
export function resolveStepCompanions(
  doc: SurfaceAwareDoc,
  step: { screenId: string; companions?: Record<string, string> },
): { surface: Surface; screenId: string }[] {
  if (!step.companions) return [];
  const own = surfaceOf(doc, step.screenId).id;
  const screenIds = new Set(doc.screens.map((screen) => screen.id));
  const resolved: { surface: Surface; screenId: string }[] = [];
  for (const [surfaceId, screenId] of Object.entries(step.companions)) {
    if (surfaceId === own || !screenIds.has(screenId)) continue;
    const surface = surfaceById(doc, surfaceId);
    if (!surface || surfaceOf(doc, screenId).id !== surfaceId) continue;
    resolved.push({ surface, screenId });
  }
  return resolved;
}
