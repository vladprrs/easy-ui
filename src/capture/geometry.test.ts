import { describe, expect, it } from "vitest";
import { collectGeometry, unionRects } from "./geometry.mjs";

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
});
