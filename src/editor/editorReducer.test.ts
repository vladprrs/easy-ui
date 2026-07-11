import { describe, expect, it } from "vitest";
import { prototypeDocSchema } from "../prototype/schema";
import { editorReducer, type EditorState } from "./editorReducer";

const doc = prototypeDocSchema.parse({
  version: 1, id: "test", name: "Test", startScreen: "one", state: {},
  screens: [
    { id: "one", name: "One", spec: { root: "root", elements: { root: { type: "Text", props: { text: "One" } } } } },
    { id: "two", name: "Two", spec: { root: "root", elements: { root: { type: "Text", props: { text: "Two" } } } } },
  ],
});
const initial = (): EditorState => ({ doc, baseRev: 3, dirty: false, stateEpoch: 0, selection: { screenId: "one", elementKey: "root" } });

describe("editorReducer", () => {
  it("updates selection without dirtying and resets element selection on screen selection", () => {
    const selected = editorReducer(initial(), { type: "select-screen", screenId: "two" });
    expect(selected.selection).toEqual({ screenId: "two", elementKey: null });
    expect(selected.dirty).toBe(false);
    expect(editorReducer(selected, { type: "select-element", screenId: "two", elementKey: "root" }).selection.elementKey).toBe("root");
  });

  it("marks document mutations dirty and returns the same state for no-ops", () => {
    const state = initial();
    expect(editorReducer(state, { type: "set-element-props", screenId: "missing", elementKey: "root", props: {} })).toBe(state);
    const next = editorReducer(state, { type: "set-element-props", screenId: "one", elementKey: "root", props: { text: "Changed" } });
    expect(next.dirty).toBe(true);
    expect(next.doc.screens[0]!.spec.elements.root!.props).toEqual({ text: "Changed" });
  });

  it("increments stateEpoch only for state and stateOverrides changes", () => {
    let state = editorReducer(initial(), { type: "set-screen-meta", screenId: "one", patch: { name: "Renamed" } });
    expect(state.stateEpoch).toBe(0);
    state = editorReducer(state, { type: "set-screen-meta", screenId: "one", patch: { stateOverrides: { local: true } } });
    expect(state.stateEpoch).toBe(1);
    state = editorReducer(state, { type: "set-doc-meta", patch: { name: "Document" } });
    expect(state.stateEpoch).toBe(1);
    state = editorReducer(state, { type: "set-doc-meta", patch: { state: { global: true } } });
    expect(state.stateEpoch).toBe(2);
  });

  it("replaces the normalized document and revision on saved", () => {
    const dirty = { ...initial(), dirty: true, stateEpoch: 4 };
    const savedDoc = { ...doc, name: "Normalized" };
    const saved = editorReducer(dirty, { type: "saved", rev: 9, doc: savedDoc });
    expect(saved).toEqual({ ...dirty, doc: savedDoc, baseRev: 9, dirty: false });
  });
});
