import { afterEach, describe, expect, it } from "vitest";
import { collectCaptureEnv, observedCaptureEnvFingerprint, type CaptureEnvInput } from "./env";
import { codesFromReadinessReasons, READINESS_REASON_CODES } from "./failureCodes";
import {
  collectReadiness, collectResourceManifest, collectThemeAssets, collectThemeTokens,
  documentDeclaresPseudoResources, fontFaceShorthand,
  fontShorthandWeight, requiredFontFaces, settleResourceBarrier, srcsetCandidates, usedFontFamilies,
  type ResourceDecodeOutcome,
} from "./readiness";
import type { CaptureFontFaceDeclaration } from "./protocol";
import { clearRuntimePropsWarningsForTests, recordRuntimePropsWarning } from "../catalog/runtimeDefaults";
import {
  BARRIER_READINESS_POLICY, BARRIER_READINESS_POLICY_V3, BARRIER_READINESS_POLICY_V4,
  barrierPolicyIsV4, canonicalReadinessPolicy, DEFAULT_READINESS_POLICY, isReadinessPolicy,
  perResourceTimeoutMs, readinessPolicyHash, STRICT_READINESS_POLICY, type ReadinessPolicy,
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

  /**
   * W9 (план 2026-08-07 §1.6): предупреждения рантайма о props, не сошедшихся со схемой флагнутого
   * компонента, дренируются сборкой доказательства и едут в receipt **предупреждением**. Проверяем
   * ровно то, что делает контракт волны отличным от контракта событий: `met` не падает.
   */
  it("дренирует предупреждения runtime-дефолтов, не роняя met", async () => {
    clearRuntimePropsWarningsForTests();
    recordRuntimePropsWarning("Badge", "label: expected string");
    recordRuntimePropsWarning("Badge", "label: expected string");
    const report = await collectReadiness(surface("<span>text</span>"), {
      ...DEFAULT_READINESS_POLICY, timeoutMs: 2_000, network: { quietMs: 0, scope: "component-owned" },
    });
    expect(report.met).toBe(true);
    expect(report.reason).toBeUndefined();
    expect(report.codes).toEqual([{
      code: "runtime_props_parse_failed", severity: "warning",
      detail: "label: expected string (×2)", ref: "Badge",
    }]);

    // Сток опустошён: следующий кадр той же страницы не наследует чужие предупреждения.
    const next = await collectReadiness(surface("<span>text</span>"), {
      ...DEFAULT_READINESS_POLICY, timeoutMs: 2_000, network: { quietMs: 0, scope: "component-owned" },
    });
    expect(next.codes).toEqual([]);
  });

  /**
   * R3: `codes` появляются **рядом**, а `reason` остаётся в доволновом формате — склеенная
   * запятыми строка тех же токенов, отсутствующая при выполненной политике. Это не косметика:
   * маппинг причин в коды не биективен (§3 E3, C-M5), уже записанные evidence-артефакты и метрики
   * гейта `readiness` читают именно `reason`, и импакт-анализ W6 сравнивает его как строку.
   */
  it("reason сохраняет доволновый формат, а codes едут рядом", async () => {
    // Картинка без растра в jsdom: политика не выполняется, причина непустая.
    const root = surface('<img src="/api/assets/asset_missing" alt="broken" />');
    const report = await collectReadiness(root, { ...DEFAULT_READINESS_POLICY, timeoutMs: 2_000, network: { quietMs: 0, scope: "component-owned" } });

    expect(report.met).toBe(false);
    expect(typeof report.reason).toBe("string");
    // Формат: только известные токены, разделитель — запятая без пробелов, без обёрток и префиксов.
    expect(report.reason).toMatch(/^[a-z_]+(,[a-z_]+)*$/);
    const tokens = report.reason!.split(",");
    expect(tokens).toContain("images_failed");
    for (const token of tokens) expect(Object.keys(READINESS_REASON_CODES)).toContain(token);
    // Коды — производное от тех же токенов, но не замена: две строки могут дать один код.
    expect(report.codes).toEqual(codesFromReadinessReasons(tokens));
    expect(report.codes.some((item) => item.code === "image_load_failed")).toBe(true);

    // Выполненная политика: поля `reason` нет вовсе (а не пустая строка), коды пусты.
    const ok = await collectReadiness(surface("<span>text</span>"), {
      ...DEFAULT_READINESS_POLICY, timeoutMs: 2_000, network: { quietMs: 0, scope: "component-owned" },
    });
    expect(ok.met).toBe(true);
    expect("reason" in ok).toBe(false);
    expect(ok.codes).toEqual([]);

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

// --- R4: строгая политика readiness 2.0 --------------------------------------------------
// (план `docs/plans/2026-08-03-renderer-contract-2.md` §5 R4)

describe("строгая политика v2", () => {
  /**
   * K-инвариант волны: политика v1 обязана давать **тот же** `policyHash`, что до неё. Хэш
   * политики входит в `case_fingerprint` (D1) и в отпечаток рендерера — его сдвиг обнулил бы весь
   * накопленный reuse приёмки молча. Значение снято с доволнового кода (коммит f54eec0).
   */
  it("v1 даёт доволновый policyHash, v2 — свой", async () => {
    expect(await readinessPolicyHash(DEFAULT_READINESS_POLICY))
      .toBe("5d5b5fb16425aa9d45c759724d6fc96b86253ca9153541cc960575dc8c3acbe7");
    expect(await readinessPolicyHash(STRICT_READINESS_POLICY))
      .not.toBe(await readinessPolicyHash(DEFAULT_READINESS_POLICY));
    expect(DEFAULT_READINESS_POLICY.version).toBe(1);
    expect("layout" in DEFAULT_READINESS_POLICY).toBe(false);
    expect(STRICT_READINESS_POLICY).toMatchObject({
      version: 2, fonts: "required-faces", images: "decoded-strict", layout: { stabilize: true, attempts: 3 },
    });
  });

  it("валидирует политику по версии: смесь v1-условий со строгими — испорченный bootstrap", () => {
    expect(isReadinessPolicy(STRICT_READINESS_POLICY)).toBe(true);
    expect(isReadinessPolicy({ ...STRICT_READINESS_POLICY, layout: undefined })).toBe(false);
    expect(isReadinessPolicy({ ...STRICT_READINESS_POLICY, layout: { stabilize: true, attempts: 0 } })).toBe(false);
    expect(isReadinessPolicy({ ...DEFAULT_READINESS_POLICY, layout: { stabilize: true, attempts: 3 } })).toBe(false);
    expect(isReadinessPolicy({ ...DEFAULT_READINESS_POLICY, fonts: "required-faces" })).toBe(false);
    expect(isReadinessPolicy({ ...STRICT_READINESS_POLICY, version: 3 })).toBe(false);
  });

  it("шорткод face'а нормализует variable-диапазон веса и стиль", () => {
    expect(fontShorthandWeight("400 700")).toBe("400");
    expect(fontShorthandWeight(500)).toBe("500");
    expect(fontShorthandWeight("bold")).toBe("bold");
    expect(fontShorthandWeight(undefined)).toBe("400");
    expect(fontFaceShorthand({ family: "Corpus Text", weight: "400 700", style: "italic" }))
      .toBe('400 italic 16px "Corpus Text"');
  });

  /** T-M10: required = declared ∩ observed-used-families. Тема вправе объявлять лишнее. */
  it("требует только те объявленные faces, чьё семейство наблюдено на поверхности", () => {
    const declared: CaptureFontFaceDeclaration[] = [
      { family: "Corpus Text", weight: "400", style: "normal", assetId: "asset_a", sha256: null },
      { family: "Never Used", weight: "400", style: "normal", assetId: "asset_b", sha256: null },
    ];
    const required = requiredFontFaces(declared, new Set(["corpus text"]));
    expect(required.map((face) => face.family)).toEqual(["Corpus Text"]);
  });
});

describe("readiness под строгой политикой", () => {
  const STRICT: ReadinessPolicy = { ...STRICT_READINESS_POLICY, timeoutMs: 2_000, network: { quietMs: 0, scope: "component-owned" } };

  /** Минимальный FontFaceSet: jsdom его не реализует, а вся строгость шрифтов — про него. */
  const installFontSet = (options: { available: string[]; faces?: { family: string; weight: string; style: string; status: string }[]; failing?: string[] }) => {
    const checked: string[] = [];
    const loaded: string[] = [];
    const set = {
      ready: Promise.resolve(),
      load(query: string) {
        loaded.push(query);
        return options.failing?.includes(query) ? Promise.reject(new Error("network")) : Promise.resolve([]);
      },
      check(query: string) { checked.push(query); return options.available.includes(query); },
      [Symbol.iterator]() { return (options.faces ?? [])[Symbol.iterator](); },
    };
    Object.defineProperty(document, "fonts", { value: set, configurable: true });
    return { checked, loaded };
  };

  const surface = (html: string): HTMLElement => {
    const root = document.createElement("div");
    root.id = "eui-capture-surface";
    root.innerHTML = html;
    document.body.append(root);
    return root;
  };

  const manifest = (declared: CaptureFontFaceDeclaration[]) => ({ declared, manifestHash: "manifest-hash" });

  afterEach(() => { Reflect.deleteProperty(document, "fonts"); });

  /**
   * Variable-шрифт объявляет диапазон весов (`"400 700"`). Без нормализации шорткода `check()`
   * получил бы невалидный ввод, и волна начала бы врать `font_face_missing` на каждой такой теме.
   */
  it("variable-шрифт weight:\"400 700\" не даёт ложного font_face_missing", async () => {
    const probe = installFontSet({ available: ['400 normal 16px "Corpus Text"'] });
    const root = surface('<p style="font-family: \'Corpus Text\', sans-serif">1 234 ₽</p>');

    const report = await collectReadiness(root, STRICT, {
      fonts: manifest([{ family: "Corpus Text", weight: "400 700", style: "normal", assetId: "asset_f", sha256: null }]),
    });

    expect(probe.checked).toEqual(['400 normal 16px "Corpus Text"']);
    expect(report.codes.some((code) => code.code === "font_face_missing")).toBe(false);
    expect(report.evidence.fontManifestHash).toBe("manifest-hash");
    // Обязательный face виден в доказательстве вместе с ассетом, по которому его объявила тема.
    expect(report.evidence.fontFaces).toContainEqual(expect.objectContaining({ family: "Corpus Text", required: true, checked: true, assetId: "asset_f" }));
    root.remove();
  });

  it("объявленный темой, но не использованный компонентом face не требуется", async () => {
    const probe = installFontSet({ available: ['400 normal 16px "Corpus Text"'] });
    const root = surface('<p style="font-family: \'Corpus Text\'">x</p>');

    const report = await collectReadiness(root, STRICT, {
      fonts: manifest([
        { family: "Corpus Text", weight: "400", style: "normal", assetId: "asset_a", sha256: null },
        { family: "Never Used", weight: "400", style: "normal", assetId: "asset_b", sha256: null },
      ]),
    });

    expect(probe.checked).toEqual(['400 normal 16px "Corpus Text"']);
    expect(report.codes.some((code) => code.code === "font_face_missing")).toBe(false);
    root.remove();
  });

  it("отсутствующий face темы — font_face_missing с указателем на семейство", async () => {
    installFontSet({ available: [], faces: [] });
    const root = surface('<p style="font-family: \'Corpus Missing\'">Шрифт не доехал</p>');

    const report = await collectReadiness(root, STRICT, {
      fonts: manifest([{ family: "Corpus Missing", weight: "400", style: "normal", assetId: "asset_0", sha256: null }]),
    });

    expect(report.met).toBe(false);
    const missing = report.codes.find((code) => code.code === "font_face_missing");
    expect(missing).toMatchObject({ severity: "error", ref: "Corpus Missing" });
    expect(report.reason).toContain("fonts_missing");
    // Доволновая семантика v1 на той же поверхности молчит: строгость приходит политикой.
    const lenient = await collectReadiness(surface('<p style="font-family: \'Corpus Missing\'">x</p>'), { ...DEFAULT_READINESS_POLICY, timeoutMs: 2_000, network: { quietMs: 0, scope: "component-owned" } });
    expect(lenient.codes.some((code) => code.code === "font_face_missing")).toBe(false);
    root.remove();
  });

  it("объявленный face со статусом error — font_load_failed, а не отсутствие", async () => {
    installFontSet({
      available: ['400 normal 16px "Corpus Text"'],
      faces: [{ family: "Corpus Text", weight: "400", style: "normal", status: "error" }],
    });
    const root = surface('<p style="font-family: \'Corpus Text\'">x</p>');

    const report = await collectReadiness(root, STRICT, {
      fonts: manifest([{ family: "Corpus Text", weight: "400", style: "normal", assetId: "asset_a", sha256: null }]),
    });

    expect(report.codes.some((code) => code.code === "font_load_failed")).toBe(true);
    expect(report.codes.some((code) => code.code === "font_face_missing")).toBe(false);
    root.remove();
  });

  /**
   * `decoded-strict`: картинка с растром, но без успешного `decode()`, больше не считается годной.
   * До волны такой кадр объявлялся готовым — это и есть дыра §1.4 плана.
   */
  it("decoded-strict валит картинку без декода, decoded — нет", async () => {
    installFontSet({ available: [] });
    const root = surface('<img src="/api/assets/asset_11" alt="half" />');
    const image = root.querySelector("img")!;
    Object.defineProperty(image, "complete", { value: true, configurable: true });
    Object.defineProperty(image, "naturalWidth", { value: 64, configurable: true });
    Object.defineProperty(image, "naturalHeight", { value: 0, configurable: true });
    Object.defineProperty(image, "decode", { value: () => Promise.reject(new Error("broken")), configurable: true });

    const strict = await collectReadiness(root, STRICT, { fonts: manifest([]) });
    expect(strict.met).toBe(false);
    // `img.src` в браузере — абсолютный URL: доказательство несёт ровно то, что запрашивалось.
    const failed = strict.codes.find((code) => code.code === "image_load_failed");
    expect(failed).toMatchObject({ severity: "error" });
    expect(failed?.ref).toContain("/api/assets/asset_11");
    expect(strict.evidence.imageDetails).toEqual([
      expect.objectContaining({ assetId: "asset_11", naturalWidth: 64, naturalHeight: 0, decoded: false, contentHash: null }),
    ]);

    const lenient = await collectReadiness(root, { ...DEFAULT_READINESS_POLICY, timeoutMs: 2_000, network: { quietMs: 0, scope: "component-owned" } });
    expect(lenient.evidence.images.failed).toBe(0);
    expect(lenient.evidence.imageDetails).toBeUndefined();
    root.remove();
  });

  it("contentHash берётся из id ассета, когда id каноничен", async () => {
    installFontSet({ available: [] });
    const sha = "a".repeat(64);
    const root = surface(`<img src="/api/assets/asset_${sha}" alt="ok" />`);
    const image = root.querySelector("img")!;
    Object.defineProperty(image, "complete", { value: true, configurable: true });
    Object.defineProperty(image, "naturalWidth", { value: 8, configurable: true });
    Object.defineProperty(image, "naturalHeight", { value: 8, configurable: true });
    Object.defineProperty(image, "decode", { value: () => Promise.resolve(), configurable: true });

    const report = await collectReadiness(root, STRICT, { fonts: manifest([]) });
    expect(report.evidence.imageDetails?.[0]).toMatchObject({ assetId: `asset_${sha}`, contentHash: sha, decoded: true });
    expect(report.codes.some((code) => code.code === "image_load_failed")).toBe(false);
    root.remove();
  });

  it("стабилизация layout едет в доказательстве и молчит на спокойной поверхности", async () => {
    installFontSet({ available: [] });
    const root = surface('<div data-eui-key="root"><span>стабильно</span></div>');
    const report = await collectReadiness(root, STRICT, { fonts: manifest([]) });
    expect(report.evidence.layout).toEqual({ stable: true, attempts: 1, elementKey: null });
    expect(report.codes.some((code) => code.code === "layout_unstable")).toBe(false);
    root.remove();
  });
});

/**
 * W2 (план 2026-08-07 §W2, P0.2) — детерминированный барьер ресурсов. Предмет тестов — три вещи,
 * которых доволновая readiness не умела: **видеть** ресурсы мимо `<img>` (CSS-фон, inline-SVG
 * `<image>`), **доказывать** отсутствие поздних ресурсов повторным дифом манифеста и **отказывать
 * изнутри страницы** по суммарному бюджету, до дедлайна джобы.
 */
describe("resource barrier (W2)", () => {
  const surface = (html: string): HTMLElement => {
    const root = document.createElement("div");
    root.id = "eui-capture-surface";
    root.innerHTML = html;
    document.body.append(root);
    return root;
  };
  const barrier = BARRIER_READINESS_POLICY.resourceBarrier!;
  /** Декодер-инъекция: тесты не зависят от того, умеет ли jsdom грузить растр. */
  const decodeAll = async (): Promise<ResourceDecodeOutcome> => "decoded";
  const barrierOptions = { decode: decodeAll, fontsReady: () => Promise.resolve(), frame: () => Promise.resolve() };

  it("видит CSS background и inline-SVG <image>, которых доволновая readiness не знала", async () => {
    const root = surface(`
      <div style="background-image: url(/api/assets/asset_bg)"></div>
      <div style="-webkit-mask-image: url(/api/assets/asset_mask)"></div>
      <svg><image href="/api/assets/asset_svg" /></svg>
      <img src="/api/assets/asset_img" alt="img" />
    `);
    const manifest = collectResourceManifest(root, [...root.querySelectorAll("*")], barrier.maxResources);
    const urls = manifest.entries.map((entry) => entry.url);
    expect(urls).toContain("/api/assets/asset_bg");
    expect(urls).toContain("/api/assets/asset_svg");
    expect(urls.some((url) => url.includes("asset_img"))).toBe(true);
    expect(manifest.overflow).toBe(false);

    const outcome = await settleResourceBarrier(root, { barrier, deadline: performance.now() + 5_000, ...barrierOptions });
    expect(outcome.evidence.expected).toBe(manifest.entries.length);
    expect(outcome.evidence.decoded).toBe(manifest.entries.length);
    expect(outcome.evidence.fontsReady).toBe(true);
    expect(outcome.evidence.stableFrames).toBe(barrier.stableFrames);
    expect(outcome.codes).toEqual([]);
    root.remove();
  });

  it("поздний ассет ловится дифом манифеста: resource_late_after_barrier и met:false", async () => {
    const root = surface('<div style="background-image: url(/api/assets/asset_bg)"></div>');
    // Ассет приезжает в DOM **во время** барьера — ровно тот класс дефекта, ради которого волна.
    const late = async (): Promise<ResourceDecodeOutcome> => {
      const node = document.createElement("div");
      node.setAttribute("style", "background-image: url(/api/assets/asset_late)");
      root.append(node);
      return "decoded";
    };
    const outcome = await settleResourceBarrier(root, { barrier, deadline: performance.now() + 5_000, ...barrierOptions, decode: late });
    expect(outcome.evidence.lateAfterBarrier).toEqual(["/api/assets/asset_late"]);
    const code = outcome.codes.find((item) => item.code === "resource_late_after_barrier");
    expect(code).toMatchObject({ severity: "error", ref: "/api/assets/asset_late" });
    expect(outcome.reasons).toContain("resource_late_after_barrier");

    // Тот же исход через `collectReadiness`: политика v3 отдаёт `met:false` и несёт эхо барьера.
    const root2 = surface('<div style="background-image: url(/api/assets/asset_bg2)"></div>');
    const report = await collectReadiness(root2, { ...BARRIER_READINESS_POLICY, timeoutMs: 3_000, network: { quietMs: 0, scope: "component-owned" } }, {
      barrier: {
        ...barrierOptions,
        decode: async () => {
          const node = document.createElement("div");
          node.setAttribute("style", "background-image: url(/api/assets/asset_late2)");
          root2.append(node);
          return "decoded";
        },
      },
    });
    expect(report.met).toBe(false);
    expect(report.reason?.split(",")).toContain("resource_late_after_barrier");
    expect(report.evidence.resourceBarrier?.lateAfterBarrier).toEqual(["/api/assets/asset_late2"]);
    expect(report.evidence.phaseTimings?.barrierMs).toBeGreaterThanOrEqual(0);
    root.remove();
    root2.remove();
  });

  it("отказывает по суммарному бюджету изнутри страницы, задолго до дедлайна джобы", async () => {
    const root = surface(`
      <div style="background-image: url(/api/assets/asset_a)"></div>
      <div style="background-image: url(/api/assets/asset_b)"></div>
    `);
    // Часы двигает сам тест: бюджет обязан кончиться по объявленному числу, а не по стенным часам.
    let clock = 0;
    const outcome = await settleResourceBarrier(root, {
      barrier: { ...barrier, budgetMs: 800 },
      // Дедлайн политики заведомо дальше бюджета: отказ обязан прийти по **бюджету барьера**.
      deadline: 60_000,
      now: () => clock,
      fontsReady: () => Promise.resolve(),
      frame: () => Promise.resolve(),
      decode: async () => { clock += 900; return "decoded"; },
    });
    const timeout = outcome.codes.find((code) => code.code === "resource_barrier_timeout");
    expect(timeout).toMatchObject({ severity: "error" });
    expect(timeout?.ref).toMatch(/^decode:\/api\/assets\/asset_/);
    expect(outcome.reasons).toContain("resource_barrier_timeout");
    // Фаза уложилась в свой бюджет с запасом относительно JOB_DEADLINE_MS (60 000 мс).
    expect(outcome.evidence.durationMs).toBeLessThan(2_000);
    root.remove();
  });

  it("декод-отказ и переполнение манифеста различаются severity", async () => {
    const root = surface('<div style="background-image: url(/api/assets/asset_broken)"></div>');
    const outcome = await settleResourceBarrier(root, {
      barrier, deadline: performance.now() + 5_000, ...barrierOptions, decode: async () => "failed",
    });
    expect(outcome.codes).toEqual([
      expect.objectContaining({ code: "resource_decode_failed", severity: "error", ref: "/api/assets/asset_broken" }),
    ]);
    expect(outcome.evidence.decoded).toBe(0);

    const wide = surface([...Array(5).keys()].map((index) => `<div style="background-image: url(/api/assets/asset_${index})"></div>`).join(""));
    const capped = await settleResourceBarrier(wide, {
      barrier: { ...barrier, maxResources: 2 }, deadline: performance.now() + 5_000, ...barrierOptions,
    });
    // Переполнение — предел **нашего** доказательства, а не дефект страницы: warning, кадр не валится.
    expect(capped.codes.find((code) => code.code === "resource_manifest_overflow")).toMatchObject({ severity: "warning", ref: "5" });
    expect(capped.reasons).toEqual([]);
    expect(capped.evidence.expected).toBe(2);
    root.remove();
    wide.remove();
  });

  it("политика v3 валидна только с барьерной веткой и двигает хэш", async () => {
    // Ветка v3 в `isReadinessPolicy` обязательна: без неё политика волны молча деградирует в v1
    // у поверхности (триаж C-M6), и «барьер не исполнялся» видно только по расхождению хешей.
    expect(isReadinessPolicy(BARRIER_READINESS_POLICY)).toBe(true);
    expect(isReadinessPolicy({ ...BARRIER_READINESS_POLICY, resourceBarrier: undefined })).toBe(false);
    expect(isReadinessPolicy({ ...BARRIER_READINESS_POLICY, version: 2 })).toBe(false);
    // Барьер в политике v1/v2 — испорченный bootstrap, а не «политика с барьером».
    expect(isReadinessPolicy({ ...DEFAULT_READINESS_POLICY, resourceBarrier: BARRIER_READINESS_POLICY.resourceBarrier })).toBe(false);
    expect(isReadinessPolicy({ ...STRICT_READINESS_POLICY, resourceBarrier: BARRIER_READINESS_POLICY.resourceBarrier })).toBe(false);
    // Бюджет сверх потолка §1.5 — не политика.
    expect(isReadinessPolicy({ ...BARRIER_READINESS_POLICY, resourceBarrier: { ...barrier, budgetMs: 8_001 } })).toBe(false);

    // Барьерные поля входят в канонизацию ⇒ двигают хэш (иначе reuse не инвалидируется).
    const base = await readinessPolicyHash(BARRIER_READINESS_POLICY);
    expect(canonicalReadinessPolicy(BARRIER_READINESS_POLICY)).toContain("resourceBarrier");
    for (const changed of [
      { ...BARRIER_READINESS_POLICY, resourceBarrier: { ...barrier, budgetMs: 4_000 } },
      { ...BARRIER_READINESS_POLICY, resourceBarrier: { ...barrier, maxResources: 128 } },
      { ...BARRIER_READINESS_POLICY, resourceBarrier: { ...barrier, stableFrames: 3 } },
    ]) expect(await readinessPolicyHash(changed as ReadinessPolicy)).not.toBe(base);
    expect(base).not.toBe(await readinessPolicyHash(STRICT_READINESS_POLICY));
    // Пер-ресурсный потолок — производная бюджета, а не отдельная ручка политики.
    expect(perResourceTimeoutMs(barrier)).toBe(1_000);
    expect(perResourceTimeoutMs({ ...barrier, budgetMs: 800 })).toBe(500);
  });
});

// ------------------------------------------------------------------ BR-03 (план 2026-08-08 §3)

/**
 * Полный registry-resource barrier. Предмет тестов — AC §3 плана: registry-иконки, приезжающие
 * темой, обнаруживаются **до** первого evidence frame; `expected=decoded`; `lateAfterBarrier=[]`;
 * кейс без картинок не обзаводится лишними зависимостями; недогруженный ассет назван поимённо
 * (assetId/owner/channel/phase). Плюс инвариант байтовой совместимости: политика v3 — прежняя.
 */
describe("resource barrier v4 (BR-03)", () => {
  const surface = (html: string): HTMLElement => {
    const root = document.createElement("div");
    root.id = "eui-capture-surface";
    root.innerHTML = html;
    document.body.append(root);
    return root;
  };
  const barrier4 = BARRIER_READINESS_POLICY_V4.resourceBarrier!;
  const barrier3 = BARRIER_READINESS_POLICY_V3.resourceBarrier!;
  const decodeAll = async (): Promise<ResourceDecodeOutcome> => "decoded";
  const options = { decode: decodeAll, fontsReady: () => Promise.resolve(), frame: () => Promise.resolve() };
  /** Реестр темы: тот же объект, что наполняет `applyActiveTheme`. */
  const installRegistry = (icons: Record<string, { assetUrl: string }>): void => {
    (globalThis as { __easyUiShared?: Record<string, unknown> }).__easyUiShared = { icons };
  };
  const clearRegistry = (): void => {
    delete (globalThis as { __easyUiShared?: unknown }).__easyUiShared;
  };
  afterEach(() => { clearRegistry(); for (const style of document.querySelectorAll("style[data-test]")) style.remove(); });

  it("фаза registry дожидается темы: registry-иконка попадает в манифест, expected=decoded, поздних нет", async () => {
    const root = surface("<div data-eui-key=\"root/0\"></div>");
    // Тема доезжает **после** старта барьера — ровно та гонка, из которой рождались поздние
    // registry-<img>: до волны манифест снимался раньше, чем `applyActiveTheme` наполнял реестр.
    let polls = 0;
    const icons = (): number => {
      polls += 1;
      if (polls === 2) {
        installRegistry({ star: { assetUrl: "/api/assets/asset_star" } });
        const image = document.createElement("img");
        image.setAttribute("src", "/api/assets/asset_star");
        image.setAttribute("data-eui-icon", "star");
        root.querySelector("[data-eui-key]")!.append(image);
      }
      return polls >= 2 ? 1 : 0;
    };
    const outcome = await settleResourceBarrier(root, {
      barrier: barrier4, deadline: performance.now() + 5_000, ...options,
      expectations: { themeIcons: 1 }, icons,
    });
    expect(outcome.evidence.registry).toMatchObject({ iconsExpected: 1, iconsObserved: 1, timedOut: false });
    expect(outcome.evidence.expected).toBe(1);
    expect(outcome.evidence.decoded).toBe(1);
    expect(outcome.evidence.lateAfterBarrier).toEqual([]);
    expect(outcome.codes).toEqual([]);
    // jsdom резолвит `img.src` в абсолютный URL — записи ищутся по `assetId`, а не по строке URL.
    const record = outcome.evidence.resources!.find((item) => item.assetId === "asset_star")!;
    // Иконка реестра опознана каналом, а не «просто картинкой»: это и есть класс дефекта волны.
    expect(record).toMatchObject({
      channel: "icon-registry", discoveredAt: "dom", assetId: "asset_star",
      ownerElementKey: "root/0", ownerComponentId: null,
      requested: true, loaded: true, decoded: true, completedBeforeStableFrame: true, phase: null,
    });
    root.remove();
  });

  it("темы нет — фаза завершается мгновенно, кейс без картинок не обзаводится зависимостями", async () => {
    const root = surface("<div>нет ни одной картинки</div>");
    const outcome = await settleResourceBarrier(root, {
      barrier: barrier4, deadline: performance.now() + 5_000, ...options,
      expectations: { themeIcons: 0 },
      // Реестра нет вовсе: `icons()` не должен вызываться в цикле — фаза выходит по объявлению.
      icons: () => 0,
      fontEntries: () => [],
    });
    expect(outcome.evidence.registry).toMatchObject({ iconsExpected: 0, iconsObserved: 0, timedOut: false });
    expect(outcome.evidence.registry!.waitedMs).toBeLessThan(100);
    expect(outcome.evidence.expected).toBe(0);
    expect(outcome.evidence.resources).toEqual([]);
    expect(outcome.codes).toEqual([]);
    expect(outcome.reasons).toEqual([]);
    root.remove();
  });

  it("исчерпанная фаза registry — типизированный resource_barrier_timeout с ref registry:…", async () => {
    const root = surface("<div></div>");
    const outcome = await settleResourceBarrier(root, {
      // Под-дедлайн фазы — внутри бюджета барьера, поэтому отказ приходит от **фазы**, а не от джобы.
      barrier: { ...barrier4, registryDeadlineMs: 40 },
      deadline: performance.now() + 5_000, ...options,
      expectations: { themeIcons: 3 }, icons: () => 0, fontEntries: () => [],
    });
    expect(outcome.evidence.registry).toMatchObject({ iconsExpected: 3, iconsObserved: 0, timedOut: true });
    expect(outcome.codes.find((code) => code.code === "resource_barrier_timeout")).toMatchObject({
      severity: "error", ref: "registry:0/3",
    });
    expect(outcome.reasons).toContain("resource_barrier_timeout");
    root.remove();
  });

  it("каналы: srcset и шрифты — report-only, ожидаемые ассеты кандидата не требуют декода", async () => {
    const root = surface(`
      <img data-eui-key="k1" src="/api/assets/asset_main" srcset="/api/assets/asset_2x 2x, /api/assets/asset_3x 3x" />
    `);
    const manifest = collectResourceManifest(root, [...root.querySelectorAll("*")], barrier4.maxResources, {
      channels: true,
      expectedAssets: ["asset_declared"],
      fontEntries: [{ family: "Inter", weight: "400", style: "normal", status: "loaded" }],
    });
    const byAsset = new Map(manifest.entries.map((entry) => [entry.assetId ?? entry.url, entry]));
    expect(byAsset.get("asset_2x")).toMatchObject({ channel: "img-srcset", reportOnly: true });
    expect(byAsset.get("font:Inter|400|normal")).toMatchObject({ channel: "font", reportOnly: true, loaded: true });
    expect(byAsset.get("asset_declared")).toMatchObject({ discoveredAt: "bundle", reportOnly: true });
    // Уже наблюдённый ассет вторым (report-only) дублем не приезжает — иначе каждая объявленная
    // и отрендеренная иконка удваивала бы записи ровно там, где ищут недоехавшую.
    expect(manifest.entries.filter((entry) => entry.assetId === "asset_main")).toHaveLength(1);
    // Реальный `<img>` — цель декода: ключа `reportOnly` у него нет вовсе.
    expect(byAsset.get("asset_main")).toMatchObject({ channel: "img" });
    expect(byAsset.get("asset_main")).not.toHaveProperty("reportOnly");

    // Решение (в): decode-цель — только `currentSrc`, поэтому `expected` считает один ресурс из
    // пяти записей; иначе фаза декода утроилась бы на каждом responsive-изображении.
    const decoded: string[] = [];
    const outcome = await settleResourceBarrier(root, {
      barrier: barrier4, deadline: performance.now() + 5_000, ...options,
      expectations: { themeIcons: 0, expectedAssets: ["asset_declared"] },
      icons: () => 0,
      fontEntries: () => [{ family: "Inter", weight: "400", style: "normal", status: "loaded" }],
      decode: async (url) => { decoded.push(url); return "decoded"; },
    });
    expect(decoded.map((url) => url.replace(/^https?:\/\/[^/]+/, ""))).toEqual(["/api/assets/asset_main"]);
    expect(outcome.evidence.expected).toBe(1);
    expect(outcome.evidence.decoded).toBe(1);
    expect(outcome.evidence.resources!.map((item) => item.channel).sort())
      .toEqual(["font", "img", "img-srcset", "img-srcset", "img"].sort());
    root.remove();
  });

  it("псевдоэлементы: канал пропускается без правил и включается по документному предикату", () => {
    const root = surface("<div class=\"pseudo-host\"></div>");
    expect(documentDeclaresPseudoResources()).toBe(false);
    const style = document.createElement("style");
    style.dataset.test = "";
    style.textContent = ".pseudo-host::before{content:url(/api/assets/asset_pseudo)}";
    document.head.append(style);
    // Предикат — один скан таблиц стилей документа, а не поэлементная проверка (решение (б)).
    expect(documentDeclaresPseudoResources()).toBe(true);
    root.remove();
  });

  it("srcset-парсер берёт URL кандидата, а не дескриптор", () => {
    expect(srcsetCandidates("/a.png 1x, /b.png 2x")).toEqual(["/a.png", "/b.png"]);
    expect(srcsetCandidates(null)).toEqual([]);
  });

  it("недогруженный ассет назван поимённо: assetId, владелец, канал и фаза", async () => {
    installRegistry({ star: { assetUrl: "/api/assets/asset_star" } });
    const root = surface('<div data-eui-key="card/1"><img src="/api/assets/asset_star" data-eui-icon="star" /></div>');
    const outcome = await settleResourceBarrier(root, {
      barrier: barrier4, deadline: performance.now() + 5_000, ...options,
      expectations: { themeIcons: 1 }, icons: () => 1, fontEntries: () => [],
      decode: async () => "failed",
    });
    const record = outcome.evidence.resources!.find((item) => item.assetId === "asset_star")!;
    expect(record).toMatchObject({
      assetId: "asset_star", ownerElementKey: "card/1", channel: "icon-registry",
      phase: "decode", decoded: false, completedBeforeStableFrame: false,
    });
    expect(outcome.reasons).toContain("resource_decode_failed");
    root.remove();
  });

  it("политика v3 остаётся байт-в-байт доволновой: ни каналов, ни записей, ни фазы registry", async () => {
    expect(barrierPolicyIsV4(barrier3)).toBe(false);
    expect(barrierPolicyIsV4(barrier4)).toBe(true);
    expect(isReadinessPolicy(BARRIER_READINESS_POLICY_V4)).toBe(true);
    // «v4 без фазы» и «v3 с фазой» — испорченный bootstrap, а не половина волны.
    expect(isReadinessPolicy({ ...BARRIER_READINESS_POLICY_V4, resourceBarrier: barrier3 })).toBe(false);
    expect(isReadinessPolicy({ ...BARRIER_READINESS_POLICY_V3, resourceBarrier: barrier4 })).toBe(false);
    // Хэш v3 не двигается волной (он адресует уже снятые кадры), хэш v4 — обязан отличаться.
    expect(await readinessPolicyHash(BARRIER_READINESS_POLICY_V3)).toBe(await readinessPolicyHash(BARRIER_READINESS_POLICY));
    expect(await readinessPolicyHash(BARRIER_READINESS_POLICY_V4)).not.toBe(await readinessPolicyHash(BARRIER_READINESS_POLICY_V3));

    installRegistry({ star: { assetUrl: "/api/assets/asset_star" } });
    // CSS-фон, а не `<img>`: jsdom резолвит `src` в абсолютный URL, а предмет проверки — форма
    // записи манифеста (ни одного ключа волны), а не нормализация URL браузером.
    const root = surface('<div data-eui-key="k" style="background-image: url(/api/assets/asset_star)"></div>');
    const manifest = collectResourceManifest(root, [...root.querySelectorAll("*")], barrier3.maxResources);
    expect(manifest.entries).toEqual([{ id: "/api/assets/asset_star", kind: "css", url: "/api/assets/asset_star" }]);
    const outcome = await settleResourceBarrier(root, { barrier: barrier3, deadline: performance.now() + 5_000, ...options });
    expect(outcome.evidence.policyVersion).toBeUndefined();
    expect(outcome.evidence.registry).toBeUndefined();
    expect(outcome.evidence.resources).toBeUndefined();
    expect(Object.keys(outcome.evidence).sort())
      .toEqual(["decoded", "durationMs", "expected", "fontsReady", "lateAfterBarrier", "stableFrames"]);
    root.remove();
  });

  /**
   * Перф-подтверждение (§3, замер V0-D5): расширенный обход с реестром иконок укладывается в
   * бюджет барьера с запасом. Порог мягкий (десятая доля бюджета) — предмет проверки «не выросло
   * на порядок», а не микро-бенчмарк: жёсткий порог во флаки-среде CI ловил бы шум планировщика.
   */
  it("перф: полный барьер с registry-иконками и всеми каналами укладывается в бюджет", async () => {
    installRegistry(Object.fromEntries([...Array(20).keys()].map((index) => [
      `icon${index}`, { assetUrl: `/api/assets/asset_icon_${index}` },
    ])));
    const style = document.createElement("style");
    style.dataset.test = "";
    style.textContent = ".pseudo-host::after{content:url(/api/assets/asset_pseudo)}";
    document.head.append(style);
    const root = surface([...Array(120).keys()].map((index) => `
      <div class="pseudo-host" data-eui-key="row/${index}" style="background-image:url(/api/assets/asset_bg_${index})">
        <img src="/api/assets/asset_icon_${index % 20}" data-eui-icon="icon${index % 20}" srcset="/api/assets/asset_icon_${index % 20}@2x 2x" />
      </div>`).join(""));
    const startedAt = performance.now();
    const outcome = await settleResourceBarrier(root, {
      barrier: barrier4, deadline: performance.now() + 8_000, ...options,
      expectations: { themeIcons: 20 }, icons: () => 20,
      fontEntries: () => [{ family: "Inter", weight: "400", style: "normal", status: "loaded" }],
    });
    const spent = performance.now() - startedAt;
    expect(outcome.evidence.expected).toBe(outcome.evidence.decoded);
    expect(outcome.evidence.lateAfterBarrier).toEqual([]);
    expect(outcome.evidence.resources!.length).toBeGreaterThan(120);
    // Мягкий перф-гейт: ловит порядковую регрессию обхода (D5: реальная цена ~55 мс), а не шум
    // параллельного CI-прогона — budgetMs/10 однажды флакнул на 863 мс под нагрузкой.
    expect(spent).toBeLessThan(barrier4.budgetMs / 4);
    root.remove();
  });
});
