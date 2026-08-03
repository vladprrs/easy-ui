import { describe, expect, it } from "vitest";
import { SLOT_TYPE } from "../../catalog/hostPrimitives/composition.definition";
import { analyzeComposition } from "../compositionAnalyze";
import { COMPOSITION_ELEMENTS_LIMIT } from "../composition";

/**
 * Анализатор композиционного кандидата (план 2026-08-03 §5 W8g).
 * По вердикту на каждый класс: чистая композиция, один компонент с вариациями,
 * невыразимая фича. Каждый вердикт обязан нести содержательные `reasons`.
 */

const doc = (value: Record<string, unknown>): Record<string, unknown> => ({
  version: 3, name: "Candidate", atomicLevel: "molecule", params: {}, slots: [], ...value,
});

const codes = (result: ReturnType<typeof analyzeComposition>): string[] => result.reasons.map((reason) => reason.code);

describe("composition analyzer — verdict composition", () => {
  it("accepts a structural body with slots, branches, switches and a parameterised repeat", () => {
    const result = analyzeComposition({
      doc: doc({
        params: {
          tone: { type: "enum", values: ["brand", "muted"], default: "brand" },
          title: { type: "string", default: "FAQ" },
          items: { type: "array", items: { type: "object", schema: { text: { type: "string", required: true } } }, maxItems: 10, default: [] },
          "with-footer": { type: "boolean", default: true },
        },
        slots: { footer: { required: false } },
        spec: {
          root: "shell",
          elements: {
            shell: { type: "YpBox", props: { tone: { $switch: { param: "tone", cases: { brand: "accent", muted: "grey" } } } }, children: ["heading", "hint", "row", "footer-slot"] },
            heading: { type: "YpText", props: { text: { $param: "title" } } },
            hint: { type: "YpText", props: { text: "See below" }, when: { param: "with-footer", eq: true } },
            row: { type: "YpText", props: { text: { $item: "text" } }, repeatParam: { param: "items" } },
            "footer-slot": { type: SLOT_TYPE, props: { name: "footer" } },
          },
        },
      }),
    });
    expect(result.verdict).toBe("composition");
    expect(result.schemaValid).toBe(true);
    expect(result.unsupported).toEqual([]);
    expect(codes(result)).toContain("analyze/expressible");
    expect(result.stats).toMatchObject({ slots: 1, switches: 1, repeats: 1, componentTypes: ["YpBox", "YpText"] });
  });

  it("keeps a valid multi-element body expressible and schema-valid", () => {
    const result = analyzeComposition({
      doc: doc({
        params: { title: { type: "string", default: "Title" } },
        slots: ["content"],
        spec: {
          root: "shell",
          elements: {
            shell: { type: "YpBox", props: {}, children: ["heading", "content-slot"] },
            heading: { type: "YpText", props: { text: { $param: "title" } } },
            "content-slot": { type: SLOT_TYPE, props: { name: "content" } },
          },
        },
      }),
    });
    expect(result.verdict).toBe("composition");
    expect(result.schemaValid).toBe(true);
    expect(result.reasons.at(-1)!.message).toContain("expressible with composition v3");
  });

  it("does not mistake a single host primitive for a component to extend", () => {
    const result = analyzeComposition({
      doc: doc({ spec: { root: "image", elements: { image: { type: "Image", props: { src: "https://example.test/a.png" } } } } }),
    });
    expect(result.verdict).toBe("composition");
    expect(codes(result)).toContain("analyze/host-primitive-body");
  });
});

describe("composition analyzer — verdict extend-component", () => {
  it("flags a body that is one component with parameterised props", () => {
    const result = analyzeComposition({
      doc: doc({
        params: { label: { type: "string", default: "Pay" }, tone: { type: "enum", values: ["brand", "muted"], default: "brand" } },
        spec: {
          root: "button",
          elements: {
            button: {
              type: "YpButton",
              props: { label: { $param: "label" }, tone: { $switch: { param: "tone", cases: { brand: "accent", muted: "grey" } } } },
            },
          },
        },
      }),
    });
    expect(result.verdict).toBe("extend-component");
    expect(result.unsupported).toEqual([]);
    expect(codes(result)).toContain("analyze/single-element-body");
    expect(result.reasons.find((reason) => reason.code === "analyze/single-element-body")!.message).toContain("YpButton");
  });

  it("flags mutually exclusive elements of the same type as prop variations", () => {
    const result = analyzeComposition({
      doc: doc({
        params: { state: { type: "enum", values: ["idle", "busy"], default: "idle" } },
        spec: {
          root: "root",
          elements: {
            root: { type: "YpButton", props: {}, children: ["idle", "busy"] },
            idle: { type: "YpButton", props: { label: "Pay" }, when: { param: "state", eq: "idle" } },
            busy: { type: "YpButton", props: { label: "…" }, when: { param: "state", eq: "busy" } },
          },
        },
      }),
    });
    expect(result.verdict).toBe("extend-component");
    expect(codes(result)).toContain("analyze/component-variations");
  });

  it("keeps a slotted single element a composition (the slot is the contract)", () => {
    const result = analyzeComposition({
      doc: doc({
        slots: ["content"],
        spec: {
          root: "shell",
          elements: {
            shell: { type: "YpBox", props: {}, children: ["content-slot"] },
            "content-slot": { type: SLOT_TYPE, props: { name: "content" } },
          },
        },
      }),
    });
    expect(result.verdict).toBe("composition");
  });
});

describe("composition analyzer — verdict needs-ownership-component", () => {
  it("reports a timer prop on a host primitive", () => {
    const result = analyzeComposition({
      doc: doc({
        spec: { root: "box", elements: { box: { type: "Overlay", props: { autoPlayDelayMs: 3000 } } } },
      }),
    });
    expect(result.verdict).toBe("needs-ownership-component");
    expect(result.unsupported.map((entry) => entry.feature)).toContain("timer");
    expect(result.unsupported[0]!.elementKey).toBe("box");
    expect(result.unsupported[0]!.hint).toMatch(/clock/);
  });

  it("reports an action outside the runtime's closed set", () => {
    const result = analyzeComposition({
      doc: doc({
        spec: {
          root: "row",
          elements: { row: { type: "YpButton", props: {}, on: { press: [{ action: "submitPayment", params: {} }] } } },
        },
      }),
    });
    expect(result.verdict).toBe("needs-ownership-component");
    expect(result.unsupported.map((entry) => entry.feature)).toEqual(["custom-action"]);
    expect(result.reasons.some((reason) => reason.message.includes("submitPayment"))).toBe(true);
  });

  it("reports business state: a handler rewriting several state paths at once", () => {
    const result = analyzeComposition({
      doc: doc({
        spec: {
          root: "row",
          elements: {
            row: {
              type: "YpButton",
              props: {},
              on: {
                press: [
                  { action: "setState", params: { statePath: "/cart/total", value: 1 } },
                  { action: "setState", params: { statePath: "/cart/fee", value: 2 } },
                  { action: "pushState", params: { statePath: "/cart/log", value: "paid" } },
                ],
              },
            },
          },
        },
      }),
    });
    expect(result.verdict).toBe("needs-ownership-component");
    expect(result.unsupported.map((entry) => entry.feature)).toContain("business-state");
  });

  it("reports an unknown props directive as a dynamic construct", () => {
    const result = analyzeComposition({
      doc: doc({ spec: { root: "row", elements: { row: { type: "YpText", props: { text: { $expr: "a + b" } } } } } }),
    });
    expect(result.verdict).toBe("needs-ownership-component");
    expect(result.unsupported.map((entry) => entry.feature)).toEqual(["dynamic-directive"]);
    expect(result.schemaValid).toBe(true);
  });

  it("reports scroll and DOM measurement on events", () => {
    const result = analyzeComposition({
      doc: doc({
        spec: {
          root: "row",
          elements: {
            row: { type: "YpBox", props: {}, on: { scrollEnd: { action: "setState", params: { statePath: "/seen", value: true } } } },
            // Второй элемент нужен, чтобы вердикт не путался с extend-component.
            note: { type: "YpText", props: {}, on: { measureHeight: { action: "back" } } },
          },
        },
      }),
    });
    expect(result.verdict).toBe("needs-ownership-component");
    const features = result.unsupported.map((entry) => entry.feature).sort();
    expect(features).toEqual(["dom-measurement", "scroll"]);
  });

  it("reports a body that outgrows the element budget", () => {
    const elements: Record<string, unknown> = { root: { type: "YpBox", props: {}, children: [] as string[] } };
    const children: string[] = [];
    for (let index = 0; index <= COMPOSITION_ELEMENTS_LIMIT; index += 1) {
      const key = `row-${index}`;
      children.push(key);
      elements[key] = { type: "YpText", props: { text: String(index) } };
    }
    (elements.root as { children: string[] }).children = children;
    const result = analyzeComposition({ doc: doc({ spec: { root: "root", elements } }) });
    expect(result.verdict).toBe("needs-ownership-component");
    expect(result.unsupported.map((entry) => entry.feature)).toContain("limit/elements");
    // Строгая схема тот же лимит подтверждает — черновик анализируется и без её прохождения.
    expect(result.schemaValid).toBe(false);
  });
});

describe("composition analyzer — drafts", () => {
  it("analyzes an invalid draft and explains why the strict schema rejected it", () => {
    const result = analyzeComposition({
      doc: { version: 3, name: "Draft", atomicLevel: "molecule", spec: { root: "row", elements: { row: { type: "YpBox" } } } },
    });
    expect(result.schemaValid).toBe(false);
    expect(codes(result)).toContain("analyze/schema-invalid");
    expect(result.reasons.length).toBeGreaterThan(1);
  });

  it("never throws on a shapeless input", () => {
    const result = analyzeComposition({ doc: null });
    expect(result.verdict).toBe("composition");
    expect(result.schemaValid).toBe(false);
    expect(result.stats.elements).toBe(0);
  });
});
