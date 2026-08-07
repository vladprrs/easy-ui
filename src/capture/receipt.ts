/**
 * Capture receipt — один машиночитаемый документ о происхождении кадра
 * (план `docs/plans/2026-08-03-renderer-contract-2.md` §3 **E4**, §5 **R5**).
 *
 * Зачем. До этой волны доказательства капчура ехали **только** байтовым каналом приёмки
 * (`deliver:"bytes"`, `probe:"paint"`): интерактивный `snap`, кадр визуального рана и вообще всё,
 * что уезжает в asset-store, не несло ни рендерера, ни readiness, ни таймингов (дыра §1.6).
 * Receipt закрывает её тем, что собирается **до ветвления по kind** — то есть один и тот же
 * документ получают оба канала доставки.
 *
 * Три правила формы, которые здесь держатся:
 *
 * 1. **Детерминизм.** Receipt — функция объявленных входов, кроме двух явно волатильных мест:
 *    `timings` (измерение) и `renderer.provenance.builtAt` (штамп сборки). Сравнивать два
 *    receipt'а «по существу» полагается через {@link stableReceiptView}, а не глазами.
 * 2. **`output: null` — это факт, а не пропуск.** У `probe:"geometry"` PNG не существует вовсе
 *    (C-M8), и врать нулевыми размерами нельзя.
 * 3. **`null` вместо выдумки.** Поля, которых доказательство не принесло (шелл до волны, политика
 *    v1, отсутствующая тема), остаются `null`; отсутствие доказательства не превращается в «ок».
 *
 * Модуль живёт в `src/capture/`, потому что типы receipt'а — общий словарь клиента и сервера, и
 * не зависит ни от Bun, ни от серверных модулей: объявление рендерера принимается **структурно**
 * ({@link ReceiptRendererDeclaration}), чтобы `src/` не импортировал `server/`.
 */
import { canonicalStringify } from "./canonicalJson";
import { sanitizeCaptureCodes, type CaptureCode } from "./failureCodes";

export const CAPTURE_RECEIPT_VERSION = 1;

/** Потолки списков: receipt — диагностика, а не дамп страницы. */
export const RECEIPT_FONT_FACES_LIMIT = 64;
export const RECEIPT_IMAGES_LIMIT = 64;
export const RECEIPT_CONSOLE_LIMIT = 100;
export const RECEIPT_THEME_RESOURCES_LIMIT = 200;
/** Сколько **различных** сигнатур подавленного шума едет в receipt (W10); счётчики точны. */
export const RECEIPT_SUPPRESSED_SIGNATURES_LIMIT = 32;
/** Потолок длины одной сигнатуры: она — ключ агрегации, а не сообщение целиком. */
export const RECEIPT_SIGNATURE_LENGTH_LIMIT = 200;

/**
 * Структурная проекция `RendererDeclaration` (`server/capture/renderer.ts`). Дублируется здесь
 * намеренно: `src/` не импортирует `server/`, а форма сверяется тестом.
 */
export interface ReceiptRendererDeclaration {
  rendererSchema: number;
  rendererVersion: string;
  os: string;
  arch: string;
  nodeVersion: string | null;
  playwrightVersion: string | null;
  browserName: string;
  browserVersion: string | null;
  browserRevision: string | null;
  launchedExecutable: string | null;
  browserExecutableSha256: string | null;
  fontStackSha256: string | null;
  appFontsSha256: string | null;
  systemLibsHash: string | null;
  launchDeterminismArgsHash: string;
  contextOptionsHash: string | null;
  colorProfile: "srgb";
  source: "manifest" | "fallback";
  provenance: { buildSha: string | null; imageRef: string | null; builtAt: string | null; bunVersion: string | null } | null;
}

export interface CaptureReceiptRenderer extends ReceiptRendererDeclaration {
  /** Отпечаток рендерера под readiness-политику **этой** джобы (E1). */
  fingerprint: string;
  /** Версия браузера, которую сообщил фактически нарисовавший кадр процесс. */
  observedBrowserVersion: string | null;
  /**
   * Расхождения объявленного и наблюдённого (E2). Пустой массив — сверка прошла; непустой при
   * `EASYUI_RENDERER_STRICT_MANIFEST=0` означает, что кадр снят вопреки расхождению.
   */
  drift: CaptureCode[];
}

/** Цель капчура. Поля, неприменимые к виду цели, — `null`, а не отсутствуют (форма стабильна). */
export interface CaptureReceiptTarget {
  kind: "prototype" | "component" | "component-draft";
  componentId: string | null;
  prototypeId: string | null;
  /** Опубликованная версия компонента (`kind:"component"`). */
  version: number | null;
  /** Ревизия прототипа либо head-ревизия драфта. */
  rev: number | null;
  /** sha256 исходника драфта/кандидата. */
  sourceHash: string | null;
  bundleHash: string | null;
  dsMetaVersion: number | null;
  propsHash: string | null;
}

export interface CaptureReceiptFontFace {
  family: string;
  weight: string;
  style: string;
  assetId: string | null;
  sha256: string | null;
  status: string;
  /** `document.fonts.check()` строгой политики R4; `null` — политика v1, проверки не было. */
  checked: boolean | null;
  /** Был ли face обязательным (пересечение манифеста темы и наблюдённых семейств, T-M10). */
  required: boolean | null;
}

export interface CaptureReceiptImage {
  url: string;
  assetId: string | null;
  naturalWidth: number | null;
  naturalHeight: number | null;
  decoded: boolean | null;
  contentHash: string | null;
}

/**
 * Эхо фазы барьера ресурсов (план 2026-08-07 §W2). `null` — политика барьера не требовала (v1/v2)
 * **или** доказательство не приехало; различить эти случаи — предмет гейта `readiness`, который
 * знает политику джобы и отказывает кадру с `met:true` без блока при v3 (§1.5).
 */
export interface CaptureReceiptResourceBarrier {
  expected: number;
  decoded: number;
  fontsReady: boolean;
  stableFrames: number;
  lateAfterBarrier: string[];
  durationMs: number;
}

export interface CaptureReceiptResources {
  /** Хэш манифеста шрифтов темы джобы (N4: свойство темы, а не рендерера). */
  fontManifestHash: string | null;
  fontFaces: CaptureReceiptFontFace[];
  images: CaptureReceiptImage[];
  themeResources: { tokens: string[]; icons: string[]; images: string[] } | null;
  /** W2: доказательство барьера ресурсов; `null` — блока в evidence не было. */
  resourceBarrier: CaptureReceiptResourceBarrier | null;
}

/**
 * Свёрнутая сигнатура подавленного сообщения (W10). `count` — сколько раз сигнатура встретилась
 * в **этом** капчуре: сотня одинаковых `favicon.ico 404` в логе неотличима от одной, а разница
 * между «один раз» и «сто раз» — как раз то, что человек и агент читают в регрессионном логе.
 */
export interface CaptureReceiptSuppressedSignature {
  signature: string;
  count: number;
}

export interface CaptureReceiptConsole {
  errors: string[];
  warnings: string[];
  pageErrors: string[];
  /**
   * W10 (P2.2): консольный шум, **подавленный** классификацией капчура (`infraNoise`), свёрнутый
   * в `{signature, count}`. Пустой массив — либо шума не было, либо доказательство не приехало;
   * различать эти случаи receipt не берётся (подавленное не влияет на вердикт).
   */
  suppressed: CaptureReceiptSuppressedSignature[];
}

export interface CaptureReceiptOutput {
  viewport: { width: number; height: number };
  dpr: number;
  colorScheme: "light" | "dark";
  pngWidth: number;
  pngHeight: number;
  /** sha256 байтов PNG, посчитанный воркером; `null` — воркер до волны R5. */
  pngSha256: string | null;
  /** Бокс `#eui-capture-surface` в CSS px на момент съёмки; `null` — воркер его не измерил. */
  surfaceRect: { x: number; y: number; width: number; height: number } | null;
  /** Поле paint-режима, CSS px (W3). Отсутствует в прочих режимах. */
  paintMargin?: number;
}

/**
 * Тайминги капчура. `null` — «не измерялось», и это честнее нуля.
 *
 * Пофазовый раскол ожидания (`fonts/images/network/frames/stabilize`, а с волны W2 и `barrierMs`)
 * приезжает из `collectReadiness` блоком `evidence.phaseTimings` и раскладывается здесь: до W2
 * поля объявлялись схемой, но не заполнялись — измерять их мог только сам readiness, чья правка
 * была вне объёма R5.
 */
export interface CaptureReceiptTimings {
  navigateMs: number | null;
  fontsMs: number | null;
  imagesMs: number | null;
  networkMs: number | null;
  framesMs: number | null;
  stabilizeMs: number | null;
  screenshotMs: number | null;
  totalMs: number | null;
  /** Суммарное ожидание готовности, измеренное воркером (от навигации до handshake). */
  readyMs: number | null;
  /** То же по версии страницы (`ReadinessReport.elapsedMs`). */
  readinessMs: number | null;
  /** W2: длительность фазы барьера ресурсов (`evidence.resourceBarrier.durationMs`). */
  barrierMs: number | null;
}

export interface CaptureReceiptVerdict {
  captureClean: boolean;
  codes: CaptureCode[];
  readinessMet: boolean | null;
  readinessPolicyHash: string | null;
}

export interface CaptureReceipt {
  receiptVersion: typeof CAPTURE_RECEIPT_VERSION;
  renderer: CaptureReceiptRenderer;
  target: CaptureReceiptTarget;
  resources: CaptureReceiptResources;
  console: CaptureReceiptConsole;
  /** `null` для `probe:"geometry"`: кадра в этой ветке не существует (C-M8). */
  output: CaptureReceiptOutput | null;
  timings: CaptureReceiptTimings;
  verdict: CaptureReceiptVerdict;
}

/** Доказательство readiness в том виде, в каком его публикует поверхность (`CaptureReadinessReport`). */
export interface ReceiptReadinessInput {
  met: boolean | null;
  policyHash: string | null;
  codes: readonly CaptureCode[] | null;
  elapsedMs?: number | null;
  evidence: Record<string, unknown> | null;
}

export interface CaptureReceiptInput {
  renderer: ReceiptRendererDeclaration;
  fingerprint: string;
  observedBrowserVersion?: string | null;
  drift?: readonly CaptureCode[];
  target: Partial<CaptureReceiptTarget> & { kind: CaptureReceiptTarget["kind"] };
  fontManifestHash?: string | null;
  readiness?: ReceiptReadinessInput | null;
  console?: {
    errors?: readonly string[];
    warnings?: readonly string[];
    pageErrors?: readonly string[];
    /** W10: сырые подавленные сообщения (`infraNoise`); сворачиваются в сигнатуры здесь. */
    suppressed?: readonly string[];
  };
  output?: CaptureReceiptOutput | null;
  timings?: Partial<CaptureReceiptTimings>;
  captureClean: boolean;
}

const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const strings = (value: unknown, limit: number): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, limit) : [];

/**
 * Сигнатура консольного сообщения (W10): ключ, по которому повторы сворачиваются в один пункт.
 *
 * Нормализуются ровно те части, которые меняются от капчура к капчуру и при этом не несут
 * смысла для читателя лога: хвост многострочного сообщения (стек), query/hash абсолютных URL,
 * длинные hex-последовательности (sha ассетов, id) и длинные числа (таймстемпы, счётчики).
 * Коды вроде `404` и порты остаются как есть — по ним шум и опознают.
 */
export function consoleSignature(message: string): string {
  const firstLine = message.split("\n", 1)[0] ?? "";
  return firstLine
    .replace(/\bhttps?:\/\/[^\s)"'<>]+/gi, (url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
      } catch { return url.replace(/[?#].*$/, ""); }
    })
    // Числа — раньше hex: длинный таймстемп состоит из hex-цифр и иначе стал бы «хешем».
    // Границы — лукахеды, а не `\b`: `asset_<sha>` не даёт границы слова после подчёркивания.
    .replace(/(?<![0-9a-z])\d{6,}(?![0-9a-z])/gi, "<n>")
    .replace(/(?<![0-9a-z])[0-9a-f]{8,}(?![0-9a-z])/gi, "<hash>")
    .trim()
    .slice(0, RECEIPT_SIGNATURE_LENGTH_LIMIT);
}

/**
 * Агрегат подавленного шума. Порядок детерминирован (частота убыв., затем сигнатура возр.) —
 * receipt сравнивают побайтово; обрезается **число различных** сигнатур, а не счётчики.
 */
function suppressedOf(messages: readonly string[] | undefined): CaptureReceiptSuppressedSignature[] {
  if (!Array.isArray(messages)) return [];
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (typeof message !== "string") continue;
    const signature = consoleSignature(message);
    if (signature.length === 0) continue;
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([signature, count]) => ({ signature, count }))
    .sort((left, right) => (right.count - left.count) || (left.signature < right.signature ? -1 : left.signature > right.signature ? 1 : 0))
    .slice(0, RECEIPT_SUPPRESSED_SIGNATURES_LIMIT);
}

/** Порядок faces не должен зависеть от порядка обхода DOM — receipt сравнивают побайтово. */
function faceKey(face: CaptureReceiptFontFace): string {
  return `${face.family} ${face.weight} ${face.style} ${face.assetId ?? ""}`;
}

function fontFacesOf(evidence: Record<string, unknown> | null): CaptureReceiptFontFace[] {
  const raw = evidence?.fontFaces;
  if (!Array.isArray(raw)) return [];
  const faces = raw.slice(0, RECEIPT_FONT_FACES_LIMIT).flatMap((item): CaptureReceiptFontFace[] => {
    if (item === null || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return [{
      family: str(record.family) ?? "",
      weight: str(record.weight) ?? "",
      style: str(record.style) ?? "",
      assetId: str(record.assetId),
      sha256: str(record.sha256),
      status: str(record.status) ?? "unknown",
      checked: bool(record.checked),
      required: bool(record.required),
    }];
  });
  return faces.sort((left, right) => (faceKey(left) < faceKey(right) ? -1 : faceKey(left) > faceKey(right) ? 1 : 0));
}

/**
 * Картинки кадра. Источник — пофайловое доказательство строгого декода R4 (`imageDetails`);
 * агрегат `images:{total,decoded,failed}` политики v1 пофайловых записей не несёт, и выдумывать
 * их из счётчиков нельзя — тогда `images: []` честно означает «пофайловых доказательств нет».
 */
function imagesOf(evidence: Record<string, unknown> | null): CaptureReceiptImage[] {
  const raw = evidence?.imageDetails;
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, RECEIPT_IMAGES_LIMIT).flatMap((item): CaptureReceiptImage[] => {
    if (item === null || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return [{
      url: str(record.url) ?? "",
      assetId: str(record.assetId),
      naturalWidth: num(record.naturalWidth),
      naturalHeight: num(record.naturalHeight),
      decoded: bool(record.decoded),
      contentHash: str(record.contentHash),
    }];
  });
}

function themeResourcesOf(evidence: Record<string, unknown> | null): CaptureReceiptResources["themeResources"] {
  const raw = evidence?.themeResources;
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  return {
    tokens: strings(record.tokens, RECEIPT_THEME_RESOURCES_LIMIT),
    icons: strings(record.icons, RECEIPT_THEME_RESOURCES_LIMIT),
    images: strings(record.images, RECEIPT_THEME_RESOURCES_LIMIT),
  };
}

/**
 * Блок барьера из доказательства readiness. Форма проверяется структурно, а не типом: evidence
 * приезжает из страницы `Record<string, unknown>`, и неполный блок — это отсутствие доказательства,
 * а не «частично исполненный барьер».
 */
function resourceBarrierOf(evidence: Record<string, unknown> | null): CaptureReceiptResourceBarrier | null {
  const raw = evidence?.resourceBarrier;
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const expected = num(record.expected);
  const decoded = num(record.decoded);
  const stableFrames = num(record.stableFrames);
  const durationMs = num(record.durationMs);
  const fontsReady = bool(record.fontsReady);
  if (expected === null || decoded === null || stableFrames === null || durationMs === null || fontsReady === null) return null;
  return {
    expected, decoded, fontsReady, stableFrames, durationMs,
    lateAfterBarrier: strings(record.lateAfterBarrier, RECEIPT_THEME_RESOURCES_LIMIT),
  };
}

/**
 * Тайминги: явно переданное воркером сильнее, пофазовое доказательство страницы — источник
 * остальных полей. Барьерный `barrierMs` берётся из `phaseTimings`, а при его отсутствии — из
 * `resourceBarrier.durationMs` (то же число, измеренное самой фазой).
 */
const timingsOf = (
  input: Partial<CaptureReceiptTimings> | undefined,
  evidence: Record<string, unknown> | null,
  barrier: CaptureReceiptResourceBarrier | null,
): CaptureReceiptTimings => {
  const phases = (evidence?.phaseTimings ?? null) as Record<string, unknown> | null;
  const phase = (name: string): number | null => (phases === null ? null : num(phases[name]));
  return {
    navigateMs: num(input?.navigateMs),
    fontsMs: num(input?.fontsMs) ?? phase("fontsMs"),
    imagesMs: num(input?.imagesMs) ?? phase("imagesMs"),
    networkMs: num(input?.networkMs) ?? phase("networkMs"),
    framesMs: num(input?.framesMs) ?? phase("framesMs"),
    stabilizeMs: num(input?.stabilizeMs) ?? phase("stabilizeMs"),
    screenshotMs: num(input?.screenshotMs),
    totalMs: num(input?.totalMs),
    readyMs: num(input?.readyMs),
    readinessMs: num(input?.readinessMs),
    barrierMs: num(input?.barrierMs) ?? phase("barrierMs") ?? barrier?.durationMs ?? null,
  };
};

/**
 * Собирает receipt. Чистая функция: тот же вход — тот же документ (включая порядок ключей после
 * {@link canonicalReceiptJson}).
 */
export function buildCaptureReceipt(input: CaptureReceiptInput): CaptureReceipt {
  const evidence = input.readiness?.evidence ?? null;
  const fontManifestHash = input.fontManifestHash ?? str(evidence?.fontManifestHash) ?? null;
  const resourceBarrier = resourceBarrierOf(evidence);
  return {
    receiptVersion: CAPTURE_RECEIPT_VERSION,
    renderer: {
      ...input.renderer,
      fingerprint: input.fingerprint,
      observedBrowserVersion: input.observedBrowserVersion ?? null,
      drift: sanitizeCaptureCodes(input.drift ?? []),
    },
    target: {
      kind: input.target.kind,
      componentId: input.target.componentId ?? null,
      prototypeId: input.target.prototypeId ?? null,
      version: input.target.version ?? null,
      rev: input.target.rev ?? null,
      sourceHash: input.target.sourceHash ?? null,
      bundleHash: input.target.bundleHash ?? null,
      dsMetaVersion: input.target.dsMetaVersion ?? null,
      propsHash: input.target.propsHash ?? null,
    },
    resources: {
      fontManifestHash,
      fontFaces: fontFacesOf(evidence),
      images: imagesOf(evidence),
      themeResources: themeResourcesOf(evidence),
      resourceBarrier,
    },
    console: {
      errors: strings(input.console?.errors, RECEIPT_CONSOLE_LIMIT),
      warnings: strings(input.console?.warnings, RECEIPT_CONSOLE_LIMIT),
      pageErrors: strings(input.console?.pageErrors, RECEIPT_CONSOLE_LIMIT),
      suppressed: suppressedOf(input.console?.suppressed),
    },
    output: input.output ?? null,
    timings: timingsOf(input.timings, evidence, resourceBarrier),
    verdict: {
      captureClean: input.captureClean,
      codes: sanitizeCaptureCodes(input.readiness?.codes ?? []),
      readinessMet: input.readiness ? input.readiness.met : null,
      readinessPolicyHash: input.readiness?.policyHash ?? null,
    },
  };
}

/** Канонический JSON receipt'а — то, что кладётся в стор и адресуется его sha256. */
export function canonicalReceiptJson(receipt: CaptureReceipt): string {
  return canonicalStringify(receipt);
}

/**
 * Проекция без волатильных полей (`timings`, `provenance.builtAt`) — по ней сравнивают два
 * receipt'а одного входа: инвариант done-критерия R5 «receipt детерминирован кроме таймингов».
 */
export function stableReceiptView(receipt: CaptureReceipt): string {
  const provenance = receipt.renderer.provenance;
  return canonicalStringify({
    ...receipt,
    renderer: {
      ...receipt.renderer,
      provenance: provenance === null ? null : { ...provenance, builtAt: null },
    },
    timings: null,
  });
}
