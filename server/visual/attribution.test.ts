import { expect, test } from "bun:test";
import pngjs from "pngjs";
import { attributeMask, normalizeAndCompare, nodeRowIndex, ownerAt } from "../../scripts/visual-diff-worker.mjs";
import {
  buildClusters, caseElementMapOf, clusterIsStructural, elementMapToCanvas, markerComponentMap, paintClassOf,
  type AttributionNode, type CaseElementMap, type ClusterInputs, type WorkerRegionAttribution,
} from "./attribution";

/**
 * Атрибуция расхождения по элементам (EUI-BR-07, план 2026-08-08 §7).
 *
 * Предмет — четыре свойства, ради которых волна существует:
 * 1. **контракт координат** (CSS px поверхности → device px канвы через `×dsf` и окно кандидата);
 * 2. **владение по slot-дереву** (`markerKey → componentId`, порядок маркеров капчур-поверхности);
 * 3. **атрибуция по полной маске** с честным `unknown` и tie-break «побеждает глубочайший»;
 * 4. **класс краски и `structural`** — по фактам, а не по ощущению.
 */

const { PNG } = pngjs;

const node = (over: Partial<CaseElementMap["nodes"][number]> = {}): CaseElementMap["nodes"][number] => ({
  path: "div.card", bbox: { x: 0, y: 0, width: 10, height: 10 }, hasText: false,
  markerKey: "c", depth: 1, componentId: "subject", ownership: "subject", ...over,
});

// ------------------------------------------------------- владение по slot-дереву

test("markerComponentMap повторяет порядок маркеров капчур-поверхности (c, затем pre-order s0…sN)", () => {
  const markers = markerComponentMap("wrapper", [
    { slot: "items", index: 0, componentId: "child-a", version: 3, children: [{ slot: "default", index: 0, componentId: "grand", version: 1 }] },
    { slot: "items", index: 1, componentId: "child-b", version: 2 },
  ]);
  // Плоский `slots.tree` сервер собирает pre-order (узел → его поддерево → сиблинг), и ключи
  // маркеров нумеруются по этому же массиву: разойдясь, владелец пикселя стал бы догадкой.
  expect(markers).toEqual([
    { markerKey: "c", componentId: "wrapper" },
    { markerKey: "s0", componentId: "child-a", slot: "items", index: 0, version: 3 },
    { markerKey: "s1", componentId: "grand", slot: "default", index: 0, version: 1 },
    { markerKey: "s2", componentId: "child-b", slot: "items", index: 1, version: 2 },
  ]);
});

test("узлы вне маркеров субъектны: фон родителя, гэпы и маски не списываются на детей", () => {
  const map = caseElementMapOf({
    subjectComponentId: "wrapper",
    markers: markerComponentMap("wrapper", [{ slot: "items", index: 0, componentId: "child-a", version: 1 }]),
    elementMap: {
      nodes: [
        { path: "div.gap", bbox: { x: 0, y: 0, width: 4, height: 4 }, hasText: false, markerKey: "", depth: 1 },
        { path: "div.child", bbox: { x: 0, y: 0, width: 4, height: 4 }, hasText: false, markerKey: "s0", depth: 2 },
      ],
      truncated: false, total: 2,
    },
  });
  expect(map.nodes.map((item) => [item.markerKey, item.componentId, item.ownership])).toEqual([
    ["", null, "subject"],
    ["s0", "child-a", "dependency"],
  ]);
});

// ------------------------------------------------------- контракт координат (ревью m20)

test("контракт координат: ×dsf, затем минус окно кандидата — фикстура с известным офсетом", () => {
  const map = caseElementMapOf({
    subjectComponentId: "subject",
    markers: [{ markerKey: "c", componentId: "subject" }],
    elementMap: { nodes: [{ path: "div.card", bbox: { x: 70, y: 34, width: 20, height: 12 }, hasText: true, markerKey: "c", depth: 1 }], truncated: false, total: 1 },
  });
  // dsf 2 ⇒ кадр: (140, 68, 40, 24). Окно BR-02 вырезает канву начиная с (128, 56) кадра ⇒ канва:
  // (12, 12, 40, 24). Ровно та арифметика, которую делает `windowPng`: пиксель кадра (x, y) едет
  // в пиксель канвы (x − window.x, y − window.y).
  expect(elementMapToCanvas(map, { deviceScaleFactor: 2, candidateWindow: { x: 128, y: 56 } }))
    .toEqual([{
      key: "c//div.card", path: "div.card", markerKey: "c", componentId: "subject",
      depth: 1, hasText: true, ownership: "subject", x: 12, y: 12, width: 40, height: 24,
    }]);
  // Окна нет — кандидат кладётся в канву по левому-верхнему углу, то есть второго шага нет.
  expect(elementMapToCanvas(map, { deviceScaleFactor: 2, candidateWindow: null })[0])
    .toMatchObject({ x: 140, y: 68 });
});

test("окно с отрицательным началом (поле меньше маргина канвы) сдвигает узлы вправо-вниз", () => {
  const map = caseElementMapOf({
    subjectComponentId: "subject",
    markers: [{ markerKey: "c", componentId: "subject" }],
    elementMap: { nodes: [node({ bbox: { x: 5, y: 5, width: 10, height: 10 } })], truncated: false, total: 1 },
  });
  expect(elementMapToCanvas(map, { deviceScaleFactor: 2, candidateWindow: { x: -8, y: -4 } })[0])
    .toMatchObject({ x: 18, y: 14, width: 20, height: 20 });
});

// ------------------------------------------------------- атрибуция по полной маске

const canvasNode = (over: Partial<AttributionNode>): AttributionNode => ({
  key: "c//div", path: "div", markerKey: "c", componentId: "subject",
  depth: 1, hasText: false, ownership: "subject", x: 0, y: 0, width: 4, height: 4, ...over,
});

/** Маска 8×8 с прямоугольником единиц. */
function maskOf(width: number, height: number, rects: { x: number; y: number; width: number; height: number }[]): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const rect of rects) {
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) mask[y * width + x] = 1;
    }
  }
  return mask;
}

test("владельцем становится глубочайший узел, содержащий пиксель; непокрытые пиксели — unknown", () => {
  const mask = maskOf(8, 8, [{ x: 0, y: 0, width: 4, height: 2 }, { x: 6, y: 6, width: 2, height: 2 }]);
  const result = attributeMask({
    mask, width: 8, height: 8,
    nodes: [
      canvasNode({ key: "c//outer", depth: 1, x: 0, y: 0, width: 8, height: 4 }),
      canvasNode({ key: "c//inner", depth: 3, x: 0, y: 0, width: 2, height: 2 }),
    ],
  });
  // 8 пикселей внутри `outer`, из них 4 — внутри `inner`: побеждает глубочайший.
  // Порядок — по убыванию числа пикселей, ничья решается порядком глубины (глубочайший первым).
  expect(result.owners).toEqual([
    { elementKey: "c//inner", markerKey: "c", componentId: "subject", depth: 3, mismatchedPixels: 4 },
    { elementKey: "c//outer", markerKey: "c", componentId: "subject", depth: 1, mismatchedPixels: 4 },
  ]);
  // Второй прямоугольник не покрыт ни одним узлом — это `unknown`, а не «владелец по умолчанию».
  expect(result.unknownPixels).toBe(4);
  expect(result.attributedPixels).toBe(8);
  expect(result.coveragePct).toBe(66.6667);
});

test("построчный индекс отдаёт узлы по убыванию глубины, а вне прямоугольника — «ничей»", () => {
  const nodes = [canvasNode({ key: "deep", depth: 5, x: 1, y: 1, width: 2, height: 2 }), canvasNode({ key: "wide", depth: 1, x: 0, y: 0, width: 8, height: 8 })];
  const rows = nodeRowIndex(nodes, 8, 8);
  expect(ownerAt(rows, nodes, 1, 1)).toBe(0);
  expect(ownerAt(rows, nodes, 5, 5)).toBe(1);
  expect(ownerAt(rows, nodes, 5, 5) === -1).toBe(false);
  expect(ownerAt(nodeRowIndex([], 8, 8), [], 0, 0)).toBe(-1);
});

test("владение считает субъектные и зависимые пиксели раздельно и группирует по зависимости", () => {
  const mask = maskOf(8, 8, [{ x: 0, y: 0, width: 8, height: 2 }]);
  const result = attributeMask({
    mask, width: 8, height: 8,
    nodes: [
      canvasNode({ key: "c//wrap", depth: 1, x: 0, y: 0, width: 8, height: 8 }),
      canvasNode({ key: "s0//child", markerKey: "s0", componentId: "child-a", ownership: "dependency", depth: 3, x: 0, y: 0, width: 4, height: 2 }),
    ],
  });
  expect(result.dependencyPixels).toBe(8);
  expect(result.dependencyByMarker).toEqual([{ markerKey: "s0", componentId: "child-a", pixels: 8 }]);
});

// ------------------------------------------------------- кластеры §10

const region = (over: Partial<WorkerRegionAttribution> = {}): WorkerRegionAttribution => ({
  index: 0, ownerElementKey: "c//span.title", ownerMarkerKey: "c", ownerPath: "span.title", ownerDepth: 3,
  ownerHasText: true, ownerComponentId: "subject", mismatchedPixels: 100, unknownPixels: 0,
  edgeInsidePixels: 99, edgeOutsidePixels: 1, alphaDominantPixels: 0, meanMaxDelta: 12, maxChannelDelta: 40, ...over,
});

const inputs = (over: Partial<ClusterInputs> = {}): ClusterInputs => ({
  regions: [{ bbox: { x: 0, y: 0, width: 20, height: 10 }, areaPct: 1, meanDelta: 12 }],
  attribution: [region()],
  bestOffset: { dx: 0, dy: 0, residualPct: 0 },
  totalPixels: 10_000, surfacePixels: 10_000,
  channelStats: { alphaDominantPct: 0, semiTransparentPct: 0, stdMaxDelta: 40 },
  ...over,
});

test("остаток на контурах внутри hasText-узла — live-text и НЕ structural", () => {
  const [cluster] = buildClusters(inputs());
  expect(cluster).toMatchObject({
    paintClass: "live-text", structural: false, ownerElementKey: "c//span.title", ownerComponentId: "subject",
    mismatchedPixels: 100, rawDiffPct: 1, aaResidualPct: 1,
  });
  expect(cluster!.basis.some((item) => item.startsWith("edgeResidual:"))).toBe(true);
  expect(cluster!.confidence).toBe(1);
});

test("тот же остаток вне текста — vector-edge; сдвиг целиком — geometry и всегда structural", () => {
  expect(buildClusters(inputs({ attribution: [region({ ownerHasText: false })] }))[0])
    .toMatchObject({ paintClass: "vector-edge", structural: false });
  expect(buildClusters(inputs({
    bestOffset: { dx: 2, dy: 0, residualPct: 0.1 }, geometry: { shifted: true },
  }))[0]).toMatchObject({ paintClass: "geometry", structural: true });
});

test("пересечение с ресурсом барьера — registry-image с sourceAssetId и structural", () => {
  const [cluster] = buildClusters(inputs({
    resources: [{ channel: "icon-registry", ownerElementKey: "c", assetId: "asset_1" }],
  }));
  expect(cluster).toMatchObject({ paintClass: "registry-image", structural: true, sourceAssetId: "asset_1" });
});

test("неатрибутированные пиксели кластера делают его structural, а confidence — честно ниже", () => {
  const [cluster] = buildClusters(inputs({ attribution: [region({ unknownPixels: 40 })] }));
  expect(cluster).toMatchObject({ structural: true });
  expect(cluster!.confidence).toBeLessThan(1);
  expect(cluster!.basis).toContain("unknownPixels:40");
});

test("mismatch вне заявленного владельца — structural (владелец не тот, кого объявили)", () => {
  expect(clusterIsStructural(region({ ownerMarkerKey: "s0" }), "live-text", inputs({ declaredOwnerMarkerKeys: ["c"] })))
    .toBe(true);
  expect(clusterIsStructural(region(), "live-text", inputs({ declaredOwnerMarkerKeys: ["c"] }))).toBe(false);
});

test("ровная дельта: тонкая полоса — stroke, площадь — fill; оба structural", () => {
  const basis: string[] = [];
  const flat = { channelStats: { alphaDominantPct: 0, semiTransparentPct: 0, stdMaxDelta: 4 } };
  const noEdge = region({ edgeInsidePixels: 10, edgeOutsidePixels: 90 });
  expect(paintClassOf(noEdge, { width: 40, height: 4 }, inputs(flat), basis)).toBe("stroke");
  expect(paintClassOf(noEdge, { width: 40, height: 40 }, inputs(flat), basis)).toBe("fill");
  expect(clusterIsStructural(noEdge, "fill", inputs(flat))).toBe(true);
});

test("расхождение по альфе — effect; ничем не объяснённое — unknown и structural", () => {
  const basis: string[] = [];
  const alpha = region({ edgeInsidePixels: 10, edgeOutsidePixels: 90, alphaDominantPixels: 80 });
  expect(paintClassOf(alpha, { width: 20, height: 20 }, inputs(), basis)).toBe("effect");
  const noisy = region({ edgeInsidePixels: 10, edgeOutsidePixels: 90, meanMaxDelta: 0 });
  expect(paintClassOf(noisy, { width: 20, height: 20 }, inputs({ channelStats: null }), basis)).toBe("unknown");
  expect(clusterIsStructural(noisy, "unknown", inputs())).toBe(true);
});

// ------------------------------------------------------- сквозной прогон воркера

test("воркер атрибутирует полную маску и отдаёт владельца кластера (сквозной прогон)", () => {
  const framePng = (color: [number, number, number, number]): Buffer => {
    const png = new PNG({ width: 16, height: 16 });
    png.data.fill(0);
    for (let y = 2; y < 6; y += 1) {
      for (let x = 2; x < 10; x += 1) {
        const offset = (y * 16 + x) * 4;
        png.data[offset] = color[0]; png.data[offset + 1] = color[1];
        png.data[offset + 2] = color[2]; png.data[offset + 3] = color[3];
      }
    }
    return PNG.sync.write(png);
  };
  const result = normalizeAndCompare(framePng([0x20, 0x40, 0xc0, 0xff]), framePng([0xc0, 0x20, 0x20, 0xff]), {
    edge: true,
    attribution: {
      nodes: [
        { key: "c//div.card", path: "div.card", markerKey: "c", componentId: "subject", depth: 1, hasText: false, ownership: "subject", x: 0, y: 0, width: 16, height: 8 },
        { key: "s0//span.text", path: "span.text", markerKey: "s0", componentId: "child-a", depth: 3, hasText: true, ownership: "dependency", x: 2, y: 2, width: 4, height: 4 },
      ],
      ownership: true,
    },
  });
  expect(result.indeterminate).toBe(false);
  const attribution = (result as { metrics: { attribution: NonNullable<ReturnType<typeof attributeMask>> } }).metrics.attribution;
  // Все различающиеся пиксели покрыты картой ⇒ честные 100 % и ни одного `unknown`.
  expect(attribution.unknownPixels).toBe(0);
  expect(attribution.coveragePct).toBe(100);
  // Глубочайший узел забирает свои 16 пикселей, остальные 16 — у корня.
  expect(attribution.owners.map((owner) => [owner.elementKey, owner.mismatchedPixels]).sort())
    .toEqual([["c//div.card", 16], ["s0//span.text", 16]]);
  expect(attribution.regions[0]).toMatchObject({ mismatchedPixels: 32, unknownPixels: 0 });
  // BR-08: половина расхождения принадлежит зависимости и вычитается из субъектного числителя.
  expect(attribution.ownership).toMatchObject({ dependencyRawDiffPixels: 16, subjectRawDiffPixels: 16 });
  expect(attribution.ownership!.byDependency).toEqual([{ markerKey: "s0", componentId: "child-a", pixels: 16 }]);
});

test("задание без карты элементов оставляет метрики воркера доволновыми byte-for-byte", () => {
  const png = (): Buffer => {
    const image = new PNG({ width: 8, height: 8 });
    image.data.fill(0);
    return PNG.sync.write(image);
  };
  const result = normalizeAndCompare(png(), png(), {}) as unknown as { metrics: Record<string, unknown> };
  expect(result.metrics).not.toHaveProperty("attribution");
});
