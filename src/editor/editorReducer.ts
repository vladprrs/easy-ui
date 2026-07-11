import type { PrototypeDoc } from "../prototype/schema";
import { patchDocMeta, patchScreen, setElementProps, type Screen } from "./docMutations";

export type EditorState = {
  doc: PrototypeDoc;
  baseRev: number;
  dirty: boolean;
  stateEpoch: number;
  selection: { screenId: string; elementKey: string | null };
};

type DocMetaPatch = Partial<Pick<PrototypeDoc, "name" | "description" | "startScreen" | "device">> & {
  state?: PrototypeDoc["state"];
};

export type EditorAction =
  | { type: "select-screen"; screenId: string }
  | { type: "select-element"; screenId?: string; elementKey: string | null }
  | { type: "set-element-props"; screenId: string; elementKey: string; props: Record<string, unknown> }
  | { type: "set-screen-meta"; screenId: string; patch: Partial<Pick<Screen, "name" | "note" | "stateOverrides" | "canvas">> }
  | { type: "set-doc-meta"; patch: DocMetaPatch }
  | { type: "saved"; rev: number; doc: PrototypeDoc };

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "select-screen":
      if (state.selection.screenId === action.screenId && state.selection.elementKey === null) return state;
      return { ...state, selection: { screenId: action.screenId, elementKey: null } };
    case "select-element":
      if ((!action.screenId || state.selection.screenId === action.screenId) && state.selection.elementKey === action.elementKey) return state;
      return { ...state, selection: { screenId: action.screenId ?? state.selection.screenId, elementKey: action.elementKey } };
    case "set-element-props": {
      const doc = setElementProps(state.doc, action.screenId, action.elementKey, action.props);
      return doc === state.doc ? state : { ...state, doc, dirty: true };
    }
    case "set-screen-meta": {
      const previous = state.doc.screens.find((screen) => screen.id === action.screenId);
      const doc = patchScreen(state.doc, action.screenId, action.patch);
      if (doc === state.doc) return state;
      const next = doc.screens.find((screen) => screen.id === action.screenId);
      const stateChanged = !Object.is(previous?.stateOverrides, next?.stateOverrides);
      return { ...state, doc, dirty: true, stateEpoch: state.stateEpoch + (stateChanged ? 1 : 0) };
    }
    case "set-doc-meta": {
      const { state: nextDocState, ...meta } = action.patch;
      let doc = patchDocMeta(state.doc, meta);
      let stateChanged = false;
      if (nextDocState !== undefined && !Object.is(state.doc.state, nextDocState)) {
        doc = { ...doc, state: nextDocState };
        stateChanged = true;
      }
      if (doc === state.doc) return state;
      return { ...state, doc, dirty: true, stateEpoch: state.stateEpoch + (stateChanged ? 1 : 0) };
    }
    case "saved":
      return { ...state, doc: action.doc, baseRev: action.rev, dirty: false };
  }
}
