import { describe, expect, it } from "vitest";
import { firstUnstableKey, quantize, rectSignature, settleLayout, type LayoutSignature } from "./stability";

// R4 (план 2026-08-03-renderer-contract-2 §5): стабилизация layout. Меру и кадр можно инъектировать,
// поэтому цикл проверяется детерминированно — без гонки с настоящим rAF и без реального раствора.

const signature = (surface: string, nodes: Record<string, string> = {}): LayoutSignature => ({ surface, nodes });

describe("rect signature", () => {
  it("округляет до 1/64 px: субпиксельный шум — не движение, а 1/64 px — движение", () => {
    expect(quantize(10.0001)).toBe(10);
    expect(quantize(10.4999)).toBe(10.5);
    expect(quantize(10 + 1 / 64)).not.toBe(10);
    // Нечисло не роняет подпись: она обязана сниматься при любом состоянии layout-движка.
    expect(quantize(Number.NaN)).toBe(0);
  });

  it("снимает поверхность и geometry-узлы теми же маркерами, что и geometry-проба", () => {
    const root = document.createElement("div");
    root.innerHTML = '<div data-eui-key="a"></div><div data-eui-key="b"></div><span></span>';
    document.body.append(root);
    const shot = rectSignature(root);
    expect(Object.keys(shot.nodes).sort()).toEqual(["a", "b"]);
    expect(typeof shot.surface).toBe("string");
    root.remove();
  });

  it("называет виновника, а не факт «что-то поехало»", () => {
    expect(firstUnstableKey(signature("0,0,10,10", { a: "1", b: "2" }), signature("0,0,10,10", { a: "1", b: "3" }))).toBe("b");
    expect(firstUnstableKey(signature("0,0,10,10"), signature("0,0,10,11"))).toBe("#eui-capture-surface");
    expect(firstUnstableKey(signature("0,0,10,10", { a: "1" }), signature("0,0,10,10", { a: "1" }))).toBeNull();
  });
});

describe("settleLayout", () => {
  const frame = (): Promise<void> => Promise.resolve();

  it("признаёт покой на первой же попытке, если две подряд меры совпали", async () => {
    let measured = 0;
    const outcome = await settleLayout({
      attempts: 3, nextFrame: frame,
      measure: () => { measured += 1; return signature("0,0,100,50", { a: "0,0,10,10" }); },
    });
    expect(outcome).toEqual({ stable: true, attempts: 1, elementKey: null, timedOut: false });
    expect(measured).toBe(2);
  });

  it("даёт layout устояться позже: движение на первой попытке — ещё не приговор", async () => {
    const shots = [
      signature("0,0,100,50"), signature("0,0,100,90"),   // попытка 1 — поехало
      signature("0,0,100,90"), signature("0,0,100,90"),   // попытка 2 — устоялось
    ];
    const outcome = await settleLayout({ attempts: 3, nextFrame: frame, measure: () => shots.shift() ?? signature("0,0,100,90") });
    expect(outcome.stable).toBe(true);
    expect(outcome.attempts).toBe(2);
  });

  it("исчерпав попытки, возвращает нестабильность с ключом узла — ровно за attempts попыток", async () => {
    let height = 50;
    let measured = 0;
    const outcome = await settleLayout({
      attempts: 3, nextFrame: frame,
      measure: () => { measured += 1; height += 10; return signature("0,0,100,50", { late: `0,0,100,${height}` }); },
    });
    expect(outcome).toEqual({ stable: false, attempts: 3, elementKey: "late", timedOut: false });
    // Ровно «rAF → мера → rAF → мера» на попытку: цикл не имеет права стоить кадру больше.
    expect(measured).toBe(6);
  });

  it("истёкший потолок политики — `timedOut`, а не обвинение в нестабильности", async () => {
    const outcome = await settleLayout({
      attempts: 3, deadline: 100, now: () => 1_000, nextFrame: frame,
      measure: () => signature("0,0,100,50"),
    });
    expect(outcome).toMatchObject({ stable: false, timedOut: true, attempts: 0 });
  });
});
