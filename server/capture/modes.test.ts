import { describe, expect, test } from "bun:test";
import { isCaptureMode, resolveCaptureMode } from "./modes";
import { ACCEPTANCE_POLICIES } from "../acceptance/policies";
import { DEFAULT_READINESS_POLICY, STRICT_READINESS_POLICY } from "../../src/capture/readinessPolicy";
import { readinessPolicyHashOf } from "../acceptance/ids";

// R4 (план `docs/plans/2026-08-03-renderer-contract-2.md` §3 E8, §5 R4).

describe("capture modes", () => {
  test("режим — согласованная тройка «политика × доставка × полоса», а не новый путь капчура", () => {
    expect(resolveCaptureMode("interactive")).toEqual({ mode: "interactive", readiness: DEFAULT_READINESS_POLICY, deliver: "asset", background: false });
    expect(resolveCaptureMode("acceptance")).toMatchObject({ deliver: "bytes", background: true });
    expect(resolveCaptureMode("reference")).toMatchObject({ readiness: STRICT_READINESS_POLICY, deliver: "bytes" });
  });

  test("неизвестное имя не включает строгость молча", () => {
    expect(isCaptureMode("nope")).toBe(false);
    expect(resolveCaptureMode(undefined).mode).toBe("interactive");
    expect(resolveCaptureMode("nope").readiness).toBe(DEFAULT_READINESS_POLICY);
  });
});

describe("readiness политик приёмки", () => {
  /**
   * N10: строгость включается **политикой профиля**, а не env-флагом. `default-v1` остаётся на v1
   * — его перевод отдельный откатываемый шаг после приёмки волны; интерактивные пути политику не
   * получают вовсе и ведут себя как до волны.
   */
  test("pixel-strict-v1 требует v2, default-v1 остаётся на v1", () => {
    expect(ACCEPTANCE_POLICIES["pixel-strict-v1"].readiness).toBe(STRICT_READINESS_POLICY);
    expect(ACCEPTANCE_POLICIES["default-v1"].readiness).toBe(DEFAULT_READINESS_POLICY);
    // Хэши политик разные ⇒ `case_fingerprint` строгого профиля инвалидируется автоматически,
    // без bump'а версии схемы отпечатка (N5: bump в пакете ровно один, и он был в R1).
    expect(readinessPolicyHashOf(ACCEPTANCE_POLICIES["pixel-strict-v1"].readiness))
      .not.toBe(readinessPolicyHashOf(ACCEPTANCE_POLICIES["default-v1"].readiness));
    expect(readinessPolicyHashOf(DEFAULT_READINESS_POLICY)).toBe("5d5b5fb16425aa9d45c759724d6fc96b86253ca9153541cc960575dc8c3acbe7");
  });
});
