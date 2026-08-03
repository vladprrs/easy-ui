/**
 * **Наблюдённая** проба окружения капчура (план §5 W4; переименована в R1 плана
 * renderer-contract-2 — §3 E2):
 *
 * ```
 * observedCaptureEnvFingerprint = sha256({ browserVersion, platform, dpr, colorScheme|colorProfile,
 *                                         fontRasterFingerprint, rendererBuild, readinessPolicyHash })
 * ```
 *
 * Имя говорит про эпистемологию, а не про красоту: это то, что видно **изнутри страницы** уже
 * после съёмки. Ключ reuse приёмки — другой отпечаток, объявленный сервером до капчура
 * (`server/capture/renderer.ts#rendererFingerprint`); держать рядом два разных
 * «captureEnvFingerprint» было бы приглашением перепутать наблюдение с объявлением.
 *
 * Зачем: два визуально одинаковых кадра, снятых в разных средах (другой chromium, другой
 * растеризатор шрифтов, другой DPR), сравнивать нельзя — и переиспользовать чужой вердикт тоже.
 * Отпечаток наблюдается **в самой странице** и уезжает в результат джобы и в evidence.
 *
 * Честные границы (§8 не-цели): точного ICC-профиля браузер странице не отдаёт, поэтому
 * `colorProfile` — best-effort и в отсутствие профиля деградирует до `"colorSchemeOnly"`, а не
 * притворяется знанием. `fontRasterFingerprint` — канвас-проба: эталонная строка рисуется в
 * offscreen canvas, пиксели хешируются; разный растеризатор/набор шрифтов даёт разное значение.
 */
import { canonicalStringify } from "./canonicalJson";
import { sha256Hex } from "./readinessPolicy";

export interface CaptureEnvInput {
  /** UA-строка браузера страницы; воркер знает точную версию chromium и кладёт её рядом. */
  browserVersion: string | null;
  platform: string;
  dpr: number;
  colorScheme: "light" | "dark";
  /** `"colorSchemeOnly"` — ICC-профиль недоступен (канон §8), иначе — наблюдённый gamut. */
  colorProfile: string;
  fontRasterFingerprint: string;
  rendererBuild: string | null;
  readinessPolicyHash: string;
}

export interface CaptureEnv {
  fingerprint: string;
  input: CaptureEnvInput;
}

/** Чистая функция отпечатка: те же входы — тот же хэш (тест детерминизма опирается на неё). */
export function observedCaptureEnvFingerprint(input: CaptureEnvInput): Promise<string> {
  return sha256Hex(canonicalStringify(input));
}

/** Эталонная строка канвас-пробы: латиница + кириллица + цифры + метрически «узкие» знаки. */
export const FONT_RASTER_SAMPLE = "EasyUI readiness — Ёжик 0123456789 iliWM";
const RASTER_WIDTH = 256;
const RASTER_HEIGHT = 48;

/** FNV-1a по байтам растра: дешёвый и стабильный — от него нужна различимость, не крипта. */
function fnv1a(bytes: Uint8Array | Uint8ClampedArray): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index]!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Канвас-проба растеризации. `"unavailable"` — честный исход там, где canvas не работает
 * (jsdom, headless без 2d-контекста): отпечаток остаётся детерминированным, просто беднее.
 */
export function fontRasterFingerprint(fontFamily: string): string {
  try {
    if (typeof document === "undefined") return "unavailable";
    // jsdom не умеет 2d-контекст и шумит «Not implemented» в консоль на каждый вызов: растр там
    // всё равно был бы `unavailable`, поэтому проба туда не ходит вовсе.
    if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent)) return "unavailable";
    const canvas = document.createElement("canvas");
    canvas.width = RASTER_WIDTH;
    canvas.height = RASTER_HEIGHT;
    const context = canvas.getContext("2d");
    if (!context) return "unavailable";
    context.clearRect(0, 0, RASTER_WIDTH, RASTER_HEIGHT);
    context.fillStyle = "#000000";
    context.textBaseline = "top";
    context.font = `16px ${fontFamily || "sans-serif"}`;
    context.fillText(FONT_RASTER_SAMPLE, 2, 2);
    const data = context.getImageData(0, 0, RASTER_WIDTH, RASTER_HEIGHT).data;
    return `fnv1a:${fnv1a(data)}`;
  } catch {
    // Тайнтед-канвас/отключённый 2d — не повод ронять капчур: отпечаток честно беднее.
    return "unavailable";
  }
}

/** Наблюдаемый gamut как best-effort замена ICC-профилю (§8): точного профиля странице не дают. */
function observedColorProfile(): string {
  try {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "colorSchemeOnly";
    if (window.matchMedia("(color-gamut: rec2020)").matches) return "gamut:rec2020";
    if (window.matchMedia("(color-gamut: p3)").matches) return "gamut:p3";
    if (window.matchMedia("(color-gamut: srgb)").matches) return "gamut:srgb";
    return "colorSchemeOnly";
  } catch { return "colorSchemeOnly"; }
}

/** Собирает окружение прямо в снимаемой странице (шрифт растра — фактический шрифт поверхности). */
export async function collectCaptureEnv(options: {
  readinessPolicyHash: string;
  rendererBuild: string | null;
  colorScheme: "light" | "dark";
  surfaceFontFamily?: string;
}): Promise<CaptureEnv> {
  const input: CaptureEnvInput = {
    browserVersion: typeof navigator === "undefined" ? null : navigator.userAgent,
    platform: typeof navigator === "undefined" ? "unknown" : (navigator.platform || "unknown"),
    dpr: typeof window === "undefined" ? 1 : window.devicePixelRatio,
    colorScheme: options.colorScheme,
    colorProfile: observedColorProfile(),
    fontRasterFingerprint: fontRasterFingerprint(options.surfaceFontFamily ?? "sans-serif"),
    rendererBuild: options.rendererBuild,
    readinessPolicyHash: options.readinessPolicyHash,
  };
  return { fingerprint: await observedCaptureEnvFingerprint(input), input };
}
