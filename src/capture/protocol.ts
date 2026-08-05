/**
 * Shared capture-shell protocol: the `__EUI_CAPTURE_BOOTSTRAP__` object the
 * worker injects before navigation and the `__EUI_CAPTURE_READY__` object the
 * shell publishes once the screen surface has settled. Both discriminated
 * unions keep the prototype and component captures strictly separate so the
 * worker can canonically compare the shell's readiness with the enqueue
 * snapshot (`expected`).
 */
import type { CaptureEnvInput } from "./env";
import type { CaptureCode } from "./failureCodes";
import type { ReadinessPolicy } from "./readinessPolicy";

export interface PrototypeExpected {
  kind: "prototype";
  prototypeInstanceId: string;
  rev: number;
  componentManifestHash: string;
  builtinCatalogHash: string;
  /**
   * Дизайн-система **снимаемого экрана** (план multi-surface-flows, D14): у мульти-поверхностного
   * документа экраны разных поверхностей рендерятся разными ДС, и без явной системы дрейф темы
   * второй ДС не детектировался бы handshake'ом. Для одно-поверхностного дока — `doc.designSystem`.
   */
  designSystem: string | null;
  /** Пиннутая версия темы **этой** ДС (карта `prototype_revision_theme_pins`, миграция v24). */
  dsMetaVersion: number | null;
  rendererBuild: string | null;
}

export interface ComponentExpected {
  kind: "component";
  componentId: string;
  version: number;
  bundleHash: string;
  propsHash: string;
  dsMetaVersion: number | null;
  rendererBuild: string | null;
}

/**
 * Draft variant of the component handshake (план 2026-08-02, P1b): the target
 * is a saved but unpublished head revision rendered from the ephemeral
 * validate candidate bundle. `rev` + `sourceHash` replace the published
 * `version`; the bundle itself is job-scoped by the content-addressed URL
 * the enqueue puts into the bootstrap target.
 */
export interface ComponentDraftExpected {
  kind: "component-draft";
  componentId: string;
  rev: number;
  sourceHash: string;
  bundleHash: string;
  propsHash: string;
  dsMetaVersion: number | null;
  rendererBuild: string | null;
  /**
   * Слот-привязки случая приёмки (план 2026-08-05 §A3): sha256 **разрешённого** кортежа
   * `[{slot,index,componentId,version,bundleHash,propsHash}]`. Присутствует ровно тогда, когда
   * случай что-то положил в слоты — бесслотовый handshake обязан остаться байт-в-байт прежним
   * (§«Design invariants»), поэтому поле опционально и никогда не едет как `null`/пустая строка.
   */
  slotsHash?: string;
}

export type CaptureExpected = PrototypeExpected | ComponentExpected | ComponentDraftExpected;

/**
 * Объявленный face темы (план renderer-contract-2 §5 **R4**). Собирает его **сервер** на
 * постановке: `themeContent.fonts[].src` — это assetId (`assetUrl(font.src)` в `ThemeStyle`), а
 * sha256 содержимого выводится из формата id `asset_<sha256>`; в схеме темы ни того, ни другого
 * поля нет (C-m13), поэтому парсинг — явный объём волны.
 *
 * Поверхность не ходит за этим списком в API: манифест обязан относиться к той же версии темы,
 * по которой считался `case_fingerprint` джобы.
 */
export interface CaptureFontFaceDeclaration {
  family: string;
  /** CSS-значение `font-weight` как объявлено темой (в т.ч. диапазон variable-шрифта, `"400 700"`). */
  weight: string;
  style: string;
  assetId: string;
  /** sha256 файла шрифта, если id содержит его (`asset_<sha256>`); иначе `null`. */
  sha256: string | null;
}

/** Манифест шрифтов темы джобы: объявленные faces + их хэш (вход receipt'а R5 и guard'а R6). */
export interface CaptureFontManifest {
  declared: CaptureFontFaceDeclaration[];
  manifestHash: string;
}

/**
 * Доказательство готовности кадра (план §5 W4). Едет **рядом** с handshake-полями и в сравнение
 * `readyToExpected` ↔ `expected` не входит: политика в `expected` не дублируется (триаж R1-m2),
 * сервер сверяет её хэш прямо в результате. Для не-acceptance путей поле advisory.
 */
export interface CaptureReadinessReport {
  met: boolean;
  reason?: string;
  /**
   * Типизированные коды тех же причин (§5 R3). Опционально: шелл, собранный до волны, их не шлёт,
   * и это «неизвестно», а не «пусто». `reason` рядом сохраняется в доволновом формате — маппинг
   * не биективен (§3 E3, C-M5), поэтому одно поле не выводится из другого.
   */
  codes?: CaptureCode[];
  policyHash: string;
  elapsedMs: number;
  evidence: {
    /**
     * `checked`/`required`/`assetId`/`sha256` — строгая политика R4: какие faces были **обязаны**
     * приехать (пересечение манифеста темы и наблюдённых семейств, T-M10) и что показал
     * `document.fonts.check()`. У политики v1 полей нет — форма доказательства аддитивна.
     */
    fontFaces: { family: string; weight: string; style: string; status: string; required?: boolean; checked?: boolean; assetId?: string; sha256?: string | null }[];
    images: { total: number; decoded: number; failed: number };
    /** Строгий декод R4: пофайловое доказательство (URL/assetId/интринсики/contentHash). */
    imageDetails?: { url: string; assetId: string | null; naturalWidth: number; naturalHeight: number; decoded: boolean; contentHash: string | null }[];
    /** Исход стабилизации layout (R4): присутствует, когда политика её требует. */
    layout?: { stable: boolean; attempts: number; elementKey: string | null };
    /** Хэш манифеста шрифтов темы, по которому судились required-faces (R4). */
    fontManifestHash?: string | null;
    pendingRequests: string[];
    framesWaited: number;
    animationsDisabled: boolean;
    /** Наблюдённые ресурсы темы — вход импакт-анализа W6 (триаж R2-14). */
    themeResources: { tokens: string[]; icons: string[]; images: string[] };
  };
}

/** Отпечаток окружения капчура (`src/capture/env.ts`) — публикуется вместе с readiness. */
export interface CaptureEnvReport {
  fingerprint: string;
  input: CaptureEnvInput;
}

/** Общие для всех ready-вариантов дополнительные поля W4 (опциональны: старый шелл их не шлёт). */
export interface CaptureReadyExtras {
  readiness?: CaptureReadinessReport;
  env?: CaptureEnvReport;
}

export interface PrototypeReady extends CaptureReadyExtras {
  status: "ready";
  kind: "prototype";
  prototypeInstanceId: string;
  revision: number;
  componentManifestHash: string;
  builtinCatalogHash: string;
  /** Резолвнутая пара `(designSystem, dsMetaVersion)` снимаемого экрана — см. `PrototypeExpected`. */
  designSystem: string | null;
  dsMetaVersion: number | null;
  rendererBuild: string | null;
}

export interface ComponentReady extends CaptureReadyExtras {
  status: "ready";
  kind: "component";
  componentId: string;
  version: number;
  bundleHash: string;
  propsHash: string;
  dsMetaVersion: number | null;
  rendererBuild: string | null;
}

export interface ComponentDraftReady extends CaptureReadyExtras {
  status: "ready";
  kind: "component-draft";
  componentId: string;
  rev: number;
  sourceHash: string;
  bundleHash: string;
  propsHash: string;
  dsMetaVersion: number | null;
  rendererBuild: string | null;
  /**
   * Эхо `bootstrap.expected.slotsHash` (домашний паттерн: rev/sourceHash/bundleHash поверхность
   * тоже эхорит, пересчитывается только `propsHash`). Отсутствует у бесслотового кадра.
   */
  slotsHash?: string;
}

export interface CaptureErrorReady extends CaptureReadyExtras {
  status: "error";
  error: string;
}

export type CaptureReady = PrototypeReady | ComponentReady | ComponentDraftReady | CaptureErrorReady;

/**
 * Prototype-target payload the enqueue freezes into `bootstrap.target` (план 2026-08-02, P2.3).
 * `components`/`componentManifestHash` присутствуют, когда постановка джобы уже разрешила пины:
 * поверхность рендерит именно их и публикует именно этот manifest-hash, поэтому публикация
 * новой версии компонента между enqueue и рендером не ломает exact-match handshake.
 */
export interface PrototypeBootstrapTarget {
  kind: "prototype";
  rev: number;
  componentManifestHash?: string;
  components?: { id: string; name: string; version: number; bundleUrl: string; bundleHash: string; status?: string }[];
}

/**
 * Опубликованный ребёнок слота, замороженный на постановке (план 2026-08-05 §A6). Форма — та же,
 * что у пинов прототипа: поверхность грузит бандл по `bundleUrl` и сверяет `bundleHash`.
 */
export interface CaptureSlotChildPin {
  id: string;
  name: string;
  version: number;
  bundleUrl: string;
  bundleHash: string;
  status: string;
}

/**
 * Один ребёнок в порядке рендера. `slot` **отсутствует** у детей неявного слота `children`
 * (§A2a: канон дефолтного слота — запись без ключа; `runtimeSpec` схлопывает обе формы в
 * `slotIndices.default`). `name` — имя опубликованного компонента, оно же ключ `customTypes`.
 */
export interface CaptureSlotTreeEntry {
  slot?: string;
  index: number;
  name: string;
  props: Record<string, unknown>;
}

/** Слот-содержимое capture-джобы: пины бандлов + дерево рендера (план 2026-08-05 §A6). */
export interface CaptureSlotsBootstrap {
  children: CaptureSlotChildPin[];
  tree: CaptureSlotTreeEntry[];
}

/** Worker-injected bootstrap. Absent in browser (Library) preview mode. */
export interface CaptureBootstrap {
  kind: "prototype" | "component" | "component-draft";
  target: Record<string, unknown>;
  props?: Record<string, unknown>;
  /**
   * Draft captures only (P1b): props schema and named examples from the draft
   * extraction. A published capture reads them from the version DTO instead —
   * a draft has no published DTO, so the enqueue delivers them here, job-scoped
   * by construction.
   */
  propsJsonSchema?: unknown;
  examples?: Record<string, Record<string, unknown>>;
  /**
   * Режим `probe:"paint"` (план 2026-08-03 §3 D4, W3): поверхность рендерится с **прозрачным**
   * фоном и полем `marginPx` вокруг компонента, чтобы element-screenshot не клиппил чернила
   * (тень/блюр) коробкой `#eui-capture-surface` и ink-bbox вообще стал измерим. Поле отсутствует
   * во всех прочих режимах — они не меняются ни на пиксель.
   */
  paint?: { marginPx: number };
  /**
   * Политика readiness джобы (W4). Отсутствует — поверхность берёт дефолт
   * (`DEFAULT_READINESS_POLICY`), то есть интерактивные пути ведут себя как раньше.
   */
  readiness?: ReadinessPolicy;
  /**
   * Манифест шрифтов темы джобы (R4). Отсутствует — строгая политика вырождается в v1-семантику
   * шрифтов: у ДС без темы (`fonts: []`) требовать нечего (K3-оговорка §5 R4).
   */
  fonts?: CaptureFontManifest;
  /**
   * Слот-содержимое кандидатного капчура (план 2026-08-05 §A6). Отсутствует — поверхность строит
   * одноэлементное дерево, как и до волны: бесслотовый кадр не меняется ни на пиксель.
   */
  slots?: CaptureSlotsBootstrap;
  expected: CaptureExpected;
}

export const CAPTURE_READY_KEY = "__EUI_CAPTURE_READY__";
export const CAPTURE_BOOTSTRAP_KEY = "__EUI_CAPTURE_BOOTSTRAP__";

declare global {
  interface Window {
    __EUI_CAPTURE_READY__?: CaptureReady;
    __EUI_CAPTURE_BOOTSTRAP__?: CaptureBootstrap;
  }
}
