/**
 * Impact-driven gallery regression (план `docs/plans/2026-08-07-migration-feedback-wave.md`
 * §1.7/§W5, миграция v34).
 *
 * Модуль отвечает ровно на один вопрос: **какие экраны прототипа обязаны быть сняты заново**, а
 * какие уже сняты в точности в этих условиях и переиспользуются с доказательством. Доказательство
 * — `screenFrameFingerprint`: sha256 кортежа тех входов, от которых зависят сами пиксели экрана.
 *
 * **Инвариант волны:** `screenFrameFingerprint` — ключ reuse и только он. Он не входит ни в один
 * отпечаток приёмки (`frameFingerprint`/`comparisonFingerprint`/`caseFingerprint`), не двигает
 * `CASE_FINGERPRINT_ALGO_VERSION` и ничего не решает про вердикты: галерейная съёмка и матричная
 * приёмка — разные контуры, и связывать их одним хэшем значило бы инвалидировать корпус приёмки
 * каждой правкой галереи.
 *
 * **Состав кортежа** (§1.7, триаж C-M1 + раунд 2 N11) — поимённо:
 *  1. кортеж прототипного `CaptureExpected` (`src/capture/protocol.ts#PrototypeExpected`):
 *     `prototypeInstanceId`, `componentManifestHash` **по подмножеству пинов экрана**,
 *     `builtinCatalogHash`, `designSystem` (ДС **поверхности экрана**), `dsMetaVersion` (пин темы
 *     этой ДС) — плюс `screenId`, потому что кадр принадлежит экрану;
 *  2. `screenSpecHash` — экран плюс документные входы рендера (§`screenSpecHashOf`);
 *  3. `viewport`/`dsf`/`theme`;
 *  4. `readinessPolicyHash` — политика готовности, по которой снимается кадр;
 *  5. `rendererFingerprint` — объявленный рендерер под этой политикой;
 *  6. **резолвнутая meta-версия темы** ДС поверхности экрана + версия spacing-резолвера.
 *
 * **Отступление от буквы §1.7: `rev` в пре-образ не входит** (он остаётся колонкой строки и полем
 * квитанции). Причина продуктовая и арифметическая: любое добавление экрана — это новая ревизия,
 * и `rev` внутри хэша означал бы, что после каждого сохранения ни один экран не доказуем, то есть
 * ровно тот исход, против которого волна и написана («addition-only ⇒ 1 capture + N proven-reuse»,
 * `reuseReceipt.previousRev` тоже теряет смысл, если reuse не переживает ревизию). Информации о
 * пикселях `rev` не несёт: всё, что ревизия может изменить **для этого экрана**, уже представлено
 * `screenSpecHash` (спека + документные входы), `componentManifestHash` подмножества пинов экрана,
 * `builtinCatalogHash` и пином темы. `rev` — идентичность, а не содержание.
 *
 * Про (6) отдельно (раунд 2, N11): отдельного `themeContentHash` нет и не нужно — версии ДС
 * иммутабельны и append-only, поэтому номер версии **и есть** содержимое. Вход считается строго
 * per-screen (`surfaceDesignSystem` → `themePinsOf`): у мульти-ДС документа пин второй ДС двигался
 * бы независимо, и per-prototype вход дал бы ложный reuse. Незапиннутая (`null`) тема резолвится в
 * `latestMetaVersion` — именно то значение, которое возьмёт постановка джобы, поэтому публикация
 * новой версии темы честно двигает отпечаток всех экранов этой ДС.
 *
 * **Критерий недоказуемости** (триаж C-m11): «использование по имени в JSON экрана» не отличает
 * «компонента нет» от «есть транзитивно», поэтому экран, чьё resolved-дерево не разворачивается
 * полностью — композиция без доступного тела, тип без пина ревизии, вложенность глубже предела —
 * **всегда** `capture`. Недоказанный reuse = capture, без исключений.
 */
import type { Database } from "bun:sqlite";
import { COMPOSITION_TYPE } from "../../src/catalog/hostPrimitives/composition.definition";
import { hostPrimitiveNames } from "../../src/catalog/hostPrimitives/definitions";
import { COMPOSITION_DEPTH_LIMIT, type CompositionDoc } from "../../src/prototype/composition";
import type { PrototypeDoc } from "../../src/prototype/schema";
import { surfaceDesignSystem, surfaceOf, type SurfaceAwareDoc } from "../../src/prototype/surfaces";
import { canonicalReadinessPolicy, DEFAULT_READINESS_POLICY, type ReadinessPolicy } from "../../src/capture/readinessPolicy";
import { rendererFingerprint } from "../capture/renderer";
import { getDesignSystemVersion, getLatestDesignSystemContent } from "../designSystems";
import { ApiError } from "../http";
import { componentManifestHashOf, PrototypeRepo } from "../repos/prototypes";

const sha256 = (value: string): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");

/** Ревизий на прототип, чьи кадры хранятся (триаж O-m12); sweep — на каждой записи. */
export const SCREEN_FRAME_RETENTION_REVS = 5;

/**
 * Потолок экранов в одном плане. 256 — по прецедентам волны (`resourceBarrierMaxResources`,
 * `sourcePackageMaxExports`) и с шестикратным запасом к крупнейшей известной галерее миграции
 * YP v2 (43 экрана). План — чистое чтение без съёмки, но каждый экран стоит раскрытия
 * композиций и резолва темы, поэтому потолок объявлен, а не оставлен неявным.
 */
export const SNAP_PLAN_MAX_SCREENS = 256;

/** Потолок квитанции кадра (триаж O-m12): 64 КБ на строку, больше — усечение до минимума. */
export const SCREEN_FRAME_RECEIPT_MAX_BYTES = 64 * 1024;

/**
 * Kill-switch волны (`EASYUI_IMPACTED_SNAP_DISABLED=1`, регистрация — `server/main.ts`).
 *
 * Гасит **и** ручку плана (404), **и** запись кадров на горячем пути съёмки: иначе «выключенная»
 * фича продолжала бы писать в таблицу, которой при откате образа не существует. Env читается по
 * месту (прецедент `surfacesWriteEnabled`), параметр — ради тестов.
 */
export const impactedSnapEnabled = (raw: string | undefined = process.env.EASYUI_IMPACTED_SNAP_DISABLED): boolean =>
  raw !== "1";

export interface ScreenFrameViewport { width: number; height: number }

/** Кортеж входов отпечатка кадра экрана — ровно то, что хэшируется (см. шапку модуля). */
export interface ScreenFrameInputs {
  prototypeInstanceId: string;
  screenId: string;
  /** `componentManifestHashOf` **подмножества** пинов ревизии, участвующих в дереве экрана. */
  componentManifestHash: string;
  builtinCatalogHash: string;
  /** ДС поверхности экрана (у одно-поверхностного документа — `doc.designSystem`). */
  designSystem: string | null;
  /** Пин темы этой ДС на ревизии; `null` — тема не запиннута (голова). */
  dsMetaVersion: number | null;
  screenSpecHash: string;
  viewport: ScreenFrameViewport;
  dsf: number;
  theme: "light" | "dark";
  readinessPolicyHash: string;
  rendererFingerprint: string;
  /** Резолвнутая (пин или голова) meta-версия темы ДС поверхности экрана; `null` — темы нет. */
  themeMetaVersion: number | null;
  /** Версия spacing-резолвера этой версии темы (миграция v23): 1 — legacy, 2 — мердж на шкалу ДС. */
  spacingResolver: number;
}

/**
 * Отпечаток кадра экрана. Пре-образ — литерал с **фиксированным порядком ключей**: величина
 * персистится и сравнивается между процессами, поэтому порядок обязан быть свойством кода, а не
 * порядка ключей входного объекта (прецедент `componentManifestHashOf`).
 */
export function screenFrameFingerprint(inputs: ScreenFrameInputs): string {
  return sha256(JSON.stringify({
    v: 1,
    prototypeInstanceId: inputs.prototypeInstanceId,
    screenId: inputs.screenId,
    componentManifestHash: inputs.componentManifestHash,
    builtinCatalogHash: inputs.builtinCatalogHash,
    designSystem: inputs.designSystem,
    dsMetaVersion: inputs.dsMetaVersion,
    screenSpecHash: inputs.screenSpecHash,
    viewport: { width: inputs.viewport.width, height: inputs.viewport.height },
    dsf: inputs.dsf,
    theme: inputs.theme,
    readinessPolicyHash: inputs.readinessPolicyHash,
    rendererFingerprint: inputs.rendererFingerprint,
    themeMetaVersion: inputs.themeMetaVersion,
    spacingResolver: inputs.spacingResolver,
  }));
}

/**
 * `screenSpecHash` — сам экран плюс **документные** входы рендера.
 *
 * Экран рисуется не в вакууме: начальный `doc.state`, производные `doc.computed`, устройство,
 * ДС и описание поверхностей попадают в пиксели ровно так же, как спека экрана. Поэтому в хэш
 * едут обе части, но разными проекциями: правка одного экрана двигает только его отпечаток, а
 * правка документных входов — все (осознанно консервативно: ложный reuse дороже пересъёмки).
 *
 * Навигация (`flows`, `startScreen`), имя, описание, теги и архитектурные исключения в хэш **не**
 * входят: они не наблюдаемы в кадре одного экрана, а их включение убило бы главный сценарий волны
 * — «добавили экран в галерею, сняли один кадр».
 */
export function screenSpecHashOf(doc: PrototypeDoc, screen: unknown): string {
  const scope = {
    version: doc.version,
    device: doc.device,
    designSystem: doc.designSystem,
    state: doc.state,
    computed: doc.computed ?? null,
    surfaces: doc.surfaces ?? null,
  };
  return sha256(JSON.stringify({ scope, screen }));
}

/** Пин ревизии в форме, которой хватает и для manifest-хэша, и для сопоставления по имени типа. */
export interface ScreenFramePin { id: string; name: string; version: number; bundleHash: string }

/** Тело композиции, закреплённой за ревизией (`PrototypeRepo.revision().compositions`). */
export interface ScreenFrameComposition { id: string; doc: CompositionDoc }

interface ScreenTreeResolution {
  /** Имена типов custom-компонентов, встреченные в дереве экрана (включая тела композиций). */
  names: Set<string>;
  /** Причина недоказуемости, если дерево не разворачивается полностью; иначе `null`. */
  unprovable: string | null;
}

type ElementMap = Record<string, { type: string; props?: Record<string, unknown> }>;

/**
 * Разворачивает дерево экрана в множество имён компонентов.
 *
 * Возвращает первую причину недоказуемости, а не бросает: экран с нераскрываемым элементом — не
 * ошибка запроса, а честный `capture`. Ровно те три исхода, что перечислены в §1.7: композиция без
 * доступного тела, тип без пина ревизии, вложенность глубже предела раскрытия.
 */
function resolveScreenTree(elements: ElementMap, pinNames: ReadonlySet<string>, compositions: Map<string, CompositionDoc>, depth = 1): ScreenTreeResolution {
  const names = new Set<string>();
  if (depth > COMPOSITION_DEPTH_LIMIT) {
    return { names, unprovable: `composition nesting exceeds the expansion depth limit of ${COMPOSITION_DEPTH_LIMIT}` };
  }
  for (const [key, element] of Object.entries(elements)) {
    const type = element?.type;
    if (typeof type !== "string") return { names, unprovable: `element '${key}' has no resolvable type` };
    if (type === COMPOSITION_TYPE) {
      const reference = element.props?.composition;
      if (typeof reference !== "string") return { names, unprovable: `composition element '${key}' has no composition reference` };
      const body = compositions.get(reference);
      // Композиция без тела — ровно тот случай «нет inner-ключей», ради которого критерий и введён:
      // её внутренние компоненты не видны, и доказать, что экран не задет, нечем.
      if (!body) return { names, unprovable: `composition '${reference}' of element '${key}' is not resolvable at this revision` };
      const nested = resolveScreenTree(body.spec.elements as ElementMap, pinNames, compositions, depth + 1);
      for (const name of nested.names) names.add(name);
      if (nested.unprovable) return { names, unprovable: nested.unprovable };
      continue;
    }
    if (hostPrimitiveNames.has(type)) continue;
    // Тип без пина ревизии: либо бандл не разобран, либо документ ссылается на то, чего в пинах
    // нет. И то и другое — недоказуемо.
    if (!pinNames.has(type)) return { names, unprovable: `element '${key}' uses type '${type}', which has no component pin at this revision` };
    names.add(type);
  }
  return { names, unprovable: null };
}

/** Результат резолва одного экрана: отпечаток и (при недоказуемости) её причина. */
export interface ResolvedScreenFrame {
  screenId: string;
  fingerprint: string;
  inputs: ScreenFrameInputs;
  /** `null` — дерево развернулось полностью; строка — причина, по которой экран всегда снимается. */
  unprovable: string | null;
}

export interface ScreenFrameContext {
  doc: PrototypeDoc;
  prototypeInstanceId: string;
  rev: number;
  builtinCatalogHash: string;
  /** Пины ревизии целиком (в их каноническом порядке) — подмножество экрана берётся из них. */
  pins: ScreenFramePin[];
  compositions: ScreenFrameComposition[];
  /** Карта пинов темы ревизии (`themePinsOf`). */
  themePins: Record<string, number | null>;
  viewport: ScreenFrameViewport;
  dsf: number;
  theme: "light" | "dark";
  /** Политика готовности джобы; галерейный дефолт — `DEFAULT_READINESS_POLICY`. */
  readinessPolicy?: ReadinessPolicy;
}

/**
 * Отпечаток одного экрана из уже прочитанного состояния ревизии. Отдельный вход существует ради
 * постановки джобы: она эти факты уже держит в руках, и второе чтение ревизии внесло бы риск
 * рассинхронизации плана и записи.
 */
export function screenFrameOf(db: Database, context: ScreenFrameContext, screenId: string): ResolvedScreenFrame {
  const doc = context.doc;
  const screen = doc.screens.find((item) => item.id === screenId);
  if (!screen) throw new ApiError(404, "screen_not_found", "Screen not found");
  const designSystem = surfaceDesignSystem(surfaceOf(doc as SurfaceAwareDoc, screenId), doc as SurfaceAwareDoc) ?? doc.designSystem;
  const dsMetaVersion = context.themePins[designSystem] ?? null;
  // Та же резолюция темы, что и у постановки джобы (`enqueuePrototypeFrozen`): пин, а без пина —
  // голова. Иначе отпечаток описывал бы не ту тему, которой рисуется кадр.
  const themeContent = dsMetaVersion === null
    ? getLatestDesignSystemContent(db, designSystem)
    : getDesignSystemVersion(db, designSystem, dsMetaVersion);
  const themeMetaVersion = dsMetaVersion !== null
    ? (themeContent === null ? null : dsMetaVersion)
    : (themeContent as { latestMetaVersion: number | null } | null)?.latestMetaVersion ?? null;
  const spacingResolver = themeContent?.spacingResolver ?? 1;

  const pinNames = new Set(context.pins.map((pin) => pin.name));
  const compositions = new Map(context.compositions.map((entry) => [entry.id, entry.doc]));
  const tree = resolveScreenTree(screen.spec.elements as ElementMap, pinNames, compositions);
  // Подмножество пинов экрана — в каноническом порядке ревизии: `componentManifestHashOf`
  // хэширует список как есть, и сортировка «по месту в документе» дала бы разные хэши у
  // одинаковых экранов.
  const screenPins = context.pins.filter((pin) => tree.names.has(pin.name));
  const readinessPolicy = context.readinessPolicy ?? DEFAULT_READINESS_POLICY;
  const readinessPolicyHash = sha256(canonicalReadinessPolicy(readinessPolicy));
  const inputs: ScreenFrameInputs = {
    prototypeInstanceId: context.prototypeInstanceId,
    screenId,
    componentManifestHash: componentManifestHashOf(screenPins),
    builtinCatalogHash: context.builtinCatalogHash,
    designSystem,
    dsMetaVersion,
    screenSpecHash: screenSpecHashOf(doc, screen),
    viewport: { width: context.viewport.width, height: context.viewport.height },
    dsf: context.dsf,
    theme: context.theme,
    readinessPolicyHash,
    rendererFingerprint: rendererFingerprint(readinessPolicyHash),
    themeMetaVersion,
    spacingResolver,
  };
  return { screenId, fingerprint: screenFrameFingerprint(inputs), inputs, unprovable: tree.unprovable };
}

export interface ScreenFrameRequest {
  prototypeId: string;
  rev?: number;
  version?: number;
  viewport: ScreenFrameViewport;
  dsf: number;
  theme: "light" | "dark";
  readinessPolicy?: ReadinessPolicy;
  /** Подмножество экранов; по умолчанию — все экраны ревизии в порядке документа. */
  screenIds?: string[];
}

export interface ResolvedScreenFrames {
  rev: number;
  frames: ResolvedScreenFrame[];
}

/** Контекст ревизии для отпечатков: одно чтение репозитория на весь план. */
export function screenFrameContext(db: Database, prototypeId: string, selector: { rev?: number; version?: number }, capture: { viewport: ScreenFrameViewport; dsf: number; theme: "light" | "dark"; readinessPolicy?: ReadinessPolicy }): ScreenFrameContext {
  const repo = new PrototypeRepo(db);
  const rev = selector.version !== undefined
    ? repo.version(prototypeId, selector.version).rev
    : selector.rev ?? repo.meta(prototypeId).headRev;
  const full = repo.revision(prototypeId, rev);
  return {
    doc: full.doc,
    prototypeInstanceId: full.prototypeInstanceId,
    rev,
    builtinCatalogHash: full.builtinCatalogHash,
    pins: full.components.map((pin) => ({ id: pin.id, name: pin.name, version: pin.version, bundleHash: pin.bundleHash })),
    compositions: full.compositions.map((entry) => ({ id: entry.id, doc: entry.doc })),
    themePins: full.designSystemMetaVersions,
    viewport: capture.viewport,
    dsf: capture.dsf,
    theme: capture.theme,
    ...(capture.readinessPolicy ? { readinessPolicy: capture.readinessPolicy } : {}),
  };
}

/** Отпечатки экранов ревизии (плановый путь). */
export function resolveScreenFrames(db: Database, request: ScreenFrameRequest): ResolvedScreenFrames {
  const context = screenFrameContext(db, request.prototypeId, { rev: request.rev, version: request.version }, request);
  const ids = request.screenIds ?? context.doc.screens.map((screen) => screen.id);
  if (ids.length > SNAP_PLAN_MAX_SCREENS) {
    throw new ApiError(422, "snap_plan_too_many_screens",
      `A snap plan covers at most ${SNAP_PLAN_MAX_SCREENS} screens; ${ids.length} were requested`);
  }
  return { rev: context.rev, frames: ids.map((screenId) => screenFrameOf(db, context, screenId)) };
}

// --------------------------------------------------------------- хранилище кадров (миграция v34)

/** Строка `prototype_screen_frames` в её прикладной форме. */
export interface ScreenFrameRow {
  prototypeId: string;
  rev: number;
  screenId: string;
  screenFrameFingerprint: string;
  pngSha256: string;
  receipt: ScreenFrameReceipt | null;
  createdAt: string;
}

/**
 * Квитанция кадра: провенанс съёмки плюс **разложенный кортеж** отпечатка. Кортеж хранится не ради
 * читаемости: именно по нему план называет причину пересъёмки (`renderer` / `theme` / `impacted`),
 * а без него все три исхода схлопнулись бы в «отпечаток другой».
 */
export interface ScreenFrameReceipt {
  assetId?: string;
  captureReceiptSha256?: string;
  capturedAt: string;
  inputs: ScreenFrameInputs;
}

interface ScreenFrameDbRow {
  prototype_id: string; rev: number; screen_id: string; screen_frame_fingerprint: string;
  png_sha256: string; receipt_json: string | null; created_at: string;
}

function parseReceipt(json: string | null): ScreenFrameReceipt | null {
  if (json === null) return null;
  try { return JSON.parse(json) as ScreenFrameReceipt; } catch { return null; }
}

const fromRow = (row: ScreenFrameDbRow): ScreenFrameRow => ({
  prototypeId: row.prototype_id, rev: row.rev, screenId: row.screen_id,
  screenFrameFingerprint: row.screen_frame_fingerprint, pngSha256: row.png_sha256,
  receipt: parseReceipt(row.receipt_json), createdAt: row.created_at,
});

/**
 * Записывает кадр и подметает retention (последние `SCREEN_FRAME_RETENTION_REVS` ревизий на
 * прототип). Sweep — на записи, а не по таймеру: в сервере нет периодических задач, и «подмести
 * когда-нибудь» означало бы неограниченный рост таблицы на активной галерее.
 *
 * Идемпотентна по ключу `(prototype_id, rev, screen_id, screen_frame_fingerprint)`: повторная
 * съёмка тех же условий обновляет png/квитанцию, а не плодит строки.
 */
export function recordScreenFrame(db: Database, row: Omit<ScreenFrameRow, "createdAt"> & { createdAt?: string }): void {
  const createdAt = row.createdAt ?? new Date().toISOString();
  let receiptJson = row.receipt === null ? null : JSON.stringify(row.receipt);
  // Потолок квитанции — 64 КБ (триаж O-m12). Превышение не роняет запись кадра: сам кадр важнее
  // квитанции, поэтому переполненная квитанция усекается до пустой, а факт остаётся.
  if (receiptJson !== null && Buffer.byteLength(receiptJson, "utf8") > SCREEN_FRAME_RECEIPT_MAX_BYTES) receiptJson = null;
  db.transaction(() => {
    db.query(`INSERT INTO prototype_screen_frames
        (prototype_id,rev,screen_id,screen_frame_fingerprint,png_sha256,receipt_json,created_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT (prototype_id,rev,screen_id,screen_frame_fingerprint)
      DO UPDATE SET png_sha256=excluded.png_sha256,receipt_json=excluded.receipt_json,created_at=excluded.created_at`)
      .run(row.prototypeId, row.rev, row.screenId, row.screenFrameFingerprint, row.pngSha256, receiptJson, createdAt);
    db.query(`DELETE FROM prototype_screen_frames WHERE prototype_id=? AND rev NOT IN (
        SELECT rev FROM (SELECT DISTINCT rev FROM prototype_screen_frames WHERE prototype_id=? ORDER BY rev DESC LIMIT ?))`)
      .run(row.prototypeId, row.prototypeId, SCREEN_FRAME_RETENTION_REVS);
  })();
}

/** Кадр, доказывающий reuse: та же связка прототип+отпечаток, самая свежая ревизия. */
export function findProvenFrame(db: Database, prototypeId: string, fingerprint: string): ScreenFrameRow | null {
  const row = db.query(`SELECT * FROM prototype_screen_frames
    WHERE prototype_id=? AND screen_frame_fingerprint=? ORDER BY rev DESC LIMIT 1`)
    .get(prototypeId, fingerprint) as ScreenFrameDbRow | null;
  return row ? fromRow(row) : null;
}

/** Последний записанный кадр экрана (любых условий) — вход классификации причины пересъёмки. */
export function latestFrameOfScreen(db: Database, prototypeId: string, screenId: string): ScreenFrameRow | null {
  const row = db.query(`SELECT * FROM prototype_screen_frames
    WHERE prototype_id=? AND screen_id=? ORDER BY rev DESC,created_at DESC LIMIT 1`)
    .get(prototypeId, screenId) as ScreenFrameDbRow | null;
  return row ? fromRow(row) : null;
}

/** Все кадры прототипа (диагностика и тесты retention). */
export function screenFramesOf(db: Database, prototypeId: string): ScreenFrameRow[] {
  return (db.query("SELECT * FROM prototype_screen_frames WHERE prototype_id=? ORDER BY rev,screen_id,screen_frame_fingerprint")
    .all(prototypeId) as ScreenFrameDbRow[]).map(fromRow);
}

// --------------------------------------------------------------------------------- план съёмки

/**
 * Причина решения по экрану.
 *
 * - `proven-reuse` — кадр с этим отпечатком уже снят; переиспользуется с квитанцией;
 * - `new` — у экрана нет ни одного записанного кадра;
 * - `unprovable` — дерево экрана не разворачивается полностью (§1.7);
 * - `renderer` — сменился `rendererFingerprint` (в него входит и политика готовности);
 * - `theme` — сменилась резолвнутая версия темы, её пин или spacing-резолвер;
 * - `impacted` — всё остальное: пины экрана, спека или условия съёмки.
 */
export type SnapPlanReason = "proven-reuse" | "new" | "unprovable" | "renderer" | "theme" | "impacted";

export interface SnapPlanScreen {
  screenId: string;
  action: "capture" | "reuse";
  reason: SnapPlanReason;
  screenFrameFingerprint: string;
  /** Причина недоказуемости — только у `reason: "unprovable"`. */
  unprovable?: string;
  /** Подписанная сервером квитанция переиспользования — только у `action: "reuse"`. */
  reuseReceipt?: { screenId: string; screenFrameFingerprint: string; previousRev: number; previousPngSha256: string; provenAt: string };
}

export interface SnapPlan {
  prototypeId: string;
  rev: number;
  viewport: ScreenFrameViewport;
  deviceScaleFactor: number;
  theme: "light" | "dark";
  screens: SnapPlanScreen[];
  summary: { total: number; capture: number; reuse: number };
}

/** Классификация причины пересъёмки по последнему кадру экрана (см. `SnapPlanReason`). */
function captureReason(previous: ScreenFrameRow | null, inputs: ScreenFrameInputs): SnapPlanReason {
  if (previous === null) return "new";
  const before = previous.receipt?.inputs;
  // Кадр без разложенного кортежа (запись более старой сборки) — не «новый» и не «тема»:
  // честно `impacted`, потому что доказать более узкую причину нечем.
  if (!before) return "impacted";
  if (before.rendererFingerprint !== inputs.rendererFingerprint) return "renderer";
  if (before.themeMetaVersion !== inputs.themeMetaVersion
    || before.dsMetaVersion !== inputs.dsMetaVersion
    || before.spacingResolver !== inputs.spacingResolver
    || before.builtinCatalogHash !== inputs.builtinCatalogHash) return "theme";
  return "impacted";
}

export function buildSnapPlan(db: Database, request: ScreenFrameRequest): SnapPlan {
  const resolved = resolveScreenFrames(db, request);
  const screens: SnapPlanScreen[] = resolved.frames.map((frame) => {
    if (frame.unprovable !== null) {
      return { screenId: frame.screenId, action: "capture", reason: "unprovable", screenFrameFingerprint: frame.fingerprint, unprovable: frame.unprovable };
    }
    const proven = findProvenFrame(db, request.prototypeId, frame.fingerprint);
    if (proven) {
      return {
        screenId: frame.screenId, action: "reuse", reason: "proven-reuse", screenFrameFingerprint: frame.fingerprint,
        reuseReceipt: {
          screenId: frame.screenId, screenFrameFingerprint: frame.fingerprint,
          previousRev: proven.rev, previousPngSha256: proven.pngSha256, provenAt: proven.createdAt,
        },
      };
    }
    return {
      screenId: frame.screenId, action: "capture", screenFrameFingerprint: frame.fingerprint,
      reason: captureReason(latestFrameOfScreen(db, request.prototypeId, frame.screenId), frame.inputs),
    };
  });
  const reuse = screens.filter((screen) => screen.action === "reuse").length;
  return {
    prototypeId: request.prototypeId,
    rev: resolved.rev,
    viewport: request.viewport,
    deviceScaleFactor: request.dsf,
    theme: request.theme,
    screens,
    summary: { total: screens.length, capture: screens.length - reuse, reuse },
  };
}
