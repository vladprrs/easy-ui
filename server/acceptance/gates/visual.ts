/**
 * Гейт `visual` — минимальный per-case визуальный вердикт (план 2026-08-03 §2 A5, §5 W5a).
 *
 * Что он **не** делает (вне объёма A5): lifecycle эталонов, promotion baseline'ов, автоприёмка,
 * миграция подсистемы `visual_references`/`visual_runs`. Эталон здесь приходит из case-set'а
 * (`referenceAssetId` случая) и привязан к манифесту, а не к опубликованной версии — ровно
 * поэтому блокер RFC про fingerprint-модель references этой волной не задевается.
 *
 * Что он делает:
 *
 * 1. **Берёт тот самый кадр, который уже измерила геометрия** — `paint.png` случая (прозрачная
 *    поверхность + маргин-поле). Второй съёмки нет: `layoutBounds`, `paintBounds` и пиксельный
 *    вердикт обязаны относиться к одной сессии (R1-M3), а лишний капчур — это лишние 4–8 с на
 *    случай в матрице на 49 состояний.
 * 2. **Нормализует размеры** (обязательная часть A5): crop эталона по `cropLineage.rect`, pad обеих
 *    картинок до общего холста. Несводимое расхождение — `indeterminate` с названной причиной, а
 *    не `fail`: «эталон снят в другом масштабе» — не дефект компонента (триаж R1-M4).
 * 3. **Считает метрики в подпроцессе** (канон `spawnDiffWorker`): `rawDiffPct`/`aaDiffPct`,
 *    `maxChannelDelta`, связные области diff-маски (≤12) и `bestOffset`. Подпроцесс запускается
 *    **после** завершения capture-джобы, поэтому системный слот тяжёлой работы по-прежнему один
 *    (§4.6) — тот же порядок, что у ink-bbox в гейте `geometry`.
 *
 * Обязательность (D10): `required` — только когда визуальная приёмка объявлена (`requireVisual`
 * профиля `pixel-strict-v1` или case-set-манифеста). Иначе гейт считается, кладёт метрики в
 * evidence, но ран не роняет. Случай без эталона: `skipped` у необязательного гейта и
 * `indeterminate` у обязательного — D10 разрешает `skipped` только необязательным.
 *
 * Инвариант D5 держит раннер: кадр, не прошедший readiness, до этого гейта не доходит вовсе.
 */
import { AssetRepo } from "../../repos/assets";
import {
  spawnNormalizedDiffWorker,
  type NormalizedDiffMetrics, type NormalizedDiffResult, type RunNormalizedDiff,
} from "../../visual/diff-runner";
import type { ReferenceSurface, TextAaBudget } from "../../../src/acceptance/caseSetSchema";
import { comparisonSurfaceOf, expectedSurfacesOf, type GeometrySurface } from "../../../src/acceptance/surfaces";
import { CAUSE_THRESHOLDS } from "../../visual/causes";
import { cropIsApplied } from "../caseSets";
import { putArtifact, readArtifact } from "../evidence";
import { VIEWPORT_SURFACE_PAINT_MARGIN_PX } from "../../screenshot/service";
import { captureV4Enabled, COMPARISON_POLICY_VERSION } from "../../capture/captureV4";
import { COMPARISON_PAINT_MARGIN_PX } from "../ids";
import { rendererReport } from "../../capture/renderer";
import {
  buildClusters, comparisonOwnershipEnabled, elementMapToCanvas, visualAttributionV2Enabled,
  type AttributionCluster, type CaseElementMap, type ClusterInputs,
} from "../../visual/attribution";
import { applyRendererProfiles, type RendererProfileDecision } from "../rendererProfiles";
import { elementMapKey, geometryFactsKey, paintShaKey, type GeometryFacts } from "./geometry2";
import { renderReadinessKey } from "./render";
import type { Gate, GateContext, GateResult } from "./types";

/** Порог случая: per-case допуск манифеста (W2) перекрывает профильный (RFC §3.4). */
export function maxRawDiffPctOf(ctx: GateContext): number {
  const perCase = ctx.case.casePolicy?.maxRawDiffPct;
  return typeof perCase === "number" ? perCase : ctx.policy.visual.maxRawDiffPct;
}

/**
 * **Пресеты бюджета растрового текста** (план 2026-08-06 §1.2, §W4 T4b; строка 5 фидбэка).
 *
 * Числа принадлежат **серверу**, а манифест объявляет только имя: эталон приёмки — Figma-PNG, у
 * него нет renderer fingerprint, поэтому «одинаковый шрифтовой стек» на паре «макет ↔ живой
 * капчур» недостижим в принципе, и вместо свободной ручки продукт получает документированный
 * профиль с фиксированной семантикой. Тюнинг = **новый** пресет (`live-text-v2`), потому что
 * иначе одно и то же имя означало бы в разное время разное.
 *
 * `minEdgeResidualPct` — **та же самая** константа, что у классификатора `text-raster-residual`
 * (`CAUSE_THRESHOLDS.edgeResidualInsidePct`), а не её копия (§W4-3): порог «остаток лежит на
 * контурах эталона» ровно один, и разъехавшись, вердикт и объяснение вердикта противоречили бы
 * друг другу. Синхронность закреплена тестом.
 */
export interface TextAaPreset {
  id: TextAaBudget;
  /** Потолок сырого расхождения, выше которого пресет не спасает: это уже не растровый шум. */
  maxRawDiffPct: number;
  /** Доля остатка внутри edge-маски эталона, с которой остаток признаётся растровым. */
  minEdgeResidualPct: number;
}

export const TEXT_AA_PRESETS: Record<TextAaBudget, TextAaPreset> = {
  "live-text-v1": {
    id: "live-text-v1",
    maxRawDiffPct: 0.75,
    minEdgeResidualPct: CAUSE_THRESHOLDS.edgeResidualInsidePct,
  },
};

export const textAaPresetOf = (budget: TextAaBudget | undefined): TextAaPreset | null =>
  budget === undefined ? null : TEXT_AA_PRESETS[budget] ?? null;

/**
 * Спасает ли пресет случай, провалившийся по `rawDiffPct`.
 *
 * Два условия и оба обязательны: расхождение **мало** (иначе это не сглаживание живого текста, а
 * другая вёрстка) и оно **лежит на контурах эталона** (иначе это перекрашенный блок, который
 * случайно уложился в 0,75 %). Без `edgeResidual` пресет не применяется вовсе: «не измерено» —
 * это не «в допуске».
 */
export function textAaBudgetApplies(
  preset: TextAaPreset,
  metrics: { rawDiffPct: number; edgeResidual?: { insidePct: number | null } },
): boolean {
  if (metrics.rawDiffPct > preset.maxRawDiffPct) return false;
  const insidePct = metrics.edgeResidual?.insidePct;
  return typeof insidePct === "number" && insidePct >= preset.minEdgeResidualPct;
}

/** Обязателен ли визуальный вердикт в этом ране (профиль либо `requireVisual` набора). */
export const visualIsRequired = (ctx: GateContext): boolean => ctx.policy.gates.visual === "required";

/**
 * Класс severity визуального провала (D10): `aa`, когда AA-терпимая метрика укладывается в тот же
 * бюджет (расхождение объясняется сглаживанием), иначе `raw` — структурное расхождение пикселей.
 * `raw` тяжелее `aa` по рангу, поэтому сортировка репорта показывает настоящие дефекты первыми.
 */
export function visualSeverityClass(metrics: { rawDiffPct: number; aaDiffPct: number }, maxRawDiffPct: number): "raw" | "aa" {
  return metrics.aaDiffPct <= maxRawDiffPct ? "aa" : "raw";
}

/** Байты эталона из asset-store. Эталон **не** копируется в CAS: в манифест кейса едет его id. */
async function referenceBytes(ctx: GateContext, assetId: string): Promise<{ bytes: Uint8Array; sha256: string } | null> {
  const repo = new AssetRepo(ctx.db, ctx.dataDir);
  const row = repo.get(assetId);
  if (!row) return null;
  try {
    const file = Bun.file(repo.bytesPath(row.sha256));
    return { bytes: new Uint8Array(await file.arrayBuffer()), sha256: row.sha256 };
  } catch { return null; }
}

/**
 * Вырезка, которую **надо применить** к байтам ассета.
 *
 * До W5 crop применялся всегда, когда объявлен `cropLineage` — и это порождало ловушку фидбэка
 * P1: агент, уже вырезавший эталон вручную, сохранял rect как provenance, а сервер резал второй
 * раз (`136×32 → 116×12`). Теперь решает `sourceSurface`: «ассет = экспорт узла» (или legacy-
 * отсутствие поля) ⇒ режем, «ассет уже content-hug/paint» ⇒ rect остаётся историей.
 */
const cropRectOf = (ctx: GateContext): number[] | null => {
  const lineage = ctx.case.cropLineage;
  if (!cropIsApplied(lineage)) return null;
  const rect = lineage?.rect;
  return Array.isArray(rect) && rect.length === 4 ? [...rect] : null;
};

/** Поверхность эталона: дефолт применяет **потребитель**, а не схема (C6/C25). */
export const referenceSurfaceOf = (ctx: GateContext): ReferenceSurface => ctx.case.referenceSurface ?? "paint";

/**
 * Цвет matte случая или `null` (§W4 T4a). Дефолт — «не матировать»: и отсутствие
 * `comparison.matte`, и явное `"none"` дают один и тот же путь, ровно доволновой.
 */
export const matteOf = (ctx: GateContext): string | null => {
  const matte = ctx.case.comparison?.matte;
  return matte === undefined || matte === "none" ? null : matte;
};

export interface ReferenceCanvas {
  padTo: { width: number; height: number };
  placement: { x: number; y: number };
  marginPx: number;
  deviceScaleFactor: number;
  layoutRoot: { width: number; height: number };
  /**
   * Откуда взят корень канвы. `surface:<name>` — волна 2026-08-07: случай **назвал** поверхность
   * сравнения явно, и метрика обязана это показывать; прежние три значения остаются у доволновых
   * случаев байт-в-байт (их ветка кода не тронута вовсе).
   */
  layoutRootSource: "expectedGeometry" | "layoutBounds" | "viewport" | `surface:${GeometrySurface}`;
}

/**
 * Канва по **явно названной** поверхности сравнения (план 2026-08-07 §1.1).
 *
 * Ветка включается только при объявленном `comparisonSurface`: дефолт (`layoutUnion`) — это ровно
 * сегодняшнее поведение, и подменять его нормализованным путём значило бы рискнуть байтами канвы
 * всего накопленного корпуса ради тождественного результата. Габариты поверхности объявлены по
 * построению (`422 case_comparison_surface_undeclared` на PUT), поэтому догадок здесь нет;
 * выравнивание — существующий `referencePlacement` с тем же дефолтом `margin × dsf`.
 */
function declaredSurfaceCanvasOf(ctx: GateContext, facts: GeometryFacts | undefined, dsf: number): ReferenceCanvas | null {
  const surface = comparisonSurfaceOf(ctx.case);
  const dims = expectedSurfacesOf(ctx.case)[surface] ?? null;
  if (!dims) return null;
  const marginPx = facts?.paintMargin
    ?? (ctx.surface.mode === "viewport" ? VIEWPORT_SURFACE_PAINT_MARGIN_PX : COMPARISON_PAINT_MARGIN_PX);
  return {
    padTo: {
      width: Math.round((dims.width + 2 * marginPx) * dsf),
      height: Math.round((dims.height + 2 * marginPx) * dsf),
    },
    placement: ctx.case.referencePlacement ?? { x: Math.round(marginPx * dsf), y: Math.round(marginPx * dsf) },
    marginPx,
    deviceScaleFactor: dsf,
    layoutRoot: { width: dims.width, height: dims.height },
    layoutRootSource: `surface:${surface}`,
  };
}

/**
 * Нужна ли этому случаю каноническая канва (§W5 T5c.5). Две причины, а не одна: content-hug эталон
 * (эталон — бокс контента, кадр — padded поверхность) **и** viewport-поверхность (кадр — вьюпорт с
 * полем, и даже paint-эталон вьюпорта ложится в него не в нулевой офсет).
 */
export const needsReferenceCanvas = (ctx: GateContext): boolean =>
  referenceSurfaceOf(ctx) === "content-hug" || ctx.surface.mode === "viewport"
  // Волна 2026-08-07: явно названная поверхность сравнения — это и есть просьба построить канву в
  // её координатах. Умолчание (поля нет) ничего не включает, поэтому доволновые случаи идут прежней
  // веткой; сама декларация двигает `comparisonFingerprint`, то есть оплачена re-diff'ом честно.
  || ctx.case.comparisonSurface !== undefined;

/**
 * Каноническая канва сравнения для content-hug эталона (§W5).
 *
 * `canvas = (layoutRoot + 2 × margin) × dsf`, содержимое в `(margin × dsf, margin × dsf)` — ровно
 * то, что делает paint-съёмка (`CaptureComponent` кладёт `padding: margin` вокруг inline-block'а,
 * а скриншот берётся в device px). Источник корня — `expectedGeometry` случая, иначе измеренный в
 * этом же ране `layoutBounds`; margin — фактический margin съёмки, а не константа, если кадр
 * снимался здесь.
 *
 * `null` — корень неизвестен (re-diff без свежих фактов и без `expectedGeometry`): строить канву
 * наугад значило бы сравнить компонент с пустотой и назвать это вердиктом.
 */
export function referenceCanvasOf(ctx: GateContext): ReferenceCanvas | null {
  const facts = ctx.shared.get(geometryFactsKey(ctx.case.caseId)) as GeometryFacts | undefined;
  const dsf = ctx.surface.dsf;
  // Явно названная поверхность сравнения — своя ветка; всё остальное идёт прежним путём.
  if (ctx.case.comparisonSurface !== undefined) return declaredSurfaceCanvasOf(ctx, facts, dsf);
  if (ctx.surface.mode === "viewport") return viewportReferenceCanvasOf(ctx, facts, dsf);
  const marginPx = facts?.paintMargin ?? COMPARISON_PAINT_MARGIN_PX;
  const expected = ctx.case.expectedGeometry ?? null;
  const layoutRoot = expected ?? facts?.layoutBounds ?? null;
  if (!layoutRoot) return null;
  return {
    padTo: {
      width: Math.round((layoutRoot.width + 2 * marginPx) * dsf),
      height: Math.round((layoutRoot.height + 2 * marginPx) * dsf),
    },
    placement: ctx.case.referencePlacement ?? { x: Math.round(marginPx * dsf), y: Math.round(marginPx * dsf) },
    marginPx,
    deviceScaleFactor: dsf,
    layoutRoot: { width: layoutRoot.width, height: layoutRoot.height },
    layoutRootSource: expected ? "expectedGeometry" : "layoutBounds",
  };
}

/**
 * Канва viewport-поверхности (§W5 T5c.5) — **две ветки по `referenceSurface`**, потому что кадр у
 * них один и тот же (вьюпорт + поле), а эталоны разные:
 *
 * - `"paint"` — эталон экспортирован целым вьюпортом: канва `(viewport + 2×margin) × dsf`, эталон
 *   кладётся в `margin × dsf`, то есть ровно туда, где вьюпорт лежит в кадре;
 * - `"content-hug"` — эталон это бокс контента оверлея: канва та же, но офсет берётся из
 *   **измеренного** `layoutBounds.{x,y}`. Эти координаты уже отсчитаны от внешнего
 *   `#eui-capture-surface` (`boxOf` в `geometry.mjs`), то есть маргин в них уже есть — прибавлять
 *   его второй раз значило бы сдвинуть эталон на поле.
 *
 * `null` — офсета нет: на re-diff без свежих фактов `expectedGeometry` его не заменяет (там только
 * w/h). Это ожидаемо чаще, чем у hug-кейсов, и честнее наугад построенной канвы: случай уходит в
 * `indeterminate reference_canvas_unresolved`, а не в вердикт по сравнению со сдвинутой картинкой.
 */
function viewportReferenceCanvasOf(ctx: GateContext, facts: GeometryFacts | undefined, dsf: number): ReferenceCanvas | null {
  const marginPx = facts?.paintMargin ?? VIEWPORT_SURFACE_PAINT_MARGIN_PX;
  const viewport = ctx.surface.viewport;
  const padTo = {
    width: Math.round((viewport.width + 2 * marginPx) * dsf),
    height: Math.round((viewport.height + 2 * marginPx) * dsf),
  };
  if (referenceSurfaceOf(ctx) === "paint") {
    return {
      padTo,
      placement: ctx.case.referencePlacement ?? { x: Math.round(marginPx * dsf), y: Math.round(marginPx * dsf) },
      marginPx, deviceScaleFactor: dsf,
      layoutRoot: { width: viewport.width, height: viewport.height },
      layoutRootSource: "viewport",
    };
  }
  const measured = facts?.layoutBounds ?? null;
  const placement = ctx.case.referencePlacement
    ?? (measured ? { x: Math.round(measured.x * dsf), y: Math.round(measured.y * dsf) } : null);
  if (!placement) return null;
  const layoutRoot = ctx.case.expectedGeometry ?? measured;
  if (!layoutRoot) return null;
  return {
    padTo, placement, marginPx, deviceScaleFactor: dsf,
    layoutRoot: { width: layoutRoot.width, height: layoutRoot.height },
    layoutRootSource: ctx.case.expectedGeometry ? "expectedGeometry" : "layoutBounds",
  };
}

/**
 * **Окно кандидатского растра** (BR-02, план 2026-08-08 §2).
 *
 * Кадр, снятый полем по сторонам, физически другого размера и с компонентом в другом месте, чем
 * кадр со скалярным полем. Канва сравнения при этом обязана остаться **прежней** — она
 * comparison-owned и от поля краски не зависит (блокер B3 раунда 2), — поэтому к канве приводится
 * кандидат: окно `(layoutRoot − margin) × dsf` вырезает из кадра ровно ту область, которую занял бы
 * доволновой скалярный кадр. Стороны, где поля объявлено **меньше** маргина канвы, дополняются
 * прозрачным (окно уходит в отрицательные координаты) — это те же пиксели, что были бы у скалярного
 * кадра: за краем компонента там пусто по построению paint-поверхности.
 *
 * `null` — окно не нужно (поле скалярное) либо не выводимо (кадр без измеренного `layoutBounds`):
 * выдуманное окно сдвинуло бы сравнение молча, а это ровно тот класс дефектов, который волна убирает.
 */
export function candidateWindowOf(
  ctx: GateContext, facts: GeometryFacts | undefined, canvas: ReferenceCanvas | null,
): { x: number; y: number; width: number; height: number } | null {
  const padding = facts?.paintPadding ?? null;
  if (!padding) return null;
  const layout = facts?.layoutBounds ?? null;
  if (!layout) return null;
  const dsf = ctx.surface.dsf;
  const marginPx = canvas?.marginPx
    ?? (ctx.surface.mode === "viewport" ? VIEWPORT_SURFACE_PAINT_MARGIN_PX : COMPARISON_PAINT_MARGIN_PX);
  const size = canvas?.padTo ?? {
    width: Math.round((layout.width + 2 * marginPx) * dsf),
    height: Math.round((layout.height + 2 * marginPx) * dsf),
  };
  return {
    x: Math.round((layout.x - marginPx) * dsf),
    y: Math.round((layout.y - marginPx) * dsf),
    width: size.width,
    height: size.height,
  };
}

/**
 * **Ожидаемые габариты content-hug эталона** в его собственных пикселях (BR-04, план §4, правка 4).
 *
 * Эталон сервером не масштабируется вовсе: 1×-экспорт при `dsf: 2` кладётся в канву как есть и
 * занимает вчетверо меньшую площадь, чем компонент, — а поскольку остальная канва у обоих
 * прозрачна, расхождение весит доли процента и **проходит** даже `pixel-strict-v1` (V0-D2). Проверка
 * сравнивает объявленное `layoutRoot × dsf` с фактическими габаритами ассета и называет расхождение.
 *
 * `null` — проверять нечего: эталон не content-hug (paint-ассет **уже** канва, его габариты про
 * другое) либо к нему применяется crop (тогда габариты файла не описывают содержимое случая).
 */
export function expectedReferenceSourceDims(
  ctx: GateContext, canvas: ReferenceCanvas | null, cropApplied: boolean,
): { width: number; height: number } | null {
  if (canvas === null || cropApplied) return null;
  if (referenceSurfaceOf(ctx) !== "content-hug") return null;
  const dsf = ctx.surface.dsf;
  return {
    width: Math.round(canvas.layoutRoot.width * dsf),
    height: Math.round(canvas.layoutRoot.height * dsf),
  };
}

/**
 * **Квитанция сравнения** (BR-07, перечень E1 плана — поля, а не «расширить словами»).
 *
 * Отвечает на вопрос «чем и над чем этот вердикт получен», не заглядывая в образ: что сервер
 * сделал с эталоном (matte и плоскостность после него), в каком цветовом пространстве считались
 * пиксели, каким рендерером и каким шрифтовым стеком снят кадр, по какой версии политики сравнения.
 *
 * `colorProfile: "srgb"` — не украшение и не обещание конверсии: PNG обеих сторон читается как
 * sRGB-байты без управления цветом, и это единственное честное имя тому, что происходит.
 */
export function comparisonReceiptOf(ctx: GateContext, matte: string | null, matteApplied: string | undefined): Record<string, unknown> {
  const renderer = rendererReport();
  return {
    referenceMatte: matte,
    matteApplied: matteApplied ?? null,
    // После матирования альфа обеих картинок ≡ 255 по построению — картинка «плоская».
    referenceFlattened: matteApplied !== undefined,
    colorProfile: "srgb",
    rendererFingerprint: renderer.fingerprint,
    fontStackSha256: renderer.fontStackSha256,
    appFontsSha256: renderer.appFontsSha256,
    comparisonPolicyVersion: captureV4Enabled() ? COMPARISON_POLICY_VERSION : null,
    deviceScaleFactor: ctx.surface.dsf,
  };
}

/** Отпечаток шрифтов образа как одна строка — вход `expiry.fonts` профиля рендерера. */
export const fontFingerprintOf = (): string | null => {
  const renderer = rendererReport();
  return renderer.fontStackSha256 === null && renderer.appFontsSha256 === null
    ? null
    : `${renderer.fontStackSha256 ?? ""}:${renderer.appFontsSha256 ?? ""}`;
};

/**
 * **Два вердикта** одного сравнения (BR-08).
 *
 * `integration` — сегодняшняя семантика: вся канва, весь остаток, тот же бюджет. Он и остаётся
 * вердиктом случая — ни одна строка свёртки (D10) не переезжает на субъектный.
 * `subject` — тот же бюджет, но числитель без пикселей, которыми владеют поддеревья зависимостей.
 * Исключённые пиксели никуда не деваются: они остаются в интеграционном диффе и группируются по
 * компоненту зависимости (`byDependency`), потому что «у обёртки чисто» и «у экрана чисто» — два
 * разных факта, и подменять второй первым было бы ровно тем, чего требует не делать §8.
 */
export interface OwnershipVerdicts {
  subject: { rawDiffPct: number; aaDiffPct: number; failed: boolean };
  integration: { rawDiffPct: number; aaDiffPct: number; failed: boolean };
  byDependency: { markerKey: string; componentId: string | null; pixels: number }[];
  subjectComponentId: string;
}

export function ownershipVerdictsOf(input: {
  ownership: NonNullable<NormalizedDiffMetrics["attribution"]>["ownership"];
  denominator: number;
  judgedRawDiffPct: number;
  aaDiffPct: number;
  maxRawDiffPct: number;
  subjectComponentId: string;
}): OwnershipVerdicts | null {
  const ownership = input.ownership;
  if (ownership === undefined || input.denominator <= 0) return null;
  const round4 = (value: number): number => Math.round((value + Number.EPSILON) * 10_000) / 10_000;
  const subjectRaw = round4((ownership.subjectRawDiffPixels / input.denominator) * 100);
  const subjectAa = round4((ownership.subjectAaDiffPixels / input.denominator) * 100);
  return {
    subject: { rawDiffPct: subjectRaw, aaDiffPct: subjectAa, failed: subjectRaw > input.maxRawDiffPct },
    integration: {
      rawDiffPct: input.judgedRawDiffPct, aaDiffPct: input.aaDiffPct,
      failed: input.judgedRawDiffPct > input.maxRawDiffPct,
    },
    byDependency: [...ownership.byDependency],
    subjectComponentId: input.subjectComponentId,
  };
}

export function createVisualGate(fallbackRunDiff: RunNormalizedDiff = spawnNormalizedDiffWorker): Gate {
  return {
    name: "visual",
    async run(ctx: GateContext): Promise<GateResult> {
      const required = visualIsRequired(ctx);
      const maxRawDiffPct = maxRawDiffPctOf(ctx);
      const base = { gate: "visual" as const, metrics: { required, maxRawDiffPct } };

      const assetId = ctx.case.referenceAssetId ?? null;
      if (assetId === null) {
        return required
          ? {
            ...base, status: "indeterminate",
            detail: "Case has no referenceAssetId while the run requires a visual verdict; add one to the case-set manifest",
            metrics: { ...base.metrics, reason: "no_reference" },
          }
          : { ...base, status: "skipped", detail: "Case declares no reference asset", metrics: { ...base.metrics, reason: "no_reference" } };
      }

      // Кандидат — кадр, снятый гейтом `geometry` в этом же случае (мемо рана). Своей съёмки у
      // визуала нет: два кадра одной поверхности разошлись бы между собой раньше, чем с эталоном.
      const paintSha = ctx.shared.get(paintShaKey(ctx.case.caseId));
      const candidate = typeof paintSha === "string" ? await readArtifact(ctx.dataDir, paintSha) : null;
      if (!candidate) {
        return {
          ...base, status: "indeterminate",
          detail: "No paint frame was produced for this case, so there is nothing to compare against the reference",
          metrics: { ...base.metrics, reason: "no_candidate_frame", referenceAssetId: assetId },
        };
      }

      const reference = await referenceBytes(ctx, assetId);
      if (!reference) {
        return {
          ...base, status: "indeterminate",
          detail: `Reference asset ${assetId} is registered but its bytes are unreadable`,
          metrics: { ...base.metrics, reason: "reference_unreadable", referenceAssetId: assetId },
        };
      }

      const cropRect = cropRectOf(ctx);
      const surface = referenceSurfaceOf(ctx);
      // Канва строится **только** для content-hug эталона: paint-манифест (в том числе всякий
      // манифест без нового поля) сравнивается ровно как до W5 — инвариант неизменности D13.
      const canvas = needsReferenceCanvas(ctx) ? referenceCanvasOf(ctx) : null;
      if (needsReferenceCanvas(ctx) && canvas === null) {
        return {
          ...base, status: "indeterminate",
          detail: ctx.surface.mode === "viewport"
            ? "Case is captured on a viewport surface with a content-hug reference, but no measured layoutBounds offset is"
              + " available in this run (a re-diff carries no fresh geometry facts), so the canonical comparison canvas"
              + " cannot be placed; re-run the case with a capture (--recapture) or declare referencePlacement"
            : "Case declares a content-hug reference but neither expectedGeometry nor a measured layoutBounds is"
              + " available, so the canonical comparison canvas cannot be derived; declare expectedGeometry on the case",
          metrics: { ...base.metrics, reason: "reference_canvas_unresolved", referenceAssetId: assetId, referenceSurface: surface },
        };
      }
      const lineage = {
        referenceSurface: surface,
        sourceSurface: ctx.case.cropLineage?.sourceSurface ?? (ctx.case.cropLineage ? "figma-node" : null),
        cropApplied: cropRect !== null,
        cropRect,
        padTo: canvas?.padTo ?? null,
        placement: canvas?.placement ?? null,
        marginPx: canvas?.marginPx ?? null,
        deviceScaleFactor: ctx.surface.dsf,
        layoutRoot: canvas?.layoutRoot ?? null,
        layoutRootSource: canvas?.layoutRootSource ?? null,
      };

      const runDiff = ctx.runDiff ?? fallbackRunDiff;
      const matte = matteOf(ctx);
      // BR-02/BR-04: три опции волны — и все три условные. При выключенной группе
      // (`EASYUI_CAPTURE_V4_DISABLED=1`) задание воркеру байт-в-байт доволновое, поэтому и метрики,
      // и артефакты, и вердикт остаются прежними.
      const captureWaveOn = captureV4Enabled();
      const facts = ctx.shared.get(geometryFactsKey(ctx.case.caseId)) as GeometryFacts | undefined;
      const candidateWindow = captureWaveOn ? candidateWindowOf(ctx, facts, canvas) : null;
      // Поверхность сравнения в device px: знаменатель `rawDiffPctOfSurface`. Считается всюду, где
      // канва объявлена, — то есть всюду, где корень сравнения известен числом, а не догадкой.
      const surfaceDims = captureWaveOn && canvas !== null
        ? { width: Math.round(canvas.layoutRoot.width * ctx.surface.dsf), height: Math.round(canvas.layoutRoot.height * ctx.surface.dsf) }
        : null;
      /**
       * BR-07/BR-08: карта элементов кандидата в координатах канвы. Карту кладёт гейт `geometry`
       * этой же съёмкой (`elementMapKey`); её отсутствие — не отказ, а честное «атрибуции нет»:
       * re-diff сохранённого кадра свежих фактов не несёт, и выдумывать их нельзя.
       */
      const elementMap = ctx.shared.get(elementMapKey(ctx.case.caseId)) as CaseElementMap | undefined;
      const attributionOn = visualAttributionV2Enabled() && elementMap !== undefined && elementMap.nodes.length > 0;
      const ownershipOn = attributionOn && comparisonOwnershipEnabled()
        && ctx.case.comparison?.ownership === "subject-and-integration";
      const attributionNodes = attributionOn
        ? elementMapToCanvas(elementMap!, { deviceScaleFactor: ctx.surface.dsf, candidateWindow })
        : [];
      const diff: NormalizedDiffResult = await runDiff({
        mode: "normalize",
        referencePngBase64: Buffer.from(reference.bytes).toString("base64"),
        candidatePngBase64: Buffer.from(candidate).toString("base64"),
        options: {
          maxDimensionDeltaPx: ctx.policy.visual.maxDimensionDeltaPx,
          // Edge-сигнал приёмке нужен **всегда**, а не под env-флагом визуальных ранов (§W4 T4b):
          // на нём стоят и пресет `live-text-v1`, и классификатор `text-raster-residual`, и
          // «сигнала нет» означало бы «пресет молча не сработал».
          edge: true,
          ...(cropRect === null ? {} : { cropRect }),
          ...(canvas === null ? {} : { padReferenceTo: canvas.padTo, referencePlacement: canvas.placement }),
          ...(candidateWindow === null ? {} : { candidateWindow }),
          // BR-04: объявленная канва не допускает дельты размеров вовсе (см. `exactCanvas`).
          ...(captureWaveOn && canvas !== null ? { exactCanvas: true } : {}),
          ...(surfaceDims === null ? {} : { surfaceDims }),
          ...(matte === null ? {} : { matte }),
          // BR-07: карта уезжает в воркер уже переведённой в координаты канвы (`elementMapToCanvas`
          // — единственная точка перевода). Ключ условный: без карты задание доволновое.
          ...(attributionNodes.length === 0 ? {} : {
            attribution: {
              nodes: attributionNodes,
              truncated: elementMap!.truncated,
              ...(ownershipOn ? { ownership: true } : {}),
            },
          }),
        },
      });

      if (diff.ok === false) {
        // Воркер не выдал результат — это не приговор компоненту, а отсутствие измерения.
        return {
          ...base, status: "indeterminate",
          detail: `Visual diff worker failed: ${diff.error}`,
          metrics: { ...base.metrics, reason: "diff_worker_error", referenceAssetId: assetId },
        };
      }

      /**
       * BR-04, правка 4: масштаб эталона проверяется **до** любого вердикта. Раньше 1×-экспорт при
       * `dsf: 2` не просто проходил — он проходил `pixel-strict-v1`, потому что вчетверо меньшая
       * картинка в прозрачной канве весит доли процента. Это `indeterminate` с числами, а не `fail`:
       * «эталон снят в другом масштабе» — дефект материала, а не компонента (тот же принцип, что у
       * `dimensions_irreconcilable`).
       */
      const expectedSourceDims = captureWaveOn ? expectedReferenceSourceDims(ctx, canvas, cropRect !== null) : null;
      if (expectedSourceDims !== null
        && (diff.sourceDims.width !== expectedSourceDims.width || diff.sourceDims.height !== expectedSourceDims.height)) {
        return {
          ...base, status: "indeterminate",
          detail: `Reference asset is ${diff.sourceDims.width}×${diff.sourceDims.height} device px, but a content-hug`
            + ` reference for a ${canvas!.layoutRoot.width}×${canvas!.layoutRoot.height} CSS px root at deviceScaleFactor`
            + ` ${ctx.surface.dsf} must be ${expectedSourceDims.width}×${expectedSourceDims.height}: re-export the reference at`
            + ` ${ctx.surface.dsf}x (the server never rescales a reference)`,
          metrics: {
            ...base.metrics, reason: "reference_scale_mismatch", referenceAssetId: assetId,
            referenceSurface: surface, sourceDims: diff.sourceDims, expectedSourceDims,
            layoutRoot: canvas!.layoutRoot, deviceScaleFactor: ctx.surface.dsf,
          },
        };
      }

      const common = {
        referenceAssetId: assetId,
        referenceSha256: reference.sha256,
        candidateSha256: paintSha as string,
        cropApplied: diff.cropApplied,
        ...(cropRect === null ? {} : { cropRect }),
        sourceDims: diff.sourceDims,
        refDims: diff.refDims,
        candDims: diff.candDims,
        /**
         * Что и как сервер сделал с эталоном, прежде чем сравнивать (§W5). Кладётся всегда, в том
         * числе для paint-манифестов: «ничего не паддили, ничего не резали» — тоже факт, и его
         * отсутствие раньше и делало нормализацию невидимой для автора.
         */
        referenceNormalization: {
          // Сначала факты воркера (что он получил и во что превратил), поверх — намерение сервера.
          // Значения совпадают по построению; расхождение читалось бы как «сравнили не то».
          ...(diff.referenceNormalization ?? {}),
          ...lineage,
          sourceDims: diff.sourceDims,
          refDims: diff.refDims,
        },
        // BR-02: как кадр приводился к канве сравнения. Ключ условный — кадр со скалярным полем
        // ничего к канве не приводит, и его метрики остаются доволновыми байт-в-байт.
        ...(diff.candidateNormalization === undefined ? {} : { candidateNormalization: diff.candidateNormalization }),
      };

      if (diff.indeterminate) {
        // Несводимые размеры: метрик нет вовсе (выдуманный процент хуже отсутствующего), но
        // диагностика названа — её и читает автор («увеличить маргин», «эталон в другом масштабе»).
        const record = await putArtifact(ctx.dataDir, {
          semantics: "visual-v1", verdict: "indeterminate", reason: diff.reason, ...common,
          ...(diff.dimensionDelta ? { dimensionDelta: diff.dimensionDelta } : {}),
        });
        return {
          ...base, status: "indeterminate",
          detail: `Reference and candidate could not be reconciled: ${diff.reason}`,
          artifacts: [{ name: "visual.json", sha256: record.sha256, bytes: record.bytes }],
          metrics: { ...base.metrics, reason: "dimensions_irreconcilable", ...common, ...(diff.dimensionDelta ? { dimensionDelta: diff.dimensionDelta } : {}) },
        };
      }

      const metrics: NormalizedDiffMetrics = diff.metrics;
      /**
       * BR-04, правка 3: бюджет судится по **поверхности сравнения**, а не по канве с полем. У 16 px
       * корня при поле 64 весь компонент занимает 1.23 % канвы, поэтому бюджет 2 % профиля
       * `default-v1` был для него недостижим сверху: гейт физически не мог выдать `fail`. Обе
       * величины при этом едут в метрики — читатель отчёта видит и то, чем судили, и то, чем судили
       * раньше. При выключенной группе `rawDiffPctOfSurface` не считается вовсе (legacy).
       */
      const judgedRawDiffPct = metrics.rawDiffPctOfSurface ?? metrics.rawDiffPct;
      const overBudget = judgedRawDiffPct > maxRawDiffPct;
      /**
       * Пресет — **вторая инстанция** вердикта, а не второй порог (§W4 T4b): он рассматривается
       * только у случая, уже провалившегося по бюджету, и только сдвигает `fail → pass`, когда
       * доказано, что весь остаток лежит на контурах эталона. Факт применения живёт в метриках
       * гейта; в `causes` он не едет — их контракт («только fail/indeterminate») не трогается.
       */
      const preset = textAaPresetOf(ctx.case.textAaBudget);
      const presetApplied = overBudget && preset !== null
        && textAaBudgetApplies(preset, { ...metrics, rawDiffPct: judgedRawDiffPct });

      /**
       * BR-07: кластеры §10 фидбэка. Считаются **всегда**, когда есть атрибуция, — они диагностика,
       * а не вердикт: читатель отчёта обязан видеть владельца и класс краски и у прошедшего случая.
       */
      const attribution = metrics.attribution ?? null;
      const denominator = metrics.surfacePixels ?? metrics.totalPixels;
      const barrier = (ctx.shared.get(renderReadinessKey(ctx.case.caseId)) as
        { evidence?: { resourceBarrier?: { resources?: ClusterInputs["resources"] } } } | undefined)
        ?.evidence?.resourceBarrier;
      // Сдвиг целиком — тот же критерий, что у классификатора `geometry-shift` (одна причина —
      // один детектор): остаток после лучшего смещения кратно меньше исходного расхождения.
      const shifted = (metrics.bestOffset.dx !== 0 || metrics.bestOffset.dy !== 0)
        && metrics.rawDiffPct > 0 && metrics.bestOffset.residualPct <= metrics.rawDiffPct * 0.35;
      const clusters: AttributionCluster[] = attribution === null ? [] : buildClusters({
        regions: metrics.regions,
        attribution: attribution.regions,
        bestOffset: { dx: metrics.bestOffset.dx, dy: metrics.bestOffset.dy, residualPct: metrics.bestOffset.residualPct },
        totalPixels: metrics.totalPixels,
        surfacePixels: metrics.surfacePixels ?? null,
        ...(barrier?.resources === undefined ? {} : { resources: barrier.resources }),
        geometry: { shifted },
        channelStats: metrics.channelStats ?? null,
      });

      /**
       * BR-07, вторая инстанция: профили политики рендерера. Рассматриваются **после** пресета и
       * только у случая, который иначе провалится, и только когда каждый кластер объяснён.
       * Их результат — `exceptions[]` (первый в продукте продюсер `pass_with_exceptions`).
       */
      /**
       * Профиль рассматривается **только там, где визуальный вердикт судит** (`required`).
       * У advisory-гейта провал ран не роняет вовсе, поэтому «спасать» там нечего — а `exceptions[]`
       * при `allowExceptions: false` ран как раз **роняют** (`foldRunVerdict`), и рескью advisory-
       * случая обернулось бы падением рана, который до волны проходил. Ровно та тихая смена
       * вердикта, которую волна обязана не допустить.
       */
      const profileDecision: RendererProfileDecision | null = required && overBudget && !presetApplied && attribution !== null
        ? applyRendererProfiles({
          clusters,
          unknownPixels: attribution.unknownPixels,
          judgedRawDiffPct,
          fingerprints: {
            renderer: rendererReport().fingerprint,
            fonts: fontFingerprintOf(),
            matte: matte ?? "none",
            asset: reference.sha256,
            geometry: String(ctx.surface.dsf),
          },
        })
        : null;
      const profileApplied = profileDecision?.applied === true;
      const failed = overBudget && !presetApplied && !profileApplied;

      // BR-08: два вердикта. Вердиктом случая остаётся интеграционный — субъектный едет фактом.
      const ownershipVerdicts = ownershipOn
        ? ownershipVerdictsOf({
          ownership: attribution?.ownership,
          denominator,
          judgedRawDiffPct,
          aaDiffPct: metrics.aaDiffPct,
          maxRawDiffPct,
          subjectComponentId: elementMap?.subjectComponentId ?? ctx.candidate.componentId,
        })
        : null;
      const attributionMetrics = attribution === null ? {} : {
        attribution: {
          owners: attribution.owners,
          attributedPixels: attribution.attributedPixels,
          unknownPixels: attribution.unknownPixels,
          totalMismatchedPixels: attribution.totalMismatchedPixels,
          coveragePct: attribution.coveragePct,
          truncated: attribution.truncated === true,
        },
        clusters,
        ...(ownershipVerdicts === null ? {} : { ownership: ownershipVerdicts }),
      };
      const profileMetrics = profileDecision === null ? {} : {
        rendererPolicy: {
          applied: profileDecision.applied,
          profileId: profileDecision.profileId,
          reason: profileDecision.reason,
          expiryChecked: profileDecision.expiryChecked,
        },
      };
      const comparisonReceipt = comparisonReceiptOf(ctx, matte, metrics.matteApplied);
      const severityClass = visualSeverityClass(metrics, maxRawDiffPct);
      const presetMetrics = preset === null
        ? {}
        : {
          textAaBudget: {
            preset: preset.id,
            maxRawDiffPct: preset.maxRawDiffPct,
            minEdgeResidualPct: preset.minEdgeResidualPct,
            applied: presetApplied,
          },
        };

      const diffPng = await putArtifact(ctx.dataDir, new Uint8Array(Buffer.from(diff.diffPngBase64, "base64")));
      const normalizedPng = await putArtifact(ctx.dataDir, new Uint8Array(Buffer.from(diff.normalizedCandidatePngBase64, "base64")));
      /**
       * Дериват эталона (§W5, AC фидбэка «evidence сохраняет immutable source reference и
       * server-normalized derivative с lineage»). Сам ассет в CAS по-прежнему **не** копируется —
       * он иммутабелен в реестре и адресуется парой `referenceAssetId`/`referenceSha256`; в CAS
       * едет только то, чего в реестре нет: построенная сервером канва.
       */
      const normalizedReference = diff.normalizedReferencePngBase64 === undefined
        ? null
        : await putArtifact(ctx.dataDir, new Uint8Array(Buffer.from(diff.normalizedReferencePngBase64, "base64")));
      const record = await putArtifact(ctx.dataDir, {
        semantics: "visual-v1",
        verdict: failed ? "fail" : "pass",
        maxRawDiffPct,
        severityClass,
        ...presetMetrics,
        canvas: diff.canvas,
        padded: diff.padded,
        referenceSource: { assetId, sha256: reference.sha256 },
        ...(normalizedReference === null ? {} : { normalizedReferenceSha256: normalizedReference.sha256 }),
        ...common,
        // BR-07: квитанция сравнения (E1) и атрибуция — часть **доказательства** случая, а не
        // украшение отчёта: без них «вердикт получен» неотличимо от «сравнили не тем».
        comparisonReceipt,
        ...attributionMetrics,
        ...profileMetrics,
        metrics: metrics as unknown as Record<string, unknown>,
        diffSha256: diffPng.sha256,
        normalizedCandidateSha256: normalizedPng.sha256,
      });

      return {
        gate: "visual",
        status: failed ? "fail" : "pass",
        artifacts: [
          { name: "diff.png", sha256: diffPng.sha256, bytes: diffPng.bytes },
          { name: "normalized-candidate.png", sha256: normalizedPng.sha256, bytes: normalizedPng.bytes },
          ...(normalizedReference === null
            ? []
            : [{ name: "normalized-reference.png", sha256: normalizedReference.sha256, bytes: normalizedReference.bytes }]),
          { name: "visual.json", sha256: record.sha256, bytes: record.bytes },
        ],
        metrics: {
          ...base.metrics,
          ...common,
          canvas: diff.canvas,
          padded: diff.padded,
          severityClass,
          ...presetMetrics,
          rawDiffPct: metrics.rawDiffPct,
          aaDiffPct: metrics.aaDiffPct,
          // BR-04: процент по поверхности сравнения — условные ключи (их нет при выключенной группе
          // и там, где поверхность не объявлена числом).
          ...(metrics.rawDiffPctOfSurface === undefined ? {} : { rawDiffPctOfSurface: metrics.rawDiffPctOfSurface }),
          ...(metrics.aaDiffPctOfSurface === undefined ? {} : { aaDiffPctOfSurface: metrics.aaDiffPctOfSurface }),
          ...(metrics.surfacePixels === undefined ? {} : { surfacePixels: metrics.surfacePixels }),
          ...(metrics.rawDiffPctOfSurface === undefined ? {} : { judgedRawDiffPct }),
          maxChannelDelta: metrics.maxChannelDelta,
          regions: metrics.regions,
          totalRegions: metrics.totalRegions,
          bestOffset: metrics.bestOffset,
          thresholds: metrics.thresholds,
          rawDiffPixels: metrics.rawDiffPixels,
          aaDiffPixels: metrics.aaDiffPixels,
          totalPixels: metrics.totalPixels,
          // Аддитивные ключи волны W4: остаток по edge-маске (вход пресета и классификатора) и
          // факт матирования (вход обесточивания `alpha-compositing`). Оба — условные: случай без
          // сигнала/без matte несёт ровно доволновой набор метрик.
          ...(metrics.edgeResidual === undefined ? {} : { edgeResidual: metrics.edgeResidual }),
          ...(metrics.matteApplied === undefined ? {} : { matteApplied: metrics.matteApplied }),
          // BR-07/BR-08: атрибуция, кластеры, два вердикта, решение по профилю и квитанция
          // сравнения. Все ключи условные — случай без карты элементов несёт доволновые метрики.
          ...attributionMetrics,
          ...profileMetrics,
          comparisonReceipt,
        },
        // BR-07: `exceptions[]` пишутся **только** при применённом профиле. Пустой список у
        // прошедшего случая — не «нет исключений», а «исключения не понадобились», и класть его
        // значило бы уронить ран под `allowExceptions:false` за отсутствие проблемы.
        ...(profileApplied ? { exceptions: profileDecision!.exceptions } : {}),
        ...(failed
          ? {
            detail: `Visual diff ${judgedRawDiffPct}% exceeds the ${maxRawDiffPct}% budget`
              + ` (aa-tolerant ${metrics.aaDiffPct}%, max channel delta ${metrics.maxChannelDelta},`
              + ` ${metrics.totalRegions} region(s), best offset ${metrics.bestOffset.dx}/${metrics.bestOffset.dy}px`
              + ` with ${metrics.bestOffset.residualPct}% residual)`,
          }
          : presetApplied
            ? {
              detail: `Visual diff ${judgedRawDiffPct}% is over the ${maxRawDiffPct}% budget but within the`
                + ` ${preset!.id} preset (≤${preset!.maxRawDiffPct}% with ${metrics.edgeResidual?.insidePct}% of the`
                + ` residual on the reference's own edges, ≥${preset!.minEdgeResidualPct}% required):`
                + " a live-text rasterisation residual, not a layout or colour change",
            }
            : {}),
      };
    },
  };
}

export const visualGate: Gate = createVisualGate();

/**
 * Вход **re-diff** (план 2026-08-04, D-B): пересравнение уже снятого кадра с новым эталоном.
 *
 * Кадр не снимается: `paintSha` — адрес `paint.png` строки кэша, чей `frameFingerprint` совпал с
 * отпечатком кадра нового случая. Физическое существование артефакта проверяет вызывающий
 * (`artifactPresent`) — отсутствующий кадр означает пересъёмку с причиной
 * `recapture:frame_missing`, а не «сравним с чем-нибудь» (D10/D15).
 *
 * Гейт при этом исполняется **обычным путём**: тот же код, тот же воркер, те же артефакты и
 * метрики. Разница ровно одна — источник кандидатского кадра. Именно поэтому re-diff даёт честный
 * новый `rawDiffPct`, а не пересчитанный старый (анти-репро C0: смена эталона обязана мерить
 * заново, а не арифметически переоценивать прошлое измерение).
 */
export async function rediffCase(ctx: GateContext, paintSha: string, gate: Gate = visualGate): Promise<GateResult> {
  ctx.shared.set(paintShaKey(ctx.case.caseId), paintSha);
  return gate.run(ctx);
}
