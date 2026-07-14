import type { PrototypeDoc } from "../prototype/schema";
import { patchDocMeta, patchScreen, setElementProps, type Screen } from "./docMutations";

/** Максимум undo-снапшотов authored-документа (W2-2). */
export const HISTORY_LIMIT = 50;

export type EditorState = {
  doc: PrototypeDoc;
  baseRev: number;
  /**
   * Checkpoint последнего load/save (W2-2): dirty — это сравнение doc с
   * savedDoc, а не ручной флаг, поэтому undo после save честно возвращает
   * dirty, а undo до самого checkpoint честно его снимает.
   */
  savedDoc: PrototypeDoc;
  /** Производное от doc/savedDoc; инвариант поддерживает редьюсер. */
  dirty: boolean;
  /**
   * История ТОЛЬКО authored doc (W2-2): selection/baseRev/bookkeeping не
   * снапшотятся и не откатываются. past — от старых к новым, future[0] — ближайший redo.
   */
  past: PrototypeDoc[];
  future: PrototypeDoc[];
  /**
   * Epoch authored-документа: меняется на undo/redo (restore и conflict-rebase
   * пересоздают стейт целиком через remount). PropsForm сбрасывает локальные
   * черновики полей при смене epoch.
   */
  docEpoch: number;
  stateEpoch: number;
  selection: { screenId: string; elementKey: string | null };
};

/** Начальный стейт от загруженного черновика: load = checkpoint, история пуста. */
export function createEditorState({ doc, rev }: { doc: PrototypeDoc; rev: number }): EditorState {
  return {
    doc, baseRev: rev, savedDoc: doc, dirty: false, past: [], future: [], docEpoch: 0, stateEpoch: 0,
    selection: { screenId: doc.screens.some((screen) => screen.id === doc.startScreen) ? doc.startScreen : doc.screens[0]!.id, elementKey: null },
  };
}

type DocMetaPatch = Partial<Pick<PrototypeDoc, "name" | "description" | "startScreen" | "device">> & {
  state?: PrototypeDoc["state"];
};

export type EditorAction =
  | { type: "select-screen"; screenId: string }
  | { type: "select-element"; screenId?: string; elementKey: string | null }
  | { type: "set-element-props"; screenId: string; elementKey: string; props: Record<string, unknown> }
  | { type: "set-screen-meta"; screenId: string; patch: Partial<Pick<Screen, "name" | "note" | "stateOverrides" | "canvas">> }
  | { type: "set-doc-meta"; patch: DocMetaPatch }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "saved"; rev: number; doc: PrototypeDoc };

/** Отличается ли runtime-состояние (doc.state / stateOverrides экранов) между документами. */
function runtimeStateChanged(a: PrototypeDoc, b: PrototypeDoc): boolean {
  if (!Object.is(a.state, b.state) || a.screens.length !== b.screens.length) return true;
  const overrides = new Map(a.screens.map((screen) => [screen.id, screen.stateOverrides]));
  return b.screens.some((screen) => !Object.is(overrides.get(screen.id), screen.stateOverrides));
}

/** Применение authored-правки: пуш прежнего doc в past (с лимитом), сброс future, честный dirty. */
function commitDoc(state: EditorState, doc: PrototypeDoc, stateChanged: boolean): EditorState {
  return {
    ...state, doc,
    dirty: !Object.is(doc, state.savedDoc),
    past: [...state.past, state.doc].slice(-HISTORY_LIMIT),
    future: [],
    stateEpoch: state.stateEpoch + (stateChanged ? 1 : 0),
  };
}

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
      return doc === state.doc ? state : commitDoc(state, doc, false);
    }
    case "set-screen-meta": {
      const previous = state.doc.screens.find((screen) => screen.id === action.screenId);
      const doc = patchScreen(state.doc, action.screenId, action.patch);
      if (doc === state.doc) return state;
      const next = doc.screens.find((screen) => screen.id === action.screenId);
      return commitDoc(state, doc, !Object.is(previous?.stateOverrides, next?.stateOverrides));
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
      return commitDoc(state, doc, stateChanged);
    }
    case "undo": {
      const previous = state.past[state.past.length - 1];
      if (!previous) return state;
      return {
        ...state, doc: previous,
        past: state.past.slice(0, -1),
        future: [state.doc, ...state.future],
        dirty: !Object.is(previous, state.savedDoc),
        docEpoch: state.docEpoch + 1,
        stateEpoch: state.stateEpoch + (runtimeStateChanged(state.doc, previous) ? 1 : 0),
      };
    }
    case "redo": {
      const next = state.future[0];
      if (!next) return state;
      return {
        ...state, doc: next,
        past: [...state.past, state.doc],
        future: state.future.slice(1),
        dirty: !Object.is(next, state.savedDoc),
        docEpoch: state.docEpoch + 1,
        stateEpoch: state.stateEpoch + (runtimeStateChanged(state.doc, next) ? 1 : 0),
      };
    }
    case "saved":
      // Save — новый checkpoint (doc заменяется нормализованным parsed.data);
      // история сохраняется: undo после save возможен и честно вернёт dirty.
      return { ...state, doc: action.doc, savedDoc: action.doc, baseRev: action.rev, dirty: false };
  }
}
