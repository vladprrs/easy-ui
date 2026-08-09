export interface GeometryLayoutContext {
  display: string;
  flexDirection: string;
  flexWrap: string;
  rowGap: string;
  columnGap: string;
}
export interface GeometryRect {
  key: string;
  instance: number;
  parentKey?: string;
  parentInstance?: number;
  domIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  hidden?: true;
  layoutContext: GeometryLayoutContext | null;
}
export type GeometryRole = "panel" | "frame" | "region:header" | "region:footer" | "region:statusBar";
export interface GeometryBox { x: number; y: number; width: number; height: number }
export interface GeometryRoleRect extends GeometryBox { source: "key" | "selector" | "surface"; key?: string }
export interface GeometrySafeArea { top: number; right: number; bottom: number; left: number }
export interface GeometryOwner { role: GeometryRole; areaPct: number; heightPct: number }
export interface GeometryViewportOwnership {
  frame: { width: number; height: number } | null;
  content: { width: number; height: number } | null;
  scroll: { width: number; height: number } | null;
  scrollable: boolean;
  owners: GeometryOwner[];
  unownedPct: number;
}
export interface GeometryIssue {
  code: "content-clipped-by-frame" | "overlapping-regions" | "footer-owns-page"
    /** BR-09: перелив за пределами объявленных `overflowOwnership` (прежний `content-clipped-by-frame`). */
    | "unowned-overflow"
    /** BR-09: владелец объявлен по одной оси, а поддерево переливается по другой. */
    | "owned-overflow-exceeds-axis";
  severity: "warn";
  message: string;
  detail: Record<string, unknown>;
}
/**
 * Атрибуция источника, красящего за пределами своей in-flow border-box (план W3): потомок с
 * `filter`/`box-shadow`/`outline`/`transform` либо выпавший из потока (`position:absolute|fixed`).
 */
export interface GeometryEffectSource {
  /** Ключ ближайшего маркера-владельца (`data-eui-key`); пустая строка — элемент вне маркеров. */
  elementKey: string;
  elementPath: string;
  /** `filter:blur(68px)`, `box-shadow:…`, `position:absolute`, `transform:…`, `outline:…`. */
  cause: string;
  rect: GeometryBox;
}
/** Звено цепочки клипа: предок с `overflow:hidden|clip` или `clip-path`. */
export interface GeometryClipLink {
  key: string;
  elementPath: string;
  property: "overflow" | "clip-path";
  value: string;
  /** Клип реально режет объединение layout-боксов и источников эффектов. */
  effective: boolean;
  rect: GeometryBox;
}
/**
 * Узел, выпавший из потока (`position:absolute|fixed`) либо трансформированный (BR-05, план
 * 2026-08-08 §5). Одна запись на **узел**, а не на причину: `effectSources` перечисляет причины
 * (хвост тултипа фигурирует там дважды), а роль в поверхностях — свойство узла.
 *
 * Замер **аддитивен**: `GEOMETRY_CONTRACT_VERSION` он не двигает и в `frameFingerprint` не входит
 * (прецедент W1a, дифференциальный тест `server/acceptance/ids.test.ts`).
 */
export interface GeometryOutOfFlowNode {
  elementKey: string;
  elementPath: string;
  /** `position:absolute`, `transform:matrix(…)` — в порядке объявления, ≥ 1. */
  causes: string[];
  /**
   * Коробка **до** трансформаций, в координатах поверхности (offset-геометрия). `null` — offset-
   * системы у узла нет (SVG, отсоединённое поддерево): факта нет, и авто-правило не срабатывает.
   */
  preTransformBounds: GeometryBox | null;
  /** Вычисленная матрица (`style.transform`); `null` у узла без трансформации. */
  transform: string | null;
  /** `getBoundingClientRect` узла — то, чем он реально красит. */
  postTransformPaintBounds: GeometryBox;
  /** Классификация волны; отсутствует у узла, декорацией **не** признанного. */
  role?: "decoration";
  /** Чем узел признан декорацией: авто-правилом вложенности или `cases[].geometryOwnership`. */
  roleSource?: "auto" | "declared";
  /** Причина участия/неучастия в каждой поверхности — читается по сохранённому кадру. */
  participation: {
    layoutUnion: "excluded:decoration" | "excluded:out-of-flow";
    root: "excluded:decoration" | "counted";
    paint: "included";
  };
}
/**
 * Запись **карты узлов** поддерева маркера (BR-07 S1, план 2026-08-08 §7).
 *
 * Одна запись на узел — в отличие от `rects[]`, чья гранулярность маркерная. Именно по ней
 * атрибуция диффа отвечает «какой элемент владеет этим пикселем», а не «весь диф принадлежит
 * компоненту».
 */
export interface GeometryElementMapNode {
  /** `nodePath`-формат (`div.card>span.title`), тот же, что у `effectSources[].elementPath`. */
  path: string;
  /** Border-box узла в CSS px относительно поверхности съёмки. */
  bbox: GeometryBox;
  /** У узла есть **собственные** непустые текстовые дети (вход классификации `live-text`). */
  hasText: boolean;
  /** Ключ ближайшего маркера-владельца (`data-eui-key`); пустая строка — узел вне маркеров. */
  markerKey: string;
  /** Глубина от корня измерения (сам корень — 0): tie-break атрибуции «побеждает глубочайший». */
  depth: number;
}
/** Карта узлов одной детали: записи, флаг усечения и полное число узлов поддерева. */
export interface GeometryElementMap {
  nodes: GeometryElementMapNode[];
  truncated: boolean;
  total: number;
}
/** Детальное измерение одного маркера: честный layout-контур + причины выхода краски за него. */
export interface GeometryDetail {
  key: string;
  instance: number;
  /**
   * Union border-box'ов **in-flow** потомков в CSS px относительно поверхности.
   *
   * С `GEOMETRY_CONTRACT_VERSION = 2` (W2) в union входят также живые текстовые узлы in-flow
   * элементов, а каждый бокс пересекается со стеком клипающих предков внутри поддерева маркера.
   */
  layoutBounds: GeometryBox | null;
  /**
   * Border-box **корневого бокса** компонента (W1b, план 2026-08-07 §1.1). Замер безусловный и
   * аддитивный: `layoutBounds` не меняется, поэтому `GEOMETRY_CONTRACT_VERSION` остаётся 2.
   *
   * Определение: от маркера (`span[display:contents]`) спуск **сквозь** цепочки `display:contents`
   * (включая вложенные маркеры) до первого поколения боксовых потомков; ровно один бокс — его
   * border-box, ноль либо два и более (Fragment-корень) — `null`. У overlay-корня
   * (`rootSource: "overlay"`) — бокс самого элемента детали, без спуска. `null` означает
   * «не измерено» (`not-measured` у поверхности `root`), а не «нулевой размер».
   */
  rootBounds: GeometryBox | null;
  /**
   * Клип, объявленный **самим корневым боксом** (`overflow: hidden|clip`, `clip-path`; у
   * прокручиваемого overlay-корня — ещё и `auto|scroll`). Факт для `clipExpectation`: `null` —
   * корень не режет свой layout, и превышение `layoutUnion` над `rootBounds` законно.
   */
  rootClip: { property: "overflow" | "clip-path"; value: string } | null;
  effectSources: GeometryEffectSource[];
  clipChain: GeometryClipLink[];
  /** BR-05: узлы вне потока с pre-transform геометрией и ролью. Аддитивный факт, вне отпечатка. */
  outOfFlowNodes: GeometryOutOfFlowNode[];
  /** BR-07 S1: карта узлов поддерева. Тоже аддитивный факт вне отпечатка (см. `ELEMENT_MAP_*`). */
  elementMap: GeometryElementMap;
  /**
   * `"overlay"` — корнем измерения стала контентная обёртка host-примитива `Overlay`
   * (`[data-eui-overlay-content]`, план 2026-08-06 §W5 T5c.3). Поле присутствует только на этой
   * ветке: у обычного маркерного корня его нет вовсе.
   */
  rootSource?: "overlay";
}
/** Raw browser-side measurements; `analyzeGeometry` derives ownership and issues from them. */
export interface GeometryMeasurements {
  rects: GeometryRect[];
  truncated: boolean;
  total: number;
  safeArea: GeometrySafeArea;
  roleRects: Partial<Record<GeometryRole, GeometryRoleRect>>;
  frame: GeometryRoleRect;
  /** **Paint-габарит**: union `getClientRects()` всех потомков маркеров (включая декорации). */
  content: GeometryBox;
  /**
   * **Layout-габарит** (BR-05, маршрут 1): union тех же in-flow боксов, по которым считается
   * вердикт геометрии. Аддитивен к `content` — тот не переименован и не пересчитан; смысл поля в
   * том, чтобы автор кейса перестал писать декорированное число в `expectedGeometry`.
   */
  layout: GeometryBox;
  scroll: { width: number; height: number };
  /** BR-09: владельцы перелива. Отсутствует у замера без деклараций — доволновой байт-в-байт. */
  overflowOwners?: GeometryOverflowOwner[];
  /** Присутствует только когда запрошен `detailKeys` (режим `probe:"paint"`, W3). */
  details?: GeometryDetail[];
  detailKeys?: string[];
}
export interface GeometryCollection extends GeometryMeasurements {
  viewportOwnership: GeometryViewportOwnership;
  issues: GeometryIssue[];
}
/**
 * Версия семантики измерения `layoutBounds` (план 2026-08-06 §1.3). Кадровый вход
 * `frameFingerprint`: смена значения инвалидирует накопленные кадры.
 */
export const GEOMETRY_CONTRACT_VERSION: number;
/**
 * Версия контракта измерения для случая с объявленным `geometryOwnership` (BR-05). Кладётся в
 * `frameFingerprint` **условным спредом** по манифестному факту: кейс без декларации остаётся на
 * версии 2 и сохраняет кадры байт-в-байт.
 */
export const GEOMETRY_OWNERSHIP_CONTRACT_VERSION: number;
/** BR-07 S1: потолок записей карты узлов на один маркер и на весь замер. */
export const ELEMENT_MAP_NODE_LIMIT: number;
export const ELEMENT_MAP_TOTAL_LIMIT: number;
/**
 * BR-09: факт владения переливом одного маркера. Перелив не исчезает из замера — он перестаёт
 * быть безадресным обвинением экрана: `scrollContentBounds` хранит полный габарит поддерева,
 * `scrollportBounds` — окно, `ownedOverflowPx` — сколько принадлежит владельцу по его оси.
 */
export interface GeometryOverflowOwner {
  key: string;
  instance: number;
  axis: "x" | "y";
  mode: "scroll";
  scrollportBounds: GeometryBox;
  scrollContentBounds: GeometryBox;
  ownedOverflowPx: number;
  /** Перелив по **другой** оси: декларация его не покрывает (`owned-overflow-exceeds-axis`). */
  crossAxisOverflowPx: number;
  clipChain: GeometryClipLink[];
  expectedContentOverflow?: boolean;
  contentOverflowObserved?: boolean;
}
/** Декларация владения переливом одного элемента документа (`elements[].overflowOwnership`). */
export interface OverflowOwnershipDeclaration {
  axis: "x" | "y";
  mode: "scroll";
  viewportOwner?: string;
  expectedContentOverflow?: boolean;
}
/** Декларация владения узлом (`cases[].geometryOwnership`), как её видит сбор. */
export type GeometryOwnershipDeclaration = Record<string, { role: "decoration"; participatesIn: readonly ["paint"] }>;
export const GEOMETRY_ROLES: GeometryRole[];
export const FOOTER_OWNERSHIP_RATIO: number;
export function roundCssPx(value: number): number;
export function unionRects(rects: Array<{left:number;top:number;right:number;bottom:number}>): {left:number;top:number;right:number;bottom:number;width:number;height:number}|null;
export function rectIntersection(a: GeometryBox | null | undefined, b: GeometryBox | null | undefined): GeometryBox | null;
export function unionArea(rects: Array<GeometryBox | null | undefined>): number;
export function analyzeGeometry(input?: {
  frame?: GeometryBox | null;
  content?: GeometryBox | null;
  scroll?: { width: number; height: number } | null;
  roleRects?: Partial<Record<GeometryRole, GeometryBox>>;
  /** BR-09: владельцы перелива из замера; без них `content-clipped-by-frame` остаётся прежним. */
  overflowOwners?: GeometryOverflowOwner[];
}): {
  viewportOwnership: GeometryViewportOwnership;
  issues: GeometryIssue[];
};
export function collectGeometry(options?: {
  limit?: number;
  roleKeys?: Partial<Record<GeometryRole, string>>;
  /** ≤20 ключей маркеров для детального измерения; пустой массив — корневой маркер (W3). */
  detailKeys?: string[];
  /**
   * Искать layout-корень среди `[data-eui-overlay-content]` (W5, viewport-поверхность). Выключено
   * — сбор ведёт себя ровно как до волны; включено и оверлей ровно один — корнем становится он.
   */
  overlayAwareRoot?: boolean;
  /**
   * BR-05: включить **авто-правило** decoration (узел вне потока, чья pre-transform коробка
   * вложена в union остального поддерева, прозрачен для `rootBounds`). Выключено — сбор ведёт
   * себя байт-в-байт доволново; тумблер приезжает из `EASYUI_GEOMETRY_OWNERSHIP_DISABLED`.
   */
  decorationOwnership?: boolean;
  /** BR-05: декларации случая (`cases[].geometryOwnership`); сильнее авто-правила. */
  geometryOwnership?: GeometryOwnershipDeclaration | null;
  /** BR-09: `elementKey → overflowOwnership` снимаемого экрана (из документа, через джобу). */
  overflowOwnership?: Record<string, OverflowOwnershipDeclaration> | null;
}): GeometryMeasurements;
