import { spaceTokens, type SpaceToken } from "./types";

export const canonicalSpacingScale: Record<SpaceToken, string> = {
  none: "0px", xs: "4px", sm: "8px", md: "12px", lg: "16px",
  xl: "24px", "2xl": "32px", "3xl": "48px", "4xl": "64px",
};

export const wireframeSpacingScale: Record<SpaceToken, string> = {
  none: "0px", xs: "4px", sm: "8px", md: "16px", lg: "24px",
  xl: "32px", "2xl": "48px", "3xl": "64px", "4xl": "80px",
};

export const yandexPaySpacingScale: Record<SpaceToken, string> = {
  none: "0px", xs: "4px", sm: "8px", md: "12px", lg: "16px",
  xl: "24px", "2xl": "32px", "3xl": "48px", "4xl": "64px",
};

export const shadcnSpacingScale: Record<SpaceToken, string> = {
  none: "0px", xs: "4px", sm: "8px", md: "12px", lg: "16px",
  xl: "24px", "2xl": "32px", "3xl": "48px", "4xl": "64px",
};

const systemScales: Record<string, Record<SpaceToken, string>> = {
  canonical: canonicalSpacingScale,
  wireframe: wireframeSpacingScale,
  "yandex-pay": yandexPaySpacingScale,
  shadcn: shadcnSpacingScale,
};

const pxValue = (value: unknown): number | null => {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?px$/.test(value)) return null;
  const parsed = Number(value.slice(0, -2));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

/** Resolves only from its arguments; loading or selecting a pinned theme is a caller concern. */
export function resolveSpacingScale(systemId: string, themeTokens: Record<string, string | number> = {}): Record<SpaceToken, string> {
  const base = systemScales[systemId] ?? canonicalSpacingScale;
  const spaceEntries = Object.entries(themeTokens).filter(([key]) => key.startsWith("space."));
  if (spaceEntries.length === 0) return { ...base };

  const overrides: Partial<Record<SpaceToken, string>> = {};
  for (const [key, value] of spaceEntries) {
    const token = key.slice("space.".length);
    if (!(spaceTokens as readonly string[]).includes(token) || pxValue(value) === null) return { ...canonicalSpacingScale };
    overrides[token as SpaceToken] = value as string;
  }
  const resolved = { ...canonicalSpacingScale, ...overrides };
  const values = spaceTokens.map((token) => pxValue(resolved[token]));
  if (resolved.none !== "0px" || values.some((value) => value === null)) return { ...canonicalSpacingScale };
  for (let index = 1; index < values.length; index += 1) {
    if (values[index]! < values[index - 1]!) return { ...canonicalSpacingScale };
  }
  return resolved;
}
