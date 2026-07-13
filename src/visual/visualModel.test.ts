import { describe, expect, it } from "vitest";
import type { RunReport, VisualReference } from "./api";
import { describeFingerprint, evidenceDenominator, formatPercent, referenceScope, statusLabel, statusTone } from "./visualModel";

describe("visualModel", () => {
  it("labels every run status", () => {
    expect(statusLabel("pass")).toBe("Пройдено");
    expect(statusLabel("reference_missing")).toBe("Нет эталона");
    expect(statusLabel("running")).toBe("Выполняется…");
    for (const s of ["pass", "fail", "error", "reference_missing", "running"] as const) expect(statusTone(s)).toBeTruthy();
  });

  it("never fabricates a percentage", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(undefined)).toBe("—");
    expect(formatPercent(Number.NaN)).toBe("—");
    expect(formatPercent(6.6639)).toBe("6.6639%");
  });

  it("describes prototype and component fingerprints", () => {
    expect(describeFingerprint({ scope: "prototype-screen", prototypeId: "p", screenId: "welcome", refRevision: 3, viewport: { width: 343, height: 42 }, theme: "light" }))
      .toBe("p / welcome · rev 3 · 343×42 · light");
    expect(describeFingerprint({ scope: "component", componentId: "c", refVersion: 2, viewport: { width: 100, height: 200 }, theme: "dark" }))
      .toBe("c · v2 · 100×200 · dark");
  });

  it("classifies reference scope and reads the denominator", () => {
    const ref = { fingerprint: { scope: "component" } } as unknown as VisualReference;
    expect(referenceScope(ref)).toBe("Компонент");
    const report = { totalPixels: null, metrics: { "exact-rgba": { diffPixels: 0, totalPixels: 16, diffPercent: 0 } } } as unknown as RunReport;
    expect(evidenceDenominator(report)).toBe(16);
  });
});
