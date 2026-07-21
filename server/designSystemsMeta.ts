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

export const themePatchSchema = z.strictObject({
  tokens: tokensSchema.optional(),
  fonts: fontsSchema.optional(),
  icons: iconsSchema.optional(),
  baseVersion: z.number().int().min(0),
}).superRefine((patch, context) => {
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
