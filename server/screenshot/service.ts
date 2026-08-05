import type { Database } from "bun:sqlite";
import { canonicalStringify } from "../../src/capture/canonicalJson";
import type { CaptureExpected, CaptureFontFaceDeclaration, CaptureFontManifest, CaptureSlotTreeEntry } from "../../src/capture/protocol";
import {
  codesFromReadinessReason, isCaptureFailureCode, sanitizeCaptureCodes,
  type CaptureCode, type CaptureFailureCode,
} from "../../src/capture/failureCodes";
import { DEFAULT_READINESS_POLICY, type ReadinessPolicy } from "../../src/capture/readinessPolicy";
import type { GeometryCollection, GeometryRect, GeometryRole } from "../../src/capture/geometry.mjs";
import { resolveSpacingScale } from "../../src/designSystems/spacingScale";
import type { SpaceToken } from "../../src/designSystems/types";
import { analyzeScreenRegions } from "../../src/prototype/runtimeSpec";
import { REPEAT_RENDER_COST_BUDGET } from "../../src/prototype/validate";
import { getDesignSystemVersion, getLatestDesignSystemContent } from "../designSystems";
import type { ThemeContent } from "../designSystemsMeta";
import { ApiError } from "../http";
import { ensureDraftCandidate, getCandidateForRev, type DraftCandidate } from "../components/validate";
import { AssetRepo } from "../repos/assets";
import { ComponentRepo } from "../repos/components";
import { docDesignSystems, PrototypeRepo, themePinsOf } from "../repos/prototypes";
import { surfaceDesignSystem, surfaceOf } from "../../src/prototype/surfaces";
import { resolveCaptureMode } from "../capture/modes";
import { buildCaptureReceipt, type CaptureReceipt, type CaptureReceiptOutput, type CaptureReceiptTarget } from "../../src/capture/receipt";
import { getJobReceipt, putAssetReceipt, putJobReceipt, putReceipt, readReceipt, receiptsDisabled } from "../capture/receiptStore";
import { buildDeterminismArgs, compareBrowserVersion, policyHashOf, rendererDeclaration, rendererFingerprintOf, strictManifestEnabled } from "../capture/renderer";
import { buildStaticAllowedUrls, rendererBuildFrom } from "./allowedUrls";
import { classifyCaptureErrors } from "./noise";
import { CaptureSessionStore, JOB_DEADLINE_MS } from "./sessions";

export interface Viewport { width: number; height: number }
/** Пин компонента, замороженный на enqueue и отданный поверхности через `bootstrap.target`. */
export interface CapturePin { id: string; name: string; version: number; bundleUrl: string; bundleHash: string; status: string }
/**
 * Разрешённая слот-привязка случая приёмки (план 2026-08-05 §A6). Структурно — `ResolvedSlotBinding`
 * (`server/acceptance/cases.ts`); объявлена здесь, потому что screenshot-слой про приёмку не знает
 * и знать не должен: он получает уже опубликованные пины, а не манифест case-set'а.
 */
export interface CaptureSlotBinding {
  /** Ключ слота; `default` — неявный слот `children` (§A2a). */
  slot: string;
  /** Позиция внутри слота, с нуля: порядок рендера входит в кадр. */
  index: number;
  componentId: string;
  name: string;
  version: number;
  bundleHash: string;
  props: Record<string, unknown>;
  propsHash: string;
}
/**
 * Additive capture-quality contract (wave 7.1): `consoleErrors`/`pageErrors`
 * stay populated verbatim for backward compatibility, while `productErrors` /
 * `infraNoise` / `captureClean` say whether the *prototype* misbehaved.
 */
export interface CaptureQuality {
  captureClean: boolean;
  productErrors: string[];
  infraNoise: string[];
  runtimeWarnings: string[];
}
/**
 * Исход **джобы** (амендмент A3): крэш chromium, таймаут и отказ очереди до классификации
 * консоли (`noise.ts`, качество завершившегося капчура) вообще не доходят, поэтому у
 * acceptance-ретраев своя таксономия. `queue_full` не бывает исходом поставленной джобы —
 * его возвращает enqueue (см. {@link jobOutcomeOfError}).
 */
export type JobOutcome = "ok" | "worker_crash" | "timeout" | "queue_full" | "subprocess_error" | "renderer_mismatch" | "surface_missing";

/**
 * Исходы, которые ретраить бессмысленно (§5 R3, минор приёмки R1). `renderer_mismatch` —
 * расхождение объявленного манифеста и фактически нарисовавшего кадр браузера: повтор в том же
 * процессе даст ровно то же расхождение, а бюджет `maxInfraRetries` тратился бы на шум.
 *
 * `surface_missing` (минор R3, закрыт в R4) — на странице нет `#eui-capture-surface`: шелл не
 * отрендерил поверхность (ошибка компонента, неверный маршрут). До волны это ехало как
 * `subprocess_error` и жгло `maxInfraRetries` приёмки, хотя повтор даёт ровно ту же пустую
 * страницу — терминальность по канону `renderer_mismatch`.
 */
export const TERMINAL_JOB_OUTCOMES: readonly JobOutcome[] = ["renderer_mismatch", "surface_missing"] as const;
export const isTerminalJobOutcome = (outcome: JobOutcome): boolean => TERMINAL_JOB_OUTCOMES.includes(outcome);

/**
 * Режим измерения джобы. `geometry` — измерительная джоба без кадра (существующие ручки);
 * `paint` — комбинированная сессия W3 (прозрачная поверхность + маргин, geometry **и** PNG),
 * доступная только candidate-пути приёмки: она отдаёт байты мимо asset-store (A4).
 */
export type CaptureProbe = "geometry" | "paint";

/**
 * Исход readiness капчура (план §3 D5, §5 W4). Едет только с байтовыми исходами приёмки
 * (`image-bytes`/`paint`): публичные screenshot-ручки контракта не меняют. `null` — шелл
 * доказательства не прислал (старый билд/preview): для не-acceptance путей это advisory, для
 * гейта `readiness` — `indeterminate`, а не молчаливый pass.
 */
export interface CaptureReadinessOutcome {
  readinessMet: boolean | null;
  readinessReason: string | null;
  /**
   * Те же причины типизированным словарём (§5 R3). `null` — доказательства не было вовсе;
   * пустой массив — политика выполнена. Поле **не заменяет** `readinessReason`: маппинг не
   * биективен (§3 E3, C-M5), и доволновый формат причины сохраняется как есть.
   */
  readinessCodes: CaptureCode[] | null;
  /** sha256 политики, по которой шелл реально ждал — сверяется с политикой джобы. */
  readinessPolicyHash: string | null;
  readinessEvidence: Record<string, unknown> | null;
  /**
   * **Наблюдённая** in-page проба окружения (R1 плана renderer-contract-2, §3 E2): её снимает
   * сама страница уже после рендера. Объявленный рендерер (ключ reuse приёмки) — это `renderer`
   * ниже, и путать их нельзя, поэтому у наблюдения в имени стоит `observed`.
   */
  observedCaptureEnvFingerprint: string | null;
  observedCaptureEnv: Record<string, unknown> | null;
}

/**
 * Объявление рендерера, замороженное **на постановке** джобы (§5 R1). Едет в результат, чтобы
 * клиент (и e2e) мог сверить: тот ли рендерер нарисовал кадр, что публикует `/api/capabilities`.
 */
export interface RendererOnJob {
  rendererVersion: string;
  rendererSchema: number;
  fingerprint: string;
  browserName: string;
  /** Объявленная версия браузера; наблюдённая приезжает в `browserVersion` результата. */
  browserVersion: string | null;
  browserRevision: string | null;
  launchedExecutable: string | null;
  browserExecutableSha256: string | null;
  contextOptionsHash: string | null;
  launchDeterminismArgsHash: string;
  colorProfile: "srgb";
  source: "manifest" | "fallback";
}

/** Поле вокруг компонента в paint-режиме, CSS px (план §3 D4: «дефолт 64px»). */
export const DEFAULT_PAINT_MARGIN_PX = 64;
/** Потолок поля: 20 Мпикс-бюджет кадра тратится и на него. */
export const MAX_PAINT_MARGIN_PX = 256;

/** Классификация провала джобы по сообщению воркер-раннера/исключения execute. */
export function classifyJobFailure(message: string): Exclude<JobOutcome, "ok" | "queue_full"> {
  if (/timed out|timeout|deadline/i.test(message)) return "timeout";
  // `worker produced no result` — процесс умер, не написав результат (OOM/SIGKILL/креш chromium).
  if (/produced no result|target closed|browser has been closed|crash|SIGSEGV|SIGKILL|out of memory/i.test(message)) return "worker_crash";
  return "subprocess_error";
}

/** Исход для ошибки постановки/чтения джобы: 429 `queue_full` — единственный enqueue-исход. */
export function jobOutcomeOfError(error: unknown): Exclude<JobOutcome, "ok"> {
  if (error instanceof ApiError && error.code === "queue_full") return "queue_full";
  return classifyJobFailure(error instanceof Error ? error.message : String(error));
}

/**
 * Статус джобы наружу. `error` — доволновая форма (её код остаётся из старого словаря ручек:
 * `capture_failed`, `renderer_mismatch`, ApiError-код постановки); `outcome` и `failure` —
 * **аддитивные** поля R3: таксономия исхода джобы (A3) и типизированная причина капчура (E3).
 * Ни одно существующее поле не меняет ни имени, ни значения.
 */
export interface JobStatus {
  status: "queued" | "running" | "done" | "error";
  result?: ScreenshotResult;
  error?: { code: string; message: string };
  outcome?: JobOutcome;
  failure?: { code: CaptureFailureCode; message: string };
}
export interface ScreenshotImageResult extends CaptureQuality {
  kind: "image";
  imageUrl: string; assetId: string; width: number; height: number;
  imageProduced: boolean;
  consoleErrors: string[]; pageErrors: string[];
  bundleHash?: string;
  /** Draft head-revision target (P1b): the rendered rev, so clients can report "draft rev N". */
  draftRev?: number;
  componentPins?: { id: string; version: number; bundleHash: string }[];
  rendererBuild: string | null; browserVersion: string;
  /** Объявленный рендерер джобы (R1): отпечаток и его входы. */
  renderer?: RendererOnJob;
  /**
   * Адрес capture-receipt'а этого кадра в сторе receipt'ов (R5). Отсутствует, если receipt'ы
   * выключены kill-switch'ем `EASYUI_CAPTURE_RECEIPTS_DISABLED=1` либо запись не удалась
   * (капчур из-за этого не проваливается — доказательство не важнее кадра).
   */
  receiptSha256?: string;
}
/**
 * Байтовый исход image-джобы (амендмент A4): PNG отдаётся вызывающему (acceptance-оркестратору,
 * который кладёт его в CAS) и **не** ингестится в asset-store — у asset-store нет GC, а
 * acceptance снимает десятки кадров на run. Включается опцией enqueue `deliver: "bytes"`;
 * все существующие пути остаются на `deliver: "asset"`. Байты живут в памяти до истечения
 * RESULT_TTL (10 мин), размер кадра ограничен теми же 20 Мпикс, что и у asset-режима.
 */
export interface ScreenshotImageBytesResult extends CaptureQuality, CaptureReadinessOutcome {
  kind: "image-bytes";
  bytes: Uint8Array; width: number; height: number;
  imageProduced: boolean;
  consoleErrors: string[]; pageErrors: string[];
  bundleHash?: string;
  draftRev?: number;
  componentPins?: { id: string; version: number; bundleHash: string }[];
  rendererBuild: string | null; browserVersion: string;
  renderer?: RendererOnJob;
  /** Адрес capture-receipt'а этого кадра (R5). */
  receiptSha256?: string;
}
/**
 * Исход режима `probe:"paint"` (план 2026-08-03 §3 D4, §5 W3): **одна browser-сессия** отдаёт и
 * geometry-факты, и PNG прозрачной поверхности с маргин-полем. Отдельного «geometry-кадра» и
 * «image-кадра» больше нет — иначе `layoutBounds` и `paintBounds` относились бы к разным кадрам
 * (триаж R1-M3). Байты не ингестятся в asset-store (A4): режим доступен только candidate-пути.
 */
export interface ScreenshotPaintResult extends CaptureQuality, GeometryMeasurement, CaptureReadinessOutcome {
  kind: "paint";
  surface: "component";
  componentId: string;
  version?: number;
  draftRev?: number;
  bundleHash: string;
  designSystemMetaVersion: number | null;
  resolvedSpaceScale: Record<SpaceToken, string>;
  viewport: Viewport;
  dpr: number;
  /** Поле вокруг компонента, CSS px: краска, упёршаяся в его край, делает вердикт `indeterminate`. */
  paintMargin: number;
  bytes: Uint8Array;
  /** Размер PNG в **device** px (`bounds` ink-воркера нормализуются делением на `dpr`). */
  width: number;
  height: number;
  imageProduced: boolean;
  consoleErrors: string[];
  pageErrors: string[];
  rendererBuild: string | null;
  browserVersion: string;
  renderer?: RendererOnJob;
  /** Адрес capture-receipt'а этого кадра (R5). */
  receiptSha256?: string;
}
/** Geometry measurements shared by both capture surfaces (additive wave-7.1 shape). */
interface GeometryMeasurement {
  rects: GeometryRect[];
  truncated: boolean;
  total: number;
  safeArea: GeometryCollection["safeArea"];
  roleRects: GeometryCollection["roleRects"];
  frame: GeometryCollection["frame"];
  content: GeometryCollection["content"];
  scroll: GeometryCollection["scroll"];
  viewportOwnership: GeometryCollection["viewportOwnership"];
  issues: GeometryCollection["issues"];
  /** Детальные измерения W3 (`layoutBounds`/`effectSources`/`clipChain`) — только у `probe:"paint"`. */
  details?: GeometryCollection["details"];
  detailKeys?: string[];
}
export interface ScreenshotPrototypeGeometryResult extends CaptureQuality, GeometryMeasurement {
  kind: "geometry";
  /** Адрес capture-receipt'а измерительной джобы (R5): у неё `output: null` — кадра нет (C-M8). */
  receiptSha256?: string;
  surface: "prototype";
  resolvedRev: number;
  prototypeInstanceId: string;
  componentPins: { id: string; version: number; bundleHash: string }[];
  designSystemMetaVersion: number | null;
  resolvedSpaceScale: Record<SpaceToken, string>;
  viewport: Viewport;
  dpr: number;
}
/** Component-surface geometry probe (P1b): published version or draft head revision. */
export interface ScreenshotComponentGeometryResult extends CaptureQuality, GeometryMeasurement {
  kind: "geometry";
  /** Адрес capture-receipt'а измерительной джобы (R5): у неё `output: null` — кадра нет (C-M8). */
  receiptSha256?: string;
  surface: "component";
  componentId: string;
  /** Published target — mutually exclusive with `draftRev`. */
  version?: number;
  /** Draft head-revision target — mutually exclusive with `version`. */
  draftRev?: number;
  bundleHash: string;
  designSystemMetaVersion: number | null;
  resolvedSpaceScale: Record<SpaceToken, string>;
  viewport: Viewport;
  dpr: number;
}
/** Geometry probe result, discriminated by `surface` (P1b добавил компонентную поверхность). */
export type ScreenshotGeometryResult = ScreenshotPrototypeGeometryResult | ScreenshotComponentGeometryResult;
export type ScreenshotResult = ScreenshotImageResult | ScreenshotGeometryResult | ScreenshotImageBytesResult | ScreenshotPaintResult;

export interface WorkerJob {
  captureOrigin: string; captureUrl: string; token: string;
  bootstrap: { kind: "prototype" | "component" | "component-draft"; target: Record<string, unknown>; props?: Record<string, unknown>; propsJsonSchema?: unknown; examples?: Record<string, Record<string, unknown>>; paint?: { marginPx: number }; readiness?: ReadinessPolicy; fonts?: CaptureFontManifest; expected: CaptureExpected };
  allowedUrls: string[]; viewport: Viewport; deviceScaleFactor: number; colorScheme: "light" | "dark"; waitForFonts: boolean; expected: CaptureExpected;
  probe?: CaptureProbe; geometryLimit?: number; geometryRoleKeys?: Partial<Record<GeometryRole, string>>;
  /** ≤20 ключей маркеров для детальных измерений; пустой массив — корневой маркер (W3). */
  geometryDetailKeys?: string[];
  /**
   * Детерминизм-args запуска chromium (R2a): их выбирает **сервер** тем же списком, которым
   * считает `launchDeterminismArgsHash` объявленного рендерера. Воркер `EASYUI_RENDERER_FLAGS`
   * не читает — иначе объявленный отпечаток и фактический запуск разъезжались бы молча (T-m17).
   */
  determinismArgs: string[];
}
/** Доказательство readiness и отпечаток окружения, опубликованные шеллом (W4). */
export type WorkerReadiness = {
  readiness?: { met: boolean; reason?: string; codes?: unknown; policyHash: string; elapsedMs: number; evidence: Record<string, unknown> };
  captureEnv?: { fingerprint: string; input: Record<string, unknown> };
};
/**
 * Тайминги фаз воркера (R5). Пофазовый раскол ожидания живёт в странице и сюда не приезжает —
 * см. `src/capture/receipt.ts`.
 */
export type WorkerTimings = { navigateMs: number | null; readyMs: number | null; screenshotMs: number | null; totalMs: number | null };
/** Общие для всех исходов воркера факты происхождения кадра (R5). */
export type WorkerCaptureFacts = { timings?: WorkerTimings; pngSha256?: string; surfaceRect?: { x: number; y: number; width: number; height: number } | null };
export type WorkerImageOk = { ok: true; pngBase64: string; width: number; height: number; consoleErrors: string[]; consoleWarnings?: string[]; pageErrors: string[]; browserVersion: string } & WorkerReadiness & WorkerCaptureFacts;
export type WorkerGeometryOk = { ok: true; geometry: GeometryCollection; consoleErrors: string[]; consoleWarnings?: string[]; pageErrors: string[]; browserVersion: string } & WorkerReadiness & WorkerCaptureFacts;
/** Paint-джоба: geometry и PNG приезжают вместе — это и есть смысл режима. */
export type WorkerPaintOk = WorkerImageOk & { geometry: GeometryCollection };
export type WorkerOk = WorkerImageOk | WorkerGeometryOk | WorkerPaintOk;
/** `code` — типизированный исход воркера (R3): навигация, исполнение страницы, поверхность. */
export type WorkerErr = { ok: false; error: string; code?: string; consoleErrors?: string[]; consoleWarnings?: string[]; pageErrors?: string[] };
export type WorkerResult = WorkerOk | WorkerErr;
export type RunJob = (job: WorkerJob, deadlineMs: number) => Promise<WorkerResult>;

interface InternalJob {
  id: string; status: JobStatus["status"]; kind: "prototype" | "component";
  expected: CaptureExpected; allowedUrls: string[]; props?: Record<string, unknown>;
  captureUrl: string; viewport: Viewport; dsf: number; theme: "light" | "dark"; waitForFonts: boolean;
  componentPins?: { id: string; version: number; bundleHash: string }[];
  /**
   * Полные пины, замороженные на enqueue, и их manifest-hash (план 2026-08-02, P2.3).
   * Едут в `bootstrap.target`, и поверхность рендерит именно их: для track:head-дока
   * публикация новой версии компонента между enqueue и рендером иначе увела бы DTO
   * и уронила бы exact-match handshake.
   */
  capturePins?: CapturePin[];
  captureManifestHash?: string;
  /** Draft-capture extras (P1b): what the bootstrap carries instead of a published DTO. */
  draft?: { name: string; designSystem: string; bundleUrl: string; propsJsonSchema?: unknown; examples?: Record<string, Record<string, unknown>> };
  /**
   * Слот-содержимое кандидатного капчура (план 2026-08-05 §A6): **опубликованные** пины детей
   * (по одному на различную пару `(componentId, version)`) и дерево рендера. Присутствуют вместе
   * либо отсутствуют вместе; у бесслотовой джобы обоих полей нет, и bootstrap не меняется.
   */
  slotChildren?: CapturePin[];
  slotTree?: CaptureSlotTreeEntry[];
  probe?: CaptureProbe; resolvedSpaceScale?: Record<SpaceToken, string>; geometryRoleKeys?: Partial<Record<GeometryRole, string>>;
  /** W3: поле paint-режима, CSS px. Присутствует ровно тогда, когда `probe === "paint"`. */
  paintMargin?: number;
  geometryDetailKeys?: string[];
  /** A4: куда уезжает PNG — в asset-store (по умолчанию) или байтами в результат джобы. */
  deliver?: "asset" | "bytes";
  /**
   * W4: политика readiness, по которой обязана ждать поверхность. Присутствует у acceptance-джоб
   * (её приносит профиль приёмки); прочие пути остаются на дефолте, то есть ведут себя как раньше.
   */
  readinessPolicy?: ReadinessPolicy;
  /**
   * R4: манифест шрифтов темы джобы (`fontManifestHash` + объявленные faces). Замораживается на
   * постановке вместе с темой: политика `required-faces` судит именно ту версию темы, по которой
   * считался `case_fingerprint`.
   */
  fonts?: CaptureFontManifest;
  /**
   * Объявленный рендерер, замороженный на постановке (R1). Заморожен именно здесь, а не читается
   * в момент результата: отпечаток обязан относиться к тому же процессу и той же политике, по
   * которой считался `case_fingerprint` при reuse-lookup'е.
   */
  renderer: RendererOnJob;
  /**
   * Ключ владения целью капчура (R5): `component:<id>` / `prototype:<id>`. Он же уезжает в
   * индекс `jobId → receipt` — авторизация ручки receipt'а обязана работать и после того, как
   * джоба вычищена по `RESULT_TTL_MS` (V-N4), поэтому она выводится из ключа, а не из живой джобы.
   */
  owner: { kind: "prototype" | "component"; id: string };
  /** Адрес receipt'а этого капчура (R5), если он собран. */
  receiptSha256?: string;
  result?: ScreenshotResult; error?: { code: string; message: string }; resultExpiresAt?: number;
  jobOutcome?: JobOutcome;
  /** Типизированная причина капчура (R3), если она известна: едет в `GET /api/screenshot-jobs/:id`. */
  failure?: { code: CaptureFailureCode; message: string };
}

/**
 * Region/panel roles a geometry probe reports rects for. Regions come from the
 * authored spec (the capture surface renders them inline, without the player's
 * `data-eui-region` slots), the panel is the screen root subtree.
 */
export function geometryRoleKeysOf(doc: unknown, screenId: string): Partial<Record<GeometryRole, string>> {
  const screens = (doc as { screens?: { id: string; canvas?: { width: number; height: number }; spec: { root: string; elements: Record<string, unknown> } }[] }).screens ?? [];
  const screen = screens.find((item) => item.id === screenId);
  if (!screen) return {};
  const roleKeys: Partial<Record<GeometryRole, string>> = { panel: screen.spec.root };
  const analysis = analyzeScreenRegions(screen as Parameters<typeof analyzeScreenRegions>[0]);
  for (const [kind, key] of Object.entries(analysis.regionElements)) {
    if (typeof key === "string") roleKeys[`region:${kind}` as GeometryRole] = key;
  }
  return roleKeys;
}

/** Defaults for pre-7.1 worker payloads: the geometry shape stays additive-only. */
function emptyGeometryShape(): Pick<GeometryMeasurement, "safeArea" | "roleRects" | "frame" | "content" | "scroll" | "viewportOwnership" | "issues"> {
  const zero = { x: 0, y: 0, width: 0, height: 0 };
  return {
    safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
    roleRects: {},
    frame: { ...zero, source: "surface" },
    content: zero,
    scroll: { width: 0, height: 0 },
    viewportOwnership: { frame: null, content: null, scroll: null, scrollable: false, owners: [], unownedPct: 0 },
    issues: [],
  };
}

/**
 * Объявление рендерера под политику конкретной джобы (R1). Политика входит в отпечаток по той же
 * причине, что и в `case_fingerprint`: кадр, снятый по другому правилу ожидания, — другой кадр.
 */
export function rendererOnJob(policy: ReadinessPolicy | undefined): RendererOnJob {
  const declaration = rendererDeclaration();
  return {
    rendererVersion: declaration.rendererVersion,
    rendererSchema: declaration.rendererSchema,
    fingerprint: rendererFingerprintOf(declaration, policyHashOf(policy ?? DEFAULT_READINESS_POLICY)),
    browserName: declaration.browserName,
    browserVersion: declaration.browserVersion,
    browserRevision: declaration.browserRevision,
    launchedExecutable: declaration.launchedExecutable,
    browserExecutableSha256: declaration.browserExecutableSha256,
    contextOptionsHash: declaration.contextOptionsHash,
    launchDeterminismArgsHash: declaration.launchDeterminismArgsHash,
    colorProfile: declaration.colorProfile,
    source: declaration.source,
  };
}

export const MAX_QUEUE = 5;
/** Слоты очереди, недоступные фоновым (acceptance) постановкам — план §4.7. */
export const BACKGROUND_QUEUE_RESERVE = 2;
export const GEOMETRY_RECT_LIMIT = REPEAT_RENDER_COST_BUDGET;
const RESULT_TTL_MS = 10 * 60_000;

function validateViewport(viewport: unknown, dsf: unknown): { viewport: Viewport; dsf: number } {
  const vp = viewport as { width?: unknown; height?: unknown } | undefined;
  const width = vp?.width, height = vp?.height;
  const scale = dsf === undefined ? 1 : dsf;
  const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
  if (!isInt(width) || width < 64 || width > 2000) throw new ApiError(422, "invalid_viewport", "viewport.width must be an integer in [64, 2000]");
  if (!isInt(height) || height < 64 || height > 4000) throw new ApiError(422, "invalid_viewport", "viewport.height must be an integer in [64, 4000]");
  if (!isInt(scale) || ![1, 2, 3].includes(scale)) throw new ApiError(422, "invalid_viewport", "deviceScaleFactor must be 1, 2, or 3");
  if (width * height * scale * scale > 20_000_000) throw new ApiError(422, "invalid_viewport", "width × height × dsf² must not exceed 20 megapixels");
  return { viewport: { width, height }, dsf: scale };
}

function propsHashOf(props: unknown): string {
  return new Bun.CryptoHasher("sha256").update(canonicalStringify(props ?? {})).digest("hex");
}

/**
 * Theme assets are fetched at render time by injected @font-face rules and the
 * shared icon registry. They are not part of a prototype document or component
 * bundle, so screenshot capture must allowlist them explicitly.
 */
export function themeAssetIds(content: ThemeContent | null): string[] {
  if (!content) return [];
  const ids = new Set<string>();
  for (const font of content.fonts) ids.add(font.src);
  for (const icon of content.icons) {
    ids.add(icon.assetId);
    if (icon.themes?.light) ids.add(icon.themes.light);
    if (icon.themes?.dark) ids.add(icon.themes.dark);
  }
  return [...ids];
}

/**
 * Манифест шрифтов темы (план renderer-contract-2 §5 **R4**, N4).
 *
 * `themeFontSchema` — `{family, src, weight?, style?}`: ни `assetId`, ни `sha256` в схеме нет
 * (C-m13). `src` — это и есть id ассета (`ThemeStyle` подставляет его в `assetUrl(font.src)`),
 * а sha256 содержимого выводится из канонического формата id `asset_<sha256>`
 * (`server/assets.test.ts`); id иного формата даёт `sha256: null` — врать нельзя.
 *
 * Манифест уезжает поверхности в bootstrap'е и определяет **required-faces** строгой политики:
 * без него (ДС без темы, `fonts: []`) строгость шрифтов вырождается в v1-семантику.
 */
export function declaredFontFaces(content: ThemeContent | null): CaptureFontFaceDeclaration[] {
  const faces = (content?.fonts ?? []).map((font) => {
    const assetId = /^\/api\/assets\//.test(font.src) ? decodeURIComponent(font.src.replace(/^\/api\/assets\//, "").split(/[?#]/)[0]!) : font.src;
    const sha = /^asset_([0-9a-f]{64})$/.exec(assetId);
    return {
      family: font.family,
      weight: font.weight === undefined ? "400" : String(font.weight),
      style: font.style ?? "normal",
      assetId,
      sha256: sha ? sha[1]! : null,
    };
  });
  // Порядок объявления темы на кадр не влияет, а на хэш влиял бы: сортировка делает манифест
  // функцией содержимого темы, а не порядка правок в ней.
  return faces.sort((left, right) => canonicalStringify(left) < canonicalStringify(right) ? -1 : 1);
}

/** `fontManifestHash` — sha256 канонизованного списка объявленных faces. */
export function fontManifestOf(content: ThemeContent | null): CaptureFontManifest {
  const declared = declaredFontFaces(content);
  return { declared, manifestHash: new Bun.CryptoHasher("sha256").update(canonicalStringify(declared)).digest("hex") };
}

export interface ScreenshotServiceDeps {
  db: Database; dataDir: string; serveDist?: string;
  captureOrigin: string; chromiumAvailable: boolean; runJob: RunJob;
  sessions?: CaptureSessionStore; now?: () => number;
}
export type FrozenEnqueue = { jobId:string; expected:CaptureExpected; components?:CapturePin[] };
export type FrozenTarget =
  | {kind:"prototype";id:string;screenId:string;rev?:number;version?:number}
  | {kind:"component";id:string;version:number;props?:Record<string,unknown>};

/**
 * In-memory screenshot job pipeline: bounds-validated enqueue with an atomic
 * target snapshot (expected + allowedUrls), a concurrency-1 pump with a bounded
 * queue, per-job capture-session mint/revoke around the worker run, and PNG
 * ingestion into the content-addressed asset registry.
 */
export class ScreenshotService {
  readonly sessions: CaptureSessionStore;
  private readonly jobs = new Map<string, InternalJob>();
  private readonly queue: string[] = [];
  private running = 0;
  private readonly now: () => number;
  private readonly rendererBuild: string | null;

  constructor(private readonly deps: ScreenshotServiceDeps) {
    this.sessions = deps.sessions ?? new CaptureSessionStore(deps.now);
    this.now = deps.now ?? Date.now;
    this.rendererBuild = rendererBuildFrom(deps.serveDist);
  }

  available(): boolean { return Boolean(this.deps.serveDist) && this.deps.chromiumAvailable; }

  private requireAvailable(): void {
    if (!this.available()) throw new ApiError(501, "screenshot_unavailable", "Screenshot capture requires SERVE_DIST and an installed chromium");
  }
  /**
   * Резервирование очереди (план §4.7): фоновые (acceptance) постановки отказываются на
   * `MAX_QUEUE - BACKGROUND_QUEUE_RESERVE`, чтобы интерактиву всегда оставалось 2 слота из 5.
   * Интерактивная ветка — прежний потолок, тот же код `queue_full`.
   */
  private guardQueue(lane: "interactive" | "background" = "interactive"): void {
    this.reapExpired();
    const cap = lane === "background" ? MAX_QUEUE - BACKGROUND_QUEUE_RESERVE : MAX_QUEUE;
    if (this.queue.length >= cap) throw new ApiError(429, "queue_full", "Screenshot queue is full; retry later");
  }

  /** Текущая длина очереди (без учёта бегущей джобы) — для планировщика оркестратора. */
  queueDepth(): number { this.reapExpired(); return this.queue.length; }
  /** Есть ли слот под фоновую постановку прямо сейчас (без броска 429). */
  hasBackgroundCapacity(): boolean { return this.queueDepth() < MAX_QUEUE - BACKGROUND_QUEUE_RESERVE; }

  /**
   * Ответ enqueue отдаёт разрешённые пины (P2.3/P5.2): для track:head-дока это единственный
   * момент, когда клиент узнаёт, какие версии компонентов реально пойдут в кадр.
   */
  enqueuePrototype(id: string, screenId: string, opts: { rev?: number; version?: number; viewport: unknown; deviceScaleFactor?: unknown; theme?: string; waitForFonts?: boolean; probe?: "geometry" }): { jobId: string; components: { id: string; name: string; version: number; bundleHash: string }[] } {
    const {jobId,components}=this.enqueuePrototypeFrozen(id,screenId,opts);
    return {jobId,components:(components??[]).map((pin)=>({id:pin.id,name:pin.name,version:pin.version,bundleHash:pin.bundleHash}))};
  }

  enqueueWithExpected(target:FrozenTarget,opts:{viewport:unknown;deviceScaleFactor?:unknown;theme?:string;waitForFonts?:boolean}):FrozenEnqueue {
    return target.kind==="prototype"
      ? this.enqueuePrototypeFrozen(target.id,target.screenId,{...opts,rev:target.rev,version:target.version})
      : this.enqueueComponentFrozen(target.id,target.version,{...opts,props:target.props});
  }

  private enqueuePrototypeFrozen(id: string, screenId: string, opts: { rev?: number; version?: number; viewport: unknown; deviceScaleFactor?: unknown; theme?: string; waitForFonts?: boolean; probe?: "geometry" }): FrozenEnqueue {
    this.requireAvailable();
    const { viewport, dsf } = validateViewport(opts.viewport, opts.deviceScaleFactor);
    this.guardQueue();
    const repo = new PrototypeRepo(this.deps.db);
    // Atomic snapshot: resolve rev now so a later save cannot move the target.
    const snap = repo.screenRenderStatus(id, screenId, { rev: opts.rev, version: opts.version });
    const full = repo.revision(id, snap.rev);
    const componentPins = full.components.map((p) => ({ id: p.id, version: p.version, bundleHash: p.bundleHash }));
    // Пины темы — карта по всем ДС документа (миграция v24; read-правило покрывает старые ревизии).
    const themePins = themePinsOf(this.deps.db, id, snap.rev, full.doc, full.designSystemMetaVersion ?? null);
    // ДС **снимаемого экрана**: у мульти-поверхностного дока это ДС его поверхности (D14).
    const screenDesignSystem = surfaceDesignSystem(surfaceOf(full.doc, screenId), full.doc) ?? full.doc.designSystem;
    const screenMetaVersion = themePins[screenDesignSystem] ?? null;
    // R4: тема экрана резолвится на **любой** frozen-постановке, а не только при `opts.probe` —
    // манифест шрифтов нужен и обычному кадру (мульти-ДС документ → манифест ДС снимаемого экрана).
    const themeContent = screenMetaVersion == null
      ? getLatestDesignSystemContent(this.deps.db, screenDesignSystem)
      : getDesignSystemVersion(this.deps.db, screenDesignSystem, screenMetaVersion);
    // Резолвер — свойство пиннутой версии темы (миграция v23): старые версии остаются на legacy-пути.
    const resolvedSpaceScale = opts.probe
      ? resolveSpacingScale(screenDesignSystem, themeContent?.tokens ?? {}, themeContent?.spacingResolver)
      : undefined;
    const fonts = fontManifestOf(themeContent ?? null);
    const geometryRoleKeys = opts.probe === "geometry" ? geometryRoleKeysOf(full.doc, screenId) : undefined;
    const theme = opts.theme === "dark" ? "dark" : "light";
    const expected: CaptureExpected = { kind: "prototype", prototypeInstanceId:full.prototypeInstanceId, rev: snap.rev, componentManifestHash: full.componentManifestHash, builtinCatalogHash: full.builtinCatalogHash, designSystem: screenDesignSystem ?? null, dsMetaVersion: screenMetaVersion, rendererBuild: this.rendererBuild };
    const allowedUrls = this.prototypeAllowedUrls(
      id,
      screenId,
      full.components,
      full.assets.map((a) => a.id),
      // Allowlist — объединение тем всех ДС документа с их пиннутыми версиями (D14).
      docDesignSystems(full.doc).map((designSystem) => ({ designSystem, metaVersion: themePins[designSystem] ?? null })),
      opts.version !== undefined ? `/api/prototypes/${id}/versions/${opts.version}` : `/api/prototypes/${id}/revisions/${snap.rev}`,
    );
    const query = new URLSearchParams();
    if (opts.version !== undefined) query.set("version", String(opts.version)); else query.set("rev", String(snap.rev));
    query.set("theme", theme); query.set("dsf", String(dsf));
    const captureUrl = `/capture/${encodeURIComponent(id)}/s/${encodeURIComponent(screenId)}?${query}`;
    const capturePins: CapturePin[] = full.components.map((p) => ({ id: p.id, name: p.name, version: p.version, bundleUrl: p.bundleUrl, bundleHash: p.bundleHash, status: p.status }));
    const {jobId}=this.push({ kind: "prototype", owner: { kind: "prototype", id }, expected, allowedUrls, captureUrl, viewport, dsf, theme, waitForFonts: opts.waitForFonts !== false, componentPins, capturePins, captureManifestHash: full.componentManifestHash, fonts, ...(opts.probe ? { probe: opts.probe, resolvedSpaceScale, geometryRoleKeys } : {}) });
    return {jobId,expected,components:capturePins};
  }

  enqueueComponent(id: string, version: number, opts: { props?: Record<string, unknown>; exampleName?: string; viewport: unknown; deviceScaleFactor?: unknown; theme?: string; waitForFonts?: boolean; probe?: "geometry" }): { jobId: string } {
    const {jobId}=this.enqueueComponentFrozen(id,version,opts); return {jobId};
  }

  private enqueueComponentFrozen(id: string, version: number, opts: { props?: Record<string, unknown>; exampleName?: string; viewport: unknown; deviceScaleFactor?: unknown; theme?: string; waitForFonts?: boolean; probe?: "geometry" }): FrozenEnqueue {
    this.requireAvailable();
    const { viewport, dsf } = validateViewport(opts.viewport, opts.deviceScaleFactor);
    this.guardQueue();
    const repo = new ComponentRepo(this.deps.db);
    const dto = repo.version(id, version) as { version: number; bundleHash: string; designSystem: string; propsJsonSchema?: unknown; examples?: Record<string,Record<string,unknown>>; assets: { id: string }[] };
    let props=opts.props??{};
    if(opts.exampleName!==undefined){const examples=dto.examples??Object.create(null) as Record<string,Record<string,unknown>>;if(!Object.hasOwn(examples,opts.exampleName))throw new ApiError(422,"unknown_example",`Unknown component example: ${opts.exampleName}`);props=examples[opts.exampleName]!;}
    validatePropsAgainstSchema(props, dto.propsJsonSchema);
    const propsHash = propsHashOf(props);
    const theme = opts.theme === "dark" ? "dark" : "light";
    const themeContent = getLatestDesignSystemContent(this.deps.db, dto.designSystem);
    const expected: CaptureExpected = { kind: "component", componentId: id, version, bundleHash: dto.bundleHash, propsHash, dsMetaVersion: themeContent.latestMetaVersion, rendererBuild: this.rendererBuild };
    const allowedUrls = this.componentAllowedUrls(id, version, dto.assets.map((a) => a.id), dto.designSystem);
    const query = new URLSearchParams({ theme, dsf: String(dsf) });
    const captureUrl = `/capture/component/${encodeURIComponent(id)}/${version}?${query}`;
    // Компонентная геометрия (P1b): шкала — из последней темы, ролей экрана у одиночного компонента нет.
    const resolvedSpaceScale = opts.probe ? resolveSpacingScale(dto.designSystem, themeContent.tokens, themeContent.spacingResolver) : undefined;
    const {jobId}=this.push({ kind: "component", owner: { kind: "component", id }, expected, allowedUrls, props, captureUrl, viewport, dsf, theme, waitForFonts: opts.waitForFonts !== false, fonts: fontManifestOf(themeContent), ...(opts.probe ? { probe: opts.probe, resolvedSpaceScale } : {}) });
    return {jobId,expected};
  }

  /**
   * Draft-preview сохранённой, но не опубликованной head-ревизии (план 2026-08-02, P1b).
   * Бандл — эфемерный candidate-bundle префлайта P8: при холодном кэше собирается здесь же
   * под троттлингом validate (`ensureDraftCandidate`), поэтому метод асинхронный, в отличие
   * от published-ветки. Allowlist пинует asset-ссылки, извлечённые из исходника драфта
   * (пиннинга ассетов у драфта нет — он появляется только при publish).
   */
  async enqueueComponentDraft(id: string, userId: string, opts: { props?: Record<string, unknown>; exampleName?: string; viewport: unknown; deviceScaleFactor?: unknown; theme?: string; waitForFonts?: boolean; probe?: "geometry" }): Promise<{ jobId: string }> {
    this.requireAvailable();
    // `probe:"paint"` — режим приёмки (W3): он отдаёт байты мимо asset-store и требует
    // кандидата, запиненного по `{rev, sourceHash}`. Draft/published-ручки его не получают.
    if ((opts as { probe?: string }).probe === "paint") {
      throw new ApiError(422, "unsupported_option", "probe=paint is only available on the candidate acceptance path");
    }
    const { viewport, dsf } = validateViewport(opts.viewport, opts.deviceScaleFactor);
    this.guardQueue();
    const draft = await ensureDraftCandidate(this.deps.db, this.deps.dataDir, id, userId);
    // Сборка кандидата ждала своей очереди — cap мог заполниться, пока мы компилировали.
    this.guardQueue();
    const { jobId } = this.pushDraftCapture(id, draft, viewport, dsf, opts);
    return { jobId };
  }

  /**
   * Захват, запиненный к **кандидату** (амендмент A10): бандл и handshake строятся от явной
   * пары `{rev, sourceHash}` из candidate-кэша, а не от head'а компонента, поэтому смена
   * head посреди acceptance-run'а не уводит снимаемый билд. Вытесненный бандл — `409
   * candidate_evicted` (пересборки произвольного rev нет). Постановка фоновая
   * (`background !== false`): интерактиву остаются зарезервированные слоты очереди.
   */
  async enqueueComponentCandidate(
    id: string,
    candidate: { rev: number; sourceHash: string },
    opts: {
      props?: Record<string, unknown>; exampleName?: string; viewport: unknown; deviceScaleFactor?: unknown;
      theme?: string; waitForFonts?: boolean; probe?: CaptureProbe; deliver?: "asset" | "bytes"; background?: boolean;
      /** Поле paint-режима, CSS px; игнорируется в прочих режимах (W3). */
      paintMargin?: number;
      geometryDetailKeys?: string[];
      /** Политика readiness случая (W4); по умолчанию — дефолтная политика. */
      readinessPolicy?: ReadinessPolicy;
      /** Слоты случая (план 2026-08-05 §A6): уже разрешённые до опубликованных пинов дети. */
      slotBindings?: CaptureSlotBinding[];
      /** sha256 разрешённого слот-кортежа (§A3) — часть handshake'а кандидатного кадра. */
      slotsHash?: string;
    },
  ): Promise<FrozenEnqueue> {
    this.requireAvailable();
    const { viewport, dsf } = validateViewport(opts.viewport, opts.deviceScaleFactor);
    const lane = opts.background === false ? "interactive" : "background";
    this.guardQueue(lane);
    const draft = await getCandidateForRev(this.deps.db, this.deps.dataDir, id, candidate.rev, candidate.sourceHash);
    this.guardQueue(lane);
    // Acceptance-путь **всегда** пинует политику readiness явно: её хэш входит в `case_fingerprint`,
    // поэтому «политика по умолчанию у поверхности» и «политика рана» обязаны быть одним объектом.
    return this.pushDraftCapture(id, draft, viewport, dsf, { ...opts, readinessPolicy: opts.readinessPolicy ?? resolveCaptureMode("acceptance").readiness });
  }

  /** Общее тело draft/candidate-постановки: bootstrap, allowlist и handshake строятся от `draft`. */
  private pushDraftCapture(
    id: string,
    draft: DraftCandidate,
    viewport: Viewport,
    dsf: number,
    opts: {
      props?: Record<string, unknown>; exampleName?: string; theme?: string; waitForFonts?: boolean;
      probe?: CaptureProbe; deliver?: "asset" | "bytes"; paintMargin?: number; geometryDetailKeys?: string[];
      readinessPolicy?: ReadinessPolicy;
      slotBindings?: CaptureSlotBinding[];
      slotsHash?: string;
    },
  ): FrozenEnqueue {
    const repo = new ComponentRepo(this.deps.db);
    const meta = draft.entry.extracted!.meta!;
    let props = opts.props ?? {};
    if (opts.exampleName !== undefined) {
      const examples = meta.examples ?? Object.create(null) as Record<string, Record<string, unknown>>;
      if (!Object.hasOwn(examples, opts.exampleName)) throw new ApiError(422, "unknown_example", `Unknown component example: ${opts.exampleName}`);
      props = examples[opts.exampleName]!;
    }
    validatePropsAgainstSchema(props, meta.propsJsonSchema);
    const propsHash = propsHashOf(props);
    const theme = opts.theme === "dark" ? "dark" : "light";
    const themeContent = getLatestDesignSystemContent(this.deps.db, draft.designSystem);
    // Слоты резолвятся до сборки handshake'а: их отсутствие обязано оставить и `expected`, и
    // allowlist дословно прежними (§«Design invariants», байт-идентичность бесслотовой джобы).
    const slots = this.slotCaptureOf(opts.slotBindings);
    const expected: CaptureExpected = { kind: "component-draft", componentId: id, rev: draft.rev, sourceHash: draft.sourceHash, bundleHash: draft.entry.bundleHash!, propsHash, dsMetaVersion: themeContent.latestMetaVersion, rendererBuild: this.rendererBuild, ...(opts.slotsHash === undefined ? {} : { slotsHash: opts.slotsHash }) };
    const bundleUrl = `/api/components/${encodeURIComponent(id)}/draft/${draft.sourceHash}/bundle.js`;
    const allowedUrls = this.draftComponentAllowedUrls(id, draft.sourceHash, draft.assetIds, draft.designSystem, slots?.children);
    const query = new URLSearchParams({ theme, dsf: String(dsf) });
    const captureUrl = `/capture/component/${encodeURIComponent(id)}/draft?${query}`;
    const resolvedSpaceScale = opts.probe ? resolveSpacingScale(draft.designSystem, themeContent.tokens, themeContent.spacingResolver) : undefined;
    // Поле paint-режима нормализуется здесь, а не у вызывающего: оно уезжает и в bootstrap
    // поверхности, и в результат джобы — расхождение сделало бы `paintBounds` несопоставимым.
    const paintMargin = opts.probe === "paint"
      ? Math.min(Math.max(Math.round(opts.paintMargin ?? DEFAULT_PAINT_MARGIN_PX), 0), MAX_PAINT_MARGIN_PX)
      : undefined;
    const { jobId } = this.push({
      kind: "component", owner: { kind: "component", id }, expected, allowedUrls, props, captureUrl, viewport, dsf, theme, waitForFonts: opts.waitForFonts !== false,
      draft: { name: repo.row(id).name, designSystem: draft.designSystem, bundleUrl, ...(meta.propsJsonSchema !== undefined ? { propsJsonSchema: meta.propsJsonSchema } : {}), ...(meta.examples !== undefined ? { examples: meta.examples } : {}) },
      // Драфт и кандидат приёмки: компонент не пинует тему, поэтому манифест — от последней версии
      // темы его ДС, той же, что уже дала `dsMetaVersion` handshake'а.
      fonts: fontManifestOf(themeContent),
      ...(slots === undefined ? {} : { slotChildren: slots.children, slotTree: slots.tree }),
      ...(opts.probe ? { probe: opts.probe, resolvedSpaceScale } : {}),
      ...(paintMargin === undefined ? {} : { paintMargin, geometryDetailKeys: (opts.geometryDetailKeys ?? []).slice(0, 20) }),
      ...(opts.deliver ? { deliver: opts.deliver } : {}),
      ...(opts.readinessPolicy ? { readinessPolicy: opts.readinessPolicy } : {}),
    });
    return { jobId, expected };
  }

  /**
   * Слот-привязки → пины бандлов + дерево рендера (план 2026-08-05 §A6).
   *
   * JSON-безопасность props ребёнка перепроверяется **здесь**, хотя `validateManifest` уже
   * отказала бы на PUT: манифест неизменен после публикации, но между PUT и капчуром лежит
   * durable-реконструкция случая, и директива рендерера (`$asset`/`$cond`) или служебный ключ
   * (`__eui…`), просочившиеся в bootstrap, исполнились бы как разметка, а не как данные.
   *
   * Пины дедуплицируются по паре `(componentId, version)`: у карусели из девяти одинаковых
   * детей бандл ровно один, а дерево остаётся девятиэлементным.
   */
  private slotCaptureOf(bindings: CaptureSlotBinding[] | undefined): { children: CapturePin[]; tree: CaptureSlotTreeEntry[] } | undefined {
    if (bindings === undefined || bindings.length === 0) return undefined;
    const children = new Map<string, CapturePin>();
    const tree: CaptureSlotTreeEntry[] = [];
    for (const binding of bindings) {
      const props = binding.props ?? {};
      if (!jsonSafeSlotProps(props)) {
        throw new ApiError(422, "slot_props_dynamic",
          `Slot "${binding.slot}" child ${binding.name} declares $- or __eui-prefixed props;`
          + " slot children take plain JSON data, not renderer directives");
      }
      const key = `${binding.componentId}@${binding.version}`;
      if (!children.has(key)) {
        children.set(key, {
          id: binding.componentId, name: binding.name, version: binding.version,
          bundleUrl: `/api/components/${binding.componentId}/versions/${binding.version}/bundle.js`,
          bundleHash: binding.bundleHash,
          status: this.publishStatusOf(binding.componentId, binding.version),
        });
      }
      // Дефолтный слот — канонически **без** ключа `slot` (§A2a): `runtimeSpec` схлопывает обе
      // формы в `slotIndices.default`, и одна форма в протоколе избавляет от выбора у поверхности.
      tree.push({ ...(binding.slot === "default" ? {} : { slot: binding.slot }), index: binding.index, name: binding.name, props });
    }
    return { children: [...children.values()], tree };
  }

  /** Статус публикации ребёнка — факт БД, а не догадка: пин мог быть deprecated/superseded (§A2). */
  private publishStatusOf(componentId: string, version: number): string {
    const row = this.deps.db.query("SELECT status FROM component_publishes WHERE component_id=? AND version=?")
      .get(componentId, version) as { status: string } | null;
    return row?.status ?? "unknown";
  }

  private prototypeAllowedUrls(
    id: string,
    screenId: string,
    pins: { id: string; version: number }[],
    docAssetIds: string[],
    // Все ДС документа с их пиннутыми версиями темы (multi-surface D14): одна запись у
    // обычного дока — тот же набор URL, что и раньше.
    themes: { designSystem?: string; metaVersion: number | null }[],
    snapshotUrl?: string,
  ): string[] {
    const set = new Set<string>();
    set.add(`/capture/${id}/s/${screenId}`);
    for (const { designSystem, metaVersion } of themes) {
      if (!designSystem) continue;
      set.add(`/api/design-systems/${designSystem}`);
      set.add(`/api/design-systems/${designSystem}/versions/`);
      const content = metaVersion == null
        ? getLatestDesignSystemContent(this.deps.db, designSystem)
        : getDesignSystemVersion(this.deps.db, designSystem, metaVersion);
      for (const assetId of themeAssetIds(content)) set.add(`/api/assets/${assetId}`);
    }
    // enqueuePrototype always freezes the selector into the capture URL, so the shell
    // needs exactly one immutable DTO endpoint rather than broad prototype read access.
    if(snapshotUrl) set.add(snapshotUrl);
    for (const p of pins) set.add(`/api/components/${p.id}/versions/${p.version}/bundle.js`);
    for (const assetId of docAssetIds) set.add(`/api/assets/${assetId}`);
    const componentRepo = new ComponentRepo(this.deps.db);
    for (const p of pins) for (const a of componentRepo.assets(p.id, p.version)) set.add(`/api/assets/${a.id}`);
    set.add("/api/shims/");
    for (const s of buildStaticAllowedUrls(this.deps.serveDist)) set.add(s);
    return [...set];
  }
  private componentAllowedUrls(id: string, version: number, assetIds: string[], designSystem?: string): string[] {
    const set = new Set<string>();
    set.add(`/capture/component/${id}/${version}`);
    if (designSystem) {
      set.add(`/api/design-systems/${designSystem}`);
      set.add(`/api/design-systems/${designSystem}/versions/`);
      for (const assetId of themeAssetIds(getLatestDesignSystemContent(this.deps.db, designSystem))) {
        set.add(`/api/assets/${assetId}`);
      }
    }
    set.add(`/api/components/${id}`);
    set.add(`/api/components/${id}/versions/${version}`);
    set.add(`/api/components/${id}/versions/${version}/bundle.js`);
    for (const assetId of assetIds) set.add(`/api/assets/${assetId}`);
    set.add("/api/shims/");
    for (const s of buildStaticAllowedUrls(this.deps.serveDist)) set.add(s);
    return [...set];
  }

  /**
   * Draft-allowlist (P1b): candidate-bundle идёт точным content-addressed путём (sourceHash
   * в path), поэтому в allowlist он попадает только у enqueue'нувшей джобы — чужие джобы
   * (другой компонент, другой sourceHash, published-съёмка) этот URL не получают. В
   * catalog/latest-active resolution и в bundle-export он не попадает никогда: те читают
   * только publishes. Asset-ссылки — из исходника драфта; published-DTO (`/api/components/:id`,
   * `/versions/:v`) драфту не нужны: meta/props-схема едут в bootstrap.
   *
   * Дети слотов (план 2026-08-05 §A6) добавляют ровно две вещи на различный пин: бандл версии и
   * ассеты **этой** версии. DTO ребёнка не добавляется намеренно: загрузчику нужны только
   * `{name, bundleUrl, bundleHash}` (meta едет в bootstrap), а `/versions/:v` отдал бы поверхности
   * опубликованный `source` — расширение поверхности утечки ради удобства, которого нет.
   */
  private draftComponentAllowedUrls(id: string, sourceHash: string, assetIds: string[], designSystem: string, slotChildren?: CapturePin[]): string[] {
    const set = new Set<string>();
    set.add(`/capture/component/${id}/draft`);
    set.add(`/api/design-systems/${designSystem}`);
    set.add(`/api/design-systems/${designSystem}/versions/`);
    for (const assetId of themeAssetIds(getLatestDesignSystemContent(this.deps.db, designSystem))) {
      set.add(`/api/assets/${assetId}`);
    }
    set.add(`/api/components/${id}/draft/${sourceHash}/bundle.js`);
    for (const assetId of assetIds) set.add(`/api/assets/${assetId}`);
    if (slotChildren !== undefined && slotChildren.length > 0) {
      const componentRepo = new ComponentRepo(this.deps.db);
      for (const child of slotChildren) {
        set.add(child.bundleUrl);
        for (const asset of componentRepo.assets(child.id, child.version)) set.add(`/api/assets/${asset.id}`);
      }
    }
    set.add("/api/shims/");
    for (const s of buildStaticAllowedUrls(this.deps.serveDist)) set.add(s);
    return [...set];
  }

  private push(job: Omit<InternalJob, "id" | "status" | "renderer">): { jobId: string } {
    const id = `job_${crypto.randomUUID()}`;
    this.jobs.set(id, { ...job, id, status: "queued", renderer: rendererOnJob(job.readinessPolicy) });
    this.queue.push(id);
    queueMicrotask(() => this.pump());
    return { jobId: id };
  }

  get(jobId: string): JobStatus {
    this.reapExpired();
    const job = this.jobs.get(jobId);
    if (!job) throw new ApiError(404, "job_not_found", "Screenshot job not found");
    return {
      status: job.status,
      ...(job.result ? { result: job.result } : {}),
      ...(job.error ? { error: job.error } : {}),
      // R3: таксономия исхода и типизированная причина выходят наружу — «почему кадр не получился»
      // перестаёт быть вопросом к тексту сообщения (K4).
      ...(job.jobOutcome ? { outcome: job.jobOutcome } : {}),
      ...(job.failure ? { failure: job.failure } : {}),
    };
  }
  /**
   * Исход джобы (A3) для in-process потребителей (acceptance-оркестратор). С волны R3 та же
   * таксономия аддитивно едет и в HTTP-ответ `GET /api/screenshot-jobs/:id` (поле `outcome`):
   * клиенту нужно отличать «инфраструктура, повтори» от «терминально, не повторяй».
   * `undefined` — джоба ещё не терминальна либо результат уже вычищен по RESULT_TTL.
   */
  outcome(jobId: string): JobOutcome | undefined {
    return this.jobs.get(jobId)?.jobOutcome;
  }
  /** Test-only introspection of the frozen enqueue snapshot. */
  peek(jobId: string): InternalJob | undefined { return this.jobs.get(jobId); }

  private reapExpired(): void {
    const t = this.now();
    for (const [id, job] of this.jobs) if (job.resultExpiresAt !== undefined && job.resultExpiresAt <= t) this.jobs.delete(id);
    this.sessions.sweep();
  }

  private pump(): void {
    if (this.running >= 1) return;
    const id = this.queue.shift();
    if (id === undefined) return;
    const job = this.jobs.get(id);
    if (!job) { this.pump(); return; }
    this.running += 1;
    job.status = "running";
    void this.execute(job).finally(() => { this.running -= 1; this.pump(); });
  }

  private async execute(job: InternalJob): Promise<void> {
    const session = this.sessions.mint({ kind: job.kind, allowedUrls: job.allowedUrls, expected: job.expected, props: job.props });
    try {
      const workerJob: WorkerJob = {
        captureOrigin: this.deps.captureOrigin, captureUrl: job.captureUrl, token: session.token,
        bootstrap: {
          kind: job.expected.kind === "component-draft" ? "component-draft" : job.kind,
          target: this.targetOf(job),
          ...(job.props ? { props: job.props } : {}),
          // Драфт: published-DTO не существует, поэтому схема/examples едут в bootstrap (P1b).
          ...(job.draft?.propsJsonSchema !== undefined ? { propsJsonSchema: job.draft.propsJsonSchema } : {}),
          ...(job.draft?.examples !== undefined ? { examples: job.draft.examples } : {}),
          // Слоты (§A6): поверхность строит многоэлементный runtimeSpec из этого дерева. Поля нет
          // у бесслотовой джобы — её bootstrap обязан остаться прежним байт-в-байт.
          ...(job.slotChildren === undefined ? {} : { slots: { children: job.slotChildren, tree: job.slotTree ?? [] } }),
          expected: job.expected,
        },
        allowedUrls: job.allowedUrls, viewport: job.viewport, deviceScaleFactor: job.dsf, colorScheme: job.theme, waitForFonts: job.waitForFonts, expected: job.expected,
        determinismArgs: buildDeterminismArgs(),
        ...(job.probe ? { probe: job.probe, geometryLimit: GEOMETRY_RECT_LIMIT, ...(job.geometryRoleKeys ? { geometryRoleKeys: job.geometryRoleKeys } : {}) } : {}),
        ...(job.probe === "paint" ? { geometryDetailKeys: job.geometryDetailKeys ?? [] } : {}),
      };
      // Поле paint-режима едет поверхности через bootstrap: она и решает, рисовать ли фон.
      if (job.paintMargin !== undefined) workerJob.bootstrap.paint = { marginPx: job.paintMargin };
      // Политика readiness — туда же: поверхность исполняет её и публикует доказательство (W4).
      if (job.readinessPolicy !== undefined) workerJob.bootstrap.readiness = job.readinessPolicy;
      // R4: манифест шрифтов темы — вход правила required-faces (T-M10). Пустой манифест уезжает
      // тоже: «тема есть, шрифтов в ней нет» и «манифест не приехал» — разные факты.
      if (job.fonts !== undefined) workerJob.bootstrap.fonts = job.fonts;
      const result = await this.deps.runJob(workerJob, JOB_DEADLINE_MS);
      if (!result.ok) {
        job.status = "error";
        // Типизированный код воркера (R3) становится и кодом ошибки джобы, и её `failure`;
        // нетипизированный отказ остаётся доволновым `capture_failed` — врать про код нельзя.
        const code = isCaptureFailureCode(result.code) ? result.code : null;
        job.error = { code: code ?? "capture_failed", message: result.error };
        if (code !== null) job.failure = { code, message: result.error };
        // Отсутствие поверхности — терминальный исход, а не инфраструктурный шум (см.
        // `TERMINAL_JOB_OUTCOMES`): классификация по тексту сообщения дала бы `subprocess_error`.
        job.jobOutcome = code === "surface_missing" ? "surface_missing" : classifyJobFailure(result.error);
        this.expire(job);
        return;
      }
      // Сверка объявленного и фактического рендерера (§3 E2). Расхождение major.minor.build
      // значит, что образ не соответствует манифесту: кадр нельзя ни сравнивать с эталоном, ни
      // переиспользовать по `case_fingerprint`, поэтому это hard-fail, а не предупреждение.
      const mismatch = this.rendererMismatch(job, result);
      if (mismatch !== null && strictManifestEnabled()) {
        job.status = "error";
        job.error = { code: "renderer_mismatch", message: mismatch };
        job.failure = { code: "renderer_mismatch", message: mismatch };
        // Собственный **терминальный** исход таксономии (R3): раньше расхождение ехало как
        // `subprocess_error` и приёмка тратила на него бюджет `maxInfraRetries` — ретраи в том же
        // процессе дают ровно то же расхождение, это не инфраструктурный шум.
        job.jobOutcome = "renderer_mismatch";
        this.expire(job);
        return;
      }
      const quality = this.qualityOf(result);
      // Kill-switch `EASYUI_RENDERER_STRICT_MANIFEST=0`: расхождение остаётся видимым, но капчур
      // доигрывается (T-M7 — аварийная ручка на случай, если сверка валит весь прод).
      if (mismatch !== null) quality.runtimeWarnings.push(`renderer_mismatch: ${mismatch}`);
      // Receipt собирается **здесь** — после воркера и до ветвления по kind (E4): иначе asset-путь
      // (интерактивный `snap`, кадр визуального рана) снова остался бы без доказательств
      // происхождения, то есть дыра §1.6 закрылась бы только для байтового канала.
      const receiptSha256 = await this.storeReceipt(job, result, quality, mismatch);
      if (receiptSha256 !== undefined) job.receiptSha256 = receiptSha256;
      const receiptField = receiptSha256 === undefined ? {} : { receiptSha256 };
      if (job.probe === "paint") {
        // Комбинированный исход: обе половины обязаны приехать из одной сессии, иначе вердикт
        // геометрии сравнивал бы разные кадры (триаж R1-M3) — поэтому это `throw`, не деградация.
        if (!("geometry" in result) || !("pngBase64" in result)) throw new Error("paint worker result mismatch");
        if (job.expected.kind === "prototype") throw new Error("paint probe is component-only");
        const bytes = Buffer.from(result.pngBase64, "base64");
        job.result = {
          kind: "paint",
          surface: "component",
          ...quality,
          ...receiptField,
          ...this.readinessOf(result),
          componentId: job.expected.componentId,
          ...(job.expected.kind === "component-draft" ? { draftRev: job.expected.rev } : { version: job.expected.version }),
          bundleHash: job.expected.bundleHash,
          designSystemMetaVersion: job.expected.dsMetaVersion,
          resolvedSpaceScale: job.resolvedSpaceScale!,
          viewport: job.viewport,
          dpr: job.dsf,
          paintMargin: job.paintMargin ?? DEFAULT_PAINT_MARGIN_PX,
          bytes: new Uint8Array(bytes),
          width: result.width, height: result.height,
          imageProduced: true,
          consoleErrors: result.consoleErrors, pageErrors: result.pageErrors,
          rendererBuild: job.expected.rendererBuild, browserVersion: result.browserVersion,
          renderer: job.renderer,
          ...emptyGeometryShape(),
          ...result.geometry,
        };
        job.status = "done";
        job.jobOutcome = "ok";
        this.expire(job);
        return;
      }
      if (job.probe === "geometry") {
        if (!("geometry" in result)) throw new Error("geometry worker result mismatch");
        const measurement = { ...emptyGeometryShape(), ...result.geometry };
        if (job.expected.kind === "prototype") {
          job.result = {
            kind: "geometry",
            surface: "prototype",
            ...quality,
            ...receiptField,
            resolvedRev: job.expected.rev,
            prototypeInstanceId: job.expected.prototypeInstanceId,
            componentPins: job.componentPins ?? [],
            designSystemMetaVersion: job.expected.dsMetaVersion,
            resolvedSpaceScale: job.resolvedSpaceScale!,
            viewport: job.viewport,
            dpr: job.dsf,
            ...measurement,
          };
        } else {
          job.result = {
            kind: "geometry",
            surface: "component",
            ...quality,
            ...receiptField,
            componentId: job.expected.componentId,
            ...(job.expected.kind === "component-draft" ? { draftRev: job.expected.rev } : { version: job.expected.version }),
            bundleHash: job.expected.bundleHash,
            designSystemMetaVersion: job.expected.dsMetaVersion,
            resolvedSpaceScale: job.resolvedSpaceScale!,
            viewport: job.viewport,
            dpr: job.dsf,
            ...measurement,
          };
        }
        job.status = "done";
        job.jobOutcome = "ok";
        this.expire(job);
        return;
      }
      if (!("pngBase64" in result)) throw new Error("image worker result mismatch");
      const bytes = Buffer.from(result.pngBase64, "base64");
      const imageExtras = {
        ...(job.expected.kind === "component" ? { bundleHash: job.expected.bundleHash }
          : job.expected.kind === "component-draft" ? { bundleHash: job.expected.bundleHash, draftRev: job.expected.rev }
          : { componentPins: job.componentPins }),
      };
      if (job.deliver === "bytes") {
        // A4: acceptance-кадр не попадает в asset-store — байты уезжают вызывающему (в CAS).
        job.result = {
          kind: "image-bytes",
          ...quality,
          ...receiptField,
          ...this.readinessOf(result),
          imageProduced: true,
          bytes: new Uint8Array(bytes), width: result.width, height: result.height,
          consoleErrors: result.consoleErrors, pageErrors: result.pageErrors,
          ...imageExtras,
          rendererBuild: job.expected.rendererBuild, browserVersion: result.browserVersion,
          renderer: job.renderer,
        };
        job.status = "done";
        job.jobOutcome = "ok";
        this.expire(job);
        return;
      }
      const assetRepo = new AssetRepo(this.deps.db, this.deps.dataDir);
      const ingest = await assetRepo.ingest(new Uint8Array(bytes), "image/png", "screenshot.png");
      // Индекс `assetId → receipt` пишется **после** ингеста: до него assetId не существует
      // (V-N7). По нему R6 резолвит рендерер эталона, залитого серверным капчуром (T-B2).
      if (receiptSha256 !== undefined) {
        try { await putAssetReceipt(this.deps.dataDir, ingest.asset.id, receiptSha256); }
        catch (error) { quality.runtimeWarnings.push(`receipt_asset_index_failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
      job.result = {
        kind: "image",
        ...quality,
        ...receiptField,
        imageProduced: true,
        imageUrl: `/api/assets/${ingest.asset.id}`, assetId: ingest.asset.id, width: result.width, height: result.height,
        consoleErrors: result.consoleErrors, pageErrors: result.pageErrors,
        ...imageExtras,
        rendererBuild: job.expected.rendererBuild, browserVersion: result.browserVersion,
        renderer: job.renderer,
      };
      job.status = "done";
      job.jobOutcome = "ok";
      this.expire(job);
    } catch (error) {
      job.status = "error";
      job.error = { code: error instanceof ApiError ? error.code : "capture_failed", message: error instanceof Error ? error.message : String(error) };
      job.jobOutcome = jobOutcomeOfError(error);
      this.expire(job);
    } finally {
      this.sessions.revoke(session.token);
    }
  }

  /**
   * Расхождение объявленного рендерера и фактически нарисовавшего кадр (§3 E2).
   *
   * Сравнение — по `major.minor.build`: patch-часть плавает между сборками одного chromium и на
   * растр не влияет. Стенды и старые воркеры присылают синтетические версии (`"test/1"`) — такие
   * строки не разбираются в версию chromium и дают `unknown`, то есть сверка молчит: превращать
   * их в отказ капчура значило бы уронить всё, кроме прода.
   */
  private rendererMismatch(job: InternalJob, result: WorkerOk): string | null {
    const verdict = compareBrowserVersion(job.renderer.browserVersion, result.browserVersion);
    if (verdict !== "mismatch") return null;
    return `declared browser ${job.renderer.browserVersion} (renderer manifest, source=${job.renderer.source}) does not match the browser that rendered this frame (${result.browserVersion})`;
  }

  /** Цель капчура в форме receipt'а (R5): поля, неприменимые к виду цели, — `null`. */
  private receiptTargetOf(job: InternalJob): CaptureReceiptTarget {
    const expected = job.expected;
    if (expected.kind === "prototype") {
      return {
        kind: "prototype", componentId: null, prototypeId: job.owner.id,
        version: null, rev: expected.rev, sourceHash: null, bundleHash: null,
        dsMetaVersion: expected.dsMetaVersion, propsHash: null,
      };
    }
    if (expected.kind === "component-draft") {
      return {
        kind: "component-draft", componentId: expected.componentId, prototypeId: null,
        version: null, rev: expected.rev, sourceHash: expected.sourceHash, bundleHash: expected.bundleHash,
        dsMetaVersion: expected.dsMetaVersion, propsHash: expected.propsHash,
      };
    }
    return {
      kind: "component", componentId: expected.componentId, prototypeId: null,
      version: expected.version, rev: null, sourceHash: null, bundleHash: expected.bundleHash,
      dsMetaVersion: expected.dsMetaVersion, propsHash: expected.propsHash,
    };
  }

  /**
   * Собирает и сохраняет receipt капчура (§3 E4). Возвращает его адрес либо `undefined`, если
   * receipt'ы выключены kill-switch'ем или запись не удалась: доказательство происхождения не
   * важнее самого кадра, поэтому отказ стора никогда не валит джобу — он едет предупреждением.
   */
  private async storeReceipt(job: InternalJob, result: WorkerOk, quality: CaptureQuality, mismatch: string | null): Promise<string | undefined> {
    if (receiptsDisabled()) return undefined;
    try {
      const readiness = this.readinessOf(result);
      const png = "pngBase64" in result;
      // `probe:"geometry"` — измерительная джоба: PNG в этой ветке не существует, и `output`
      // честно `null`, а не нулевые размеры (C-M8).
      const output: CaptureReceiptOutput | null = png
        ? {
          viewport: job.viewport,
          dpr: job.dsf,
          colorScheme: job.theme,
          pngWidth: result.width,
          pngHeight: result.height,
          pngSha256: result.pngSha256 ?? null,
          surfaceRect: result.surfaceRect ?? null,
          ...(job.paintMargin === undefined ? {} : { paintMargin: job.paintMargin }),
        }
        : null;
      const receipt = buildCaptureReceipt({
        renderer: rendererDeclaration(),
        fingerprint: job.renderer.fingerprint,
        observedBrowserVersion: result.browserVersion ?? null,
        // Расхождение объявленного и наблюдённого доехало сюда только с выключенной строгой
        // сверкой (иначе джоба уже терминализована) — в receipt оно предупреждение, но видимое.
        drift: mismatch === null ? [] : [{ code: "renderer_mismatch" as const, severity: "warning" as const, detail: mismatch }],
        target: this.receiptTargetOf(job),
        fontManifestHash: job.fonts?.manifestHash ?? null,
        readiness: {
          met: readiness.readinessMet,
          policyHash: readiness.readinessPolicyHash,
          codes: readiness.readinessCodes,
          elapsedMs: result.readiness?.elapsedMs ?? null,
          evidence: readiness.readinessEvidence,
        },
        console: { errors: result.consoleErrors ?? [], warnings: result.consoleWarnings ?? [], pageErrors: result.pageErrors ?? [] },
        output,
        timings: { ...(result.timings ?? {}), readinessMs: result.readiness?.elapsedMs ?? null },
        captureClean: quality.captureClean,
      });
      const stored = await putReceipt(this.deps.dataDir, receipt);
      // Индекс джобы — сразу после записи: он и есть канал доступа (N12), и он обязан пережить
      // саму джобу (`RESULT_TTL_MS` 10 мин против 7 суток стора, V-N4).
      await putJobReceipt(this.deps.dataDir, job.id, { receiptSha256: stored.sha256, ownerKey: `${job.owner.kind}:${job.owner.id}` });
      return stored.sha256;
    } catch (error) {
      quality.runtimeWarnings.push(`receipt_store_failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /**
   * Пины свипера receipt'ов: адреса, на которые ссылаются **живые** job-результаты. Пока джоба
   * жива, её receipt обязан быть читаем ручкой — вытеснение по TTL/LRU здесь было бы дырой.
   */
  liveReceiptShas(): Set<string> {
    const shas = new Set<string>();
    for (const job of this.jobs.values()) if (job.receiptSha256) shas.add(job.receiptSha256);
    return shas;
  }

  /**
   * Receipt джобы для HTTP-ручки (N12). Живая джоба и мёртвая резолвятся одинаково — через
   * индекс стора; `ownerKey` возвращается **вместе** с документом, авторизацию делает роут.
   */
  async receiptFor(jobId: string): Promise<{ receiptSha256: string; ownerKey: string; receipt: CaptureReceipt } | null> {
    const link = await getJobReceipt(this.deps.dataDir, jobId)
      ?? (() => {
        const job = this.jobs.get(jobId);
        return job?.receiptSha256 ? { receiptSha256: job.receiptSha256, ownerKey: `${job.owner.kind}:${job.owner.id}`, createdAt: "" } : null;
      })();
    if (link === null) return null;
    const receipt = await readReceipt(this.deps.dataDir, link.receiptSha256);
    return receipt === null ? null : { receiptSha256: link.receiptSha256, ownerKey: link.ownerKey, receipt };
  }

  /**
   * Исход readiness капчура (W4). Шелл, не приславший доказательства (старый билд, preview),
   * даёт `null` — «неизвестно», а не «готов»: гейт `readiness` отличает эти случаи.
   */
  private readinessOf(result: WorkerOk): CaptureReadinessOutcome {
    return {
      readinessMet: result.readiness ? result.readiness.met : null,
      readinessReason: result.readiness?.reason ?? null,
      // Коды берутся у шелла, а если он их не прислал (билд до R3) — выводятся из доволновой
      // строки причины тем же словарём. Отсутствие доказательства целиком — `null`.
      readinessCodes: result.readiness
        ? (Array.isArray(result.readiness.codes)
          ? sanitizeCaptureCodes(result.readiness.codes)
          : codesFromReadinessReason(result.readiness.reason))
        : null,
      readinessPolicyHash: result.readiness?.policyHash ?? null,
      readinessEvidence: result.readiness?.evidence ?? null,
      observedCaptureEnvFingerprint: result.captureEnv?.fingerprint ?? null,
      observedCaptureEnv: result.captureEnv?.input ?? null,
    };
  }

  /** Classify browser output once per job; capture-clean means no product errors. */
  private qualityOf(result: WorkerOk): CaptureQuality {
    const messages = [...(result.consoleErrors ?? []), ...(result.pageErrors ?? [])];
    const { productErrors, infraNoise } = classifyCaptureErrors(messages, { captureOrigin: this.deps.captureOrigin });
    return { captureClean: productErrors.length === 0, productErrors, infraNoise, runtimeWarnings: [...(result.consoleWarnings ?? [])] };
  }

  private targetOf(job: InternalJob): Record<string, unknown> {
    if (job.expected.kind === "prototype") {
      // P2.3: пины и их manifest-hash заморожены на enqueue. Поверхность рендерит их вместо
      // DTO-пинов, поэтому publish компонента между enqueue и рендером не меняет ни кадр,
      // ни публикуемый handshake — это существующий канал, allowlist остаётся path-only.
      return { kind: "prototype", rev: job.expected.rev,
        ...(job.capturePins ? { components: job.capturePins } : {}),
        ...(job.captureManifestHash !== undefined ? { componentManifestHash: job.captureManifestHash } : {}) };
    }
    if (job.expected.kind === "component-draft") {
      // Драфт (P1b): поверхность читает name/designSystem/bundleUrl отсюда — published-DTO нет.
      return { kind: "component-draft", componentId: job.expected.componentId, rev: job.expected.rev, ...(job.draft ? { name: job.draft.name, designSystem: job.draft.designSystem, bundleUrl: job.draft.bundleUrl } : {}) };
    }
    return { kind: "component", componentId: job.expected.componentId, version: job.expected.version };
  }
  private expire(job: InternalJob): void { job.resultExpiresAt = this.now() + RESULT_TTL_MS; }
}

/**
 * Conservative subset validation of props against a `z.toJSONSchema` document:
 * enforces object-ness, declared `required` presence, and top-level primitive
 * `type` mismatches. Lenient beyond that (avoids false rejects on the full
 * JSON-Schema surface); the trusted-code model is the real boundary.
 */
/**
 * JSON-безопасность props ребёнка слота (план 2026-08-05 §A2): тот же обход, что в
 * {@link validatePropsAgainstSchema}, плюс отказ на префикс `__eui` — служебные ключи рантайма
 * в bootstrap ребёнка так же недопустимы, как директивы рендерера `$…`.
 */
export function jsonSafeSlotProps(node: unknown): boolean {
  if (node === null) return true;
  const kind = typeof node;
  if (kind === "string" || kind === "boolean") return true;
  if (kind === "number") return Number.isFinite(node as number);
  if (Array.isArray(node)) return node.every(jsonSafeSlotProps);
  if (kind === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key.startsWith("$") || key.startsWith("__eui")) return false;
      if (!jsonSafeSlotProps(value)) return false;
    }
    return true;
  }
  return false;
}

export function validatePropsAgainstSchema(props: unknown, schema: unknown): void {
  if (props === null || typeof props !== "object" || Array.isArray(props)) throw new ApiError(422, "invalid_props", "props must be a JSON object");
  const record = props as Record<string, unknown>;
  const walk = (node: unknown): boolean => {
    if (node === null) return true;
    const t = typeof node;
    if (t === "string" || t === "boolean") return true;
    if (t === "number") return Number.isFinite(node as number);
    if (Array.isArray(node)) return node.every(walk);
    if (t === "object") { for (const [k, v] of Object.entries(node as Record<string, unknown>)) { if (k.startsWith("$")) return false; if (!walk(v)) return false; } return true; }
    return false;
  };
  if (!walk(record)) throw new ApiError(422, "invalid_props", "props must be JSON-safe and free of $-prefixed keys");
  if (!schema || typeof schema !== "object") return;
  const s = schema as { required?: unknown; properties?: Record<string, { type?: unknown }> };
  if (Array.isArray(s.required)) for (const key of s.required) if (typeof key === "string" && !(key in record)) throw new ApiError(422, "invalid_props", `missing required prop: ${key}`);
  if (s.properties) for (const [key, def] of Object.entries(s.properties)) {
    if (!(key in record) || def?.type === undefined) continue;
    const expected = def.type;
    const value = record[key];
    if (typeof expected === "string" && !primitiveMatches(expected, value)) throw new ApiError(422, "invalid_props", `prop ${key} must be of type ${expected}`);
  }
}

function primitiveMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": case "integer": return typeof value === "number";
    case "boolean": return typeof value === "boolean";
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "null": return value === null;
    default: return true;
  }
}
