import { describe, expect, test } from "bun:test";
import { isCaptureMode, resolveCaptureMode } from "./modes";
import { ACCEPTANCE_POLICIES } from "../acceptance/policies";
import { BARRIER_READINESS_POLICY, DEFAULT_READINESS_POLICY, STRICT_READINESS_POLICY } from "../../src/capture/readinessPolicy";
import { barrierAwareReadinessPolicy, readinessRequiresBarrier } from "./resourceBarrier";
import { readinessPolicyHashOf } from "../acceptance/ids";

// R4 (план `docs/plans/2026-08-03-renderer-contract-2.md` §3 E8, §5 R4) + W2 (план 2026-08-07).

describe("capture modes", () => {
  test("режим — согласованная тройка «политика × доставка × полоса», а не новый путь капчура", () => {
    expect(resolveCaptureMode("interactive")).toEqual({ mode: "interactive", readiness: DEFAULT_READINESS_POLICY, deliver: "asset", background: false });
    expect(resolveCaptureMode("acceptance")).toMatchObject({ deliver: "bytes", background: true });
    // W2: эталонная съёмка переведена на v3 (строгая + барьер ресурсов).
    expect(resolveCaptureMode("reference")).toMatchObject({ readiness: BARRIER_READINESS_POLICY, deliver: "bytes" });
  });

  test("неизвестное имя не включает строгость молча", () => {
    expect(isCaptureMode("nope")).toBe(false);
    expect(resolveCaptureMode(undefined).mode).toBe("interactive");
    expect(resolveCaptureMode("nope").readiness).toBe(DEFAULT_READINESS_POLICY);
  });
});

describe("readiness политик приёмки", () => {
  /**
   * W2 (план 2026-08-07 §1.5): точка включения барьера — **`ACCEPTANCE_POLICIES`**, и оба профиля
   * получают v3. До волны здесь было «`pixel-strict-v1` — v2, `default-v1` — v1»; после неё
   * профили расходятся только тем, куда откатывает их kill-switch.
   */
  test("оба профиля приёмки требуют v3 (барьер ресурсов)", () => {
    expect(ACCEPTANCE_POLICIES["pixel-strict-v1"].readiness).toBe(BARRIER_READINESS_POLICY);
    expect(ACCEPTANCE_POLICIES["default-v1"].readiness).toBe(BARRIER_READINESS_POLICY);
    expect(readinessRequiresBarrier(ACCEPTANCE_POLICIES["default-v1"].readiness)).toBe(true);
    // Хэш доволновой политики не двигается волной: он адресует старые кадры в reuse-кэше.
    expect(readinessPolicyHashOf(DEFAULT_READINESS_POLICY)).toBe("5d5b5fb16425aa9d45c759724d6fc96b86253ca9153541cc960575dc8c3acbe7");
    // v3 — другая политика ⇒ другой хэш ⇒ корпус приёмки честно инвалидируется (K-инвариант).
    expect(readinessPolicyHashOf(BARRIER_READINESS_POLICY)).not.toBe(readinessPolicyHashOf(STRICT_READINESS_POLICY));
    expect(readinessPolicyHashOf(BARRIER_READINESS_POLICY)).not.toBe(readinessPolicyHashOf(DEFAULT_READINESS_POLICY));
  });

  /**
   * Kill-switch возвращает **доволновую политику каждого профиля**, а не «всем v2» (§1.5): иначе
   * аварийное выключение барьера молча ужесточило бы `default-v1` до строгой readiness R4.
   */
  test("EASYUI_RESOURCE_BARRIER_DISABLED откатывает каждый скоуп в свою доволновую политику", () => {
    expect(barrierAwareReadinessPolicy("acceptance-default", true)).toBe(DEFAULT_READINESS_POLICY);
    expect(barrierAwareReadinessPolicy("acceptance-strict", true)).toBe(STRICT_READINESS_POLICY);
    expect(barrierAwareReadinessPolicy("reference", true)).toBe(STRICT_READINESS_POLICY);
    // Галерейный опт-ин при выключенном барьере — no-op, а не строгость: дефолт интерактива.
    expect(barrierAwareReadinessPolicy("gallery", true)).toBe(DEFAULT_READINESS_POLICY);
    for (const scope of ["acceptance-default", "acceptance-strict", "reference", "gallery"] as const) {
      expect(barrierAwareReadinessPolicy(scope, false)).toBe(BARRIER_READINESS_POLICY);
    }
    expect(readinessRequiresBarrier(barrierAwareReadinessPolicy("acceptance-default", true))).toBe(false);
  });
});
