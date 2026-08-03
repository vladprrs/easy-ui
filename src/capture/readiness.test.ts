import { describe, expect, it } from "vitest";
import { collectCaptureEnv, observedCaptureEnvFingerprint, type CaptureEnvInput } from "./env";
import { collectReadiness, collectThemeAssets, collectThemeTokens, usedFontFamilies } from "./readiness";
import {
  canonicalReadinessPolicy, DEFAULT_READINESS_POLICY, isReadinessPolicy, readinessPolicyHash,
  type ReadinessPolicy,
} from "./readinessPolicy";

// W4 (план 2026-08-03 §3 D5, §5 W4): политика readiness, отпечаток окружения и сбор
// доказательства. DOM-часть гоняется в jsdom, поэтому проверяется структура доказательства
// (включая обязательные `themeResources`), а не пиксели — их предмет у e2e-спеки.

describe("readiness policy", () => {
  it("hashes canonically: key order does not matter, a changed condition changes the hash", async () => {
    const reordered = {
      timeoutMs: DEFAULT_READINESS_POLICY.timeoutMs,
      animations: DEFAULT_READINESS_POLICY.animations,
      frames: DEFAULT_READINESS_POLICY.frames,
      network: { scope: DEFAULT_READINESS_POLICY.network.scope, quietMs: DEFAULT_READINESS_POLICY.network.quietMs },
      images: DEFAULT_READINESS_POLICY.images,
      fonts: DEFAULT_READINESS_POLICY.fonts,
      version: DEFAULT_READINESS_POLICY.version,
    } as ReadinessPolicy;
    const base = await readinessPolicyHash(DEFAULT_READINESS_POLICY);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(await readinessPolicyHash(reordered)).toBe(base);
    expect(await readinessPolicyHash(DEFAULT_READINESS_POLICY)).toBe(base);

    // Смена любого условия обязана менять хэш: он и есть механизм инвалидации reuse (D1).
    for (const changed of [
      { ...DEFAULT_READINESS_POLICY, fonts: "document-ready" as const },
      { ...DEFAULT_READINESS_POLICY, frames: 3 },
      { ...DEFAULT_READINESS_POLICY, timeoutMs: 9_000 },
      { ...DEFAULT_READINESS_POLICY, network: { ...DEFAULT_READINESS_POLICY.network, quietMs: 400 } },
      { ...DEFAULT_READINESS_POLICY, animations: "allowed" as const },
    ]) expect(await readinessPolicyHash(changed)).not.toBe(base);

    expect(canonicalReadinessPolicy(DEFAULT_READINESS_POLICY).startsWith("{\"animations\"")).toBe(true);
  });

  it("rejects malformed policies from the bootstrap instead of honouring them", () => {
    expect(isReadinessPolicy(DEFAULT_READINESS_POLICY)).toBe(true);
    expect(isReadinessPolicy(undefined)).toBe(false);
    expect(isReadinessPolicy({ ...DEFAULT_READINESS_POLICY, version: 2 })).toBe(false);
    expect(isReadinessPolicy({ ...DEFAULT_READINESS_POLICY, network: { quietMs: 1 } })).toBe(false);
    expect(isReadinessPolicy({ ...DEFAULT_READINESS_POLICY, timeoutMs: 0 })).toBe(false);
  });
});

describe("capture env fingerprint", () => {
  const input: CaptureEnvInput = {
    browserVersion: "HeadlessChrome/140", platform: "Linux x86_64", dpr: 2,
    colorScheme: "light", colorProfile: "colorSchemeOnly", fontRasterFingerprint: "fnv1a:deadbeef",
    rendererBuild: "build-1", readinessPolicyHash: "policy-hash",
  };

  it("is deterministic for the same environment and moves with every input", async () => {
    const base = await observedCaptureEnvFingerprint(input);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(await observedCaptureEnvFingerprint({ ...input })).toBe(base);
    for (const changed of [
      { ...input, browserVersion: "HeadlessChrome/141" },
      { ...input, dpr: 3 },
      { ...input, colorScheme: "dark" as const },
      { ...input, fontRasterFingerprint: "fnv1a:00000000" },
      { ...input, rendererBuild: "build-2" },
      { ...input, readinessPolicyHash: "other" },
    ]) expect(await observedCaptureEnvFingerprint(changed)).not.toBe(base);
  });

  it("collects the same fingerprint twice in one environment", async () => {
    const options = { readinessPolicyHash: "policy-hash", rendererBuild: null, colorScheme: "light" as const };
    const first = await collectCaptureEnv(options);
    const second = await collectCaptureEnv(options);
    expect(first.fingerprint).toBe(second.fingerprint);
    // Отсутствующий 2d-контекст — честная деградация, а не молчаливое совпадение по пустоте.
    expect(first.input.fontRasterFingerprint).toBe("unavailable");
    expect(first.input.colorProfile).toBe("colorSchemeOnly");
  });
});

describe("readiness evidence", () => {
  const surface = (html: string): HTMLElement => {
    const root = document.createElement("div");
    root.id = "eui-capture-surface";
    root.innerHTML = html;
    document.body.append(root);
    return root;
  };

  it("reports fonts, images, frames and the theme resources W6 depends on", async () => {
    const root = surface(`
      <span style="color: var(--eui-color-fg); background: var(--eui-color-bg)">label</span>
      <img src="/api/assets/asset_icon" alt="icon" />
      <img src="/api/assets/asset_photo" alt="photo" />
    `);
    (globalThis as { __easyUiShared?: unknown }).__easyUiShared = {
      icons: { star: { assetUrl: "/api/assets/asset_icon" } },
    };

    const report = await collectReadiness(root, { ...DEFAULT_READINESS_POLICY, timeoutMs: 2_000, network: { quietMs: 0, scope: "component-owned" } });

    expect(report.policyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.evidence.images.total).toBe(2);
    expect(report.evidence.animationsDisabled).toBe(true);
    expect(report.evidence.framesWaited).toBe(2);
    // Наблюдённые ресурсы темы обязательны: без них класс «сменилась только тема» в W6 нереализуем.
    expect(report.evidence.themeResources.tokens).toEqual(["--eui-color-bg", "--eui-color-fg"]);
    expect(report.evidence.themeResources.icons).toEqual(["asset_icon"]);
    expect(report.evidence.themeResources.images).toEqual(["asset_photo"]);
    // jsdom не растеризует картинки: незагруженные попадают в pending, а не выдаются за готовые.
    expect(report.met).toBe(report.evidence.images.failed === 0);
    if (!report.met) expect(report.evidence.pendingRequests.some((item) => item.startsWith("image:"))).toBe(true);

    delete (globalThis as { __easyUiShared?: unknown }).__easyUiShared;
    root.remove();
  });

  it("collects used font families, tokens and assets from the surface only", () => {
    const root = surface('<p style="font-family: \'Ya Sans\', sans-serif; color: var(--eui-color-fg)">x</p>');
    const outside = document.createElement("div");
    outside.setAttribute("style", "color: var(--eui-outside-token)");
    document.body.append(outside);

    const elements = [root, ...Array.from(root.querySelectorAll("*"))];
    expect(usedFontFamilies(elements)).toContain("ya sans");
    expect(collectThemeTokens(elements)).toEqual(["--eui-color-fg"]);
    expect(collectThemeAssets(root, elements)).toEqual({ icons: [], images: [] });

    outside.remove();
    root.remove();
  });
});
