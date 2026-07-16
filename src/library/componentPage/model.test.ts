import { describe, expect, it } from "vitest";
import type { ComponentMeta, ComponentVersion } from "../../api/client";
import { buildPreviewSpec, parseVersionQuery, resolveSelectedVersion } from "./model";

const meta = (publishedVersion: number | null, versions: ComponentMeta["versions"]): ComponentMeta => ({
  id: "widget", name: "Widget", designSystem: "shadcn", headRev: 1, publishedVersion, versions, updatedAt: "",
});
const summary = (version: number, status: ComponentMeta["versions"][number]["status"]): ComponentMeta["versions"][number] => ({
  version, status, rev: 1, statusReason: null, supersededBy: null, statusRev: 1, designSystem: "shadcn", publishedAt: "",
});
const version = (slots: string[], namedSlots = false): ComponentVersion => ({
  version: 1, rev: 1, status: "active", source: "", designSystem: "shadcn", bundleHash: "hash", hostAbiVersion: 3,
  assets: [], events: [], slots, ...(namedSlots ? { capabilities: { namedSlots: true } } : {}), publishedAt: "",
});

describe("component page model", () => {
  it.each(["v=1&v=2", "v=0", "v=01", "v=nope", "v=9007199254740992", "x=1", "v=1&x=2"])("rejects invalid query %s", (query) => {
    expect(parseVersionQuery(new URLSearchParams(query))).toEqual({ kind: "invalid" });
  });

  it("accepts an absent selector and one safe positive version", () => {
    expect(parseVersionQuery(new URLSearchParams())).toEqual({ kind: "auto" });
    expect(parseVersionQuery(new URLSearchParams("v=42"))).toEqual({ kind: "version", version: 42 });
  });

  it("prefers publishedVersion, then the newest deprecated/superseded version", () => {
    expect(resolveSelectedVersion(meta(2, [summary(1, "deprecated"), summary(2, "active")]), { kind: "auto" })).toBe(2);
    expect(resolveSelectedVersion(meta(null, [summary(1, "deprecated"), summary(4, "rejected"), summary(3, "superseded")]), { kind: "auto" })).toBe(3);
    expect(resolveSelectedVersion(meta(null, [summary(4, "rejected"), summary(5, "archived")]), { kind: "auto" })).toBeNull();
  });

  it("does not inject children for a component with slots: []", () => {
    const spec = buildPreviewSpec("Widget", {}, version([]), "__preview_placeholder__");
    expect(spec.elements.component.children).toBeUndefined();
    expect(Object.keys(spec.elements)).toEqual(["component"]);
  });

  it("injects default only for legacy slots and default plus declared named slots when enabled", () => {
    const legacy = buildPreviewSpec("Widget", {}, version(["header", "items"]), "__preview_placeholder__");
    expect(legacy.elements.component.children).toEqual(["placeholder-default"]);
    expect(legacy.elements["placeholder-default"]?.slot).toBeUndefined();

    const named = buildPreviewSpec("Widget", {}, version(["header", "items", "default"], true), "__preview_placeholder__");
    expect(named.elements.component.children).toHaveLength(3);
    expect(Object.values(named.elements).filter((element) => element.type === "__preview_placeholder__").map((element) => element.props.slot)).toEqual(["default", "header", "items"]);
    expect(named.elements["placeholder-1"]?.slot).toBe("header");
  });
});

