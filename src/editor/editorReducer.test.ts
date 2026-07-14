import { describe, expect, it } from "vitest";
import { prototypeDocSchema } from "../prototype/schema";
import { createEditorState, editorReducer, HISTORY_LIMIT, type EditorAction, type EditorState } from "./editorReducer";

const doc = prototypeDocSchema.parse({
  version: 1, id: "test", name: "Test", startScreen: "one", state: {},
  screens: [
    { id: "one", name: "One", spec: { root: "root", elements: { root: { type: "Text", props: { text: "One" } } } } },
    { id: "two", name: "Two", spec: { root: "root", elements: { root: { type: "Text", props: { text: "Two" } } } } },
  ],
});
const initial = (): EditorState => ({ ...createEditorState({ doc, rev: 3 }), selection: { screenId: "one", elementKey: "root" } });
const setText = (text: string): EditorAction => ({ type: "set-element-props", screenId: "one", elementKey: "root", props: { text } });
const rootText = (state: EditorState) => (state.doc.screens[0]!.spec.elements.root!.props as { text: string }).text;

describe("editorReducer", () => {
  it("creates the initial state as a clean checkpoint with empty history", () => {
    const state = createEditorState({ doc, rev: 3 });
    expect(state).toMatchObject({ baseRev: 3, dirty: false, past: [], future: [], docEpoch: 0, stateEpoch: 0 });
    expect(state.savedDoc).toBe(doc);
    expect(state.selection).toEqual({ screenId: "one", elementKey: null });
  });

  it("updates selection without dirtying and resets element selection on screen selection", () => {
    const selected = editorReducer(initial(), { type: "select-screen", screenId: "two" });
    expect(selected.selection).toEqual({ screenId: "two", elementKey: null });
    expect(selected.dirty).toBe(false);
    expect(selected.past).toHaveLength(0); // selection не попадает в history
    expect(editorReducer(selected, { type: "select-element", screenId: "two", elementKey: "root" }).selection.elementKey).toBe("root");
  });

  it("marks document mutations dirty and returns the same state for no-ops", () => {
    const state = initial();
    expect(editorReducer(state, { type: "set-element-props", screenId: "missing", elementKey: "root", props: {} })).toBe(state);
    const next = editorReducer(state, setText("Changed"));
    expect(next.dirty).toBe(true);
    expect(rootText(next)).toBe("Changed");
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

  it("replaces the normalized document, checkpoint and revision on saved, keeping history", () => {
    const edited = editorReducer(initial(), setText("Changed"));
    const savedDoc = { ...edited.doc, name: "Normalized" };
    const saved = editorReducer(edited, { type: "saved", rev: 9, doc: savedDoc });
    expect(saved).toEqual({ ...edited, doc: savedDoc, savedDoc, baseRev: 9, dirty: false });
    expect(saved.past).toHaveLength(1);
  });

  it("fully rebases after restore: clears history, resets selection and bumps form epochs", () => {
    let state = editorReducer(initial(), setText("Changed"));
    state = editorReducer(state, { type: "undo" });
    state = editorReducer(state, { type: "redo" });
    const restoredDoc = { ...doc, startScreen: "two", name: "Restored" };
    const rebased = editorReducer(state, { type: "rebase", rev: 12, doc: restoredDoc });
    expect(rebased).toMatchObject({ baseRev: 12, dirty: false, past: [], future: [], selection: { screenId: "two", elementKey: null } });
    expect(rebased.doc).toBe(restoredDoc);
    expect(rebased.savedDoc).toBe(restoredDoc);
    expect(rebased.docEpoch).toBe(state.docEpoch + 1);
    expect(rebased.stateEpoch).toBe(state.stateEpoch + 1);
    expect(editorReducer(rebased, { type: "undo" })).toBe(rebased);
  });

  it("undoes and redoes authored doc snapshots without touching selection or baseRev", () => {
    let state = editorReducer(initial(), setText("A"));
    state = editorReducer(state, { type: "select-screen", screenId: "two" });
    state = editorReducer(state, { type: "select-element", screenId: "one", elementKey: "root" });
    state = editorReducer(state, setText("B"));
    const selection = state.selection;

    const undone = editorReducer(state, { type: "undo" });
    expect(rootText(undone)).toBe("A");
    expect(undone.selection).toBe(selection); // selection вне history
    expect(undone.baseRev).toBe(3);
    expect(undone.dirty).toBe(true);
    expect(undone.docEpoch).toBe(state.docEpoch + 1);

    const backToBase = editorReducer(undone, { type: "undo" });
    expect(rootText(backToBase)).toBe("One");
    expect(backToBase.dirty).toBe(false); // откат до checkpoint честно снимает dirty

    const redone = editorReducer(backToBase, { type: "redo" });
    expect(rootText(redone)).toBe("A");
    expect(redone.dirty).toBe(true);
    expect(redone.docEpoch).toBe(backToBase.docEpoch + 1);
    expect(rootText(editorReducer(redone, { type: "redo" }))).toBe("B");
  });

  it("no-ops undo with empty past and redo with empty future", () => {
    const state = initial();
    expect(editorReducer(state, { type: "undo" })).toBe(state);
    expect(editorReducer(state, { type: "redo" })).toBe(state);
  });

  it("clears the redo stack on a new edit after undo", () => {
    let state = editorReducer(initial(), setText("A"));
    state = editorReducer(state, setText("B"));
    state = editorReducer(state, { type: "undo" });
    state = editorReducer(state, setText("C"));
    expect(state.future).toHaveLength(0);
    expect(editorReducer(state, { type: "redo" })).toBe(state);
  });

  it("keeps dirty honest around save: undo after save is dirty, redo back is clean", () => {
    let state = editorReducer(initial(), setText("A"));
    const normalized = { ...state.doc };
    state = editorReducer(state, { type: "saved", rev: 4, doc: normalized });
    expect(state.dirty).toBe(false);

    const undone = editorReducer(state, { type: "undo" });
    expect(rootText(undone)).toBe("One");
    expect(undone.dirty).toBe(true); // undo после save — снова dirty (checkpoint-семантика)

    const redone = editorReducer(undone, { type: "redo" });
    expect(redone.doc).toBe(normalized);
    expect(redone.dirty).toBe(false);
  });

  it("bumps stateEpoch when undo/redo cross a state or stateOverrides change", () => {
    let state = editorReducer(initial(), { type: "set-doc-meta", patch: { state: { flag: true } } });
    state = editorReducer(state, { type: "set-screen-meta", screenId: "one", patch: { name: "Renamed" } });
    const beforeUndo = state.stateEpoch;
    state = editorReducer(state, { type: "undo" }); // откат переименования — state не менялся
    expect(state.stateEpoch).toBe(beforeUndo);
    state = editorReducer(state, { type: "undo" }); // откат doc.state
    expect(state.stateEpoch).toBe(beforeUndo + 1);
    state = editorReducer(state, { type: "redo" });
    expect(state.stateEpoch).toBe(beforeUndo + 2);
  });

  it("caps history at HISTORY_LIMIT snapshots and undoes down to the oldest retained one", () => {
    let state = initial();
    for (let index = 1; index <= HISTORY_LIMIT + 10; index += 1) state = editorReducer(state, setText(`v${index}`));
    expect(state.past).toHaveLength(HISTORY_LIMIT);
    for (let index = 0; index < HISTORY_LIMIT + 10; index += 1) state = editorReducer(state, { type: "undo" });
    expect(rootText(state)).toBe("v10"); // старейшие снапшоты вытеснены лимитом
    expect(state.past).toHaveLength(0);
    expect(state.future).toHaveLength(HISTORY_LIMIT);
  });
});
