import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { catalogDtsPath, readSnapshot, renderCatalogDts, renderSnapshotJson, SNAPSHOT_DESIGN_SYSTEM, snapshotPath, type CatalogManifestSnapshot } from "../scripts/generate-sdk";

const snapshot = () => readSnapshot(snapshotPath(SNAPSHOT_DESIGN_SYSTEM));
const rendered = () => renderCatalogDts(snapshot(), SNAPSHOT_DESIGN_SYSTEM);

const manifest = (...components: Record<string, unknown>[]): CatalogManifestSnapshot =>
  ({ components: components.map((component) => ({ id: "x", designSystem: "sdk-demo", version: 1, ...component })) as CatalogManifestSnapshot["components"] });

describe("generate-sdk", () => {
  test("emits the committed catalog types from the snapshot fixture (drift check)", () => {
    expect(readFileSync(catalogDtsPath(SNAPSHOT_DESIGN_SYSTEM), "utf8")).toBe(rendered());
  });

  test("is deterministic and orders components and props alphabetically", () => {
    expect(rendered()).toBe(rendered());
    const names = [...rendered().matchAll(/^export interface (Demo\w+)Props/gm)].map((match) => match[1]);
    expect(names).toEqual(["DemoActionFooter", "DemoBadge", "DemoNavBar", "DemoScreenShell"]);
    expect(rendered().indexOf("disabled?:")).toBeLessThan(rendered().indexOf("primaryLabel:"));
  });

  test("derives props, enums, arrays, records and tuples from propsJsonSchema", () => {
    const output = rendered();
    expect(output).toContain('tone: Authored<"light" | "dark">;');
    expect(output).toContain("logoUrl?: Authored<string>;");
    expect(output).toContain("count?: Authored<number | string>;");
    expect(output).toContain("origin?: Authored<[number, number]>;");
    expect(output).toContain("links?: Authored<Array<{");
    expect(output).toMatch(/meta\?: Authored<\{\n\s+\[key: string\]: string;\n\s+}>;/);
  });

  test("emits slots, events, typed payloads, atomicLevel and the component union", () => {
    const output = rendered();
    expect(output).toContain('export type DemoScreenShellSlots = "content" | "footer" | "header";');
    expect(output).toContain('export type DemoActionFooterEvents = "press" | "secondaryPress";');
    expect(output).toContain("export interface DemoActionFooterEventPayloads {");
    expect(output).toContain("    itemId: string;");
    expect(output).toContain("export type DemoNavBarEvents = never;");
    expect(output).toContain('atomicLevel: "organism";');
    expect(output).toContain("namedSlots: true;");
    expect(output).toContain("export type ComponentName = keyof CatalogComponents & string;");
  });

  test("carries scope/canonicalFor through when the manifest starts emitting them", () => {
    const output = renderCatalogDts(manifest({
      name: "Scoped", description: "", events: [], slots: [], atomicLevel: "page",
      scope: "screen", canonicalFor: ["payment-success"], propsJsonSchema: { type: "object", properties: {} },
    }), "sdk-demo");
    expect(output).toContain('scope: "screen";');
    expect(output).toContain('canonicalFor: "payment-success";');
  });

  test("filters by design system and rejects an empty or malformed catalog", () => {
    const mixed: CatalogManifestSnapshot = {
      components: [
        ...manifest({ name: "Kept", description: "", events: [], slots: [] }).components,
        { id: "other", name: "Dropped", designSystem: "other-ds", version: 1, description: "", events: [], slots: [] },
      ],
    };
    const output = renderCatalogDts(mixed, "sdk-demo");
    expect(output).toContain("Kept:");
    expect(output).not.toContain("Dropped");
    expect(renderSnapshotJson(mixed, "sdk-demo")).not.toContain("Dropped");
    expect(() => renderCatalogDts(mixed, "missing-ds")).toThrow(/no components for design system/);
    expect(() => renderCatalogDts(manifest({ name: "bad name", description: "", events: [], slots: [] }), "sdk-demo")).toThrow(/not a TypeScript identifier/);
    expect(() => renderCatalogDts(manifest({ name: "Dup", description: "", events: [], slots: [] }, { name: "Dup", description: "", events: [], slots: [] }), "sdk-demo"))
      .toThrow(/Duplicate component name/);
  });

  test("resolves $ref/$defs and widens recursive or unrepresentable schemas to unknown", () => {
    const output = renderCatalogDts(manifest({
      name: "Refs", description: "", events: [], slots: [],
      propsJsonSchema: {
        type: "object",
        $defs: { tone: { type: "string", enum: ["a", "b"] }, tree: { type: "object", properties: { child: { $ref: "#/$defs/tree" } } } },
        properties: { tone: { $ref: "#/$defs/tone" }, tree: { $ref: "#/$defs/tree" }, loose: {} },
        required: ["tone"],
      },
    }), "sdk-demo");
    expect(output).toContain('tone: Authored<"a" | "b">;');
    expect(output).toContain("child?: unknown;");
    expect(output).toContain("loose?: Authored<unknown>;");
  });
});
