import { describe, expect, it } from "vitest";
import { z } from "zod";
import regionFixture from "../../../test/fixtures/screen-regions/prototype.json";
import { FLOW_ROOT_TYPE } from "../../catalog/hostPrimitives";
import { analyzeScreenRegions, applyRegionPolicy, buildScreenRenderPlan, toRuntimeSpec } from "../runtimeSpec";
import { prototypeDocSchema, type PrototypeDoc } from "../schema";
import { regionEligibility } from "../regionRules";
import { validatePrototype } from "../validate";

const definitions = {
  RegionBar: { description: "Region bar", props: z.strictObject({ label: z.string() }) },
  ContentPanel: { description: "Content", props: z.strictObject({ label: z.string() }) },
};

function fixture(): PrototypeDoc {
  return prototypeDocSchema.parse(structuredClone(regionFixture));
}

function regionMessages(doc: PrototypeDoc): string[] {
  return validatePrototype(doc, { definitions }).errors.map((entry) => entry.message);
}

describe("screen region rules", () => {
  it("accepts a production-like custom-only region screen and exposes eligibility", () => {
    const doc = fixture();
    expect(regionEligibility(doc.screens[0]!)).toEqual({ eligible: true, reason: null });
    expect(analyzeScreenRegions(doc.screens[0]!)).toMatchObject({ valid: true, hasRegions: true });
    expect(regionMessages(doc)).toEqual([]);
  });

  it("uses the same preflight for validator errors and runtime fail-closed identity", () => {
    const doc = fixture();
    doc.screens[0]!.spec.elements.footer!.region = "header";
    const analysis = analyzeScreenRegions(doc.screens[0]!);
    expect(analysis.valid).toBe(false);
    expect(analysis.issues.some((entry) => entry.message.includes("at most one header"))).toBe(true);
    expect(regionMessages(doc)).toEqual(expect.arrayContaining(analysis.issues.map((entry) => entry.message)));
    const tree = toRuntimeSpec(doc.screens[0]!.spec);
    expect(applyRegionPolicy(tree, { header: "extract" }).content).toBe(tree);
  });

  it.each([
    ["orphan marker", (doc: PrototypeDoc) => { doc.screens[0]!.spec.elements.root!.children = doc.screens[0]!.spec.elements.root!.children!.filter((id) => id !== "header"); }, /direct child.*exactly one parent/],
    ["duplicate child reference", (doc: PrototypeDoc) => { doc.screens[0]!.spec.elements.root!.children!.push("header"); }, /direct child.*exactly one parent/],
    ["non-FlowRoot root", (doc: PrototypeDoc) => { doc.screens[0]!.spec.elements.root!.type = "ContentPanel"; doc.screens[0]!.spec.elements.root!.props = { label: "Root" }; }, /requires the screen root/],
    ["canvas", (doc: PrototypeDoc) => { doc.screens[0]!.canvas = { width: 320, height: 640 }; }, /not allowed on a canvas/],
    ["region repeat", (doc: PrototypeDoc) => { doc.screens[0]!.spec.elements.header!.repeat = { statePath: "/items" }; }, /cannot repeat/],
    ["region slot", (doc: PrototypeDoc) => { doc.screens[0]!.spec.elements.header!.slot = "header"; }, /cannot use a named slot/],
    ["region on Overlay", (doc: PrototypeDoc) => { doc.screens[0]!.spec.elements.header!.type = "Overlay"; doc.screens[0]!.spec.elements.header!.props = { placement: "top" }; }, /not allowed on Overlay/],
    ["region on Hotspot", (doc: PrototypeDoc) => { doc.screens[0]!.spec.elements.header!.type = "Hotspot"; doc.screens[0]!.spec.elements.header!.props = { x: 0, y: 0, width: 1, height: 1, ariaLabel: "x" }; }, /not allowed on Hotspot/],
    ["nested FlowRoot", (doc: PrototypeDoc) => { doc.screens[0]!.spec.elements.content!.type = FLOW_ROOT_TYPE; doc.screens[0]!.spec.elements.content!.props = {}; }, /only allowed as the screen root/],
    ["FlowRoot repeat", (doc: PrototypeDoc) => { doc.screens[0]!.spec.elements.root!.repeat = { statePath: "/items" }; }, /FlowRoot cannot repeat/],
    ["FlowRoot visible", (doc: PrototypeDoc) => { doc.screens[0]!.spec.elements.root!.visible = true; }, /FlowRoot cannot be conditional/],
    ["FlowRoot events", (doc: PrototypeDoc) => { doc.screens[0]!.spec.elements.root!.on = { press: { action: "back" } }; }, /FlowRoot cannot declare events/],
  ] as const)("rejects %s", (_label, mutate, expected) => {
    const doc = fixture();
    mutate(doc);
    expect(regionMessages(doc).join("\n")).toMatch(expected);
    const tree = toRuntimeSpec(doc.screens[0]!.spec);
    if (doc.screens[0]!.canvas) {
      const plan = buildScreenRenderPlan(tree, { canvas: doc.screens[0]!.canvas, regionPolicy: { header: "extract", footer: "drop" } });
      expect(plan.regions).toEqual({});
    } else {
      expect(applyRegionPolicy(tree, { header: "extract", footer: "drop" }).content).toBe(tree);
    }
  });

  it("reports nested regions, regions inside Overlay, and Hotspot descendants precisely", () => {
    const nested = fixture();
    nested.screens[0]!.spec.elements.root!.children = nested.screens[0]!.spec.elements.root!.children!.filter((id) => id !== "footer");
    nested.screens[0]!.spec.elements.header!.children = ["footer"];
    expect(regionMessages(nested).join("\n")).toMatch(/nested inside another region subtree/);
    const nestedTree = toRuntimeSpec(nested.screens[0]!.spec);
    expect(applyRegionPolicy(nestedTree, { header: "extract" }).content).toBe(nestedTree);

    const inOverlay = fixture();
    inOverlay.screens[0]!.spec.elements.root!.children = inOverlay.screens[0]!.spec.elements.root!.children!.filter((id) => id !== "header");
    inOverlay.screens[0]!.spec.elements.overlay!.children!.push("header");
    expect(regionMessages(inOverlay).join("\n")).toMatch(/inside Overlay/);
    const overlayTree = toRuntimeSpec(inOverlay.screens[0]!.spec);
    expect(applyRegionPolicy(overlayTree, { header: "extract" }).content).toBe(overlayTree);

    const hotspot = fixture();
    hotspot.screens[0]!.spec.elements.hot = { type: "Hotspot", props: { x: 0, y: 0, width: 1, height: 1, ariaLabel: "x" } };
    hotspot.screens[0]!.spec.elements.header!.children = ["hot"];
    expect(regionMessages(hotspot).join("\n")).toMatch(/Hotspot is not allowed inside a region subtree/);
    const hotspotTree = toRuntimeSpec(hotspot.screens[0]!.spec);
    expect(applyRegionPolicy(hotspotTree, { header: "extract" }).content).toBe(hotspotTree);
  });

  it("reports ineligible reasons without consulting component definitions", () => {
    const canvas = fixture();
    canvas.screens[0]!.canvas = { width: 320, height: 640 };
    expect(regionEligibility(canvas.screens[0]!)).toEqual({ eligible: false, reason: "canvas" });
    const customRoot = fixture();
    customRoot.screens[0]!.spec.elements.root!.type = "ContentPanel";
    expect(regionEligibility(customRoot.screens[0]!)).toEqual({ eligible: false, reason: "flow-root" });
  });
});
