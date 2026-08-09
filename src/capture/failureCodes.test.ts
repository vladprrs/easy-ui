import { describe, expect, it } from "vitest";
import {
  CAPTURE_CODE_ORIGINS, CAPTURE_FAILURE_CODES, codesFromReadinessReason, codesFromReadinessReasons,
  isCaptureFailureCode, READINESS_REASON_CODES, sanitizeCaptureCodes,
  type CaptureFailureCode,
} from "./failureCodes";

// R3 (план 2026-08-03-renderer-contract-2 §3 E3, §5 R3): словарь исходов капчура. Предмет теста —
// не строки сами по себе, а два инварианта волны: **каждый код достижим** (фикстурой здесь либо
// названной фикстурой другого уровня, либо явно помечен волной-эмитентом) и **`reason` не
// подменяется кодами** (маппинг не биективен, C-M5).

/**
 * Как проверяется достижимость каждого кода. `unit` — фикстура прямо в этом файле; `fixture` —
 * фикстура другого уровня, названная файлом (её достижимость проверяет тот тест); `deferred` —
 * эмитента ещё нет, волна названа явно. Третий вариант — единственный законный способ иметь в
 * словаре код без эмитента, и он обязан совпадать с `CAPTURE_CODE_ORIGINS`.
 */
const REACHABILITY: Record<CaptureFailureCode, { kind: "unit"; codes: () => string[] } | { kind: "fixture"; where: string } | { kind: "deferred"; wave: "R4" | "R6" }> = {
  font_load_failed: { kind: "unit", codes: () => codesFromReadinessReasons(["fonts_timeout"]).map((item) => item.code) },
  image_load_failed: { kind: "unit", codes: () => codesFromReadinessReasons(["images_timeout", "images_failed"]).map((item) => item.code) },
  layout_unstable: { kind: "unit", codes: () => codesFromReadinessReasons(["frames_timeout"]).map((item) => item.code) },
  runtime_error: { kind: "unit", codes: () => codesFromReadinessReasons(["network_timeout"]).map((item) => item.code) },
  navigation_failed: { kind: "fixture", where: "scripts/screenshot-worker.mjs → server/screenshot-worker.test.ts + e2e/preview/capture-failure-codes.spec.ts" },
  surface_missing: { kind: "fixture", where: "scripts/screenshot-worker.mjs → server/screenshot-worker.test.ts + server/screenshot.test.ts" },
  surface_overflow: { kind: "fixture", where: "server/acceptance/gates/geometry2.ts → server/acceptance/gates/geometry2.test.ts" },
  renderer_mismatch: { kind: "fixture", where: "server/screenshot/service.ts → server/capture/renderer.test.ts" },
  // R4 посажен: эмитент — `settleFonts` в required-faces (`check()===false`).
  font_face_missing: { kind: "fixture", where: "src/capture/readiness.ts#settleFonts → src/capture/readiness.test.ts + e2e/preview/capture-strictness.spec.ts" },
  // W1a (план 2026-08-07): эмитент — `geometryCodes` по расходящимся поверхностям вердикта.
  surface_mismatch: { kind: "fixture", where: "server/acceptance/gates/geometry2.ts#geometryCodes → server/acceptance/gates/geometry2.test.ts" },
  // W1b: эмитент — `referenceExportCodes` на третьем исходе замера габаритов эталона.
  dimensions_irreconcilable: { kind: "fixture", where: "server/acceptance/gates/geometry2.ts#referenceExportCodes → server/acceptance/gates/geometry2.test.ts" },
  // W2 (план 2026-08-07 §W2): все четыре кода эмитит фаза барьера ресурсов внутри страницы.
  resource_barrier_timeout: { kind: "fixture", where: "src/capture/readiness.ts#settleResourceBarrier → src/capture/readiness.test.ts" },
  resource_decode_failed: { kind: "fixture", where: "src/capture/readiness.ts#settleResourceBarrier → src/capture/readiness.test.ts" },
  resource_late_after_barrier: { kind: "fixture", where: "src/capture/readiness.ts#settleResourceBarrier → src/capture/readiness.test.ts" },
  resource_manifest_overflow: { kind: "fixture", where: "src/capture/readiness.ts#collectResourceManifest → src/capture/readiness.test.ts" },
  // W9 (план 2026-08-07 §W9): эмитент — адаптер рантайма, сток дренируется сборкой readiness.
  runtime_props_parse_failed: { kind: "fixture", where: "src/player/easyUiRuntime.tsx → src/player/__tests__/runtimeDefaults.test.tsx + src/capture/readiness.test.ts" },
  // BR-02 (план 2026-08-08 §2): эмитент — гейт геометрии по названному ink clamp'у политики.
  paint_capture_clipped: { kind: "fixture", where: "server/acceptance/gates/geometry2.ts#paintClippedCodes → server/acceptance/gates/geometry2.test.ts" },
  // BR-03 (план 2026-08-08 §3): эмитент — гейт readiness, сужающий вердикт на барьерных причинах.
  resource_barrier_incomplete: { kind: "fixture", where: "server/acceptance/gates/readiness.ts (barrier-only met:false) → server/acceptance/gates/readiness.test.ts" },
  // BR-05 (план 2026-08-08 §5): эмитент — гейт геометрии по фактам замера
  // (`detail.ownershipViolations` → `gates/audit.ts#geometryOwnershipViolationCodes`).
  geometry_ownership_invalid: { kind: "fixture", where: "server/acceptance/gates/audit.ts#geometryOwnershipViolationCodes → server/acceptance/gates/geometry2.test.ts" },
};

describe("capture failure codes", () => {
  it("каждый код достижим фикстурой или явно помечен волной-эмитентом", () => {
    expect(new Set(CAPTURE_FAILURE_CODES).size).toBe(CAPTURE_FAILURE_CODES.length);
    expect(Object.keys(REACHABILITY).sort()).toEqual([...CAPTURE_FAILURE_CODES].sort());
    // Каждый код объявляет эмитента ровно один раз.
    expect(CAPTURE_CODE_ORIGINS.map((origin) => origin.code).sort()).toEqual([...CAPTURE_FAILURE_CODES].sort());

    for (const code of CAPTURE_FAILURE_CODES) {
      const plan = REACHABILITY[code];
      const origin = CAPTURE_CODE_ORIGINS.find((item) => item.code === code)!;
      if (plan.kind === "unit") {
        expect(plan.codes(), `${code} должен эмититься фикстурой этого теста`).toContain(code);
        expect(origin.wave).toBe("R3");
      } else if (plan.kind === "fixture") {
        expect(plan.where.length, `${code} обязан называть файл с фикстурой`).toBeGreaterThan(0);
        // Волна происхождения — R3 (typed codes) либо R4 (строгая readiness посадила эмитент).
        expect(["R3", "R4", "W1a", "W1b", "W2", "W9", "BR-02", "BR-03", "BR-05"]).toContain(origin.wave);
      } else {
        // Отложенный код обязан согласовываться с реестром: волна в одном месте, а не в двух.
        expect(origin.wave).toBe(plan.wave);
      }
      expect(isCaptureFailureCode(code)).toBe(true);
    }
    expect(isCaptureFailureCode("fonts_timeout")).toBe(false);
  });

  it("схлопывает не-биективный маппинг причин, сохраняя исходные строки в detail", () => {
    // Две legacy-строки → один код: ровно тот случай, ради которого `reason` остаётся полем (C-M5).
    const codes = codesFromReadinessReason("images_timeout,images_failed");
    expect(codes).toHaveLength(1);
    expect(codes[0]!.code).toBe("image_load_failed");
    expect(codes[0]!.severity).toBe("error");
    expect(codes[0]!.detail).toBe("readiness: images_timeout, images_failed");

    // Шрифты и тишина сети до строгой политики R4 — предупреждение, а не обвинение кадра.
    const soft = codesFromReadinessReason("fonts_timeout,fonts_pending,network_timeout");
    expect(soft.map((item) => `${item.code}:${item.severity}`)).toEqual(["font_load_failed:warning", "runtime_error:warning"]);

    // Все объявленные legacy-строки маппятся в объявленные коды — словарь замкнут.
    for (const [reason, mapped] of Object.entries(READINESS_REASON_CODES)) {
      expect(codesFromReadinessReason(reason)[0]!.code).toBe(mapped.code);
      expect(isCaptureFailureCode(mapped.code)).toBe(true);
    }
    // Неизвестная строка не проглатывается молча.
    const unknown = codesFromReadinessReason("some_new_reason");
    expect(unknown[0]!.code).toBe("runtime_error");
    expect(unknown[0]!.detail).toContain("some_new_reason");

    expect(codesFromReadinessReason(null)).toEqual([]);
    expect(codesFromReadinessReason("")).toEqual([]);
  });

  it("санитайзер пропускает только объявленные коды", () => {
    expect(sanitizeCaptureCodes([
      { code: "surface_missing", severity: "error", detail: "gone", ref: "#eui-capture-surface" },
      { code: "not_a_code", severity: "error", detail: "x" },
      { code: "layout_unstable", severity: "nonsense", detail: 7 },
      "garbage", null,
    ])).toEqual([
      { code: "surface_missing", severity: "error", detail: "gone", ref: "#eui-capture-surface" },
      // Непонятная severity — консервативно `error`, отсутствующий detail — пустая строка.
      { code: "layout_unstable", severity: "error", detail: "" },
    ]);
    expect(sanitizeCaptureCodes(undefined)).toEqual([]);
  });
});
