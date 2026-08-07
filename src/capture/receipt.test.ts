import { describe, expect, it } from "vitest";
import {
  buildCaptureReceipt, canonicalReceiptJson, stableReceiptView,
  type CaptureReceiptInput, type ReceiptRendererDeclaration,
} from "./receipt";

// R5 (план 2026-08-03-renderer-contract-2 §3 E4, §5 R5). Предмет теста — три обещания формы:
// receipt детерминирован (кроме `timings` и `provenance.builtAt`), `output: null` у измерительной
// джобы — факт, а не пропуск, и отсутствующее доказательство остаётся `null`, а не «всё хорошо».

const declaration: ReceiptRendererDeclaration = {
  rendererSchema: 2, rendererVersion: "r2", os: "linux", arch: "x64",
  nodeVersion: "24.5.0", playwrightVersion: "1.61.1", browserName: "chromium",
  browserVersion: "149.0.7827.55", browserRevision: "1210",
  launchedExecutable: "chrome-headless-shell", browserExecutableSha256: "a".repeat(64),
  fontStackSha256: "b".repeat(64), appFontsSha256: "c".repeat(64), systemLibsHash: "d".repeat(64),
  launchDeterminismArgsHash: "e".repeat(64), contextOptionsHash: "f".repeat(64),
  colorProfile: "srgb", source: "manifest",
  provenance: { buildSha: "deadbeef", imageRef: "ghcr.io/x:deadbeef", builtAt: "2026-08-04T10:00:00.000Z", bunVersion: "1.3.14" },
};

const evidence = {
  fontFaces: [
    { family: "YS Text", weight: "500", style: "normal", status: "loaded", required: true, checked: true, assetId: "asset_" + "1".repeat(64), sha256: "1".repeat(64) },
    { family: "YS Text", weight: "400", style: "normal", status: "loaded", required: true, checked: true, assetId: "asset_" + "2".repeat(64), sha256: "2".repeat(64) },
  ],
  images: { total: 1, decoded: 1, failed: 0 },
  imageDetails: [{ url: "/api/assets/asset_" + "3".repeat(64), assetId: "asset_" + "3".repeat(64), naturalWidth: 48, naturalHeight: 48, decoded: true, contentHash: "3".repeat(64) }],
  fontManifestHash: "9".repeat(64),
  pendingRequests: [],
  framesWaited: 2,
  animationsDisabled: true,
  themeResources: { tokens: ["--yp-color-bg"], icons: ["asset_" + "4".repeat(64)], images: [] },
};

const input = (overrides: Partial<CaptureReceiptInput> = {}): CaptureReceiptInput => ({
  renderer: declaration,
  fingerprint: "7".repeat(64),
  observedBrowserVersion: "149.0.7827.55",
  target: { kind: "component", componentId: "yp-button", version: 3, bundleHash: "bundle-1", dsMetaVersion: 7, propsHash: "8".repeat(64) },
  fontManifestHash: "9".repeat(64),
  readiness: { met: true, policyHash: "5".repeat(64), codes: [], elapsedMs: 120, evidence },
  console: { errors: [], warnings: ["slow"], pageErrors: [] },
  output: {
    viewport: { width: 390, height: 844 }, dpr: 2, colorScheme: "light",
    pngWidth: 780, pngHeight: 1688, pngSha256: "6".repeat(64),
    surfaceRect: { x: 0, y: 0, width: 390, height: 844 },
  },
  timings: { navigateMs: 40, readyMs: 130, screenshotMs: 60, totalMs: 260, readinessMs: 120 },
  captureClean: true,
  ...overrides,
});

describe("capture receipt (R5)", () => {
  it("детерминирован во всём, кроме таймингов и штампа сборки", () => {
    const first = buildCaptureReceipt(input());
    const second = buildCaptureReceipt(input({
      // Второй капчур того же входа: другие тайминги и другой штамп сборки того же образа.
      timings: { navigateMs: 51, readyMs: 400, screenshotMs: 71, totalMs: 522, readinessMs: 390 },
      renderer: { ...declaration, provenance: { ...declaration.provenance!, builtAt: "2026-08-04T23:59:59.000Z" } },
    }));

    expect(stableReceiptView(second)).toBe(stableReceiptView(first));
    // Инвариант «кроме»: без нормализации документы обязаны различаться — иначе тест доказывал бы
    // не детерминизм, а то, что волатильные поля не попали в receipt вовсе.
    expect(canonicalReceiptJson(second)).not.toBe(canonicalReceiptJson(first));
    expect(first.timings.navigateMs).toBe(40);
    expect(second.timings.navigateMs).toBe(51);
  });

  it("порядок faces не зависит от порядка обхода страницы", () => {
    const reversed = { ...evidence, fontFaces: [...evidence.fontFaces].reverse() };
    const direct = buildCaptureReceipt(input());
    const shuffled = buildCaptureReceipt(input({ readiness: { met: true, policyHash: "5".repeat(64), codes: [], elapsedMs: 120, evidence: reversed } }));
    expect(canonicalReceiptJson(shuffled)).toBe(canonicalReceiptJson(direct));
    expect(direct.resources.fontFaces.map((face) => face.weight)).toEqual(["400", "500"]);
  });

  it("ресурсы и цель переносятся из доказательства readiness без домысливания", () => {
    const receipt = buildCaptureReceipt(input());
    expect(receipt.receiptVersion).toBe(1);
    expect(receipt.renderer.fingerprint).toBe("7".repeat(64));
    expect(receipt.renderer.observedBrowserVersion).toBe("149.0.7827.55");
    expect(receipt.renderer.drift).toEqual([]);
    expect(receipt.target).toEqual({
      kind: "component", componentId: "yp-button", prototypeId: null, version: 3, rev: null,
      sourceHash: null, bundleHash: "bundle-1", dsMetaVersion: 7, propsHash: "8".repeat(64),
    });
    expect(receipt.resources.fontManifestHash).toBe("9".repeat(64));
    expect(receipt.resources.images).toHaveLength(1);
    expect(receipt.resources.images[0]!.decoded).toBe(true);
    expect(receipt.resources.themeResources?.tokens).toEqual(["--yp-color-bg"]);
    expect(receipt.verdict).toEqual({ captureClean: true, codes: [], readinessMet: true, readinessPolicyHash: "5".repeat(64) });
  });

  it("`output: null` у измерительной джобы, а отсутствие доказательства — не «готов»", () => {
    const receipt = buildCaptureReceipt(input({ output: null, readiness: null, timings: {} }));
    // probe:"geometry" — PNG в этой ветке не существует (C-M8).
    expect(receipt.output).toBeNull();
    // Шелл до волны W4 доказательства не шлёт: `null` вместо выдуманного «met».
    expect(receipt.verdict.readinessMet).toBeNull();
    expect(receipt.verdict.readinessPolicyHash).toBeNull();
    expect(receipt.resources.fontFaces).toEqual([]);
    expect(receipt.resources.images).toEqual([]);
    expect(receipt.resources.themeResources).toBeNull();
    // Неизмеренная фаза остаётся `null`, а не нулём: ноль означал бы «мгновенно».
    expect(receipt.timings).toEqual({
      navigateMs: null, fontsMs: null, imagesMs: null, networkMs: null, framesMs: null,
      stabilizeMs: null, screenshotMs: null, totalMs: null, readyMs: null, readinessMs: null,
      barrierMs: null,
    });
    // W2: барьера не было — `null`, а не пустой блок «как будто исполнен».
    expect(receipt.resources.resourceBarrier).toBeNull();
  });

  /**
   * W2 (план 2026-08-07 §W2): эхо барьера и пофазовые тайминги приезжают из доказательства
   * страницы. До волны `timings.fontsMs`/`imagesMs`/… были объявлены схемой, но всегда `null` —
   * измерить их мог только сам readiness.
   */
  it("раскладывает блок барьера и phaseTimings доказательства в receipt", () => {
    const receipt = buildCaptureReceipt(input({
      timings: {},
      readiness: {
        met: true, policyHash: "hash-v3", codes: [],
        evidence: {
          resourceBarrier: { expected: 4, decoded: 4, fontsReady: true, stableFrames: 2, lateAfterBarrier: [], durationMs: 812 },
          phaseTimings: { fontsMs: 40, imagesMs: 10, networkMs: 200, framesMs: 32, stabilizeMs: 16, barrierMs: 812 },
        },
      },
    }));
    expect(receipt.resources.resourceBarrier).toEqual({
      expected: 4, decoded: 4, fontsReady: true, stableFrames: 2, lateAfterBarrier: [], durationMs: 812,
    });
    expect(receipt.timings).toMatchObject({ fontsMs: 40, imagesMs: 10, networkMs: 200, framesMs: 32, stabilizeMs: 16, barrierMs: 812 });
    // Неполный блок — это отсутствие доказательства, а не «частично исполненный барьер».
    const broken = buildCaptureReceipt(input({
      timings: {},
      readiness: { met: true, policyHash: "hash-v3", codes: [], evidence: { resourceBarrier: { expected: 4 } } },
    }));
    expect(broken.resources.resourceBarrier).toBeNull();
    expect(broken.timings.barrierMs).toBeNull();
  });

  it("дрейф рендерера едет кодом, а мусорные коды отбрасываются санитайзером", () => {
    const receipt = buildCaptureReceipt(input({
      drift: [{ code: "renderer_mismatch", severity: "warning", detail: "declared 149.0.7827 vs observed 150.0.1" }],
      readiness: { met: false, policyHash: "5".repeat(64), codes: [{ code: "image_load_failed", severity: "error", detail: "broken", ref: "/api/assets/x" }], elapsedMs: 10, evidence },
      captureClean: false,
    }));
    expect(receipt.renderer.drift).toEqual([{ code: "renderer_mismatch", severity: "warning", detail: "declared 149.0.7827 vs observed 150.0.1" }]);
    expect(receipt.verdict.codes).toEqual([{ code: "image_load_failed", severity: "error", detail: "broken", ref: "/api/assets/x" }]);
    expect(receipt.verdict.captureClean).toBe(false);
  });
});
