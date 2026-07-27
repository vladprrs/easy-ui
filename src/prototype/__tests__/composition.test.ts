import { describe, expect, it } from "vitest";
import { z } from "zod";
import compositionFixture from "../../../test/fixtures/architecture/ctyp-payment-success.composition.json";
import composedScreenFixture from "../../../test/fixtures/architecture/composition-screen.json";
import monolithFixture from "../../../test/fixtures/architecture/monolith-screen.json";
import type { ComponentDefinition } from "../../catalog/definitions";
import { compositionDocSchema, expandCompositions, hostKeyOf, type CompositionDoc } from "../composition";
import { inputPrototypeDocSchema, prototypeDocSchema, type PrototypeDoc } from "../schema";
import { lintPrototypeArchitecture } from "../architectureLints";
import { validatePrototype } from "../validate";
import { toRuntimeSpec } from "../runtimeSpec";

const definition = (extra: Partial<ComponentDefinition> = {}): ComponentDefinition => ({
  description: "test",
  props: z.looseObject({}),
  ...extra,
});

const definitions: Record<string, ComponentDefinition> = {
  CtypSuccessShell: definition({ atomicLevel: "organism", scope: "section" }),
  CtypAccrualBadge: definition({ atomicLevel: "molecule", props: z.strictObject({ amount: z.string() }) }),
};

const composition = compositionDocSchema.parse(structuredClone(compositionFixture));
const composed = () => inputPrototypeDocSchema.parse(structuredClone(composedScreenFixture)) as PrototypeDoc;
const expand = (doc: PrototypeDoc, docs: Record<string, CompositionDoc> = { "ctyp-payment-success": composition }) =>
  expandCompositions(doc, { compositions: docs });

describe("composition document", () => {
  it("rejects region markers, nesting and @eui/FlowRoot inside a composition", () => {
    const base = structuredClone(compositionFixture) as Record<string, unknown>;
    const withRegion = structuredClone(base) as typeof compositionFixture;
    (withRegion.spec.elements.badge as Record<string, unknown>).region = "footer";
    expect(compositionDocSchema.safeParse(withRegion).success).toBe(false);

    const nested = structuredClone(base) as typeof compositionFixture;
    (nested.spec.elements.badge as Record<string, unknown>).type = "@eui/Composition";
    expect(compositionDocSchema.safeParse(nested).success).toBe(false);

    const flowRoot = structuredClone(base) as typeof compositionFixture;
    (flowRoot.spec.elements.badge as Record<string, unknown>).type = "@eui/FlowRoot";
    expect(compositionDocSchema.safeParse(flowRoot).success).toBe(false);
  });

  it("rejects a $ in authored element keys so expanded keys cannot collide", () => {
    const doc = structuredClone(composedScreenFixture) as unknown as { screens: { spec: { elements: Record<string, unknown> } }[] };
    doc.screens[0]!.spec.elements["na$v"] = doc.screens[0]!.spec.elements.nav;
    expect(inputPrototypeDocSchema.safeParse(doc).success).toBe(false);
  });
});

describe("expandCompositions", () => {
  it("inlines the composition under <hostKey>$<innerKey> keys and routes slotted children", () => {
    const { doc, issues, refs, expandedFrom } = expand(composed());
    expect(issues).toEqual([]);
    expect(refs).toEqual([{ screenIndex: 0, screenId: "success", elementKey: "screen", compositionId: "ctyp-payment-success" }]);
    const elements = doc.screens[0]!.spec.elements;
    // Host element is gone; the composition root took its place under the FlowRoot.
    expect(elements.screen).toBeUndefined();
    expect(elements.root!.children).toEqual(["screen$shell"]);
    // Slot elements disappear and the authored children take their positions in order.
    expect(elements["screen$shell"]!.children).toEqual(["nav", "merchant", "screen$badge", "offer", "method", "footer"]);
    // The routed children lose their side-channel slot (their parent is no longer the composition).
    expect((elements.nav as { slot?: string }).slot).toBeUndefined();
    // Params substitute props only.
    expect(elements["screen$badge"]!.props).toEqual({ amount: "12 ₽" });
    expect(expandedFrom["screen$badge"]).toEqual({ compositionId: "ctyp-payment-success", hostKey: "screen", innerKey: "badge" });
    expect(hostKeyOf("screen$badge")).toBe("screen");
  });

  it("reports missing composition, unknown params and unknown slots against the authored path", () => {
    expect(expand(composed(), {}).issues[0]!.message).toContain("unknown or unpublished composition");

    const wrongParam = composed();
    (wrongParam.screens[0]!.spec.elements.screen!.props.params as Record<string, unknown>)["accrual-amount"] = 12;
    expect(expand(wrongParam).issues).toEqual([{
      path: "/screens/0/spec/elements/screen/props/params/accrual-amount",
      message: "composition param accrual-amount must be of type string",
    }]);

    const missingRequired = composed();
    wrongParamDelete(missingRequired);
    expect(expand(missingRequired).issues[0]!.message).toContain("required composition param is missing");

    const badSlot = composed();
    (badSlot.screens[0]!.spec.elements.nav as { slot?: string }).slot = "unknown-slot";
    expect(expand(badSlot).issues[0]!.message).toContain("unknown slot for composition");
  });

  it("carries the host element's region marker onto the expanded root", () => {
    const doc = composed();
    doc.screens[0]!.spec.elements.screen!.region = "footer";
    const expanded = expand(doc).doc;
    expect(expanded.screens[0]!.spec.elements["screen$shell"]!.region).toBe("footer");
  });

  it("keeps slot indices for an unexpanded @eui/Composition element (B5)", () => {
    const tree = toRuntimeSpec(composed().screens[0]!.spec);
    expect(tree.metadata.screen!.slotIndices).toEqual({
      nav: [0], merchant: [1], offer: [2], "payment-method": [3], footer: [4],
    });
  });
});

function wrongParamDelete(doc: PrototypeDoc): void {
  delete (doc.screens[0]!.spec.elements.screen!.props.params as Record<string, unknown>)["accrual-amount"];
}

describe("acceptance: motivating case rebuilt as a composition", () => {
  it("flags the monolith screen but leaves the composed screen without arch warnings", () => {
    const monolith = prototypeDocSchema.parse(structuredClone(monolithFixture));
    const monolithCodes = lintPrototypeArchitecture(monolith, {
      YpCtypMagnitPaymentSuccess: definition({ atomicLevel: "organism", scope: "screen" }),
    }).warnings.map((warning) => warning.code);
    expect(monolithCodes).toContain("arch/monolith-root");

    const expanded = expand(composed());
    expect(expanded.issues).toEqual([]);
    const result = validatePrototype(expanded.doc, { definitions });
    expect(result.errors).toEqual([]);
    expect(result.warnings.filter((warning) => warning.code?.startsWith("arch/"))).toEqual([]);
  });
});
