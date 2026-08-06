import { describe, expect, it } from "vitest";
import { analyzeGeometry, collectGeometry, GEOMETRY_CONTRACT_VERSION, rectIntersection, unionArea, unionRects } from "./geometry.mjs";

type Box = { left:number; top:number; right:number; bottom:number; width:number; height:number; x:number; y:number; toJSON():unknown };
const box = (left:number, top:number, width:number, height:number):Box => ({ left, top, right:left+width, bottom:top+height, width, height, x:left, y:top, toJSON(){ return this; } });

function installRects(values:Record<string,Box>) {
  const originalBounding = Element.prototype.getBoundingClientRect;
  const originalClient = Element.prototype.getClientRects;
  Element.prototype.getBoundingClientRect = function () { return values[(this as HTMLElement).dataset.rect ?? ""] ?? box(0, 0, 0, 0); };
  Element.prototype.getClientRects = function () {
    const value = values[(this as HTMLElement).dataset.rect ?? ""];
    return (value ? [value] : []) as unknown as DOMRectList;
  };
  return () => { Element.prototype.getBoundingClientRect = originalBounding; Element.prototype.getClientRects = originalClient; };
}

/**
 * Текстовые узлы измеряются через `Range` (W2), а jsdom не раскладывает текст — стаб отдаёт
 * прямоугольник по самому тексту, так же как `installRects` отдаёт его по `data-rect`.
 */
function installTextRects(values:Record<string,Box>) {
  const original = Range.prototype.getClientRects;
  Range.prototype.getClientRects = function () {
    const node = (this as Range).startContainer as Text;
    const value = values[(node.data ?? "").trim()];
    return (value ? [value] : []) as unknown as DOMRectList;
  };
  return () => { Range.prototype.getClientRects = original; };
}

describe("geometry collector", () => {
  it("shares the worker union vector and rounds transformed CSS coordinates", () => {
    const vector = [box(110.125, 220.126, 10, 10), box(125.555, 218.444, 4, 18)];
    const united = unionRects(vector)!;
    expect(united).toMatchObject({ left:110.125, top:218.444, right:129.555, bottom:236.444, height:18 });
    expect(united.width).toBeCloseTo(19.43, 10);
    document.body.innerHTML = `<div id="eui-capture-surface" data-rect="surface"><span data-eui-key="root" style="display:contents"><div data-rect="a"></div><div data-rect="b"></div></span></div>`;
    const restore = installRects({ surface:box(100, 200, 300, 300), a:vector[0]!, b:vector[1]! });
    try { expect(collectGeometry().rects[0]).toMatchObject({ x:10.13, y:18.44, width:19.43, height:18 }); }
    finally { restore(); }
  });

  it("finds a flex owner through wrappers and preserves margin clearance", () => {
    document.body.innerHTML = `<div id="eui-capture-surface" data-rect="surface"><span data-eui-key="root" style="display:contents"><section><div style="display:flex;flex-direction:column;flex-wrap:nowrap;row-gap:12px;column-gap:7px"><span data-eui-key="a" style="display:contents"><div data-rect="a"></div></span><span data-eui-key="b" style="display:contents"><div data-rect="b" style="margin-top:8px"></div></span></div></section></span></div>`;
    const restore = installRects({ surface:box(0, 0, 300, 300), a:box(0, 0, 20, 10), b:box(0, 30, 20, 10) });
    try {
      const result = collectGeometry();
      expect(result.rects[0]?.layoutContext).toMatchObject({ display:"flex", flexDirection:"column", flexWrap:"nowrap", rowGap:"12px", columnGap:"7px" });
      const first = result.rects[1]!, second = result.rects[2]!;
      expect(second.y - (first.y + first.height)).toBe(20);
    } finally { restore(); }
  });

  it("fails soft for fragments and multiple roots", () => {
    for (const html of [
      `<span data-eui-key="root" style="display:contents"><span data-eui-key="a" style="display:contents"></span><span data-eui-key="b" style="display:contents"></span></span>`,
      `<span data-eui-key="root" style="display:contents"><div><span data-eui-key="a" style="display:contents"></span></div><div><span data-eui-key="b" style="display:contents"></span></div></span>`,
    ]) {
      document.body.innerHTML = `<div id="eui-capture-surface" data-rect="surface">${html}</div>`;
      const restore = installRects({ surface:box(0, 0, 300, 300) });
      try { expect(collectGeometry().rects[0]?.layoutContext).toBeNull(); }
      finally { restore(); }
    }
  });

  it("distinguishes hidden and zero-size markers and reports truncation totals", () => {
    document.body.innerHTML = `<div id="eui-capture-surface" data-rect="surface"><span data-eui-key="hidden" style="display:none"><div></div></span><span data-eui-key="zero" style="display:contents"><div data-rect="zero"></div></span></div>`;
    const restore = installRects({ surface:box(0, 0, 300, 300), zero:box(4, 5, 0, 0) });
    try {
      const all = collectGeometry();
      expect(all.rects[0]).toMatchObject({ key:"hidden", hidden:true, width:0, height:0 });
      expect(all.rects[1]).toMatchObject({ key:"zero", width:0, height:0 });
      expect(all.rects[1]?.hidden).toBeUndefined();
      expect(collectGeometry({limit:1})).toMatchObject({ truncated:true, total:2, rects:[{key:"hidden"}] });
    } finally { restore(); }
  });

  it("includes portal markers, preserves scrolled coordinates, and filters fixed boxes outside the surface", () => {
    document.body.innerHTML = `<div id="eui-capture-surface" data-rect="surface"><span data-eui-key="scrolled" style="display:contents"><div data-rect="scrolled"></div></span><span data-eui-key="fixed" style="display:contents"><div data-rect="fixed" style="position:fixed"></div></span></div><div id="portal"><span data-eui-key="portal" style="display:contents"><div data-rect="portal"></div></span></div>`;
    const restore = installRects({ surface:box(100, 100, 200, 200), scrolled:box(80, 90, 30, 20), fixed:box(500, 500, 10, 10), portal:box(120, 130, 15, 16) });
    try {
      const result=collectGeometry();
      expect(result.rects.find((rect)=>rect.key==="scrolled")).toMatchObject({x:-20,y:-10,width:30,height:20});
      expect(result.rects.find((rect)=>rect.key==="fixed")).toMatchObject({width:0,height:0});
      const portal=result.rects.find((rect)=>rect.key==="portal")!;
      expect(portal).toMatchObject({x:20,y:30,width:15,height:16});
      expect(portal).not.toHaveProperty("parentKey");
    } finally { restore(); }
  });

  it("resolves role rects from authored keys and DOM slots, plus safe area and content bounds", () => {
    document.body.innerHTML = `<div id="eui-capture-surface" data-rect="surface"><span data-eui-key="root" style="display:contents"><span data-eui-key="head" style="display:contents"><div data-rect="head" data-eui-region="header"></div></span><span data-eui-key="foot" style="display:contents"><div data-rect="foot"></div></span></span></div>`;
    const restore = installRects({ surface:box(0, 0, 390, 844), head:box(0, 0, 390, 60), foot:box(0, 784, 390, 60) });
    try {
      const result = collectGeometry({ roleKeys: { panel:"root", "region:footer":"foot" } });
      expect(result.roleRects.panel).toMatchObject({ x:0, y:0, width:390, height:844, source:"key", key:"root" });
      expect(result.roleRects["region:footer"]).toMatchObject({ y:784, height:60, source:"key" });
      // Header has no roleKey: the DOM slot marker is the fallback.
      expect(result.roleRects["region:header"]).toMatchObject({ height:60, source:"selector" });
      expect(result.frame).toMatchObject({ width:390, height:844, source:"surface" });
      expect(result.content).toMatchObject({ x:0, y:0, width:390, height:844 });
      expect(result.safeArea).toEqual({ top:0, right:0, bottom:0, left:0 });
      expect(document.querySelector("#eui-capture-surface")?.children.length).toBe(1); // probe removed
    } finally { restore(); }
  });
});

describe("geometry analysis", () => {
  const frame = { x:0, y:0, width:390, height:844 };
  it("computes viewport ownership over the frame", () => {
    const result = analyzeGeometry({
      frame,
      content: { x:0, y:0, width:390, height:844 },
      scroll: { width:390, height:1200 },
      roleRects: { "region:header":{ x:0, y:0, width:390, height:84 }, "region:footer":{ x:0, y:760, width:390, height:84 } },
    });
    expect(result.viewportOwnership.scrollable).toBe(true);
    expect(result.viewportOwnership.owners).toEqual([
      { role:"region:header", areaPct:9.95, heightPct:9.95 },
      { role:"region:footer", areaPct:9.95, heightPct:9.95 },
    ]);
    expect(result.viewportOwnership.unownedPct).toBeCloseTo(80.1, 1);
    expect(result.issues).toEqual([]);
  });

  it("detects clipping, overlap, and a footer that owns the page", () => {
    const clipped = analyzeGeometry({ frame, content:{ x:0, y:0, width:420, height:900 }, roleRects:{} });
    expect(clipped.issues).toMatchObject([{ code:"content-clipped-by-frame", detail:{ overflowRight:30, overflowBottom:56 } }]);

    const overlapping = analyzeGeometry({
      frame,
      content: { x:0, y:0, width:390, height:844 },
      roleRects: { "region:header":{ x:0, y:0, width:390, height:100 }, "region:footer":{ x:0, y:50, width:390, height:100 } },
    });
    expect(overlapping.issues.map((issue) => issue.code)).toContain("overlapping-regions");
    expect(overlapping.issues.find((issue) => issue.code === "overlapping-regions")?.detail).toMatchObject({ roles:["region:header", "region:footer"] });

    const heavyFooter = analyzeGeometry({ frame, content:{ x:0, y:0, width:390, height:844 }, roleRects:{ "region:footer":{ x:0, y:400, width:390, height:444 } } });
    expect(heavyFooter.issues.map((issue) => issue.code)).toEqual(["footer-owns-page"]);
    expect(heavyFooter.issues[0]?.detail).toMatchObject({ footerHeight:444, frameHeight:844 });
  });

  it("stays silent on a well-formed screen and on missing measurements", () => {
    expect(analyzeGeometry({ frame, content:{ x:0, y:0, width:390, height:844 }, roleRects:{ "region:footer":{ x:0, y:760, width:390, height:84 } } }).issues).toEqual([]);
    expect(analyzeGeometry().issues).toEqual([]);
    expect(analyzeGeometry().viewportOwnership).toMatchObject({ frame:null, owners:[], unownedPct:0 });
    expect(unionArea([{ x:0, y:0, width:10, height:10 }, { x:5, y:0, width:10, height:10 }])).toBe(150);
    expect(rectIntersection({ x:0, y:0, width:5, height:5 }, { x:10, y:10, width:5, height:5 })).toBeNull();
  });
});

// --- Geometry Contract 2.0 (план 2026-08-03 §5 W3) ------------------------------------------

describe("layout bounds and attribution", () => {
  const surface = box(0, 0, 400, 400);

  it("out-of-flow и трансформированные потомки не раздувают layoutBounds, но попадают в атрибуцию", () => {
    // Исходный дефект §19.2: декоративная подсветка шире контента, а union getClientRects
    // засчитывал её в габариты. `rects[]` остаётся прежним, `layoutBounds` — честным.
    document.body.innerHTML = `<div id="eui-capture-surface" data-rect="surface"><span data-eui-key="root" style="display:contents">`
      + `<div data-rect="body"></div>`
      + `<div data-rect="halo" style="position:absolute;filter:blur(68px)"></div>`
      + `<div data-rect="moved" style="transform:translateX(30px)"></div>`
      + `</span></div>`;
    const restore = installRects({
      surface, body: box(64, 64, 140, 96), halo: box(46, 47, 175, 130), moved: box(94, 64, 40, 20),
    });
    try {
      const result = collectGeometry({ detailKeys: [] });
      expect(result.detailKeys).toEqual(["root"]);
      const detail = result.details![0]!;
      expect(detail.key).toBe("root");
      expect(detail.layoutBounds).toEqual({ x: 64, y: 64, width: 140, height: 96 });
      // Тот же набор коробок в старом измерении по-прежнему даёт «раздутые» 175×130.
      expect(result.rects[0]).toMatchObject({ x: 46, y: 47, width: 175, height: 130 });
      const causes = detail.effectSources.map((item) => item.cause);
      expect(causes).toContain("position:absolute");
      expect(causes.some((cause) => cause.startsWith("transform:"))).toBe(true);
      expect(detail.effectSources.every((item) => item.elementKey === "root")).toBe(true);
    } finally { restore(); }
  });

  it("клип-предок записывается с признаком effective, когда он реально режет краску", () => {
    document.body.innerHTML = `<div id="eui-capture-surface" data-rect="surface"><div data-rect="card" style="overflow:hidden">`
      + `<span data-eui-key="root" style="display:contents"><div data-rect="body"></div>`
      + `<div data-rect="halo" style="position:absolute"></div></span></div></div>`;
    const restore = installRects({ surface, card: box(64, 64, 140, 96), body: box(64, 64, 140, 96), halo: box(46, 47, 175, 130) });
    try {
      const detail = collectGeometry({ detailKeys: ["root"] }).details![0]!;
      expect(detail.layoutBounds).toEqual({ x: 64, y: 64, width: 140, height: 96 });
      expect(detail.clipChain[0]).toMatchObject({ property: "overflow", effective: true });
    } finally { restore(); }
  });

  // --- W2 (план 2026-08-06 §W2): живой текст и клип-aware union ------------------------------

  it("живая строка в display:contents-обёртке и прямо в маркере входит в layoutBounds", () => {
    // T2-0 (прогон на dev-стенде): ink-bbox видел строку (paintBounds 200×57.5), а layoutBounds
    // оставался 200×40 — текстовые узлы не обходились вовсе, и обёртка `display:contents` не
    // приносила ни одного бокса. Гейт геометрии называл это `paint-overflow-not-clipped`
    // «no descendant effect explains it», то есть винил компонент в собственной слепоте.
    document.body.innerHTML = `<div id="eui-capture-surface" data-rect="surface"><span data-eui-key="root" style="display:contents">`
      + `<div data-rect="body"></div>`
      + `<div style="display:contents">CHART INFO 12345</div>`
      + `\n   `
      + `</span></div>`;
    const restore = installRects({ surface, body: box(64, 64, 200, 40) });
    // Пустой ключ — пробел-узел: если бы фильтр по trimmed отсутствовал, контур раздулся бы на всю
    // поверхность, и провал был бы заметен.
    const restoreText = installTextRects({ "CHART INFO 12345": box(64, 104, 140, 17.5), "": box(0, 0, 400, 400) });
    try {
      const detail = collectGeometry({ detailKeys: ["root"] }).details![0]!;
      expect(detail.layoutBounds).toEqual({ x: 64, y: 64, width: 200, height: 57.5 });
    } finally { restoreText(); restore(); }
  });

  it("клипнутая карусель меряется по окну клипа, а не по ленте", () => {
    // Нисходящий стек клипов: контейнер 350×40 с overflow:hidden режет ленту 900×40. Восходящая
    // `clipChain` этого не могла — клипающий контейнер лежит **внутри** поддерева маркера.
    document.body.innerHTML = `<div id="eui-capture-surface" data-rect="surface"><span data-eui-key="root" style="display:contents">`
      + `<div data-rect="window" style="overflow:hidden"><div data-rect="strip"></div></div>`
      + `</span></div>`;
    const restore = installRects({ surface, window: box(0, 0, 350, 40), strip: box(0, 0, 900, 40) });
    try {
      const result = collectGeometry({ detailKeys: ["root"] });
      expect(result.details![0]!.layoutBounds).toEqual({ x: 0, y: 0, width: 350, height: 40 });
      // Старое измерение `rects[]` аддитивно и не двигается: на нём стоят прежние потребители.
      expect(result.rects[0]).toMatchObject({ x: 0, y: 0, width: 900, height: 40 });
    } finally { restore(); }
  });

  // --- W5 (план 2026-08-06 §W5 T5c.3): overlay-aware layout root ------------------------------

  /** Сцена viewport-поверхности: внешний padded surface, внутри вьюпорт со смонтированным оверлеем. */
  const overlayScene = (contentStyle: string) => `<div id="eui-capture-surface" data-rect="surface">`
    + `<div data-rect="viewport" data-eui-capture-viewport="" style="position:relative">`
    + `<div data-eui-host-primitive="Overlay" style="position:absolute">`
    + `<div data-eui-overlay-content="" data-rect="content" style="${contentStyle}">`
    + `<div data-rect="inner"></div></div></div>`
    + `<span data-eui-key="root" style="display:contents"></span></div></div>`;

  it("контентная обёртка оверлея становится корнем измерения: placement bottom (absolute)", () => {
    document.body.innerHTML = overlayScene("position:absolute;overflow:hidden");
    const restore = installRects({
      surface, viewport: box(16, 16, 390, 844), content: box(28, 560, 366, 300), inner: box(28, 560, 366, 260),
    });
    try {
      const result = collectGeometry({ detailKeys: [], overlayAwareRoot: true });
      const detail = result.details![0]!;
      expect(detail.rootSource).toBe("overlay");
      // Координаты — от **внешней** поверхности (padded): маргин уже внутри x/y, удваивать нечего.
      expect(detail.layoutBounds).toEqual({ x: 28, y: 560, width: 366, height: 300 });
      // Без опции корнем остаётся маркер — пустая сцена, и модалку никто не мерил бы.
      expect(collectGeometry({ detailKeys: [] }).details![0]!.layoutBounds).toBeNull();
    } finally { restore(); }
  });

  it("placement center: собственный transform корня его не дисквалифицирует", () => {
    // `keeps = isRoot || (inFlow && !outOfFlow && !transformed)`: до правки абсолютный и
    // трансформированный корень выбрасывался целиком вместе с поддеревом (V3).
    document.body.innerHTML = overlayScene("position:absolute;transform:translate(-50%, -50%)");
    const restore = installRects({
      surface, viewport: box(16, 16, 390, 844), content: box(100, 300, 222, 180), inner: box(100, 320, 222, 140),
    });
    try {
      const detail = collectGeometry({ detailKeys: [], overlayAwareRoot: true }).details![0]!;
      expect(detail.layoutBounds).toEqual({ x: 100, y: 300, width: 222, height: 180 });
      const causes = detail.effectSources.map((item) => item.cause);
      expect(causes).toContain("position:absolute");
      expect(causes.some((cause) => cause.startsWith("transform:"))).toBe(true);
    } finally { restore(); }
  });

  it("прокручиваемый оверлей меряется своим боксом, а не лентой внутри", () => {
    // Modal scroll ownership (строка 10 фидбэка): `overflow-y:auto` у **overlay-корня** режет
    // потомков. Общая семантика W2 не трогается — `auto`/`scroll` по-прежнему не клип нигде,
    // кроме этой ветки, поэтому существующие кадры не двигаются.
    document.body.innerHTML = overlayScene("position:absolute;overflow-y:auto");
    const restore = installRects({
      surface, viewport: box(16, 16, 390, 844), content: box(32, 32, 358, 812), inner: box(32, 32, 358, 2000),
    });
    try {
      const detail = collectGeometry({ detailKeys: [], overlayAwareRoot: true }).details![0]!;
      expect(detail.layoutBounds).toEqual({ x: 32, y: 32, width: 358, height: 812 });
      // Тот же `overflow-y:auto` на обычном маркерном корне лентой по-прежнему не режется.
      document.body.innerHTML = `<div id="eui-capture-surface" data-rect="surface"><span data-eui-key="root" style="display:contents">`
        + `<div data-rect="content" style="overflow-y:auto"><div data-rect="inner"></div></div></span></div>`;
      expect(collectGeometry({ detailKeys: [] }).details![0]!.layoutBounds).toEqual({ x: 32, y: 32, width: 358, height: 2000 });
    } finally { restore(); }
  });

  it("опция без единственного оверлея ничего не меняет: результаты байт-в-байт прежние", () => {
    // Доказательство того, что `GEOMETRY_CONTRACT_VERSION` двигать не нужно: включённая опция на
    // обычной сцене (и на сцене с двумя оверлеями) даёт **тот же** объект измерения.
    document.body.innerHTML = `<div id="eui-capture-surface" data-rect="surface"><span data-eui-key="root" style="display:contents">`
      + `<div data-rect="body"></div><div data-rect="halo" style="position:absolute"></div></span></div>`;
    const restore = installRects({ surface, body: box(64, 64, 140, 96), halo: box(46, 47, 175, 130) });
    try {
      expect(collectGeometry({ detailKeys: [], overlayAwareRoot: true }))
        .toEqual(collectGeometry({ detailKeys: [] }));
    } finally { restore(); }

    document.body.innerHTML = `<div id="eui-capture-surface" data-rect="surface">`
      + `<div data-eui-overlay-content="" data-rect="a" style="position:absolute"></div>`
      + `<div data-eui-overlay-content="" data-rect="b" style="position:absolute"></div>`
      + `<span data-eui-key="root" style="display:contents"><div data-rect="body"></div></span></div>`;
    const restoreTwo = installRects({ surface, a: box(0, 0, 10, 10), b: box(20, 20, 10, 10), body: box(64, 64, 140, 96) });
    try {
      // Две модалки — выбирать наугад нельзя: корень остаётся маркерным.
      const withOption = collectGeometry({ detailKeys: [], overlayAwareRoot: true });
      expect(withOption).toEqual(collectGeometry({ detailKeys: [] }));
      expect(withOption.details![0]!.key).toBe("root");
    } finally { restoreTwo(); }
  });

  it("версия контракта измерения объявлена и равна 2", () => {
    // Значение — кадровый вход `frameFingerprint` (§1.3): его сдвиг честно инвалидирует кадры.
    expect(GEOMETRY_CONTRACT_VERSION).toBe(2);
  });

  it("детали не собираются, пока их не запросили: контракт probe=geometry не меняется", () => {
    document.body.innerHTML = `<div id="eui-capture-surface" data-rect="surface"><span data-eui-key="root" style="display:contents"><div data-rect="body"></div></span></div>`;
    const restore = installRects({ surface, body: box(0, 0, 10, 10) });
    try {
      const plain = collectGeometry();
      expect(plain.details).toBeUndefined();
      expect(plain.detailKeys).toBeUndefined();
      expect(collectGeometry({ detailKeys: [] }).details).toHaveLength(1);
    } finally { restore(); }
  });
});
