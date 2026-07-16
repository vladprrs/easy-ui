import { describe, expect, it } from "vitest";
import { z } from "zod";
import { prototypeDocSchema } from "../schema";
import { REPEAT_RENDER_COST_BUDGET, validatePrototype } from "../validate";

type Element = { type: string; props?: Record<string, unknown>; children?: readonly string[]; repeat?: { statePath: string } };
const document = (elements: Record<string, Element>, options: { device?: "mobile" | "desktop"; canvas?: { width: number; height: number }; state?: Record<string, unknown> } = {}) => prototypeDocSchema.parse({
  version: 1,
  id: "overlay-rules",
  name: "Overlay rules",
  ...(options.device ? { device: options.device } : {}),
  designSystem: "shadcn",
  startScreen: "main",
  state: options.state ?? {},
  screens: [{ id: "main", name: "Main", ...(options.canvas ? { canvas: options.canvas } : {}), spec: { root: "root", elements: Object.fromEntries(Object.entries(elements).map(([key, value]) => [key, { props: {}, ...value }])) } }],
});
const errors = (elements: Record<string, Element>, options?: Parameters<typeof document>[1]) => validatePrototype(document(elements, options)).errors.map((item) => item.message);

describe("Overlay validation rules", () => {
  it("accepts a direct root child and repeat content inside it", () => {
    expect(errors({
      root: { type: "Stack", children: ["overlay"] },
      overlay: { type: "Overlay", props: { placement: "bottom" }, children: ["list"] },
      list: { type: "Stack", repeat: { statePath: "/rows" }, children: ["text"] },
      text: { type: "Text", props: { text: { $item: "label" } } },
    }, { device: "mobile", state: { rows: [{ label: "A" }] } })).toEqual([]);
  });

  it("requires placement", () => {
    expect(errors({ root: { type: "Stack", children: ["overlay"] }, overlay: { type: "Overlay" } }, { device: "mobile" }).join("\n")).toMatch(/expected one of.*top/);
  });

  it.each([
    ["screen root", { root: { type: "Overlay", props: { placement: "top" } } }, "direct child"],
    ["non-root parent", { root: { type: "Stack", children: ["box"] }, box: { type: "Stack", children: ["overlay"] }, overlay: { type: "Overlay", props: { placement: "top" } } }, "direct child"],
    ["repeat ancestor", { root: { type: "Stack", children: ["list"] }, list: { type: "Stack", repeat: { statePath: "/rows" }, children: ["overlay"] }, overlay: { type: "Overlay", props: { placement: "top" } } }, "repeat subtree"],
    ["own repeat", { root: { type: "Stack", children: ["overlay"] }, overlay: { type: "Overlay", props: { placement: "top" }, repeat: { statePath: "/rows" } } }, "repeat subtree"],
    ["nested Overlay", { root: { type: "Stack", children: ["outer"] }, outer: { type: "Overlay", props: { placement: "top" }, children: ["inner"] }, inner: { type: "Overlay", props: { placement: "center" } } }, "another Overlay"],
  ] as const)("rejects %s", (_name, elements, message) => {
    expect(errors(elements, { device: "mobile", state: { rows: [] } })).toContainEqual(expect.stringContaining(message));
  });

  it("rejects Overlay inside Hotspot and Hotspot inside Overlay", () => {
    const canvas = { width: 100, height: 100 };
    expect(errors({ root: { type: "Stack", children: ["hotspot"] }, hotspot: { type: "Hotspot", props: { x: 0, y: 0, width: 10, height: 10, ariaLabel: "Area" }, children: ["overlay"] }, overlay: { type: "Overlay", props: { placement: "top" } } }, { device: "mobile", canvas })).toContain("Overlay is not allowed inside Hotspot");
    expect(errors({ root: { type: "Stack", children: ["overlay"] }, overlay: { type: "Overlay", props: { placement: "top" }, children: ["hotspot"] }, hotspot: { type: "Hotspot", props: { x: 0, y: 0, width: 10, height: 10, ariaLabel: "Area" } } }, { device: "mobile", canvas })).toContain("Hotspot is not allowed inside Overlay");
  });

  it("requires canvas on desktop, including the schema default device", () => {
    const elements = { root: { type: "Stack", children: ["overlay"] }, overlay: { type: "Overlay", props: { placement: "bottom" } } };
    expect(errors(elements)).toContain("Overlay on a desktop screen requires a canvas");
    expect(errors(elements, { device: "desktop", canvas: { width: 100, height: 100 } })).toEqual([]);
  });

  it("counts repeat descendants inside Overlay in the common render budget", () => {
    const rows = Array.from({ length: REPEAT_RENDER_COST_BUDGET + 1 }, () => ({ label: "A" }));
    expect(errors({ root: { type: "Stack", children: ["overlay"] }, overlay: { type: "Overlay", props: { placement: "top" }, children: ["list"] }, list: { type: "Stack", repeat: { statePath: "/rows" }, children: ["text"] }, text: { type: "Text", props: { text: "A" } } }, { device: "mobile", state: { rows } }).join("\n")).toMatch(/render cost.*exceeds the budget/);
  });

  it("treats Overlay as host, not custom, for slot and conditional-action rules", () => {
    const doc = document({
      root: { type: "Stack", children: ["overlay"] },
      overlay: { type: "Overlay", props: { placement: "top" }, children: ["child"] },
      child: { type: "Text", props: { text: "A" } },
    }, { device: "mobile" });
    (doc.screens[0]!.spec.elements.child as { slot?: string }).slot = "default";
    doc.screens[0]!.spec.elements.overlay!.on = { press: { action: "back", $if: true } };
    const result = validatePrototype(doc, { definitions: {
      Stack: { props: z.strictObject({}), description: "Root", atomicLevel: "atom", layoutNeutral: true },
      Text: { props: z.strictObject({ text: z.string() }), description: "Text", atomicLevel: "atom" },
    } });
    expect(result.errors.map((item) => item.message)).toContain("slot is only allowed on a child of a custom component with named slots");
    expect(result.errors.map((item) => item.message)).toContain("conditional actions ($if) are only allowed on custom component events");
  });
});
