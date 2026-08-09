/**
 * **Атрибуция расхождения по элементам** (EUI-BR-07, план
 * `docs/plans/2026-08-08-blocker-removal-eui-br.md` §7) и **владение поверхностью субъекта**
 * (EUI-BR-08, §8).
 *
 * Модуль держит три вещи, которых не должно быть ни в гейте, ни в воркере:
 *
 * 1. **Kill-switch'и волны.** `EASYUI_VISUAL_ATTRIBUTION_V2_DISABLED` гасит карту элементов,
 *    атрибуцию и контракт кластеров (evidence и метрики становятся доволновыми byte-for-byte);
 *    `EASYUI_COMPARISON_OWNERSHIP_DISABLED` — отдельная ось: он гасит второй вердикт
 *    (subject/integration), не трогая атрибуцию. Значения читаются **на каждом вызове** — тот же
 *    канон, что у `captureV4.ts`/`geometryOwnership.ts`: тумблер обязан флипаться без рестарта и
 *    проверяться парными тестами «фича / legacy».
 * 2. **Контракт координат** (ревью m20). Карта элементов живёт в **CSS px поверхности съёмки**, а
 *    кластеры диффа — в **device px канвы сравнения**. Переход между системами делается ровно
 *    здесь и ровно одной формулой (`elementMapToCanvas`), потому что двух источников правды о
 *    том, куда смотрит прямоугольник, быть не может: разъехавшись, атрибуция назвала бы
 *    виновником соседа.
 * 3. **Классификация краски и структурности** кластера — по фактам, а не по «ощущению»: текст
 *    берётся из `hasText` карты, ресурс — из per-resource записей барьера, геометрия — из фактов
 *    геометрии, заливка/обводка/эффект — из `channelStats` и уже названных причин.
 */
import type { GeometryElementMap, GeometryElementMapNode } from "../../src/capture/geometry.mjs";

/** Активна ли атрибуция v2 (карта элементов в evidence, owner-тоталы, контракт кластеров). */
export const visualAttributionV2Enabled = (): boolean => process.env.EASYUI_VISUAL_ATTRIBUTION_V2_DISABLED !== "1";

/** Активен ли второй вердикт по владению (BR-08): subject/integration. Своя ось тумблера. */
export const comparisonOwnershipEnabled = (): boolean => process.env.EASYUI_COMPARISON_OWNERSHIP_DISABLED !== "1";

/**
 * Потолок узлов, уезжающих в воркер (контракт транспорта). Совпадает с потолком карты на маркер
 * (`ELEMENT_MAP_NODE_LIMIT`) намеренно: воркер строит по узлам построчный индекс, и «сколько узлов
 * поместится» обязано быть свойством контракта, а не удачи конкретного кадра.
 */
export const ATTRIBUTION_MAX_NODES = 512;

/** Целевая доля атрибутированных пикселей (§10 фидбэка). Цель отчёта, а не порог вердикта. */
export const ATTRIBUTION_COVERAGE_TARGET_PCT = 95;

/** Владение узлом относительно субъекта случая (BR-08). */
export type NodeOwnership = "subject" | "dependency";

/** Запись карты элементов случая: узел + его владелец в терминах slot-дерева. */
export interface CaseElementNode extends GeometryElementMapNode {
  /** Компонент, которому принадлежит маркер узла (`markerKey` → slot-биндинг), либо `null`. */
  componentId: string | null;
  /** BR-08: субъект случая или его зависимость. Отсутствие карты слотов = всё субъектное. */
  ownership: NodeOwnership;
}

/** Карта элементов случая целиком — она же артефакт `element-map.json`. */
export interface CaseElementMap {
  subjectComponentId: string;
  /** `markerKey → componentId` по slot-дереву случая (`c` — субъект, `s0…sN` — дети слотов). */
  markers: { markerKey: string; componentId: string; slot?: string; index?: number; version?: number }[];
  nodes: CaseElementNode[];
  truncated: boolean;
  total: number;
}

/** Минимум slot-дерева, нужный карте: рекурсивный по построению (`ResolvedSlotBinding`). */
export interface ElementMapSlotBinding {
  slot: string;
  index: number;
  componentId: string;
  version?: number;
  children?: readonly ElementMapSlotBinding[];
}

/**
 * `markerKey → componentId` капчур-поверхности кандидата.
 *
 * Ключи маркеров задаёт **дерево капчура** (`src/capture/CaptureComponent.tsx#captureRuntimeTree`):
 * субъект — `c`, дети слотов — `s0…sN` по индексу в **плоском** `slots.tree`, который сервер
 * собирает pre-order обходом (`server/screenshot/service.ts#slotCaptureOf`: узел, затем его
 * поддерево, затем следующий сиблинг). Здесь тот же обход повторён по `slotBindings` случая —
 * иначе владелец пикселя определялся бы догадкой о порядке.
 */
export function markerComponentMap(
  subjectComponentId: string,
  bindings: readonly ElementMapSlotBinding[] | undefined,
): CaseElementMap["markers"] {
  const markers: CaseElementMap["markers"] = [{ markerKey: "c", componentId: subjectComponentId }];
  let next = 0;
  const walk = (level: readonly ElementMapSlotBinding[]): void => {
    for (const binding of level) {
      markers.push({
        markerKey: `s${next++}`,
        componentId: binding.componentId,
        slot: binding.slot,
        index: binding.index,
        ...(binding.version === undefined ? {} : { version: binding.version }),
      });
      if (binding.children !== undefined && binding.children.length > 0) walk(binding.children);
    }
  };
  walk(bindings ?? []);
  return markers;
}

/**
 * Карта элементов случая из факта замера и slot-дерева.
 *
 * `subjectComponentId` — компонент-субъект (`ctx.candidate.componentId`) либо явно объявленный
 * `comparison.subjectComponentId` (BR-08). Узел, чей маркер принадлежит **другому** компоненту,
 * получает `ownership: "dependency"`; всё прочее — включая узлы вне маркеров (фон родителя, гэпы,
 * маски) — субъектное: маска зависимостей их не покрывает, и списывать их на детей значило бы
 * прощать субъекту его собственную раскладку (§8).
 */
export function caseElementMapOf(input: {
  elementMap: GeometryElementMap | null | undefined;
  subjectComponentId: string;
  markers: CaseElementMap["markers"];
}): CaseElementMap {
  const byMarker = new Map(input.markers.map((marker) => [marker.markerKey, marker.componentId] as const));
  const nodes: CaseElementNode[] = (input.elementMap?.nodes ?? []).map((node) => {
    const componentId = byMarker.get(node.markerKey) ?? null;
    return {
      ...node,
      componentId,
      ownership: componentId !== null && componentId !== input.subjectComponentId ? "dependency" : "subject",
    };
  });
  return {
    subjectComponentId: input.subjectComponentId,
    markers: input.markers,
    nodes,
    truncated: input.elementMap?.truncated ?? false,
    total: input.elementMap?.total ?? nodes.length,
  };
}

/** Узел карты в координатах канвы диффа (device px). */
export interface AttributionNode {
  key: string;
  path: string;
  markerKey: string;
  componentId: string | null;
  depth: number;
  hasText: boolean;
  ownership: NodeOwnership;
  x: number; y: number; width: number; height: number;
}

/**
 * **Контракт координат** (ревью m20), явный в коде, а не в комментарии к отчёту.
 *
 * Карта элементов измерена в CSS px относительно `#eui-capture-surface` — того же нуля, от
 * которого отсчитан `layoutBounds` (`geometry.mjs#boxOf`). Кандидатский кадр — тот же surface,
 * снятый в device px, поэтому:
 *
 * 1. `× deviceScaleFactor` — из CSS px поверхности в device px **кадра**;
 * 2. `− candidateWindow.{x,y}` — из кадра в **канву сравнения**. Окно строит `candidateWindowOf`
 *    (BR-02) в координатах кадра, и `windowPng` кладёт пиксель кадра `(x, y)` в пиксель канвы
 *    `(x − window.x, y − window.y)` — включая отрицательное окно (дополнение прозрачным).
 *
 * Окна нет ⇒ второго шага нет: кандидат кладётся в канву `padPng`-ом по левому-верхнему углу,
 * то есть его координаты и есть координаты канвы. Эталон при этом двигается `referencePlacement`-ом
 * **сам** — карта описывает кандидата, и сдвиг эталона к ней не относится.
 */
export function elementMapToCanvas(
  map: CaseElementMap,
  transform: { deviceScaleFactor: number; candidateWindow: { x: number; y: number } | null },
  limit: number = ATTRIBUTION_MAX_NODES,
): AttributionNode[] {
  const dsf = transform.deviceScaleFactor;
  const offsetX = transform.candidateWindow?.x ?? 0;
  const offsetY = transform.candidateWindow?.y ?? 0;
  const out: AttributionNode[] = [];
  for (const node of map.nodes) {
    if (out.length >= limit) break;
    const x = Math.round(node.bbox.x * dsf) - offsetX;
    const y = Math.round(node.bbox.y * dsf) - offsetY;
    const width = Math.round(node.bbox.width * dsf);
    const height = Math.round(node.bbox.height * dsf);
    if (width <= 0 || height <= 0) continue;
    out.push({
      key: `${node.markerKey}//${node.path}`,
      path: node.path,
      markerKey: node.markerKey,
      componentId: node.componentId,
      depth: node.depth,
      hasText: node.hasText,
      ownership: node.ownership,
      x, y, width, height,
    });
  }
  return out;
}

// --------------------------------------------------------- контракт кластера (§10 фидбэка)

export type PaintClass =
  | "live-text" | "vector-edge" | "registry-image" | "fill" | "stroke" | "effect" | "geometry" | "unknown";

/** Кластер расхождения в форме §10 фидбэка: кто виноват, чем он красит и структурно ли это. */
export interface AttributionCluster {
  boundsDevicePx: { x: number; y: number; width: number; height: number };
  mismatchedPixels: number;
  ownerElementKey: string | null;
  ownerComponentId: string | null;
  paintClass: PaintClass;
  sourceAssetId: string | null;
  rawDiffPct: number;
  aaResidualPct: number | null;
  bestOffset: { dx: number; dy: number; residualPct: number };
  structural: boolean;
  basis: string[];
  confidence: number;
}

/** Пер-регионный факт воркера — вход построения кластера. */
export interface WorkerRegionAttribution {
  index: number;
  ownerElementKey: string | null;
  ownerMarkerKey: string | null;
  ownerPath: string | null;
  ownerDepth: number | null;
  ownerHasText: boolean;
  ownerComponentId: string | null;
  mismatchedPixels: number;
  unknownPixels: number;
  edgeInsidePixels: number;
  edgeOutsidePixels: number;
  alphaDominantPixels: number;
  meanMaxDelta: number;
  /** Максимальная поканальная дельта внутри кластера (факт воркера; классификацией не читается). */
  maxChannelDelta?: number;
}

/** Ресурс из per-resource записей барьера (BR-03) — для класса `registry-image`. */
export interface BarrierResourceRef {
  /** Канал записи барьера (`img`, `img-srcset`, `icon-registry`, `pseudo`, `font`, …). */
  channel?: string;
  ownerElementKey?: string;
  assetId?: string;
  url?: string;
}

export interface ClusterInputs {
  regions: { bbox: { x: number; y: number; width: number; height: number }; areaPct: number; meanDelta: number }[];
  attribution: WorkerRegionAttribution[];
  bestOffset: { dx: number; dy: number; residualPct: number };
  totalPixels: number;
  /** Пиксели поверхности сравнения (знаменатель BR-04); `null` — считаем по канве. */
  surfacePixels: number | null;
  /** Ресурсы барьера кадра (BR-03) — только они дают `registry-image` и `sourceAssetId`. */
  resources?: readonly BarrierResourceRef[];
  /** Факты геометрии: decoration-источники и наблюдённый overflow — вход класса `geometry`. */
  geometry?: { decorationElementKeys?: readonly string[]; shifted?: boolean };
  /** Статистика маски целиком (вход `fill`/`effect`), уже посчитанная воркером. */
  channelStats?: { alphaDominantPct: number; semiTransparentPct: number; stdMaxDelta: number } | null;
  /** Совпал ли owner с заявленным владельцем (BR-08): mismatch вне субъекта — structural. */
  declaredOwnerMarkerKeys?: readonly string[];
}

/** Доля остатка кластера, лежащая на контурах эталона, с которой он признаётся растровым. */
export const CLUSTER_EDGE_INSIDE_PCT = 95;
/** Разброс дельты, ниже которого расхождение внутри кластера считается ровной заливкой. */
export const CLUSTER_FILL_STD_DELTA = 24;
/** Толщина, ниже которой ровный кластер читается обводкой, а не заливкой (device px). */
export const CLUSTER_STROKE_THICKNESS_PX = 8;

const round4 = (value: number): number => Math.round((value + Number.EPSILON) * 10_000) / 10_000;
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * Класс краски кластера. Порядок веток — порядок доказательности: сначала то, что подтверждено
 * отдельным фактом (ресурс реестра, геометрия, текст), потом то, что выводится из статистики.
 */
export function paintClassOf(
  region: WorkerRegionAttribution,
  bbox: { width: number; height: number },
  inputs: ClusterInputs,
  basis: string[],
): PaintClass {
  const edgeTotal = region.edgeInsidePixels + region.edgeOutsidePixels;
  const insidePct = edgeTotal === 0 ? null : (region.edgeInsidePixels / edgeTotal) * 100;
  const resource = (inputs.resources ?? []).find((item) =>
    item.ownerElementKey !== undefined && region.ownerMarkerKey !== null && item.ownerElementKey === region.ownerMarkerKey);
  if (resource) { basis.push(`resource:${resource.channel ?? "img"}`); return "registry-image"; }
  if (inputs.geometry?.shifted === true && (inputs.bestOffset.dx !== 0 || inputs.bestOffset.dy !== 0)) {
    basis.push("geometry:best-offset");
    return "geometry";
  }
  if (region.ownerMarkerKey !== null && (inputs.geometry?.decorationElementKeys ?? []).includes(region.ownerMarkerKey)) {
    basis.push("geometry:decoration-source");
    return "geometry";
  }
  if (insidePct !== null && insidePct >= CLUSTER_EDGE_INSIDE_PCT) {
    basis.push(`edgeResidual:${round4(insidePct)}%`);
    // Единственная разница между двумя растровыми классами — **живой текст** узла-владельца
    // (`hasText` карты), а не догадка по форме кластера.
    return region.ownerHasText ? "live-text" : "vector-edge";
  }
  const stats = inputs.channelStats ?? null;
  if (region.mismatchedPixels > 0 && region.alphaDominantPixels / region.mismatchedPixels >= 0.5) {
    basis.push("channelStats:alpha-dominant");
    return "effect";
  }
  if (stats !== null && stats.stdMaxDelta <= CLUSTER_FILL_STD_DELTA && region.meanMaxDelta > 0) {
    basis.push(`channelStats:stdMaxDelta=${stats.stdMaxDelta}`);
    // Тонкая полоса ровной дельты — обводка (`stroke`); ровная дельта по площади — заливка
    // (`fill`). Порог тонкости — тот же, что у `edge-radius-stroke` в таксономии причин.
    return Math.min(bbox.width, bbox.height) <= CLUSTER_STROKE_THICKNESS_PX ? "stroke" : "fill";
  }
  return "unknown";
}

/**
 * Структурный кластер: он **никогда** не смягчается ни профилем рендерера, ни бюджетом.
 *
 * Четыре повода из §10 фидбэка: сдвиг геометрии, отсутствующий ассет, «не та» заливка/обводка/
 * эффект и mismatch **вне заявленного владельца**. Пятый, свой: пиксели кластера, которых не
 * покрыл ни один узел карты (`unknown`) — «не знаю, кто это» не бывает renderer-only.
 */
export function clusterIsStructural(region: WorkerRegionAttribution, paintClass: PaintClass, inputs: ClusterInputs): boolean {
  if (paintClass === "geometry") return true;
  if (paintClass === "registry-image") return true;
  if (paintClass === "fill" || paintClass === "stroke" || paintClass === "effect") return true;
  if (paintClass === "unknown") return true;
  if (region.unknownPixels > 0) return true;
  const declared = inputs.declaredOwnerMarkerKeys;
  if (declared !== undefined && declared.length > 0
    && (region.ownerMarkerKey === null || !declared.includes(region.ownerMarkerKey))) return true;
  return false;
}

/** Кластеры §10 из регионов диффа и пер-регионной атрибуции воркера. */
export function buildClusters(inputs: ClusterInputs): AttributionCluster[] {
  const denominator = inputs.surfacePixels ?? inputs.totalPixels;
  return inputs.regions.map((region, index) => {
    const attributed = inputs.attribution.find((item) => item.index === index) ?? {
      index, ownerElementKey: null, ownerMarkerKey: null, ownerPath: null, ownerDepth: null,
      ownerHasText: false, ownerComponentId: null, mismatchedPixels: 0, unknownPixels: 0,
      edgeInsidePixels: 0, edgeOutsidePixels: 0, alphaDominantPixels: 0, meanMaxDelta: region.meanDelta,
    } satisfies WorkerRegionAttribution;
    const basis: string[] = [];
    const paintClass = paintClassOf(attributed, region.bbox, inputs, basis);
    const structural = clusterIsStructural(attributed, paintClass, inputs);
    const edgeTotal = attributed.edgeInsidePixels + attributed.edgeOutsidePixels;
    const owned = attributed.mismatchedPixels === 0
      ? 0
      : (attributed.mismatchedPixels - attributed.unknownPixels) / attributed.mismatchedPixels;
    if (attributed.ownerElementKey !== null) basis.push(`elementMap:${attributed.ownerElementKey}`);
    if (attributed.unknownPixels > 0) basis.push(`unknownPixels:${attributed.unknownPixels}`);
    return {
      boundsDevicePx: { ...region.bbox },
      mismatchedPixels: attributed.mismatchedPixels || Math.max(0, Math.round(region.areaPct * denominator / 100)),
      ownerElementKey: attributed.ownerElementKey,
      ownerComponentId: attributed.ownerComponentId,
      paintClass,
      sourceAssetId: (inputs.resources ?? []).find((item) =>
        item.ownerElementKey !== undefined && item.ownerElementKey === attributed.ownerMarkerKey)?.assetId ?? null,
      rawDiffPct: denominator === 0 ? 0 : round4((attributed.mismatchedPixels / denominator) * 100),
      aaResidualPct: edgeTotal === 0 ? null : round4((attributed.edgeOutsidePixels / edgeTotal) * 100),
      bestOffset: { ...inputs.bestOffset },
      structural,
      basis,
      // Уверенность — сила **атрибуции**, а не вероятность дефекта: доля пикселей кластера,
      // которым нашёлся владелец, плюс поправка на названный класс краски.
      confidence: round4(clamp01(0.4 * (paintClass === "unknown" ? 0 : 1) + 0.6 * clamp01(owned))),
    };
  });
}
