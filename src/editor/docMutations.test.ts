import { describe, expect, it } from "vitest";
import { prototypeDocSchema } from "../prototype/schema";
import { patchDocMeta, patchScreen, setElementProps } from "./docMutations";

const makeDoc = () => prototypeDocSchema.parse({
  version: 1,
  id: "test",
  name: "Test",
  description: "Description",
  device: "desktop",
  startScreen: "main",
  state: {},
  screens: [{
    id: "main",
    name: "Main",
    note: "Note",
    stateOverrides: { count: 1 },
    canvas: { width: 100, height: 200 },
    spec: { root: "root", elements: { root: { type: "Text", props: { text: "Old" } } } },
  }],
});

describe("docMutations", () => {
  it("immutably replaces only the selected element props", () => {
    const doc = makeDoc();
    const props = { text: "New" };
    const next = setElementProps(doc, "main", "root", props);
    expect(next).not.toBe(doc);
    expect(next.screens).not.toBe(doc.screens);
    expect(next.screens[0]!.spec).not.toBe(doc.screens[0]!.spec);
    expect(next.screens[0]!.spec.elements.root!.props).toBe(props);
    expect(doc.screens[0]!.spec.elements.root!.props).toEqual({ text: "Old" });
    expect(setElementProps(doc, "missing", "root", props)).toBe(doc);
    expect(setElementProps(doc, "main", "missing", props)).toBe(doc);
    expect(setElementProps(doc, "main", "root", doc.screens[0]!.spec.elements.root!.props)).toBe(doc);
  });

  it("patches a screen, deletes undefined keys, and preserves no-op references", () => {
    const doc = makeDoc();
    const next = patchScreen(doc, "main", { name: "Renamed", note: undefined, canvas: undefined });
    expect(next).not.toBe(doc);
    expect(next.screens[0]).toEqual(expect.objectContaining({ name: "Renamed" }));
    expect(next.screens[0]).not.toHaveProperty("note");
    expect(next.screens[0]).not.toHaveProperty("canvas");
    expect(patchScreen(doc, "main", { name: "Main" })).toBe(doc);
    expect(patchScreen(doc, "missing", { name: "Nope" })).toBe(doc);
  });

  it("patches document metadata and deletes undefined keys", () => {
    const doc = makeDoc();
    const next = patchDocMeta(doc, { name: "Renamed", description: undefined });
    expect(next).not.toBe(doc);
    expect(next.name).toBe("Renamed");
    expect(next).not.toHaveProperty("description");
    expect(patchDocMeta(doc, { name: doc.name })).toBe(doc);
  });
});
