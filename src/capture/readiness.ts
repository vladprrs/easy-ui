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
import { codesFromReadinessReasons, type CaptureCode } from "./failureCodes";
import { CAPTURE_BOOTSTRAP_KEY, CAPTURE_READY_KEY, type CaptureBootstrap, type CaptureReady } from "./protocol";
import {
  DEFAULT_READINESS_POLICY, isReadinessPolicy, readinessPolicyHash,
  type ReadinessPolicy,
} from "./readinessPolicy";

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

export interface ReadinessFontFace { family: string; weight: string; style: string; status: string }

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
  /** Незавершённое на момент истечения политики: URL картинок/ресурсов и незагруженные шрифты. */
  pendingRequests: string[];
  framesWaited: number;
  animationsDisabled: boolean;
  themeResources: ReadinessThemeResources;
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

interface FontOutcome { faces: ReadinessFontFace[]; pending: string[]; timedOut: boolean }

async function settleFonts(policy: ReadinessPolicy, elements: Element[], deadline: number): Promise<FontOutcome> {
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  if (!fonts) return { faces: [], pending: [], timedOut: false };
  const used = policy.fonts === "used-faces" ? new Set(usedFontFamilies(elements)) : null;
  let timedOut = false;

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
  try {
    for (const face of fonts as unknown as Iterable<FontFace>) {
      const family = normalizeFamily(face.family ?? "");
      if (used && !used.has(family)) continue;
      faces.push({ family: face.family, weight: face.weight, style: face.style, status: face.status });
      // Незавершённой считается только `loading`. `unloaded` — это face, который браузеру не
      // понадобился (напр. weight 700 семейства, применённого в weight 400): считать его
      // «неготовым» значило бы валить readiness на каждой теме с несколькими начертаниями.
      // `error` попадает в доказательство, но вердикта не меняет: он может относиться к
      // неиспользуемому начертанию, а видимый дефект поймает визуальный гейт.
      if (face.status === "loading") pending.push(`font:${face.family} ${face.weight} ${face.style} (${face.status})`);
    }
  } catch { /* FontFaceSet без итератора (jsdom): доказательства беднее, политика не падает */ }
  faces.sort((left, right) => (left.family < right.family ? -1 : left.family > right.family ? 1 : 0));
  return { faces, pending, timedOut };
}

interface ImageOutcome { total: number; decoded: number; failed: number; pending: string[]; timedOut: boolean }

async function settleImages(root: ParentNode, deadline: number): Promise<ImageOutcome> {
  const images = Array.from(root.querySelectorAll("img"));
  let decoded = 0;
  let failed = 0;
  let timedOut = false;
  const pending: string[] = [];
  for (const image of images) {
    let ok = false;
    if (typeof image.decode === "function") {
      const decodedPromise = image.decode().then(() => { ok = true; }).catch(() => { ok = false; });
      if (!await within(decodedPromise, deadline)) timedOut = true;
    } else {
      ok = image.complete && image.naturalWidth > 0;
    }
    // `decode()` резолвится и на «уже отрисованной» картинке — критерий успеха один: есть растр.
    if (ok || (image.complete && image.naturalWidth > 0)) decoded += 1;
    else { failed += 1; pending.push(`image:${image.currentSrc || image.src}`); }
  }
  return { total: images.length, decoded, failed, pending, timedOut };
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

/**
 * Исполняет политику readiness над поверхностью и собирает доказательство. Никогда не бросает:
 * невыполненная политика — это `met: false` с причиной, а не сбой капчура.
 */
export async function collectReadiness(root: ParentNode, policy: ReadinessPolicy = DEFAULT_READINESS_POLICY): Promise<ReadinessReport> {
  const startedAt = now();
  const deadline = startedAt + policy.timeoutMs;
  const policyHash = await readinessPolicyHash(policy);
  const animationsDisabled = policy.animations === "disabled" ? injectAnimationFreeze() : false;
  const elements = elementsOf(root);
  const reasons: string[] = [];

  const fonts = await settleFonts(policy, elements, deadline);
  if (fonts.timedOut) reasons.push("fonts_timeout");
  const images = await settleImages(root, deadline);
  if (images.timedOut) reasons.push("images_timeout");
  if (images.failed > 0) reasons.push("images_failed");
  const network = await settleNetwork(policy, deadline);
  if (network.timedOut) reasons.push("network_timeout");
  const frames = await settleFrames(policy, deadline);
  if (frames.timedOut) reasons.push("frames_timeout");
  if (fonts.pending.length > 0) reasons.push("fonts_pending");

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
    codes: codesFromReadinessReasons(reasons),
    policyHash,
    elapsedMs: Math.round(now() - startedAt),
    evidence: {
      fontFaces: fonts.faces,
      images: { total: images.total, decoded: images.decoded, failed: images.failed },
      pendingRequests: [...images.pending, ...fonts.pending].slice(0, 50),
      framesWaited: frames.framesWaited,
      animationsDisabled,
      themeResources,
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
): Promise<{ readiness: ReadinessReport; env: CaptureEnv }> {
  const readiness = await collectReadiness(root, policy);
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
