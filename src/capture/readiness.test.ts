import { afterEach, describe, expect, it } from "vitest";
import { collectCaptureEnv, observedCaptureEnvFingerprint, type CaptureEnvInput } from "./env";
import { codesFromReadinessReasons, READINESS_REASON_CODES } from "./failureCodes";
import {
  collectReadiness, collectThemeAssets, collectThemeTokens, fontFaceShorthand, fontShorthandWeight,
  requiredFontFaces, usedFontFamilies,
} from "./readiness";
import type { CaptureFontFaceDeclaration } from "./protocol";
import {
  canonicalReadinessPolicy, DEFAULT_READINESS_POLICY, isReadinessPolicy, readinessPolicyHash,
  STRICT_READINESS_POLICY, type ReadinessPolicy,
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
