/**
 * Гейт `geometry` **v2** — Geometry Contract 2.0 (план 2026-08-03 §3 D3/D4, §5 W3).
 *
 * Заменяет advisory-гейт v1 (`gates/geometry.ts`, union `getClientRects()` — сам по себе дефект
 * §19.2 фидбэка: «измеренная ширина 175 при layout-ширине 140» давала коробка декоративного
 * потомка). Здесь измерения разделены честно:
 *
 * - `layoutBounds` — union border-box'ов **in-flow** потомков (собирает `collectGeometry`);
 * - `paintBounds` — ink-bbox по альфе кадра `probe:"paint"` (прозрачная поверхность + маргин),
 *   нормализованный в CSS px делением на `deviceScaleFactor` (триаж R1-M2);
 * - вердикт — чистая функция `src/capture/geometryPolicy.ts` (D3: факты в capture, вердикт на сервере).
 *
 * **Инвариант гейта (KPI §1, done W3):** `fail` возможен только с непустым `overflow.sources[]`
 * либо с названным `expectedGeometry`-расхождением. Наблюдённый overflow без объяснимого
 * источника — `indeterminate` с диагностикой, а не обвинение компонента: «геометрия упала, но
 * непонятно из-за кого» — ровно то, что этот пакет обязан убрать.
 */
import {
  evaluateGeometryPolicy, geometryVerdictBlocks,
  type GeometryDecorationSource, type GeometryOverflowSides, type GeometryPolicyRect,
  type GeometryPolicyResult, type GeometryPolicyVerdict, type GeometryTolerancesInput,
} from "../../../src/capture/geometryPolicy";
import { declaresSurfaces, type GeometrySurface, type SurfaceDims } from "../../../src/acceptance/surfaces";
import type { CaptureCode } from "../../../src/capture/failureCodes";
import type { GeometryDetail, GeometryOutOfFlowNode } from "../../../src/capture/geometry.mjs";
import { putArtifact } from "../evidence";
import { spawnInkBboxWorker, type RunInkBbox } from "../inkBbox";
import { captureV4Enabled } from "../../capture/captureV4";
import { geometryOwnershipEnabled } from "../../capture/geometryOwnership";
import { geometryOwnershipViolationCodes, type GeometryOwnershipViolation } from "./audit";
import { captureCase } from "./capture";
import type { Gate, GateContext, GateResult } from "./types";

/** Ключ мемо: sha paint-кадра случая — на него ссылаются и evidence, и будущий гейт `visual`. */
export const paintShaKey = (caseId: string): string => `geometry.paint.sha:${caseId}`;

/**
 * Ключ мемо: измеренные факты кадра случая (W5). Их читает гейт `visual`, когда строит
 * каноническую канву из content-hug эталона и `expectedGeometry` у случая не объявлен: канва
 * тогда выводится из **измеренного** `layoutBounds` и того же `paintMargin`, которым снимался
 * кадр. Пересчитывать margin из константы вместо факта съёмки нельзя — они обязаны совпадать.
 */
export const geometryFactsKey = (caseId: string): string => `geometry.facts:${caseId}`;
export interface GeometryFacts {
  /**
   * Бокс layout-корня в CSS px **относительно внешнего `#eui-capture-surface`**, то есть вместе с
   * маргином поля. `x`/`y` добавлены волной W5 (§T5c.5): на viewport-поверхности content-hug эталон
   * кладётся в канву именно туда, где корень оказался в кадре, — у hug-кейса это `margin×dsf`, а у
   * оверлея координата произвольная и вывести её из `expectedGeometry` (там только w/h) нельзя.
   */
  layoutBounds: { x: number; y: number; width: number; height: number } | null;
  /**
   * Бокс корня компонента в тех же координатах (W1b). Поле **опционально** намеренно: мемо
   * заполняет гейт геометрии, а конструкторы фактов в тестах визуала жили до волны — «поля нет»
   * и «корень не измерен» одинаково означают «строить по нему нечего».
   */
  rootBounds?: { x: number; y: number; width: number; height: number } | null;
  paintMargin: number | null;
  /**
   * **Поле краски кадра по сторонам**, CSS px (BR-02, план 2026-08-08 §2). Присутствует ровно у
   * кадра, чей случай объявил `paintPaddingPx`.
   *
   * Держится **отдельно** от `paintMargin` намеренно (блокер B3 раунда 2): `paintMargin` — это
   * comparison-owned поле канвы сравнения, и канва обязана оставаться прежней независимо от того,
   * каким полем снят кадр. Асимметричное поле кадра приводится к канве сравнения кропом/подстановкой
   * кандидатского растра в гейте `visual`, а не сдвигом самой канвы.
   */
  paintPadding?: { top: number; right: number; bottom: number; left: number } | null;
  deviceScaleFactor: number;
}

/**
 * Габариты эталонного экспорта в **CSS px** из габаритов ассета в device px (W1b, §1.1).
 *
 * Единственная точка нормализации: `expectedSurfaces.referenceExport` объявляется в CSS px, а в
 * `assets.width/height` лежат пиксели файла. Два места деления на `deviceScaleFactor` рано или
 * поздно разошлись бы, и вердикт `referenceExport` начал бы врать ровно в ×dsf раз.
 *
 * `null` — габариты **неразрешимы против dsf**, а не «примерно подойдут»: device px, не кратные
 * масштабу съёмки, означают экспорт в другом масштабе (1x-ассет против 2x-кадра), и деление дало
 * бы правдоподобное, но неверное число.
 */
export function referenceExportCssDims(device: SurfaceDims, deviceScaleFactor: number): SurfaceDims | null {
  if (!Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0) return null;
  if (!Number.isFinite(device.width) || !Number.isFinite(device.height) || device.width <= 0 || device.height <= 0) return null;
  const width = device.width / deviceScaleFactor;
  const height = device.height / deviceScaleFactor;
  const integral = (value: number): boolean => Math.abs(value - Math.round(value)) <= 0.001;
  if (!integral(width) || !integral(height)) return null;
  return { width: Math.round(width), height: Math.round(height) };
}

/**
 * Три исхода замера эталонного экспорта (§W1b.2, N6 — колонки `assets.width/height` nullable):
 * габариты есть и сводятся с dsf ⇒ факт; ассета либо габаритов нет ⇒ факта нет (`not-measured` у
 * поверхности, а не догадка); габариты есть, но не сводятся ⇒ названный отказ.
 */
export type ReferenceExportMeasurement =
  | { dims: SurfaceDims; reason: null; deviceDims: SurfaceDims }
  | { dims: null; reason: "no_reference" | "asset_dims_missing" | "dimensions_irreconcilable"; deviceDims: SurfaceDims | null };

export function referenceExportDimsOf(ctx: GateContext): ReferenceExportMeasurement {
  const assetId = ctx.case.referenceAssetId ?? null;
  if (assetId === null) return { dims: null, reason: "no_reference", deviceDims: null };
  const row = ctx.db
    ? ctx.db.query("SELECT width, height FROM assets WHERE id=?").get(assetId) as { width: number | null; height: number | null } | null
    : null;
  if (!row || typeof row.width !== "number" || typeof row.height !== "number") {
    return { dims: null, reason: "asset_dims_missing", deviceDims: null };
  }
  const deviceDims = { width: row.width, height: row.height };
  const dims = referenceExportCssDims(deviceDims, ctx.surface.dsf);
  return dims === null
    ? { dims: null, reason: "dimensions_irreconcilable", deviceDims }
    : { dims, reason: null, deviceDims };
}

/**
 * Допуски случая: профиль даёт пороги в px, манифест (W2) — намерения
 * `allowPaintOverflow`/`expectedClip`, а с W3 (план 2026-08-06) ещё и числа: `sizeDeltaPx`
 * **побеждает** профильный (случай — объявленное исключение из нормы семьи) и `overflowBudgetPx`
 * задаёт per-side допуск краски. С волны 2026-08-07 сюда же приезжают **объявленные поверхности**
 * (`expectedSurfaces`/`clipExpectation`) — они и служат дискриминатором нового пути вердикта.
 */

/**
 * Kill-switch волны (`EASYUI_GEOMETRY_SURFACES_DISABLED=1`, план 2026-08-07 §W11): новый путь
 * вердикта откатывается на легаси-ветку **целиком** — поверхности перестают попадать в допуски,
 * значит `evaluateGeometryPolicy` не видит дискриминатора и исполняет прежний код. Точка одна на
 * обоих потребителей допусков (гейт и `recompute.ts`): два независимых тумблера означали бы, что
 * свежий вердикт и пересчитанный расходятся при полуоткрученном флаге.
 */
export const geometrySurfacesEnabled = (): boolean => process.env.EASYUI_GEOMETRY_SURFACES_DISABLED !== "1";

export function geometryTolerancesOf(ctx: GateContext): GeometryTolerancesInput {
  const perCase = ctx.case.casePolicy ?? {};
  // Поверхности кладутся **только** при явной декларации случая (§1.1, N3): результат нормализации
  // `expectedGeometry → {layoutUnion}` сюда не попадает никогда, иначе весь накопленный корпус
  // молча переехал бы на новый путь вердикта.
  const surfaces = geometrySurfacesEnabled() && declaresSurfaces(ctx.case)
    ? { expectedSurfaces: ctx.case.expectedSurfaces!, ...(ctx.case.clipExpectation === undefined ? {} : { clipExpectation: ctx.case.clipExpectation }) }
    : {};
  return {
    ...surfaces,
    tolerancePx: ctx.policy.geometry.overflowPx,
    sizeTolerancePx: perCase.sizeDeltaPx ?? ctx.policy.geometry.sizeDeltaPx,
    expectedGeometry: ctx.case.expectedGeometry ?? null,
    ...(perCase.allowPaintOverflow === undefined ? {} : { allowPaintOverflow: perCase.allowPaintOverflow }),
    ...(perCase.expectedClip === undefined ? {} : { expectedClip: perCase.expectedClip }),
    ...(perCase.overflowBudgetPx === undefined ? {} : { overflowBudgetPx: perCase.overflowBudgetPx }),
  };
}

/**
 * Провал обязан назвать виновника (инвариант гейта). До волны виновником был источник эффекта либо
 * `expectedGeometry`-расхождение; теперь им может быть **имя поверхности** — и это такое же
 * названное обвинение, а не догадка, поэтому `surface-mismatch` не деградирует в `indeterminate`.
 */
export function geometryVerdictIsNamed(policy: GeometryPolicyResult): boolean {
  return policy.overflow.sources.length > 0
    || policy.expectedGeometryDelta !== null
    || (policy.divergingSurfaces?.length ?? 0) > 0
    || policy.clipSatisfied === false;
}

/** Поверхностные факты вердикта — только у нового пути (условный спред, см. инвариант байт-в-байт). */
export function surfaceFacts(policy: GeometryPolicyResult): Record<string, unknown> {
  if (policy.surfaces === undefined) return {};
  return {
    surfaces: policy.surfaces,
    divergingSurfaces: policy.divergingSurfaces ?? [],
    clipSatisfied: policy.clipSatisfied ?? null,
  };
}

const isRect = (value: unknown): value is GeometryPolicyRect =>
  value !== null && typeof value === "object"
  && ["x", "y", "width", "height"].every((key) => typeof (value as Record<string, unknown>)[key] === "number");

/** Корневой детальный замер: по умолчанию `detailKeys` — корневой маркер, он и есть компонент. */
function rootDetail(geometry: Record<string, unknown>): GeometryDetail | null {
  const details = geometry.details;
  if (!Array.isArray(details) || details.length === 0) return null;
  return details[0] as GeometryDetail;
}

/**
 * Вердикт геометрии в типизированный словарь (§3 E3, §5 R3): `surface_overflow` — единственный код
 * этой области, и он эмитится **только** когда вердикт действительно блокирует при текущих
 * допусках. `indeterminate` кодом не сопровождается: «не измерили» — не «вылезло за поверхность».
 * `severity` берётся из того же `geometryVerdictBlocks`, что и статус гейта, — два источника
 * правды о том, провал это или нет, здесь недопустимы.
 */
export function geometryCodes(
  verdict: GeometryPolicyVerdict,
  overflow: GeometryOverflowSides | null,
  tolerances: GeometryTolerancesInput,
  reasons: readonly string[],
  divergingSurfaces: readonly GeometrySurface[] = [],
): CaptureCode[] {
  if (verdict === "clean" || verdict === "indeterminate") return [];
  // W1a: расхождение поверхности — свой код с `ref = <поверхность>`, по коду на поверхность.
  // Читатель отчёта обязан узнать **что** разошлось, а не только «геометрия упала».
  if (verdict === "surface-mismatch") {
    return divergingSurfaces.map((surface) => ({
      code: "surface_mismatch" as const,
      severity: "error" as const,
      detail: reasons.find((reason) => reason.startsWith(`surface ${surface} `)) ?? `surface ${surface} diverges from its declared dimensions`,
      ref: surface,
    }));
  }
  const blocks = geometryVerdictBlocks(verdict, overflow, tolerances);
  return [{
    code: "surface_overflow",
    severity: blocks ? "error" : "warning",
    detail: reasons.length > 0 ? reasons.join("; ") : `geometry verdict ${verdict}`,
    ref: verdict,
  }];
}

/**
 * Код несводимых габаритов эталона (W1b). Эмитится **только** на третьем исходе замера: «ассета
 * нет» и «у ассета нет габаритов» — не отказ, а отсутствие факта, и поверхность честно получает
 * `not-measured`.
 *
 * `severity` зависит от того, объявлена ли поверхность `referenceExport`: если объявлена, вердикт
 * без факта невозможен и это ошибка кадра; если нет — это диагностика («эталон снят в другом
 * масштабе»), которая ничей вердикт не двигает.
 */
export function referenceExportCodes(measurement: ReferenceExportMeasurement, ctx: GateContext): CaptureCode[] {
  if (measurement.reason !== "dimensions_irreconcilable") return [];
  const declared = geometrySurfacesEnabled() && declaresSurfaces(ctx.case)
    && ctx.case.expectedSurfaces?.referenceExport !== undefined;
  const device = measurement.deviceDims!;
  return [{
    code: "dimensions_irreconcilable",
    severity: declared ? "error" : "warning",
    detail: `reference asset is ${device.width}×${device.height} device px, which does not reduce to CSS px`
      + ` at deviceScaleFactor ${ctx.surface.dsf}: the export was taken at a different scale`,
    ...(ctx.case.referenceAssetId ? { ref: ctx.case.referenceAssetId } : {}),
  }];
}

/**
 * Поле кадра по сторонам для политики (BR-02): объявленное per-side либо скаляр, растянутый на все
 * четыре стороны. `null`-маргин (кадр, чьего поля мы не знаем) даёт `undefined` — политика тогда
 * остаётся на доволновой безликой причине, а не выдумывает числа.
 */
export function paintFieldOf(
  padding: { top: number; right: number; bottom: number; left: number } | null,
  margin: number | null,
): { top: number; right: number; bottom: number; left: number } | undefined {
  if (padding !== null) return { ...padding };
  return margin === null ? undefined : { top: margin, right: margin, bottom: margin, left: margin };
}

/**
 * Ink clamp типизированным кодом (BR-02). Раньше этот исход был безликим `indeterminate`-reason'ом:
 * гейт возвращал `indeterminate` **без единого кода**, и отчёт не мог сказать, какой стороне не
 * хватило поля. `severity: "error"` — кадр непригоден для вердикта краски по названным сторонам.
 */
export function paintClippedCodes(policy: GeometryPolicyResult): CaptureCode[] {
  const clipped = policy.paintClipped;
  if (clipped === undefined || clipped.sides.length === 0) return [];
  return [{
    code: "paint_capture_clipped",
    severity: "error",
    detail: `ink touches the ${clipped.sides.join("/")} edge of the capture field`
      + ` (${clipped.sides.map((side) => `${side} ${clipped.requestedPx[side]}px`).join(", ")});`
      + ` declare cases[].paintPaddingPx with at least`
      + ` ${clipped.sides.map((side) => `${side} ${clipped.minimumPx[side]}`).join(", ")} and recapture`,
    ref: clipped.sides.join("/"),
  }];
}

/**
 * Decoration-источники случая (BR-05): узлы вне потока, признанные декорацией — авто-правилом
 * замера (pre-transform коробка вложена в контур) либо декларацией `cases[].geometryOwnership`.
 *
 * Пустой список при выключенной группе — единственный способ оставить вердикт доволновым
 * байт-в-байт: `evaluateGeometryPolicy` без `decorationSources` исполняет прежний код целиком.
 */
export function decorationSourcesOf(detail: GeometryDetail | null): GeometryDecorationSource[] {
  const nodes: readonly GeometryOutOfFlowNode[] = detail?.outOfFlowNodes ?? [];
  return nodes
    .filter((node) => node.role === "decoration")
    .map((node) => ({
      ...(node.elementKey ? { elementKey: node.elementKey } : {}),
      ...(node.elementPath ? { elementPath: node.elementPath } : {}),
      causes: [...node.causes],
      bounds: node.postTransformPaintBounds,
      preTransformBounds: node.preTransformBounds,
      transform: node.transform,
      roleSource: node.roleSource ?? "auto",
    }));
}

export function createGeometry2Gate(fallbackInkBbox: RunInkBbox = spawnInkBboxWorker): Gate {
  return {
    name: "geometry",
    async run(ctx: GateContext): Promise<GateResult> {
      // Ink-воркер — шов: продакшн спавнит node-подпроцесс, тесты подсовывают чистую функцию,
      // поэтому вердикт политики проверяется без chromium и без pngjs-подпроцесса.
      const runInkBbox = ctx.inkBbox ?? fallbackInkBbox;
      // BR-02: поле краски случая доезжает до съёмки. До волны гейт звал `captureCase` вовсе без
      // поля, поэтому объявленный per-case `paintPaddingPx` не мог повлиять ни на один пиксель —
      // случай снимался скалярным дефолтом. Условный спред: случай без декларации (и любой случай
      // при выключенной группе) ставит джобу байт-в-байт прежней.
      const paintPadding = captureV4Enabled() ? ctx.case.paintPaddingPx : undefined;
      // BR-05: декларация владения доезжает до браузера — она меняет **интерпретацию замера**
      // (объявленный узел перестаёт быть кандидатом в корень), поэтому её место рядом с полем
      // краски, а не в вердикте. Условный спред: случай без декларации ставит джобу как раньше.
      const geometryOwnership = geometryOwnershipEnabled() ? ctx.case.geometryOwnership : undefined;
      const capture = await captureCase(ctx, {
        probe: "paint",
        ...(paintPadding === undefined ? {} : { paintPadding }),
        ...(geometryOwnership === undefined ? {} : { geometryOwnership }),
        geometryDetailKeys: ctx.case.geometryDetailKeys ?? [],
      });
      const geometry = capture.geometry ?? {};
      const detail = rootDetail(geometry);
      const image = capture.image;
      const tolerances = geometryTolerancesOf(ctx);
      const artifacts: GateResult["artifacts"] = [];

      // Кадр и факты кладутся в evidence **всегда**, даже когда вердикт не выдан: они и есть
      // доказательство того, что мерялось (и вход диагностики «увеличить маргин»).
      if (image) {
        const png = await putArtifact(ctx.dataDir, image.bytes);
        ctx.shared.set(paintShaKey(ctx.case.caseId), png.sha256);
        artifacts.push({ name: "paint.png", sha256: png.sha256, bytes: png.bytes });
      }

      const ink = image
        ? await runInkBbox({
          pngBase64: Buffer.from(image.bytes).toString("base64"),
          options: { deviceScaleFactor: ctx.surface.dsf },
        })
        : { ok: false as const, error: "paint capture returned no image bytes" };

      const paintBounds = ink.ok && isRect(ink.bounds) ? ink.bounds : null;
      // W1b: оба факта меряются **безусловно** — и когда поверхности не объявлены. Кадр обязан
      // нести их всегда, иначе первая же декларация ожидания стоила бы пересъёмки (AC §3.4).
      const rootBoundsFact = detail?.rootBounds ?? null;
      const rootBounds = isRect(rootBoundsFact) ? rootBoundsFact : null;
      const rootClip = detail?.rootClip ?? null;
      const referenceExport = referenceExportDimsOf(ctx);
      const decorationSources = geometryOwnershipEnabled() ? decorationSourcesOf(detail) : [];
      // BR-05: злоупотребление декларацией — отказ по фактам замера (правило и код живут в
      // `gates/audit.ts`, см. там же объяснение, почему точка применения здесь).
      const ownershipViolations = (geometryOwnershipEnabled()
        ? (detail as (GeometryDetail & { ownershipViolations?: GeometryOwnershipViolation[] }) | null)?.ownershipViolations
        : undefined) ?? [];
      const ownershipCodes = geometryOwnershipViolationCodes(ownershipViolations);
      const policy = evaluateGeometryPolicy({
        layoutBounds: detail?.layoutBounds ?? null,
        paintBounds,
        paintBoundsSource: paintBounds ? "alpha" : null,
        paintClamped: ink.ok ? ink.clamped : null,
        effectSources: detail?.effectSources ?? [],
        clipChain: detail?.clipChain ?? [],
        rootBounds,
        rootClip,
        referenceExportDims: referenceExport.dims,
        // BR-02: поле кадра по сторонам — вход **называния** ink clamp'а. У скалярного кадра это
        // четыре равные стороны фактического маргина съёмки; поля нет вовсе, когда группа
        // выключена, и тогда вердикт остаётся доволновым байт-в-байт.
        ...(captureV4Enabled() ? { paintField: paintFieldOf(capture.paintPadding ?? null, capture.paintMargin ?? null) } : {}),
        // BR-05: decoration-источники — условный вход. При выключенной группе список пуст и ключ
        // не кладётся вовсе, поэтому вердикт остаётся доволновым байт-в-байт.
        ...(decorationSources.length === 0 ? {} : { decorationSources }),
        tolerances,
      });

      const record = {
        semantics: "v2-paint",
        paintMargin: capture.paintMargin ?? null,
        deviceScaleFactor: ctx.surface.dsf,
        layoutBounds: detail?.layoutBounds ?? null,
        rootBounds,
        rootClip,
        // Габариты эталона едут вместе с их происхождением: «не измерено» и «не сводится с dsf» —
        // разные факты, и по сохранённому рану это должно читаться без похода в БД.
        referenceExportDims: referenceExport.dims,
        referenceExportDimsSource: referenceExport.reason === null
          ? { deviceDims: referenceExport.deviceDims, deviceScaleFactor: ctx.surface.dsf }
          : { reason: referenceExport.reason, deviceDims: referenceExport.deviceDims, deviceScaleFactor: ctx.surface.dsf },
        paintBounds,
        paintBoundsSource: paintBounds ? "alpha" : null,
        paintBoundsPixels: ink.ok ? ink.pixelBounds : null,
        paintClamped: ink.ok ? ink.clamped : null,
        // BR-02: чем кадр снят (условный ключ — скалярный кадр остаётся доволновым байт-в-байт).
        ...(capture.paintPadding === undefined ? {} : { paintPadding: capture.paintPadding }),
        ...(policy.paintClipped === undefined ? {} : { paintClipped: policy.paintClipped }),
        // BR-05: владение геометрией — условные ключи; доволновой кадр их не несёт.
        ...(decorationSources.length === 0 ? {} : { decorationSources }),
        ...(policy.paintOwnership === undefined ? {} : { paintOwnership: policy.paintOwnership }),
        ...(ownershipViolations.length === 0 ? {} : { geometryOwnershipViolations: ownershipViolations }),
        ...(ink.ok ? {} : { inkError: ink.error }),
        policyVerdict: policy.policyVerdict,
        overflow: policy.overflow,
        expectedGeometryDelta: policy.expectedGeometryDelta,
        clippedBy: policy.clippedBy,
        // W1a: поверхности кладутся условным спредом — легаси-вердикт обязан дать байт-в-байт
        // прежний `geometry.json`, иначе производные артефакты корпуса сдвинулись бы без причины.
        ...surfaceFacts(policy),
        effectSources: detail?.effectSources ?? [],
        clipChain: detail?.clipChain ?? [],
        geometry,
      };
      // W5: факты кадра — вход канонической канвы визуального сравнения (см. `geometryFactsKey`).
      ctx.shared.set(geometryFactsKey(ctx.case.caseId), {
        layoutBounds: isRect(record.layoutBounds)
          ? { x: record.layoutBounds.x, y: record.layoutBounds.y, width: record.layoutBounds.width, height: record.layoutBounds.height }
          : null,
        rootBounds,
        paintMargin: record.paintMargin,
        // BR-02: capture-поле едет рядом с comparison-margin, не вместо него.
        ...(capture.paintPadding === undefined ? {} : { paintPadding: capture.paintPadding }),
        deviceScaleFactor: ctx.surface.dsf,
      } satisfies GeometryFacts);

      const artifact = await putArtifact(ctx.dataDir, record as unknown as Record<string, unknown>);
      artifacts.push({ name: "geometry.json", sha256: artifact.sha256, bytes: artifact.bytes });

      const named = geometryVerdictIsNamed(policy);
      const blocks = geometryVerdictBlocks(policy.policyVerdict, policy.overflow, tolerances);
      // W1b: объявленная поверхность без факта (`not-measured`) — это **отсутствие вердикта**, а не
      // `pass`. С безусловными замерами такое состояние осталось честно недостижимым для
      // измеримых случаев и означает ровно две вещи: корня как бокса нет (Fragment) либо габариты
      // эталона не прочитаны. Молчаливый `pass` здесь означал бы «ожидание объявлено и не
      // проверено» — ровно та тихая подстановка, ради устранения которой заводились поверхности.
      const unmeasuredSurfaces = Object.entries(policy.surfaces ?? {})
        .filter(([, verdict]) => verdict.verdict === "not-measured").map(([name]) => name);
      // Инвариант: провал обязан назвать виновника. Иначе — `indeterminate` (D10 всё равно не даст
      // такому случаю `pass`, но вердикт не будет ложно обвинять компонент).
      // BR-05: злоупотребление декларацией — **названный** провал, и он сильнее любого вердикта
      // краски: декларация, выкидывающая из union in-flow контейнер, делает сам замер неверным.
      const status = ownershipCodes.length > 0 ? "fail"
        : policy.policyVerdict === "indeterminate" ? "indeterminate"
        : blocks ? (named ? "fail" : "indeterminate")
        : unmeasuredSurfaces.length > 0 ? "indeterminate"
        : "pass";
      const detailMessage = status === "pass" ? undefined
        : ownershipCodes.length > 0 ? ownershipCodes.map((code) => code.detail).join("; ")
        : named || policy.reasons.length > 0
          ? policy.reasons.join("; ")
          : `paint overflow (${policy.policyVerdict}) without an attributable descendant effect`;

      return {
        gate: "geometry",
        status,
        artifacts,
        metrics: {
          semantics: "v2-paint",
          policyVerdict: policy.policyVerdict,
          // R3: тот же вердикт типизированным кодом — `surface_overflow` (плюс коды readiness
          // кадра, если поверхность их принесла: paint-джоба несёт доказательство).
          codes: [
            ...geometryCodes(policy.policyVerdict, policy.overflow, tolerances, policy.reasons, policy.divergingSurfaces ?? []),
            ...paintClippedCodes(policy),
            ...ownershipCodes,
            ...referenceExportCodes(referenceExport, ctx),
            ...(capture.readiness?.readinessCodes ?? []),
          ],
          layoutBounds: record.layoutBounds,
          rootBounds: record.rootBounds,
          rootClip: record.rootClip,
          referenceExportDims: record.referenceExportDims,
          referenceExportDimsSource: record.referenceExportDimsSource,
          paintBounds: record.paintBounds,
          paintBoundsSource: record.paintBoundsSource,
          paintClamped: record.paintClamped,
          paintMargin: record.paintMargin,
          // BR-02: поле кадра и названный ink clamp — условные ключи; доволновой кадр их не несёт.
          ...(capture.paintPadding === undefined ? {} : { paintPadding: capture.paintPadding }),
          ...(policy.paintClipped === undefined ? {} : { paintClipped: policy.paintClipped }),
          // BR-05: те же условные ключи — вход пересчёта вердикта без пересъёмки.
          ...(decorationSources.length === 0 ? {} : { decorationSources }),
          ...(policy.paintOwnership === undefined ? {} : { paintOwnership: policy.paintOwnership }),
          ...(ownershipViolations.length === 0 ? {} : { geometryOwnershipViolations: ownershipViolations }),
          deviceScaleFactor: ctx.surface.dsf,
          overflow: policy.overflow,
          expectedGeometryDelta: policy.expectedGeometryDelta,
          clippedBy: policy.clippedBy,
          ...surfaceFacts(policy),
          // W5b: атрибуция причин работает по коробкам источников эффектов, а не только по
          // сводке overflow — поэтому сами `effectSources` едут в метрики, а не только в артефакт.
          effectSources: record.effectSources,
          allowPaintOverflow: tolerances.allowPaintOverflow ?? false,
          expectedClip: tolerances.expectedClip ?? false,
          // W3: объявленные per-case числа едут в метрики рядом с намерениями — иначе по
          // сохранённому рану нельзя сказать, почему overflow не заблокировал вердикт.
          overflowBudgetPx: tolerances.overflowBudgetPx ?? null,
          sizeTolerancePx: tolerances.sizeTolerancePx ?? null,
          retries: capture.retries,
        },
        ...(capture.quality.runtimeWarnings.length + capture.quality.infraWarnings.length > 0
          ? { warnings: [...capture.quality.runtimeWarnings, ...capture.quality.infraWarnings] }
          : {}),
        ...(detailMessage === undefined ? {} : { detail: detailMessage }),
      };
    },
  };
}

export const geometry2Gate: Gate = createGeometry2Gate();
