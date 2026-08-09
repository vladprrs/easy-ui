import { describe, expect, test } from "bun:test";
import { isCaptureMode, resolveCaptureMode } from "./modes";
import { ACCEPTANCE_POLICIES } from "../acceptance/policies";
import { BARRIER_READINESS_POLICY_V3, BARRIER_READINESS_POLICY_V4, DEFAULT_READINESS_POLICY, STRICT_READINESS_POLICY } from "../../src/capture/readinessPolicy";
import { barrierAwareReadinessPolicy, readinessRequiresBarrier, readinessRequiresBarrierV4 } from "./resourceBarrier";
import { readinessPolicyHashOf } from "../acceptance/ids";

// R4 (план `docs/plans/2026-08-03-renderer-contract-2.md` §3 E8, §5 R4) + W2 (план 2026-08-07).

describe("capture modes", () => {
  test("режим — согласованная тройка «политика × доставка × полоса», а не новый путь капчура", () => {
    expect(resolveCaptureMode("interactive")).toEqual({ mode: "interactive", readiness: DEFAULT_READINESS_POLICY, deliver: "asset", background: false });
    expect(resolveCaptureMode("acceptance")).toMatchObject({ deliver: "bytes", background: true });
    // W2: эталонная съёмка переведена на барьерную политику; BR-03 поднял её до v4.
    expect(resolveCaptureMode("reference")).toMatchObject({ readiness: BARRIER_READINESS_POLICY_V4, deliver: "bytes" });
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
  test("оба профиля приёмки требуют барьер (BR-03: v4)", () => {
    expect(ACCEPTANCE_POLICIES["pixel-strict-v1"].readiness).toBe(BARRIER_READINESS_POLICY_V4);
    expect(ACCEPTANCE_POLICIES["default-v1"].readiness).toBe(BARRIER_READINESS_POLICY_V4);
    expect(readinessRequiresBarrier(ACCEPTANCE_POLICIES["default-v1"].readiness)).toBe(true);
    // Хэш доволновой политики не двигается волной: он адресует старые кадры в reuse-кэше.
    expect(readinessPolicyHashOf(DEFAULT_READINESS_POLICY)).toBe("5d5b5fb16425aa9d45c759724d6fc96b86253ca9153541cc960575dc8c3acbe7");
    // v3 — другая политика ⇒ другой хэш ⇒ корпус приёмки честно инвалидируется (K-инвариант).
    expect(readinessPolicyHashOf(BARRIER_READINESS_POLICY_V3)).not.toBe(readinessPolicyHashOf(STRICT_READINESS_POLICY));
    expect(readinessPolicyHashOf(BARRIER_READINESS_POLICY_V3)).not.toBe(readinessPolicyHashOf(DEFAULT_READINESS_POLICY));
  });

  /**
   * BR-03 (план 2026-08-08 §3): **дифференциальный** тест иерархии свитчей — предмет волны.
   *
   * 1. `EASYUI_RESOURCE_BARRIER_V4_DISABLED=1` обязан вернуть политику v3 **байт-в-байт**: тот же
   *    пре-образ и тот же `readinessPolicyHash`, что до волны, иначе аварийное выключение стоило бы
   *    пересъёмки всего корпуса — то есть было бы не откатом, а второй миграцией.
   * 2. Активная волна обязана дать **другой** хэш: смена политики и есть объявленная инвалидация
   *    кадров при включении (K-инвариант, тот же механизм, что у v2→v3).
   * 3. Старший свитч приоритетнее: при выключенном барьере значение v4-свитча не читается вовсе.
   */
  test("иерархия свитчей: v4-свитч возвращает v3 байт-в-байт, старший свитч приоритетнее", () => {
    // Доволновой хэш v3 — золотое значение: оно адресует уже снятые кадры в reuse-кэше.
    const v3Hash = readinessPolicyHashOf(BARRIER_READINESS_POLICY_V3);
    expect(readinessPolicyHashOf(barrierAwareReadinessPolicy("acceptance-default", false, true))).toBe(v3Hash);
    expect(barrierAwareReadinessPolicy("acceptance-strict", false, true)).toBe(BARRIER_READINESS_POLICY_V3);
    expect(readinessPolicyHashOf(barrierAwareReadinessPolicy("acceptance-default", false, false))).not.toBe(v3Hash);
    // Старший свитч перекрывает младший в обе стороны: политика — по-профильная доволновая.
    expect(barrierAwareReadinessPolicy("acceptance-default", true, false)).toBe(DEFAULT_READINESS_POLICY);
    expect(barrierAwareReadinessPolicy("acceptance-default", true, true)).toBe(DEFAULT_READINESS_POLICY);
    // Барьер под v4-свитчём остаётся барьером — гаснет ровно волна, а не фаза целиком.
    expect(readinessRequiresBarrier(barrierAwareReadinessPolicy("reference", false, true))).toBe(true);
    expect(readinessRequiresBarrierV4(barrierAwareReadinessPolicy("reference", false, true))).toBe(false);
    expect(readinessRequiresBarrierV4(barrierAwareReadinessPolicy("reference", false, false))).toBe(true);
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
      expect(barrierAwareReadinessPolicy(scope, false)).toBe(BARRIER_READINESS_POLICY_V4);
    }
    expect(readinessRequiresBarrier(barrierAwareReadinessPolicy("acceptance-default", true))).toBe(false);
  });
});
