import { spaceTokens, type SpaceToken } from "./types";

export const canonicalSpacingScale: Record<SpaceToken, string> = {
  none: "0px", xs: "4px", sm: "8px", md: "12px", lg: "16px",
  xl: "24px", "2xl": "32px", "3xl": "48px", "4xl": "64px",
};

/** Frozen geometry contract for custom revisions stored in retired wireframe. */
export const wireframeSpacingScale: Record<SpaceToken, string> = Object.freeze({
  none: "0px", xs: "4px", sm: "8px", md: "16px", lg: "24px",
  xl: "32px", "2xl": "48px", "3xl": "64px", "4xl": "80px",
});

export const yandexPaySpacingScale: Record<SpaceToken, string> = {
  none: "0px", xs: "4px", sm: "8px", md: "12px", lg: "16px",
  xl: "24px", "2xl": "32px", "3xl": "48px", "4xl": "64px",
};

/** Frozen geometry contract for custom revisions stored in retired shadcn. */
export const shadcnSpacingScale: Record<SpaceToken, string> = Object.freeze({
  none: "0px", xs: "4px", sm: "8px", md: "12px", lg: "16px",
  xl: "24px", "2xl": "32px", "3xl": "48px", "4xl": "64px",
});

export const legacyDesignSystemSpacingScales = Object.freeze({
  wireframe: wireframeSpacingScale,
  shadcn: shadcnSpacingScale,
});

const systemScales: Record<string, Record<SpaceToken, string>> = {
  canonical: canonicalSpacingScale,
  ...legacyDesignSystemSpacingScales,
  "yandex-pay": yandexPaySpacingScale,
};

const pxValue = (value: unknown): number | null => {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?px$/.test(value)) return null;
  const parsed = Number(value.slice(0, -2));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

/**
 * Версия алгоритма резолва, записанная в строку версии темы (`design_system_versions.spacing_resolver`,
 * миграция v23, план 2026-08-02 P6.3).
 *
 * - `1` — историческое поведение, сохраняется байт-в-байт для всех существующих версий тем:
 *   частичные `space.*`-оверрайды кладутся на **каноническую** шкалу (а не на базовую шкалу DS),
 *   любой невалидный/немонотонный набор откатывается на каноническую шкалу.
 * - `2` — фикшеный мердж (план P6.3б): оверрайды и фолбэк идут на **базовую шкалу DS**.
 *   Пишется только новыми версиями тем и только при выключенном kill-switch
 *   `EASYUI_THEME_RESOLVER_V2_DISABLED`.
 *
 * Разница между `1` и `2` наблюдаема только там, где базовая шкала DS отличается от канонической
 * (сегодня — `wireframe`/`shadcn`; их темы неизменяемы, поэтому версию с резолвером `2` они получить
 * не могут). Для кастомных систем база — каноническая шкала, и оба резолвера совпадают.
 */
export type SpacingResolver = 1 | 2;
/** Резолвер существующих (домиграционных) версий тем; дефолт функции — он же, чтобы молчаливой смены поведения не случилось. */
export const LEGACY_SPACING_RESOLVER: SpacingResolver = 1;
/** Резолвер, которым помечаются новые версии тем. */
export const CURRENT_SPACING_RESOLVER: SpacingResolver = 2;

export function spacingBaseScale(systemId: string): Record<SpaceToken, string> {
  return systemScales[systemId] ?? canonicalSpacingScale;
}

type Resolution = { scale: Record<SpaceToken, string>; fallbackTriggered: boolean; spaceTokensPresent: boolean };

function resolve(systemId: string, themeTokens: Record<string, string | number>, resolver: SpacingResolver): Resolution {
  const base = spacingBaseScale(systemId);
  // Резолвер 1 сливает оверрайды и откатывается на каноническую шкалу даже там, где база DS другая
  // (баг base-drop, план §1.4); резолвер 2 использует базу DS в обеих ролях.
  const merged = resolver === 2 ? base : canonicalSpacingScale;
  const fallback = (): Resolution => ({ scale: { ...merged }, fallbackTriggered: true, spaceTokensPresent: true });
  const spaceEntries = Object.entries(themeTokens).filter(([key]) => key.startsWith("space."));
  if (spaceEntries.length === 0) return { scale: { ...base }, fallbackTriggered: false, spaceTokensPresent: false };

  const overrides: Partial<Record<SpaceToken, string>> = {};
  for (const [key, value] of spaceEntries) {
    const token = key.slice("space.".length);
    if (!(spaceTokens as readonly string[]).includes(token) || pxValue(value) === null) return fallback();
    overrides[token as SpaceToken] = value as string;
  }
  const resolved = { ...merged, ...overrides };
  const values = spaceTokens.map((token) => pxValue(resolved[token]));
  if (resolved.none !== "0px" || values.some((value) => value === null)) return fallback();
  for (let index = 1; index < values.length; index += 1) {
    if (values[index]! < values[index - 1]!) return fallback();
  }
  return { scale: resolved, fallbackTriggered: false, spaceTokensPresent: true };
}

/**
 * Resolves only from its arguments; loading or selecting a pinned theme is a caller concern.
 * `resolver` — версия алгоритма из строки версии темы; дефолт `1` (legacy) намеренно:
 * вызывающие read-пути обязаны передать резолвер явно, иначе поведение не меняется.
 */
export function resolveSpacingScale(
  systemId: string,
  themeTokens: Record<string, string | number> = {},
  resolver: SpacingResolver = LEGACY_SPACING_RESOLVER,
): Record<SpaceToken, string> {
  return resolve(systemId, themeTokens, resolver).scale;
}

export interface SpacingResolverDiagnostics {
  /** В токенах версии есть хотя бы один `space.*`. */
  spaceTokensPresent: boolean;
  /** Legacy-резолвер откатился на каноническую шкалу (невалидный/немонотонный набор). */
  fallbackTriggered: boolean;
  /** Legacy-мердж потерял базу DS: результат резолверов расходится вне фолбэка. */
  baseDropped: boolean;
  /** Итоговые шкалы обоих резолверов расходятся (включая расхождение внутри фолбэка). */
  differs: boolean;
  legacy: Record<SpaceToken, string>;
  fixed: Record<SpaceToken, string>;
}

/** Аудит версии темы: чем результат legacy-резолвера отличается от фикшеного (см. scripts/audit-spacing-resolver.ts). */
export function spacingResolverDiagnostics(systemId: string, themeTokens: Record<string, string | number> = {}): SpacingResolverDiagnostics {
  const legacy = resolve(systemId, themeTokens, 1);
  const fixed = resolve(systemId, themeTokens, 2);
  const differs = spaceTokens.some((token) => legacy.scale[token] !== fixed.scale[token]);
  return {
    spaceTokensPresent: legacy.spaceTokensPresent,
    fallbackTriggered: legacy.fallbackTriggered,
    baseDropped: differs && !legacy.fallbackTriggered,
    differs,
    legacy: legacy.scale,
    fixed: fixed.scale,
  };
}
