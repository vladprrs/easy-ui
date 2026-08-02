import type { Database } from "bun:sqlite";
import { z } from "zod";
import { ApiError } from "./http";
import { spaceTokens } from "../src/designSystems/types";

// --- Grammar (F.2) ---------------------------------------------------------
//
// A design-system theme is three strictly-validated collections:
//  - tokens: a flat map of dotted keys to a bounded string (no CSS-breaking chars)
//    or a finite number. Serialized into `--eui-<key>` CSS custom properties.
//  - fonts: asset-backed @font-face descriptors (src must be an existing font asset).
//  - icons: asset-backed icon registry entries (assetId + optional per-theme assetIds).
//
// The grammar below is intentionally conservative: everything that reaches CSS or the
// runtime snapshot is produced only from data that passed these checks.

export const ASSET_ID_RE = /^asset_[0-9a-f]{64}$/;

const tokenKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(\.[a-z0-9-]+)*$/, "token key must match ^[a-z][a-z0-9]*(\\.[a-z0-9-]+)*$");

const tokenValueSchema = z.union([
  z
    .string()
    .max(256, "token value must be at most 256 characters")
    .refine((value) => !/[;{}<>]/.test(value), { message: "token value must not contain ; { } < >" }),
  z.number().refine((value) => Number.isFinite(value), { message: "token value must be a finite number" }),
]);

export const tokensSchema = z.record(tokenKeySchema, tokenValueSchema);

const absolutePx = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?px$/;

export function spaceTokenIssues(tokens: Record<string, unknown>): { path: string[]; message: string }[] {
  const keys = Object.keys(tokens).filter((key) => key.startsWith("space."));
  if (keys.length === 0) return [];
  const issues: { path: string[]; message: string }[] = [];
  for (const token of spaceTokens) {
    const key = `space.${token}`;
    const value = tokens[key];
    if (typeof value !== "string" || !absolutePx.test(value)) issues.push({ path: [key], message: "must be a non-negative absolute px string" });
  }
  for (const key of keys) {
    if (!(spaceTokens as readonly string[]).includes(key.slice("space.".length))) issues.push({ path: [key], message: "unknown spacing token" });
  }
  if (tokens["space.none"] !== "0px") issues.push({ path: ["space.none"], message: "must equal 0px" });
  if (issues.length === 0) {
    const values = spaceTokens.map((token) => Number((tokens[`space.${token}`] as string).slice(0, -2)));
    for (let index = 1; index < values.length; index += 1) {
      if (values[index]! < values[index - 1]!) {
        issues.push({ path: [`space.${spaceTokens[index]}`], message: "spacing scale must be monotonic" });
      }
    }
  }
  return issues;
}

// Syntactic allowlist for `color.*` token values. The grammar already bans `;{}<>`; this narrows
// values to CSS color forms so a color token cannot smuggle arbitrary CSS. The key set stays open
// (the theme owns it — see plan D1); only the value shape is constrained.
//  - hex: #rgb / #rgba / #rrggbb / #rrggbbaa
//  - functions: rgb()/rgba()/hsl()/hsla()/var()/linear-gradient()/radial-gradient() with a digit/
//    letter/space/comma/dot/percent/hash/hyphen/slash/parens payload (covers `rgba(255,255,255,.98)`,
//    `var(--x, #fff)`, nested gradients)
//  - named colors: letters only (`transparent`, `white`, `currentColor`, …)
const COLOR_HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const COLOR_FN = /^(?:rgb|rgba|hsl|hsla|var|linear-gradient|radial-gradient)\([0-9a-zA-Z.,%#\-\s()/]*\)$/;
const COLOR_NAMED = /^[a-zA-Z]+$/;

function isColorValue(value: unknown): value is string {
  return typeof value === "string" && (COLOR_HEX.test(value) || COLOR_FN.test(value) || COLOR_NAMED.test(value));
}

// --- Namespaced value grammars for shadow/gradient color tokens ------------
//
// Wave 3 (H8) keeps shadows and gradients under the `color.*` namespace (read by the same
// ABI v4 `color()` runtime — no new ABI), but their values are not plain colors:
//  - `color.shadow-*` → one or a comma-list of CSS box-shadow strings
//        `[inset] <x> <y> [blur] [spread] <color>` (offsets may be negative, units optional per CSS)
//  - `color.gradient-*` → a linear-/radial-gradient() function value
// All other `color.*` keys keep the existing `isColorValue` allowlist unchanged.

// Reusable CSS color fragment (unanchored) — hex / rgb(a)/hsl(a) / named — for the trailing color of a shadow.
const CSS_COLOR = "(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(?:rgb|rgba|hsl|hsla)\\([0-9a-zA-Z.,%\\-\\s/]*\\)|[a-zA-Z]+)";
// A length: optional sign, digits, optional decimals, optional `px` (CSS allows a bare `0`).
const SHADOW_LEN = "-?\\d+(?:\\.\\d+)?(?:px)?";
// One shadow: optional `inset`, mandatory x/y offsets, up to two more lengths (blur, spread), then a color.
const ONE_SHADOW = `(?:inset\\s+)?${SHADOW_LEN}\\s+${SHADOW_LEN}(?:\\s+${SHADOW_LEN}){0,2}\\s+${CSS_COLOR}`;
const SHADOW_RE = new RegExp(`^${ONE_SHADOW}(?:\\s*,\\s*${ONE_SHADOW})*$`);
const GRADIENT_RE = /^(?:linear-gradient|radial-gradient)\([0-9a-zA-Z.,%#\-\s()/]*\)$/;

function isShadowValue(value: unknown): value is string {
  return typeof value === "string" && SHADOW_RE.test(value);
}
function isGradientValue(value: unknown): value is string {
  return typeof value === "string" && GRADIENT_RE.test(value);
}

export function colorTokenIssues(tokens: Record<string, unknown>): { path: string[]; message: string }[] {
  const issues: { path: string[]; message: string }[] = [];
  for (const [key, value] of Object.entries(tokens)) {
    if (!key.startsWith("color.")) continue;
    if (key.startsWith("color.shadow-")) {
      if (!isShadowValue(value)) issues.push({ path: [key], message: "shadow token value must be one or a comma-list of `[inset] <x> <y> [blur] [spread] <color>` box-shadows" });
    } else if (key.startsWith("color.gradient-")) {
      if (!isGradientValue(value)) issues.push({ path: [key], message: "gradient token value must be a linear-gradient() or radial-gradient()" });
    } else if (!isColorValue(value)) {
      issues.push({ path: [key], message: "color token value must be a hex, rgb(a)/hsl(a), var(), linear-gradient() or named color" });
    }
  }
  return issues;
}

const assetIdSchema = z.string().regex(ASSET_ID_RE, "must be an asset id (asset_<64 hex>)");
const familySchema = z
  .string()
  .min(1, "font family is required")
  .max(64, "font family must be at most 64 characters")
  .regex(/^[A-Za-z0-9 -]+$/, "font family must be letters, digits, spaces or hyphens");
const weightSchema = z.union([z.number().int().min(1).max(1000), z.enum(["normal", "bold"])]);
const styleSchema = z.enum(["normal", "italic", "oblique"]);

export const fontSchema = z.strictObject({
  family: familySchema,
  src: assetIdSchema,
  weight: weightSchema.optional(),
  style: styleSchema.optional(),
});

const slugSchema = z
  .string()
  .min(1, "icon name is required")
  .max(64, "icon name must be at most 64 characters")
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "icon name must be a slug");
const viewBoxSchema = z
  .string()
  .max(64)
  .regex(/^[0-9 .-]+$/, "viewBox must be numbers, spaces, dots or hyphens");

export const iconSchema = z.strictObject({
  name: slugSchema,
  assetId: assetIdSchema,
  viewBox: viewBoxSchema.optional(),
  themes: z.strictObject({ light: assetIdSchema.optional(), dark: assetIdSchema.optional() }).optional(),
});

export const fontsSchema = z.array(fontSchema);
export const iconsSchema = z.array(iconSchema);

export type ThemeToken = z.infer<typeof tokenValueSchema>;
export type ThemeFont = z.infer<typeof fontSchema>;
export type ThemeIcon = z.infer<typeof iconSchema>;
export interface ThemeContent {
  tokens: Record<string, ThemeToken>;
  fonts: ThemeFont[];
  icons: ThemeIcon[];
}

/**
 * PATCH-тело темы (план 2026-08-02 P6).
 *
 * Три режима, взаимоисключающие по каждой коллекции:
 *  - полная замена — `tokens`/`fonts`/`icons` (историческая семантика: переданная коллекция
 *    заменяет предыдущую, опущенная наследуется);
 *  - sparse-добавление — `addTokens`/`addFonts`/`addIcons` поверх `baseVersion` (политика
 *    `appendOnly`: удалять нельзя, конфликт значения → 409, а не тихая перезапись);
 *  - `dryRun: true` — валидация + дифф + итоговая `resolvedSpaceScale` без записи версии.
 *
 * Проверка полноты/монотонности `space.*` для sparse-режима невозможна на уровне тела (набор
 * достраивается из `baseVersion`), поэтому здесь проверяются только форма ключей и значений,
 * а полная шкала валидируется на смердженном контенте в роуте (`spaceTokenIssues`).
 */
const partialSpaceTokenIssues = (tokens: Record<string, unknown>): { path: string[]; message: string }[] => {
  const issues: { path: string[]; message: string }[] = [];
  for (const [key, value] of Object.entries(tokens)) {
    if (!key.startsWith("space.")) continue;
    const token = key.slice("space.".length);
    if (!(spaceTokens as readonly string[]).includes(token)) { issues.push({ path: [key], message: "unknown spacing token" }); continue; }
    if (typeof value !== "string" || !absolutePx.test(value)) issues.push({ path: [key], message: "must be a non-negative absolute px string" });
    else if (token === "none" && value !== "0px") issues.push({ path: [key], message: "must equal 0px" });
  }
  return issues;
};

export const themePatchSchema = z.strictObject({
  tokens: tokensSchema.optional(),
  fonts: fontsSchema.optional(),
  icons: iconsSchema.optional(),
  addTokens: tokensSchema.optional(),
  addFonts: fontsSchema.optional(),
  addIcons: iconsSchema.optional(),
  dryRun: z.boolean().optional(),
  baseVersion: z.number().int().min(0),
}).superRefine((patch, context) => {
  for (const [full, sparse] of [["tokens", "addTokens"], ["fonts", "addFonts"], ["icons", "addIcons"]] as const) {
    if (patch[full] !== undefined && patch[sparse] !== undefined) {
      context.addIssue({ code: "custom", path: [sparse], message: `${full} and ${sparse} are mutually exclusive` });
    }
  }
  if (patch.addTokens) {
    for (const issue of colorTokenIssues(patch.addTokens)) context.addIssue({ code: "custom", path: ["addTokens", ...issue.path], message: issue.message });
    for (const issue of partialSpaceTokenIssues(patch.addTokens)) context.addIssue({ code: "custom", path: ["addTokens", ...issue.path], message: issue.message });
  }
  if (!patch.tokens) return;
  // Color validation runs before the space early-return so a color-only PATCH is still checked.
  for (const issue of colorTokenIssues(patch.tokens)) context.addIssue({ code: "custom", path: ["tokens", ...issue.path], message: issue.message });
  if (!Object.keys(patch.tokens).some((key) => key.startsWith("space."))) return;
  for (const issue of spaceTokenIssues(patch.tokens)) context.addIssue({ code: "custom", path: ["tokens", ...issue.path], message: issue.message });
});
export type ThemePatch = z.infer<typeof themePatchSchema>;

function issuesFrom(error: z.ZodError): { path: (string | number)[]; message: string }[] {
  return error.issues.map((issue) => ({ path: issue.path.map((part) => (typeof part === "number" ? part : String(part))), message: issue.message }));
}

/** Parses a PATCH body against the theme grammar (structure only; asset existence is checked separately). */
export function parseThemePatch(value: unknown): ThemePatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "invalid_request", "Request body must be an object");
  const parsed = themePatchSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(422, "validation_failed", "Design-system theme is invalid", { issues: issuesFrom(parsed.error) });
  return parsed.data;
}

// --- Sparse (append-only) operations, no-op detection and diffs (план 2026-08-02 P6.1–6.2) ---

export interface AppendConflict { path: (string | number)[]; existing: unknown; incoming: unknown; message: string }

const fontKey = (font: ThemeFont): string => `${font.family}|${font.weight ?? "normal"}|${font.style ?? "normal"}`;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Sparse-мердж поверх контента `baseVersion`. Политика `appendOnly`:
 *  - ключа/шрифта/иконки нет → добавляется;
 *  - есть с идентичным значением → no-op (запись не растёт);
 *  - есть с другим значением → конфликт (роут отвечает 409), а не тихая перезапись;
 *  - удаление невозможно by construction — для него остаётся полный PATCH.
 */
export function applySparsePatch(previous: ThemeContent, patch: {
  addTokens?: Record<string, ThemeToken>; addFonts?: ThemeFont[]; addIcons?: ThemeIcon[];
}): { content: ThemeContent; conflicts: AppendConflict[] } {
  const conflicts: AppendConflict[] = [];
  const tokens = { ...previous.tokens };
  for (const [key, value] of Object.entries(patch.addTokens ?? {})) {
    if (key in tokens && !same(tokens[key], value)) {
      conflicts.push({ path: ["addTokens", key], existing: tokens[key], incoming: value, message: `token ${key} already exists with a different value` });
      continue;
    }
    tokens[key] = value;
  }
  const fonts = [...previous.fonts];
  for (const font of patch.addFonts ?? []) {
    const index = fonts.findIndex((existing) => fontKey(existing) === fontKey(font));
    if (index === -1) { fonts.push(font); continue; }
    if (!same(fonts[index], font)) conflicts.push({ path: ["addFonts", fontKey(font)], existing: fonts[index], incoming: font, message: `font ${fontKey(font)} already exists with a different source` });
  }
  const icons = [...previous.icons];
  for (const icon of patch.addIcons ?? []) {
    const index = icons.findIndex((existing) => existing.name === icon.name);
    if (index === -1) { icons.push(icon); continue; }
    if (!same(icons[index], icon)) conflicts.push({ path: ["addIcons", icon.name], existing: icons[index], incoming: icon, message: `icon ${icon.name} already exists with a different definition` });
  }
  return { content: { tokens, fonts, icons }, conflicts };
}

/**
 * Семантическое равенство контента тем: токены сравниваются как множество пар (порядок ключей
 * в JSON-словаре смысла не несёт), шрифты и иконки — по порядку (он влияет на каскад @font-face
 * и на выбор иконки). Именно этот предикат гасит создание версии (no-op detection, P6.1).
 */
export function themeContentEqual(a: ThemeContent, b: ThemeContent): boolean {
  const tokensOf = (content: ThemeContent) => JSON.stringify(Object.keys(content.tokens).sort().map((key) => [key, content.tokens[key]]));
  return tokensOf(a) === tokensOf(b) && same(a.fonts, b.fonts) && same(a.icons, b.icons);
}

export interface ThemeDiff {
  tokens: { added: Record<string, ThemeToken>; changed: Record<string, { from: ThemeToken; to: ThemeToken }>; removed: string[] };
  fonts: { added: ThemeFont[]; removed: ThemeFont[] };
  icons: { added: ThemeIcon[]; removed: ThemeIcon[] };
  changed: boolean;
}

/** Дифф «предыдущая версия → предлагаемый контент» для dry-run и для ответа apply. */
export function themeDiff(previous: ThemeContent, next: ThemeContent): ThemeDiff {
  const added: Record<string, ThemeToken> = {};
  const changed: Record<string, { from: ThemeToken; to: ThemeToken }> = {};
  for (const [key, value] of Object.entries(next.tokens)) {
    if (!(key in previous.tokens)) added[key] = value;
    else if (!same(previous.tokens[key], value)) changed[key] = { from: previous.tokens[key]!, to: value };
  }
  const removed = Object.keys(previous.tokens).filter((key) => !(key in next.tokens));
  const listDiff = <T,>(before: T[], after: T[]) => ({
    added: after.filter((item) => !before.some((other) => same(other, item))),
    removed: before.filter((item) => !after.some((other) => same(other, item))),
  });
  const fonts = listDiff(previous.fonts, next.fonts);
  const icons = listDiff(previous.icons, next.icons);
  return {
    tokens: { added, changed, removed },
    fonts, icons,
    changed: !themeContentEqual(previous, next),
  };
}

/**
 * Дыра (а) плана P6.3: полный PATCH токенов, из которого `space.*` выпали целиком, молча уводил
 * шкалу на базовую (для кастомных DS — каноническую). Под резолвером 2 такой патч **наследует**
 * `space.*` базовой версии, а не подменяет шкалу; наследование применяется только если у базовой
 * версии полный валидный набор (иначе исторический grandfathering малформленных шкал сломался бы).
 * Возвращает список унаследованных ключей — роут отдаёт его в ответе, чтобы наследование не было
 * ещё одной молчаливой подменой.
 */
export function inheritSpaceTokens(previous: ThemeContent, tokens: Record<string, ThemeToken>): { tokens: Record<string, ThemeToken>; inherited: string[] } {
  const previousSpaceKeys = Object.keys(previous.tokens).filter((key) => key.startsWith("space."));
  if (!previousSpaceKeys.length) return { tokens, inherited: [] };
  if (Object.keys(tokens).some((key) => key.startsWith("space."))) return { tokens, inherited: [] };
  if (spaceTokenIssues(previous.tokens).length) return { tokens, inherited: [] };
  const merged = { ...tokens };
  for (const key of previousSpaceKeys) merged[key] = previous.tokens[key]!;
  return { tokens: merged, inherited: previousSpaceKeys };
}

const FONT_MIMES = new Set(["font/woff2", "font/ttf", "font/otf"]);

/** Verifies every referenced asset exists and has the right kind (font vs image). 422 with issues. */
export function validateThemeAssets(db: Database, content: ThemeContent): void {
  const issues: { path: (string | number)[]; message: string }[] = [];
  const mimeOf = (id: string): string | null => {
    const row = db.query("SELECT mime FROM assets WHERE id=?").get(id) as { mime: string } | null;
    return row?.mime ?? null;
  };
  content.fonts.forEach((font, index) => {
    const mime = mimeOf(font.src);
    if (mime === null) issues.push({ path: ["fonts", index, "src"], message: `unknown asset: ${font.src}` });
    else if (!FONT_MIMES.has(mime)) issues.push({ path: ["fonts", index, "src"], message: `asset ${font.src} is not a font (mime ${mime})` });
  });
  content.icons.forEach((icon, index) => {
    const check = (id: string, path: (string | number)[]) => {
      const mime = mimeOf(id);
      if (mime === null) issues.push({ path, message: `unknown asset: ${id}` });
      else if (!mime.startsWith("image/")) issues.push({ path, message: `asset ${id} is not an image (mime ${mime})` });
    };
    check(icon.assetId, ["icons", index, "assetId"]);
    if (icon.themes?.light) check(icon.themes.light, ["icons", index, "themes", "light"]);
    if (icon.themes?.dark) check(icon.themes.dark, ["icons", index, "themes", "dark"]);
  });
  if (issues.length) throw new ApiError(422, "validation_failed", "Design-system theme references invalid assets", { issues });
}
