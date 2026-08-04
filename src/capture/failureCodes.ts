/**
 * Типизированный словарь исходов капчура — один на продукт
 * (план `docs/plans/2026-08-03-renderer-contract-2.md` §3 **E3**, §5 **R3**).
 *
 * До этой волны причина неуспеха жила ad-hoc строкой, склеенной запятой (`"fonts_timeout,images_failed"`),
 * и наружу по HTTP не выходила вовсе: клиент видел `capture_failed` и шёл смотреть PNG глазами
 * (§1.5, метрика K4). Здесь заводится **один** словарь на все каналы: поверхность, воркер, сервис,
 * гейты приёмки и HTTP-ручка джобы говорят одними и теми же девятью кодами.
 *
 * Два инварианта, которые держит этот файл (и его тест):
 *
 * 1. **`readinessReason` не производится из кодов и не заменяется ими.** Маппинг legacy-строк в
 *    коды **не биективен** (C-M5): `fonts_timeout` и `fonts_pending` схлопываются в один
 *    `font_load_failed`, `images_timeout` и `images_failed` — в один `image_load_failed`. Поэтому
 *    `reason` сохраняется как отдельное поле в доволновом формате, а `codes[]` едет **рядом**.
 * 2. **Каждый код объявляет своего эмитента и волну.** Код, который сегодня не эмитится ничем,
 *    обязан быть явно помечен волной, которая его введёт (R4 — строгая readiness, R6 — guard
 *    рендерера), иначе словарь тихо обрастал бы мёртвыми значениями.
 */

/** Девять кодов §3 E3. Расширение словаря — правка плана, а не походя добавленная строка. */
export type CaptureFailureCode =
  | "font_load_failed" | "font_face_missing" | "image_load_failed"
  | "layout_unstable" | "surface_missing" | "surface_overflow"
  | "renderer_mismatch" | "navigation_failed" | "runtime_error";

/**
 * `severity` — не украшение: `warning` означает «зафиксировано, вердикта не меняет» (напр.
 * `font_load_failed` до строгой политики R4), `error` — «кадр непригоден по этой причине».
 * `ref` — указатель на предмет (URL картинки, семейство шрифта, ключ элемента), если он известен.
 */
export interface CaptureCode {
  code: CaptureFailureCode;
  severity: "error" | "warning";
  detail: string;
  ref?: string;
}

export const CAPTURE_FAILURE_CODES: readonly CaptureFailureCode[] = [
  "font_load_failed", "font_face_missing", "image_load_failed",
  "layout_unstable", "surface_missing", "surface_overflow",
  "renderer_mismatch", "navigation_failed", "runtime_error",
] as const;

export const isCaptureFailureCode = (value: unknown): value is CaptureFailureCode =>
  typeof value === "string" && (CAPTURE_FAILURE_CODES as readonly string[]).includes(value);

/**
 * Кто и с какой волны эмитит код. `wave: "R3"` — код достижим уже сейчас (и его достижимость
 * проверяет `failureCodes.test.ts` фикстурой); `"R4"`/`"R6"` — код объявлен, но эмитента получит
 * в названной волне (строгая readiness / guard рендерера).
 */
export interface CaptureCodeOrigin {
  code: CaptureFailureCode;
  emitter: string;
  wave: "R3" | "R4" | "R6";
}

export const CAPTURE_CODE_ORIGINS: readonly CaptureCodeOrigin[] = [
  { code: "font_load_failed", emitter: "src/capture/readiness.ts (fonts_timeout|fonts_pending)", wave: "R3" },
  { code: "font_face_missing", emitter: "src/capture/readiness.ts settleFonts (required-faces)", wave: "R4" },
  { code: "image_load_failed", emitter: "src/capture/readiness.ts (images_timeout|images_failed)", wave: "R3" },
  { code: "layout_unstable", emitter: "src/capture/readiness.ts (frames_timeout); src/capture/stability.ts", wave: "R3" },
  { code: "surface_missing", emitter: "scripts/screenshot-worker.mjs (#eui-capture-surface отсутствует)", wave: "R3" },
  { code: "surface_overflow", emitter: "server/acceptance/gates/geometry2.ts (policyVerdict)", wave: "R3" },
  { code: "renderer_mismatch", emitter: "server/screenshot/service.ts (сверка манифеста); VisualService guard", wave: "R3" },
  { code: "navigation_failed", emitter: "scripts/screenshot-worker.mjs (page.goto)", wave: "R3" },
  { code: "runtime_error", emitter: "scripts/screenshot-worker.mjs (handshake/mismatch); readiness network_timeout", wave: "R3" },
] as const;

/**
 * Маппинг доволновых readiness-строк в коды (§3 E3). Значения `severity` намеренно консервативны:
 * до строгой политики R4 шрифты и тишина сети — предупреждение, а не обвинение кадра.
 */
export const READINESS_REASON_CODES: Readonly<Record<string, { code: CaptureFailureCode; severity: CaptureCode["severity"] }>> = Object.freeze({
  fonts_timeout: { code: "font_load_failed", severity: "warning" },
  fonts_pending: { code: "font_load_failed", severity: "warning" },
  images_timeout: { code: "image_load_failed", severity: "error" },
  images_failed: { code: "image_load_failed", severity: "error" },
  frames_timeout: { code: "layout_unstable", severity: "error" },
  network_timeout: { code: "runtime_error", severity: "warning" },
});

/**
 * Коды по списку readiness-причин. Схлопывание не теряет информацию: исходные строки уезжают в
 * `detail`, а сам `reason` сохраняется отдельным полем отчёта (инвариант 1 шапки файла).
 * Неизвестная строка не проглатывается: она честно становится `runtime_error`-предупреждением,
 * иначе новая причина, добавленная мимо словаря, была бы невидима наружу.
 */
export function codesFromReadinessReasons(reasons: readonly string[]): CaptureCode[] {
  const byCode = new Map<CaptureFailureCode, { severity: CaptureCode["severity"]; reasons: string[] }>();
  for (const reason of reasons) {
    const mapped = READINESS_REASON_CODES[reason] ?? { code: "runtime_error" as const, severity: "warning" as const };
    const entry = byCode.get(mapped.code);
    if (entry) {
      entry.reasons.push(reason);
      // Строгость выигрывает: один и тот же код, пришедший из `images_timeout` и `images_failed`,
      // остаётся ошибкой, а не размывается предупреждением.
      if (mapped.severity === "error") entry.severity = "error";
    } else {
      byCode.set(mapped.code, { severity: mapped.severity, reasons: [reason] });
    }
  }
  return [...byCode].map(([code, entry]) => ({
    code,
    severity: entry.severity,
    detail: `readiness: ${entry.reasons.join(", ")}`,
  }));
}

/** Тот же маппинг для доволнового склеенного `reason` (`"fonts_timeout,images_failed"`). */
export function codesFromReadinessReason(reason: string | null | undefined): CaptureCode[] {
  if (typeof reason !== "string" || reason.length === 0) return [];
  return codesFromReadinessReasons(reason.split(",").map((part) => part.trim()).filter((part) => part.length > 0));
}

/** Санитайзер кодов, приехавших из страницы/воркера: наружу уходят только объявленные значения. */
export function sanitizeCaptureCodes(value: unknown): CaptureCode[] {
  if (!Array.isArray(value)) return [];
  const codes: CaptureCode[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (!isCaptureFailureCode(record.code)) continue;
    const severity = record.severity === "error" || record.severity === "warning" ? record.severity : "error";
    codes.push({
      code: record.code,
      severity,
      detail: typeof record.detail === "string" ? record.detail : "",
      ...(typeof record.ref === "string" ? { ref: record.ref } : {}),
    });
  }
  return codes;
}
