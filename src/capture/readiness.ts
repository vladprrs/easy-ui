/**
 * Клиентская сторона deterministic capture readiness (план §3 D5, §5 W4).
 *
 * Раньше «готовность» была двумя строчками: `document.fonts.ready` + `img.decode()`. Этого мало —
 * draft-скриншот `pay-action-button` снялся до появления theme-иконки и попал в визуальную
 * оценку (§1 плана). Здесь готовность — исполнение **объявленной политики** с доказательством:
 *
 * 1. анимации/переходы гасятся инъекцией стиля (`animations: "disabled"`);
 * 2. шрифты — только реально применённые к поверхности face'ы (`fonts: "used-faces"`), иначе
 *    деградация до `document.fonts.ready`;
 * 3. все `img` внутри поверхности декодированы (`images: "decoded"`);
 * 4. сеть тиха `quietMs` по **ресурсам компонента** (`/api/assets`, тема) — чужие запросы страницы
 *    ожидание не продлевают;
 * 5. `frames` подряд стабильных rAF после layout;
 * 6. потолок `timeoutMs`: превышение — не бросок, а честный `met: false` с `reason` и списком
 *    незавершённого. Кадр всё равно снимется, но гейт `readiness` (W4) не даст ему визуального
 *    вердикта (инвариант D5).
 *
 * **`themeResources` обязательны** (триаж R2-14): применённые токены темы, загруженные иконки и
 * изображения — единственный вход класса «сменилась только версия темы» в импакт-анализе W6. Без
 * них частичная пересъёмка невозможна в принципе.
 */
import { collectCaptureEnv, type CaptureEnv } from "./env";
import { codesFromReadinessReasons, READINESS_REASON_CODES, type CaptureCode } from "./failureCodes";
import {
  CAPTURE_BOOTSTRAP_KEY, CAPTURE_READY_KEY,
  type CaptureBootstrap, type CaptureFontFaceDeclaration, type CaptureFontManifest, type CaptureReady,
} from "./protocol";
import {
  DEFAULT_READINESS_POLICY, isReadinessPolicy, perResourceTimeoutMs, readinessPolicyHash,
  type ReadinessBarrierPolicy, type ReadinessPolicy,
} from "./readinessPolicy";
import { rectSignature, settleLayout } from "./stability";

/** Reads the frozen worker bootstrap, if any (absent in browser preview mode). */
export function readBootstrap(): CaptureBootstrap | undefined {
  return typeof window === "undefined" ? undefined : window[CAPTURE_BOOTSTRAP_KEY];
}

/** rendererBuild is echoed from the bootstrap; browser preview has no bootstrap → null. */
export function bootstrapRendererBuild(): string | null {
  return readBootstrap()?.expected.rendererBuild ?? null;
}

/** Политика джобы (bootstrap) либо дефолт: интерактивные пути ведут себя ровно как раньше. */
export function bootstrapReadinessPolicy(): ReadinessPolicy {
  const policy = readBootstrap()?.readiness;
  return isReadinessPolicy(policy) ? policy : DEFAULT_READINESS_POLICY;
}

/**
 * Манифест шрифтов темы, замороженный сервером на постановке (R4). В браузерном preview-режиме
 * bootstrap'а нет → `undefined`, и строгая политика вырождается в v1-семантику шрифтов.
 */
export function bootstrapFontManifest(): CaptureFontManifest | undefined {
  const manifest = readBootstrap()?.fonts;
  if (manifest === undefined || manifest === null || typeof manifest !== "object") return undefined;
  return Array.isArray(manifest.declared) && typeof manifest.manifestHash === "string" ? manifest : undefined;
}

export interface ReadinessFontFace {
  family: string; weight: string; style: string; status: string;
  /** Строгая политика R4: face был обязателен (объявлен темой **и** его семейство наблюдено). */
  required?: boolean;
  /** Вердикт `document.fonts.check()` — авторитет строгой политики. */
  checked?: boolean;
  assetId?: string;
  sha256?: string | null;
}

/** Пофайловое доказательство строгого декода (`images: "decoded-strict"`, R4). */
export interface ReadinessImageDetail {
  url: string;
  assetId: string | null;
  naturalWidth: number;
  naturalHeight: number;
  decoded: boolean;
  /** sha256 содержимого из id ассета (`asset_<sha256>`); внешний URL — `null`. */
  contentHash: string | null;
}

/**
 * Наблюдённые ресурсы темы: `tokens` — имена CSS-переменных, на которые ссылаются стили самой
 * поверхности; `icons` — asset-id иконок из реестра темы, попавших в кадр; `images` — прочие
 * asset-id, загруженные поверхностью. Всё — наблюдение, а не декларация: в импакт годится только
 * то, что кадр действительно использовал.
 */
export interface ReadinessThemeResources { tokens: string[]; icons: string[]; images: string[] }

export interface ReadinessEvidence {
  fontFaces: ReadinessFontFace[];
  images: { total: number; decoded: number; failed: number };
  /** Только строгая политика (R4): по одной записи на `<img>` поверхности. */
  imageDetails?: ReadinessImageDetail[];
  /** Только политика со стабилизацией (R4): устоялся ли layout и на какой попытке. */
  layout?: { stable: boolean; attempts: number; elementKey: string | null };
  /** Хэш манифеста шрифтов, по которому судились required-faces (R4); `null` — манифеста не было. */
  fontManifestHash?: string | null;
  /** Незавершённое на момент истечения политики: URL картинок/ресурсов и незагруженные шрифты. */
  pendingRequests: string[];
  framesWaited: number;
  animationsDisabled: boolean;
  themeResources: ReadinessThemeResources;
  /**
   * Только политика v3 (W2): доказательство исполнения барьера ресурсов. Оно **обязательно** —
   * гейт `readiness` отказывает кадру с `met:true`, пришедшему по v3-политике без этого блока
   * (§1.5: иначе «флаг не доехал до поверхности» неотличимо от «барьер исполнен»).
   */
  resourceBarrier?: ReadinessResourceBarrier;
  /**
   * Пофазовый раскол ожидания (§W2, «заполнить `timings.*`»): до волны receipt нёс только
   * суммарный `readinessMs`, и «где именно кадр простоял 9 секунд» было неизвестно.
   */
  phaseTimings?: ReadinessPhaseTimings;
}

/** Длительности фаз readiness, мс. Источник `timings.*` receipt'а (§W2). */
export interface ReadinessPhaseTimings {
  fontsMs: number;
  imagesMs: number;
  networkMs: number;
  framesMs: number;
  stabilizeMs: number;
  /** Только v3: длительность фазы барьера (она же `resourceBarrier.durationMs`). */
  barrierMs?: number;
}

export interface ReadinessReport {
  met: boolean;
  /**
   * Причина невыполнения политики (`fonts_timeout`, `images_failed`, `network_timeout`, …) в
   * **доволновом** формате: строки склеены запятой, поле отсутствует при `met: true`. Это поле
   * — не легаси-обломок: маппинг причин в коды не биективен (§3 E3, C-M5), две строки схлопываются
   * в один код, поэтому `reason` сохраняется, а `codes` едет рядом.
   */
  reason?: string;
  /** Те же причины типизированным словарём (§5 R3). Пустой массив при выполненной политике. */
  codes: CaptureCode[];
  policyHash: string;
  elapsedMs: number;
  evidence: ReadinessEvidence;
}

const ANIMATION_STYLE_ID = "eui-readiness-animations";
const ELEMENT_SAMPLE_LIMIT = 400;
const RULE_SCAN_LIMIT = 5_000;
const SELECTOR_SAMPLE_LIMIT = 100;
const FONT_FAMILY_LIMIT = 24;
const VAR_PATTERN = /var\(\s*(--[A-Za-z0-9_-]+)/g;
const ASSET_PATTERN = /\/api\/assets\/([^/?#"')]+)/;

const now = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, Math.max(ms, 0)));

/** Гонка с дедлайном политики: `false` — «не успело», а не исключение (met: false, не error). */
async function within<T>(promise: Promise<T>, deadline: number): Promise<boolean> {
  const remaining = deadline - now();
  if (remaining <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((done) => { timer = setTimeout(() => done("timeout"), remaining); });
  try {
    const result = await Promise.race([promise.then(() => "ok" as const), timeout]);
    return result === "ok";
  } catch {
    // Отказ самой операции (broken image, отвергнутый шрифт) — не таймаут: он попадёт в счётчики.
    return true;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const elementsOf = (root: ParentNode): Element[] => {
  const all: Element[] = [];
  if (root instanceof Element) all.push(root);
  for (const element of root.querySelectorAll("*")) {
    if (all.length >= ELEMENT_SAMPLE_LIMIT) break;
    all.push(element);
  }
  return all;
};

const normalizeFamily = (value: string): string => value.trim().replace(/^["']|["']$/g, "").toLowerCase();

/** Семейства, реально применённые к поверхности (`fonts: "used-faces"`). */
export function usedFontFamilies(elements: Element[]): string[] {
  const families = new Set<string>();
  for (const element of elements) {
    let computed: CSSStyleDeclaration | null = null;
    try { computed = getComputedStyle(element); } catch { computed = null; }
    if (!computed) continue;
    for (const part of (computed.fontFamily || "").split(",")) {
      const family = normalizeFamily(part);
      if (family && families.size < FONT_FAMILY_LIMIT) families.add(family);
    }
  }
  return [...families];
}

function injectAnimationFreeze(): boolean {
  if (typeof document === "undefined") return false;
  if (document.getElementById(ANIMATION_STYLE_ID)) return true;
  const style = document.createElement("style");
  style.id = ANIMATION_STYLE_ID;
  style.textContent = "*,*::before,*::after{animation:none!important;transition:none!important}";
  document.head.append(style);
  return true;
}

interface FontOutcome { faces: ReadinessFontFace[]; pending: string[]; timedOut: boolean; codes: CaptureCode[]; reasons: string[] }

/**
 * Единственный числовой/ключевой токен `font-weight` для шорткода `document.fonts.load/check`.
 *
 * Тема variable-шрифта объявляет **диапазон** (`"400 700"`), а шорткод его не принимает: без
 * нормализации `check()` бросил бы (или вернул false) и волна начала бы врать `font_face_missing`
 * на каждом variable-семействе (unit-инвариант R4).
 */
export function fontShorthandWeight(weight: string | number | undefined): string {
  const first = String(weight ?? "400").trim().split(/\s+/)[0] ?? "400";
  if (/^(normal|bold|bolder|lighter)$/i.test(first)) return first.toLowerCase();
  const numeric = Number(first);
  return Number.isFinite(numeric) && numeric > 0 ? String(Math.round(numeric)) : "400";
}

const fontShorthandStyle = (style: string | undefined): string => {
  const first = String(style ?? "normal").trim().split(/\s+/)[0]?.toLowerCase() ?? "normal";
  return first === "italic" || first === "oblique" ? first : "normal";
};

/** Шорткод одного face'а: ровно та строка, которой политика и грузит, и проверяет наличие. */
export function fontFaceShorthand(face: { family: string; weight?: string | number; style?: string }): string {
  return `${fontShorthandWeight(face.weight)} ${fontShorthandStyle(face.style)} 16px "${face.family}"`;
}

/**
 * Required-faces (правило T-M10): **пересечение** объявленных темой faces и семейств, реально
 * применённых к поверхности. Тема вправе объявлять шрифты, которых компонент не касается —
 * требовать их загрузки значило бы валить каждый компонент, не использующий всю палитру темы.
 */
export function requiredFontFaces(
  declared: readonly CaptureFontFaceDeclaration[],
  usedFamilies: ReadonlySet<string>,
): CaptureFontFaceDeclaration[] {
  return declared.filter((face) => usedFamilies.has(normalizeFamily(face.family)));
}

async function settleFonts(
  policy: ReadinessPolicy,
  elements: Element[],
  deadline: number,
  declared: readonly CaptureFontFaceDeclaration[] = [],
): Promise<FontOutcome> {
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  if (!fonts) return { faces: [], pending: [], timedOut: false, codes: [], reasons: [] };
  const used = policy.fonts === "document-ready" ? null : new Set(usedFontFamilies(elements));
  let timedOut = false;
  const codes: CaptureCode[] = [];
  const reasons: string[] = [];
  // ДС без темы (`fonts: []`) — строгость вырождается в v1-семантику: требовать нечего (K3-оговорка).
  const strict = policy.fonts === "required-faces" && declared.length > 0 && used !== null;
  const required = strict ? requiredFontFaces(declared, used) : [];
  const verdicts = new Map<string, { face: CaptureFontFaceDeclaration; checked: boolean; failed: boolean }>();

  for (const face of required) {
    const query = fontFaceShorthand(face);
    let failed = false;
    if (typeof fonts.load === "function") {
      const loading = Promise.resolve(fonts.load(query)).then(() => undefined).catch(() => { failed = true; });
      if (!await within(loading, deadline)) timedOut = true;
    }
    // `check()` — авторитет: он отвечает на единственный важный вопрос «есть ли чем нарисовать
    // этот face прямо сейчас». Бросок (невалидный для шорткода ввод) трактуется как «неизвестно»:
    // выдумывать отказ по собственной ошибке разбора нельзя.
    let checked = true;
    try { if (typeof fonts.check === "function") checked = fonts.check(query); } catch { checked = true; }
    verdicts.set(`${normalizeFamily(face.family)}|${fontShorthandWeight(face.weight)}|${fontShorthandStyle(face.style)}`, { face, checked, failed });
    if (!checked) {
      codes.push({ code: "font_face_missing", severity: "error", detail: `required face is unavailable: ${query}`, ref: face.family });
      if (!reasons.includes("fonts_missing")) reasons.push("fonts_missing");
    } else if (failed) {
      codes.push({ code: "font_load_failed", severity: "error", detail: `required face failed to load: ${query}`, ref: face.family });
      if (!reasons.includes("fonts_failed")) reasons.push("fonts_failed");
    }
  }

  if (used) {
    for (const family of used) {
      // `load` поднимает именно те face'ы, что нужны поверхности; отсутствующее семейство —
      // не ошибка (это системный шрифт), поэтому отказ гасится.
      if (typeof fonts.load === "function") {
        if (!await within(Promise.resolve(fonts.load(`16px "${family}"`)).catch(() => undefined), deadline)) timedOut = true;
      }
    }
  }
  if (fonts.ready && !await within(Promise.resolve(fonts.ready), deadline)) timedOut = true;

  const faces: ReadinessFontFace[] = [];
  const pending: string[] = [];
  const claimed = new Set<string>();
  try {
    for (const face of fonts as unknown as Iterable<FontFace>) {
      const family = normalizeFamily(face.family ?? "");
      if (used && !used.has(family)) continue;
      const key = `${family}|${fontShorthandWeight(face.weight)}|${fontShorthandStyle(face.style)}`;
      const verdict = verdicts.get(key);
      if (verdict) claimed.add(key);
      faces.push({
        family: face.family, weight: face.weight, style: face.style, status: face.status,
        ...(verdict ? { required: true, checked: verdict.checked, assetId: verdict.face.assetId, sha256: verdict.face.sha256 } : {}),
      });
      // Подтверждение вердикта (порядок §5 R4: `check()` — авторитет, `FontFace.status` — эхо):
      // объявленный темой face со статусом `error` — отказ загрузки, а не отсутствие.
      if (verdict && verdict.checked && face.status === "error") {
        codes.push({ code: "font_load_failed", severity: "error", detail: `required face reported FontFace.status="error": ${face.family}`, ref: face.family });
        if (!reasons.includes("fonts_failed")) reasons.push("fonts_failed");
      }
      // Незавершённой считается только `loading`. `unloaded` — это face, который браузеру не
      // понадобился (напр. weight 700 семейства, применённого в weight 400): считать его
      // «неготовым» значило бы валить readiness на каждой теме с несколькими начертаниями.
      // `error` попадает в доказательство, но вердикта не меняет: он может относиться к
      // неиспользуемому начертанию, а видимый дефект поймает визуальный гейт.
      if (face.status === "loading") pending.push(`font:${face.family} ${face.weight} ${face.style} (${face.status})`);
    }
  } catch { /* FontFaceSet без итератора (jsdom): доказательства беднее, политика не падает */ }
  // Обязательный face, которому не нашлось объекта `FontFace` (тема объявила — браузер не завёл),
  // обязан быть виден в доказательстве: иначе «нет ассета» выглядело бы как «шрифтов не было».
  for (const [key, verdict] of verdicts) {
    if (claimed.has(key)) continue;
    faces.push({
      family: verdict.face.family, weight: verdict.face.weight, style: verdict.face.style,
      status: verdict.checked ? "unloaded" : "missing",
      required: true, checked: verdict.checked, assetId: verdict.face.assetId, sha256: verdict.face.sha256,
    });
    if (!verdict.checked) pending.push(`font:${verdict.face.family} ${verdict.face.weight} ${verdict.face.style} (missing)`);
  }
  faces.sort((left, right) => (left.family < right.family ? -1 : left.family > right.family ? 1 : 0));
  return { faces, pending, timedOut, codes, reasons };
}

interface ImageOutcome {
  total: number; decoded: number; failed: number; pending: string[]; timedOut: boolean;
  details: ReadinessImageDetail[]; codes: CaptureCode[];
}

const contentHashOf = (assetId: string | null): string | null => {
  const match = assetId === null ? null : /^asset_([0-9a-f]{64})$/.exec(assetId);
  return match ? match[1]! : null;
};

/**
 * `images: "decoded"` — годен кадр с растром; `images: "decoded-strict"` (R4) — годен только
 * полностью декодированный: `complete ∧ naturalWidth>0 ∧ naturalHeight>0 ∧ decode() resolved`.
 * Разница буквальная: битый `<img>` рядом с живым сегодня даёт «готовый» кадр, а строгая
 * политика обязана назвать его `image_load_failed` с URL виновника.
 */
async function settleImages(root: ParentNode, deadline: number, strict: boolean): Promise<ImageOutcome> {
  const images = Array.from(root.querySelectorAll("img"));
  let decoded = 0;
  let failed = 0;
  let timedOut = false;
  const pending: string[] = [];
  const details: ReadinessImageDetail[] = [];
  const codes: CaptureCode[] = [];
  for (const image of images) {
    let ok = false;
    if (typeof image.decode === "function") {
      const decodedPromise = image.decode().then(() => { ok = true; }).catch(() => { ok = false; });
      if (!await within(decodedPromise, deadline)) timedOut = true;
    } else {
      ok = image.complete && image.naturalWidth > 0;
    }
    const url = image.currentSrc || image.src;
    const raster = image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
    // `decode()` резолвится и на «уже отрисованной» картинке — критерий успеха v1 один: есть растр.
    const good = strict ? (ok && raster) : (ok || (image.complete && image.naturalWidth > 0));
    if (strict) {
      const assetId = assetIdOf(url);
      details.push({
        url, assetId,
        naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
        decoded: ok, contentHash: contentHashOf(assetId),
      });
    }
    if (good) decoded += 1;
    else {
      failed += 1;
      pending.push(`image:${url}`);
      if (strict) codes.push({ code: "image_load_failed", severity: "error", detail: `image is not fully decoded (${image.naturalWidth}×${image.naturalHeight}, decoded=${ok})`, ref: url });
    }
  }
  return { total: images.length, decoded, failed, pending, timedOut, details, codes };
}

const isComponentOwned = (url: string): boolean => {
  try {
    const parsed = new URL(url, typeof location === "undefined" ? "http://localhost" : location.href);
    if (typeof location !== "undefined" && parsed.origin !== location.origin) return false;
    return parsed.pathname.startsWith("/api/assets/") || parsed.pathname.startsWith("/api/design-systems/");
  } catch { return false; }
};

/** Ресурсы компонента, наблюдённые resource-timing'ом (источник иконок/изображений темы). */
function ownedResourceUrls(): string[] {
  try {
    if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") return [];
    return performance.getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => isComponentOwned(name));
  } catch { return []; }
}

/**
 * Тишина сети по ресурсам компонента: ждём, пока `quietMs` не появится ни одной новой записи
 * resource-timing'а нужного скоупа. Чужие запросы страницы (аналитика, HMR) ожидание не держат.
 */
async function settleNetwork(policy: ReadinessPolicy, deadline: number): Promise<{ timedOut: boolean }> {
  const quiet = policy.network.quietMs;
  if (quiet <= 0) return { timedOut: false };
  let seen = ownedResourceUrls().length;
  let lastChangeAt = now();
  for (;;) {
    const current = ownedResourceUrls().length;
    if (current !== seen) { seen = current; lastChangeAt = now(); }
    const quietFor = now() - lastChangeAt;
    if (quietFor >= quiet) return { timedOut: false };
    if (now() >= deadline) return { timedOut: true };
    await sleep(Math.min(quiet - quietFor, Math.max(deadline - now(), 0), 25));
  }
}

/** `frames` подряд кадров rAF: доказательство, что layout больше не двигается. */
async function settleFrames(policy: ReadinessPolicy, deadline: number): Promise<{ framesWaited: number; timedOut: boolean }> {
  if (typeof requestAnimationFrame !== "function") return { framesWaited: 0, timedOut: false };
  let waited = 0;
  for (let index = 0; index < policy.frames; index += 1) {
    const frame = new Promise<void>((done) => requestAnimationFrame(() => done()));
    if (!await within(frame, deadline)) return { framesWaited: waited, timedOut: true };
    waited += 1;
  }
  return { framesWaited: waited, timedOut: false };
}

const assetIdOf = (url: string): string | null => ASSET_PATTERN.exec(url)?.[1] ?? null;

/** Реестр иконок темы, установленный `ThemeStyle` (`__easyUiShared.icons`). */
function themeIconUrls(): Set<string> {
  const urls = new Set<string>();
  const shared = (globalThis as { __easyUiShared?: { icons?: Record<string, { assetUrl?: string; themes?: { light?: string; dark?: string } }> } }).__easyUiShared;
  for (const icon of Object.values(shared?.icons ?? {})) {
    for (const url of [icon.assetUrl, icon.themes?.light, icon.themes?.dark]) if (url) urls.add(url);
  }
  return urls;
}

/**
 * Имена CSS-переменных, на которые ссылаются стили **поверхности**: инлайновые стили её элементов
 * плюс правила таблиц стилей, чей селектор матчит хоть один элемент поверхности. Это осознанная
 * аппроксимация «применённых токенов»: браузер не отдаёт список использованных custom properties,
 * а перечислять все объявленные `:root` бессмысленно — тогда любая правка темы затрагивала бы всё.
 */
export function collectThemeTokens(elements: Element[]): string[] {
  const names = new Set<string>();
  const collect = (text: string): void => {
    VAR_PATTERN.lastIndex = 0;
    for (let match = VAR_PATTERN.exec(text); match !== null; match = VAR_PATTERN.exec(text)) names.add(match[1]!);
  };
  for (const element of elements) {
    const inline = element.getAttribute("style");
    if (inline) collect(inline);
  }
  const sample = elements.slice(0, SELECTOR_SAMPLE_LIMIT);
  if (typeof document === "undefined" || sample.length === 0) return [...names].sort();
  let scanned = 0;
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | undefined;
    // Кросс-оригинные таблицы бросают на `cssRules` — просто пропускаем, это не ошибка капчура.
    try { rules = (sheet as CSSStyleSheet).cssRules; } catch { continue; }
    for (const rule of Array.from(rules ?? [])) {
      if (scanned++ > RULE_SCAN_LIMIT) return [...names].sort();
      const style = rule as CSSStyleRule;
      const text = style.cssText ?? "";
      if (!text.includes("var(--") || typeof style.selectorText !== "string") continue;
      try {
        if (sample.some((element) => element.matches(style.selectorText))) collect(text);
      } catch { /* невалидный для matches селектор (::-webkit-*, @-правила) */ }
    }
  }
  return [...names].sort();
}

/** Иконки/изображения темы, попавшие в кадр: пересечение наблюдённых URL с реестром иконок. */
export function collectThemeAssets(root: ParentNode, elements: Element[]): { icons: string[]; images: string[] } {
  const iconUrls = themeIconUrls();
  const observed = new Set<string>(ownedResourceUrls());
  for (const image of root.querySelectorAll("img")) {
    const src = image.currentSrc || image.src;
    if (src) observed.add(src);
  }
  for (const element of elements) {
    let background = "";
    try { background = getComputedStyle(element).backgroundImage || ""; } catch { background = ""; }
    if (!background.includes("url(")) continue;
    for (const match of background.matchAll(/url\((["']?)([^"')]+)\1\)/g)) observed.add(match[2]!);
  }
  const icons = new Set<string>();
  const images = new Set<string>();
  for (const url of observed) {
    const assetId = assetIdOf(url);
    if (!assetId) continue;
    const isIcon = [...iconUrls].some((iconUrl) => assetIdOf(iconUrl) === assetId);
    (isIcon ? icons : images).add(assetId);
  }
  return { icons: [...icons].sort(), images: [...images].sort() };
}

/* ------------------------------------------------------------------------------------------- *
 * Deterministic resource barrier (план 2026-08-07 §W2, P0.2)
 * ------------------------------------------------------------------------------------------- */

/**
 * Один ресурс манифеста страницы. `kind` — не украшение: он отвечает на вопрос «откуда мы вообще
 * узнали про этот ресурс», а доволновая readiness знала ровно один источник (`<img>`) — из-за чего
 * CSS-фон и inline-SVG `<image>` уезжали в кадр недогруженными (мотивировка волны).
 */
export interface ReadinessResourceEntry {
  /** Стабильный идентификатор ресурса внутри кадра (он же `resourceId` в `ref` кодов). */
  id: string;
  kind: "img" | "css" | "svg-image";
  url: string;
}

/** Доказательство исполнения барьера — то самое «эхо», без которого гейт при v3 отказывает (§1.5). */
export interface ReadinessResourceBarrier {
  /** Сколько ресурсов барьер объявил своим предметом (после cap'а). */
  expected: number;
  /** Сколько из них доказанно декодировано. */
  decoded: number;
  fontsReady: boolean;
  /** Сколько стабильных кадров отстояно после декода. */
  stableFrames: number;
  /** Ресурсы, появившиеся **после** барьера (диф второго снятия манифеста). */
  lateAfterBarrier: string[];
  durationMs: number;
}

export type ResourceDecodeOutcome = "decoded" | "failed" | "timeout";

/** Фазы барьера — первая половина `ref` кодов (`"<phase>:<resourceId>"`). */
export type ResourceBarrierPhase = "manifest" | "decode" | "fonts" | "frames" | "rediff";

export interface ResourceBarrierOptions {
  barrier: ReadinessBarrierPolicy;
  /** Дедлайн политики целиком: барьер не вправе его пережить, даже если бюджет ещё есть. */
  deadline: number;
  /** Инъекции для тестов; по умолчанию — реальные браузерные механизмы. */
  decode?: (url: string, timeoutMs: number) => Promise<ResourceDecodeOutcome>;
  fontsReady?: () => Promise<unknown> | undefined;
  frame?: () => Promise<void>;
  now?: () => number;
}

export interface ResourceBarrierOutcome {
  evidence: ReadinessResourceBarrier;
  codes: CaptureCode[];
  reasons: string[];
}

const CSS_URL_PATTERN = /url\((["']?)([^"')]+)\1\)/g;
/** Свойства computed style, через которые страница тянет растр помимо `<img>`. */
const CSS_IMAGE_PROPERTIES = ["backgroundImage", "maskImage", "webkitMaskImage", "borderImageSource", "listStyleImage", "content"] as const;

const resourceUrlsOfDeclaration = (value: string): string[] => {
  if (!value || !value.includes("url(")) return [];
  CSS_URL_PATTERN.lastIndex = 0;
  return [...value.matchAll(CSS_URL_PATTERN)].map((match) => match[2]!).filter((url) => url.length > 0);
};

/**
 * Манифест ресурсов кадра: computed-стили выборки элементов (фон, маска, border-image, list-style,
 * `content`), inline-SVG `<image>` и `<img>`. Порядок детерминирован (обход DOM), дубли схлопнуты
 * по URL — один и тот же фон на сотне элементов остаётся одним ресурсом.
 *
 * `overflow` — честный признак того, что предмет доказательства **шире** потолка: барьер отработает
 * по первым `limit` ресурсам, и это фиксируется кодом `resource_manifest_overflow`, а не молчанием.
 */
export function collectResourceManifest(
  root: ParentNode,
  elements: Element[],
  limit: number,
): { entries: ReadinessResourceEntry[]; total: number; overflow: boolean } {
  const seen = new Map<string, ReadinessResourceEntry>();
  const add = (kind: ReadinessResourceEntry["kind"], url: string): void => {
    const trimmed = url.trim();
    if (trimmed.length === 0 || trimmed === "none" || trimmed.startsWith("#")) return;
    if (!seen.has(trimmed)) seen.set(trimmed, { id: trimmed, kind, url: trimmed });
  };
  for (const element of elements) {
    let computed: CSSStyleDeclaration | null = null;
    try { computed = getComputedStyle(element); } catch { computed = null; }
    if (!computed) continue;
    for (const property of CSS_IMAGE_PROPERTIES) {
      for (const url of resourceUrlsOfDeclaration((computed as unknown as Record<string, string>)[property] ?? "")) add("css", url);
    }
  }
  for (const image of root.querySelectorAll("img")) add("img", image.currentSrc || image.src || image.getAttribute("src") || "");
  // Inline-SVG `<image>`: `href`/`xlink:href` мимо `querySelectorAll("img")` — именно этот класс
  // ресурсов доволновая readiness не видела вовсе.
  for (const image of root.querySelectorAll("image")) {
    add("svg-image", image.getAttribute("href") ?? image.getAttribute("xlink:href") ?? "");
  }
  const entries = [...seen.values()];
  return { entries: entries.slice(0, limit), total: entries.length, overflow: entries.length > limit };
}

/** Декод одного ресурса вне DOM поверхности: растр либо есть, либо назван виновником. */
async function decodeResourceDefault(url: string, timeoutMs: number): Promise<ResourceDecodeOutcome> {
  if (typeof Image !== "function") return "decoded";
  const image = new Image();
  const settled: Promise<ResourceDecodeOutcome> = new Promise((done) => {
    image.addEventListener("load", () => done("decoded"), { once: true });
    image.addEventListener("error", () => done("failed"), { once: true });
  });
  image.src = url;
  const decoded = typeof image.decode === "function"
    ? image.decode().then((): ResourceDecodeOutcome => "decoded").catch((): ResourceDecodeOutcome => "failed")
    : settled;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ResourceDecodeOutcome>((done) => { timer = setTimeout(() => done("timeout"), Math.max(timeoutMs, 0)); });
  try { return await Promise.race([decoded, timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

const nextAnimationFrame = (): Promise<void> =>
  typeof requestAnimationFrame === "function"
    ? new Promise<void>((done) => requestAnimationFrame(() => done()))
    : sleep(16);

/**
 * Фаза `settleResourceBarrier` (§W2): манифест → preload/decode всего манифеста →
 * `document.fonts.ready` → `stableFrames` стабильных кадров → **повторный** манифест и его диф.
 *
 * Бюджет — суммарный и **внутри страницы** (§1.5): исчерпание даёт типизированный
 * `resource_barrier_timeout` с указателем на фазу и предмет, а не смерть процесс-группы по
 * `JOB_DEADLINE_MS`, из-под которой наружу не доезжает ничего, кроме `capture timed out`.
 *
 * Барьер никогда не бросает: любой негодный исход — это код и `met:false`, а не сбой капчура.
 */
export async function settleResourceBarrier(
  root: ParentNode,
  options: ResourceBarrierOptions,
): Promise<ResourceBarrierOutcome> {
  const clock = options.now ?? now;
  const startedAt = clock();
  const decode = options.decode ?? decodeResourceDefault;
  const frame = options.frame ?? nextAnimationFrame;
  const perResource = perResourceTimeoutMs(options.barrier);
  // Барьер живёт внутри двух потолков сразу: собственного бюджета и дедлайна политики.
  const barrierDeadline = Math.min(options.deadline, startedAt + options.barrier.budgetMs);
  const codes: CaptureCode[] = [];
  const reasons: string[] = [];
  const addReason = (reason: string): void => { if (!reasons.includes(reason)) reasons.push(reason); };
  const timedOut = (phase: ResourceBarrierPhase, resourceId: string): void => {
    codes.push({
      code: "resource_barrier_timeout", severity: "error",
      detail: `resource barrier exhausted its ${options.barrier.budgetMs}ms budget in phase "${phase}"`,
      ref: `${phase}:${resourceId}`,
    });
    addReason("resource_barrier_timeout");
  };
  const expired = (): boolean => clock() >= barrierDeadline;

  const elements = elementsOf(root);
  const manifest = collectResourceManifest(root, elements, options.barrier.maxResources);
  if (manifest.overflow) {
    codes.push({
      code: "resource_manifest_overflow", severity: "warning",
      detail: `page declares ${manifest.total} resources, barrier proves the first ${options.barrier.maxResources}`,
      ref: String(manifest.total),
    });
  }

  let decoded = 0;
  if (expired() && manifest.entries.length > 0) timedOut("manifest", String(manifest.entries.length));
  for (const entry of manifest.entries) {
    if (expired()) { timedOut("decode", entry.id); break; }
    const remaining = Math.max(0, barrierDeadline - clock());
    const outcome = await decode(entry.url, Math.min(perResource, remaining));
    if (outcome === "decoded") { decoded += 1; continue; }
    if (outcome === "timeout") {
      // Пер-ресурсный потолок — производная бюджета, поэтому его исчерпание и есть исчерпание
      // бюджета на этом ресурсе: он назван поимённо, а фаза продолжается для остальных.
      timedOut("decode", entry.id);
      continue;
    }
    codes.push({ code: "resource_decode_failed", severity: "error", detail: `resource failed to decode (${entry.kind})`, ref: entry.url });
    addReason("resource_decode_failed");
  }

  // Гонка с дедлайном барьера ведётся по **его** часам (`clock`), а не по модульным: инъекция
  // времени в тесте иначе рассинхронизировала бы бюджет фазы и её же ожидания.
  const untilDeadline = async (promise: Promise<unknown>): Promise<boolean> => {
    const remaining = barrierDeadline - clock();
    if (remaining <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((done) => { timer = setTimeout(() => done("timeout"), remaining); });
    try { return await Promise.race([promise.then(() => "ok" as const), timeout]) === "ok"; }
    catch { return true; }
    finally { if (timer !== undefined) clearTimeout(timer); }
  };

  let fontsReady = false;
  const fontsPromise = options.fontsReady ? options.fontsReady() : (typeof document === "undefined" ? undefined : document.fonts?.ready);
  if (fontsPromise === undefined) fontsReady = true;
  else if (await untilDeadline(Promise.resolve(fontsPromise))) fontsReady = true;
  else timedOut("fonts", "document.fonts.ready");

  let stableFrames = 0;
  for (let index = 0; index < options.barrier.stableFrames; index += 1) {
    if (!await untilDeadline(frame())) { timedOut("frames", String(index)); break; }
    stableFrames += 1;
  }

  // Повторный диф — единственное доказательство того, что страница **перестала** тянуть ресурсы.
  const after = collectResourceManifest(root, elementsOf(root), options.barrier.maxResources);
  const known = new Set(manifest.entries.map((entry) => entry.id));
  const lateAfterBarrier = after.entries.filter((entry) => !known.has(entry.id)).map((entry) => entry.url);
  for (const url of lateAfterBarrier.slice(0, 10)) {
    codes.push({ code: "resource_late_after_barrier", severity: "error", detail: "resource appeared after the barrier settled", ref: url });
  }
  if (lateAfterBarrier.length > 0) addReason("resource_late_after_barrier");
  if (expired() && lateAfterBarrier.length === 0 && reasons.length === 0) timedOut("rediff", String(after.entries.length));

  return {
    evidence: {
      expected: manifest.entries.length,
      decoded,
      fontsReady,
      stableFrames,
      lateAfterBarrier: lateAfterBarrier.slice(0, 20),
      durationMs: Math.round(clock() - startedAt),
    },
    codes,
    reasons,
  };
}

/**
 * Свёртка кодов отчёта: доволновые строки маппятся словарём R3, коды строгой политики едут как
 * есть и **выигрывают** конфликт по коду (они несут `ref`). Строки, которых в словаре R3 нет
 * (`fonts_missing`, `fonts_failed`, `layout_unstable` — их ввела R4), в маппинг не попадают: они
 * уже представлены типизированным кодом, а «неизвестная строка» стала бы `runtime_error`.
 */
export function mergeCaptureCodes(reasons: readonly string[], strictCodes: readonly CaptureCode[]): CaptureCode[] {
  const known = reasons.filter((reason) => Object.prototype.hasOwnProperty.call(READINESS_REASON_CODES, reason));
  const strictSet = new Set(strictCodes.map((code) => code.code));
  return [
    ...codesFromReadinessReasons(known).filter((code) => !strictSet.has(code.code)),
    ...strictCodes,
  ];
}

/**
 * Исполняет политику readiness над поверхностью и собирает доказательство. Никогда не бросает:
 * невыполненная политика — это `met: false` с причиной, а не сбой капчура.
 */
export async function collectReadiness(
  root: ParentNode,
  policy: ReadinessPolicy = DEFAULT_READINESS_POLICY,
  options: { fonts?: CaptureFontManifest; barrier?: Omit<ResourceBarrierOptions, "barrier" | "deadline"> } = {},
): Promise<ReadinessReport> {
  const startedAt = now();
  const deadline = startedAt + policy.timeoutMs;
  const policyHash = await readinessPolicyHash(policy);
  const animationsDisabled = policy.animations === "disabled" ? injectAnimationFreeze() : false;
  const elements = elementsOf(root);
  const reasons: string[] = [];
  // Типизированные коды строгой политики: у них есть `ref` (семейство, URL, ключ элемента),
  // которого маппинг доволновых строк дать не может — поэтому они едут отдельным списком.
  const strictCodes: CaptureCode[] = [];

  // Границы фаз замеряются здесь же: `phaseTimings` — единственный источник `timings.*` receipt'а
  // (§W2), и вычислять их вне readiness было бы гаданием по суммарному `elapsedMs`.
  const phaseAt = now();
  let phaseMark = phaseAt;
  const phase = (): number => { const at = now(); const spent = Math.round(at - phaseMark); phaseMark = at; return spent; };

  const fonts = await settleFonts(policy, elements, deadline, options.fonts?.declared ?? []);
  const fontsMs = phase();
  if (fonts.timedOut) reasons.push("fonts_timeout");
  reasons.push(...fonts.reasons);
  strictCodes.push(...fonts.codes);
  const images = await settleImages(root, deadline, policy.images === "decoded-strict");
  const imagesMs = phase();
  if (images.timedOut) reasons.push("images_timeout");
  if (images.failed > 0) reasons.push("images_failed");
  strictCodes.push(...images.codes);
  const network = await settleNetwork(policy, deadline);
  const networkMs = phase();
  if (network.timedOut) reasons.push("network_timeout");
  const frames = await settleFrames(policy, deadline);
  const framesMs = phase();
  if (frames.timedOut) reasons.push("frames_timeout");
  if (fonts.pending.length > 0) reasons.push("fonts_pending");

  // Стабилизация layout — **после** frames-settle и **до** сбора ресурсов темы (§5 R4): кадры
  // доказывают, что браузер рисовал, перемера — что рисовал одно и то же.
  let layout: ReadinessEvidence["layout"];
  if (policy.layout?.stabilize) {
    const outcome = await settleLayout({
      attempts: policy.layout.attempts, deadline, now,
      measure: () => rectSignature(root),
    });
    layout = { stable: outcome.stable, attempts: outcome.attempts, elementKey: outcome.elementKey };
    if (outcome.timedOut) { if (!reasons.includes("frames_timeout")) reasons.push("frames_timeout"); }
    else if (!outcome.stable) {
      reasons.push("layout_unstable");
      strictCodes.push({
        code: "layout_unstable", severity: "error",
        detail: `layout kept moving through ${outcome.attempts} stabilization attempts`,
        ...(outcome.elementKey === null ? {} : { ref: outcome.elementKey }),
      });
    }
  }

  const stabilizeMs = phase();

  // Барьер ресурсов (W2) — **последняя** фаза перед съёмкой кадра: он и догружает всё, что
  // объявила страница (включая CSS-фоны и inline-SVG `<image>`, которых доволновая readiness не
  // видела), и доказывает повторным дифом манифеста, что после него ничего не приехало.
  let resourceBarrier: ReadinessResourceBarrier | undefined;
  if (policy.resourceBarrier !== undefined) {
    const outcome = await settleResourceBarrier(root, {
      barrier: policy.resourceBarrier,
      deadline,
      ...(options.barrier ?? {}),
    });
    resourceBarrier = outcome.evidence;
    strictCodes.push(...outcome.codes);
    for (const reason of outcome.reasons) if (!reasons.includes(reason)) reasons.push(reason);
  }
  const barrierMs = phase();

  // Ресурсы собираются **после** ожидания: нужны те, что действительно попали в готовый кадр.
  const themeResources: ReadinessThemeResources = {
    tokens: collectThemeTokens(elements),
    ...collectThemeAssets(root, elements),
  };

  return {
    met: reasons.length === 0,
    // Формат `reason` доволновый и таким остаётся: его читают уже записанные evidence-артефакты,
    // метрики гейта `readiness` и импакт W6. Типизация приезжает **дополнительным** полем.
    ...(reasons.length === 0 ? {} : { reason: reasons.join(",") }),
    // Коды строгой политики **вытесняют** одноимённые выводы из доволновых строк: у них тот же
    // код, но с указателем на виновника. Строки волны R4 (`fonts_missing`, `layout_unstable`)
    // словарю R3 неизвестны и через маппинг не гоняются — иначе стали бы `runtime_error`.
    codes: mergeCaptureCodes(reasons, strictCodes),
    policyHash,
    elapsedMs: Math.round(now() - startedAt),
    evidence: {
      fontFaces: fonts.faces,
      images: { total: images.total, decoded: images.decoded, failed: images.failed },
      ...(images.details.length > 0 ? { imageDetails: images.details.slice(0, 50) } : {}),
      ...(layout === undefined ? {} : { layout }),
      ...(options.fonts === undefined ? {} : { fontManifestHash: options.fonts.manifestHash }),
      pendingRequests: [...images.pending, ...fonts.pending].slice(0, 50),
      framesWaited: frames.framesWaited,
      animationsDisabled,
      themeResources,
      ...(resourceBarrier === undefined ? {} : { resourceBarrier }),
      phaseTimings: {
        fontsMs, imagesMs, networkMs, framesMs, stabilizeMs,
        ...(resourceBarrier === undefined ? {} : { barrierMs }),
      },
    },
  };
}

/**
 * Готовность поверхности + отпечаток окружения одним вызовом: оба поля уезжают в `CaptureReady`
 * дополнительно к handshake-полям (сравнение с `expected` их не видит — триаж R1-m2: политика в
 * `expected` не дублируется, сервер сверяет её хэш в результате).
 */
export async function settleSurface(
  root: ParentNode,
  policy: ReadinessPolicy = bootstrapReadinessPolicy(),
  fonts: CaptureFontManifest | undefined = bootstrapFontManifest(),
): Promise<{ readiness: ReadinessReport; env: CaptureEnv }> {
  const readiness = await collectReadiness(root, policy, fonts === undefined ? {} : { fonts });
  let surfaceFontFamily = "sans-serif";
  try {
    const target = root instanceof Element ? root : document.body;
    if (target) surfaceFontFamily = getComputedStyle(target).fontFamily || surfaceFontFamily;
  } catch { /* нет layout-движка (jsdom) — растр честно «unavailable» */ }
  const env = await collectCaptureEnv({
    readinessPolicyHash: readiness.policyHash,
    rendererBuild: bootstrapRendererBuild(),
    colorScheme: typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light",
    surfaceFontFamily,
  });
  return { readiness, env };
}

/** Publishes the discriminated readiness object the worker polls for. */
export function publishReady(ready: CaptureReady): void {
  if (typeof window !== "undefined") window[CAPTURE_READY_KEY] = ready;
}
