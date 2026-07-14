import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useBlocker } from "react-router";
import { ApiError, getPrototypeDraft, savePrototype, type PrototypeDraft } from "../api/client";
import type { CustomPlayerRuntime } from "../catalog/runtime";
import { createPlayerRuntime } from "../catalog/runtime";
import { resolveBuiltinSystem } from "../designSystems";
import { prototypeDocSchema } from "../prototype/schema";
import { validatePrototype } from "../prototype/validate";
import { pillGhost, pillPrimary } from "../app/chrome";
import { PrototypeChrome } from "../app/PrototypeChrome";
import { formatApiError } from "../app/strings/common";
import { editor, editorDocumentTitle } from "../app/strings/editor";
import { useDocumentTitle } from "../app/useDocumentTitle";
import { EditorCanvas } from "./EditorCanvas";
import { createEditorState, editorReducer } from "./editorReducer";
import { EditorScreenStrip } from "./EditorScreenStrip";
import { InspectorPanel } from "./InspectorPanel";
import { diffDocs, formatDocChange, humanizeIssues, type DisplayIssue, type DocChange } from "./docDiff";
import { DocEpochContext } from "./propsForm/PropsForm";

function Issues({ issues }: { issues: DisplayIssue[] }) {
  return issues.length ? <div role="alert" className="max-h-28 overflow-y-auto rounded-2xl bg-eui-lilac-100 p-3 text-sm text-eui-magenta"><p className="font-medium">{editor.fixIssues}</p><ul className="list-disc pl-5">{issues.map((issue, index) => <li key={`${issue.path}:${index}`}><span className="font-medium">{issue.path}</span>: {issue.message}</li>)}</ul></div> : null;
}

/** Диалог 409 (W2-4): трёхсторонний diff base/local/remote и явное подтверждение перезаписи. */
type ConflictState = { remoteRev: number; remoteChanges: DocChange[]; localChanges: DocChange[] };

function ChangeList({ title, changes }: { title: string; changes: DocChange[] }) {
  return <section>
    <h3 className="text-sm font-medium">{title}</h3>
    {changes.length
      ? <ul className="mt-1 max-h-40 list-disc overflow-y-auto pl-5 text-sm text-eui-slate-500">{changes.map((change, index) => <li key={index}>{formatDocChange(change)}</li>)}</ul>
      : <p className="mt-1 text-sm text-eui-slate-500">{editor.conflictNoChanges}</p>}
  </section>;
}

export function EditorView({ loaded, custom, runtimeKey, onReload }: { loaded: PrototypeDraft; custom?: CustomPlayerRuntime; runtimeKey: string; onReload: () => void }) {
  const [state, dispatch] = useReducer(editorReducer, loaded, createEditorState);
  useDocumentTitle(editorDocumentTitle(state.doc.name));
  const [issues, setIssues] = useState<DisplayIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [copyFallback, setCopyFallback] = useState(false);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const runtime = useMemo(() => createPlayerRuntime({ navigate() {}, back() {}, openUrl() {}, restart() {} }, custom, state.doc.designSystem), [custom, state.doc.designSystem]);
  const definitions = useMemo(() => ({ ...resolveBuiltinSystem(state.doc.designSystem).definitions, ...custom?.definitions }), [custom, state.doc.designSystem]);
  const customTypes = useMemo(() => new Set(Object.keys(custom?.definitions ?? {})), [custom]);
  const customDefinitions = custom?.definitions;
  const screen = state.doc.screens.find((item) => item.id === state.selection.screenId) ?? state.doc.screens[0]!;
  const canUndo = state.past.length > 0;
  const canRedo = state.future.length > 0;

  // Защита правок (W2-2): SPA-уход при dirty блокируется confirm-диалогом,
  // закрытие вкладки — нативным beforeunload.
  const blocker = useBlocker(useCallback(
    ({ currentLocation, nextLocation }: { currentLocation: { pathname: string }; nextLocation: { pathname: string } }) =>
      state.dirty && currentLocation.pathname !== nextLocation.pathname,
    [state.dirty],
  ));
  useEffect(() => { if (blocker.state === "blocked" && !state.dirty) blocker.reset(); }, [blocker, state.dirty]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (state.dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [state.dirty]);
  useEffect(() => { if (copyFallback) fallbackRef.current?.select(); }, [copyFallback]);

  // Ctrl+Z / Ctrl+Shift+Z (Cmd на mac). В текстовых полях не срабатывает —
  // нативный text-undo внутри поля остаётся живым (W2-2).
  useEffect(() => {
    const isTextTarget = (target: EventTarget | null) => target instanceof HTMLElement
      && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "z") return;
      if (isTextTarget(event.target)) return;
      event.preventDefault();
      dispatch({ type: event.shiftKey ? "redo" : "undo" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Сохранение с baseRev (W2-4): обычный save идёт от state.baseRev, «Перезаписать»
  // из диалога конфликта — от свежезагруженного remote rev. Повторная гонка (снова
  // 409) честно перезапускает цикл: новый fetch remote-драфта → новый diff → диалог.
  const runSave = async (baseRev: number) => {
    setIssues([]); setConflict(null);
    const parsed = prototypeDocSchema.safeParse(state.doc);
    if (!parsed.success) { setIssues(humanizeIssues(state.doc, parsed.error.issues)); return; }
    const validated = validatePrototype(parsed.data, { definitions });
    if (validated.errors.length) { setIssues(humanizeIssues(state.doc, validated.errors)); return; }
    setSaving(true);
    try {
      // Pass through the figma provenance that came with the draft so an editor save
      // does not erase it; null (or a legacy draft without the field) omits it (WF-5).
      const result = await savePrototype(state.doc.id, parsed.data, baseRev, loaded.figma ?? null);
      dispatch({ type: "saved", rev: result.rev, doc: parsed.data });
      setIssues([]);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // Трёхсторонний diff: base = savedDoc (checkpoint загруженной ревизии),
        // local = текущие правки, remote = свежезагруженный серверный драфт.
        try {
          const remote = await getPrototypeDraft(state.doc.id);
          setConflict({ remoteRev: remote.rev, remoteChanges: diffDocs(state.savedDoc, remote.doc), localChanges: diffDocs(state.savedDoc, parsed.data) });
        } catch {
          setIssues([{ path: editor.diffDocLabel, message: formatApiError(error.code, { message: error.message, status: error.status, currentRev: error.currentRev }) }]);
        }
      } else if (error instanceof ApiError && error.status === 422) setIssues(humanizeIssues(state.doc, error.issues));
      else if (error instanceof ApiError) setIssues([{ path: editor.diffDocLabel, message: formatApiError(error.code, { message: error.message, status: error.status, currentRev: error.currentRev, currentVersion: error.currentVersion }) }]);
      else setIssues([{ path: editor.diffDocLabel, message: error instanceof Error ? error.message : String(error) }]);
    } finally { setSaving(false); }
  };
  const save = () => runSave(state.baseRev);
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error(editor.clipboardUnavailable);
      await navigator.clipboard.writeText(JSON.stringify(state.doc, null, 2));
    } catch { setCopyFallback(true); }
  };

  // h-dvh: на /p/*-маршрутах глобальный app-header схлопнут (WF-4), поэтому
  // редактор владеет всей высотой вьюпорта. Родительский grid (min-h-dvh) не
  // ограничивает высоту ряда — h-full здесь не работает, страница бы скроллилась,
  // а канвас+инспектор теряли бы приоритет высоты (W2-1).
  return <main className="flex h-dvh min-h-0 w-full min-w-0 max-w-[100vw] flex-col overflow-hidden bg-white">
    <PrototypeChrome
      prototypeId={state.doc.id}
      prototypeName={state.doc.name}
      view="editor"
      status={<>
        {state.dirty ? <span className="text-eui-magenta" aria-label={editor.dirtyAria}>●</span> : null}
        <span aria-live="polite" className="rounded-full bg-eui-lilac-100 px-3 py-1 text-xs text-eui-slate-500">{saving ? editor.saving : state.dirty ? editor.notSaved : editor.saved}</span>
      </>}
      actions={<>
        <button type="button" disabled={!canUndo} onClick={() => dispatch({ type: "undo" })} title={editor.undoTitle} aria-label={editor.undoTitle} className={`${pillGhost} disabled:opacity-50`}>{editor.undo}</button>
        <button type="button" disabled={!canRedo} onClick={() => dispatch({ type: "redo" })} title={editor.redoTitle} aria-label={editor.redoTitle} className={`${pillGhost} disabled:opacity-50`}>{editor.redo}</button>
        <button type="button" disabled={saving} onClick={save} className={`${pillPrimary} disabled:opacity-50`}>{editor.save}</button>
      </>}
    />
    {issues.length > 0 ? <div className="border-b border-eui-ink/10 bg-white px-6 py-3 font-eui-ui"><Issues issues={issues} /></div> : null}
    <EditorScreenStrip doc={state.doc} registry={runtime.registry} handlers={runtime.handlers} runtimeKey={runtimeKey} stateEpoch={state.stateEpoch} selectedScreenId={screen.id} onSelect={(screenId) => dispatch({ type: "select-screen", screenId })} customTypes={customTypes} customDefinitions={customDefinitions} />
    <div className="flex min-h-0 flex-1"><section className="min-w-0 flex-1 overflow-auto bg-eui-lav p-6" aria-label={editor.canvasAria}><EditorCanvas doc={state.doc} screen={screen} registry={runtime.registry} handlers={runtime.handlers} runtimeKey={runtimeKey} stateEpoch={state.stateEpoch} selectedKey={state.selection.elementKey} onSelect={(elementKey) => dispatch({ type: "select-element", elementKey })} customTypes={customTypes} customDefinitions={customDefinitions} /></section><DocEpochContext.Provider value={state.docEpoch}><InspectorPanel state={state} definitions={definitions} dispatch={dispatch} /></DocEpochContext.Provider></div>
    {conflict ? <div role="dialog" aria-modal="true" aria-label={editor.conflictDialogAria} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 font-eui-ui">
      <div className="w-full max-w-xl rounded-2xl bg-white p-5 shadow-xl">
        <h2 className="font-eui-display text-lg font-medium">{editor.conflictDialogTitle(conflict.remoteRev)}</h2>
        <p className="mt-1 text-sm text-eui-slate-500">{editor.conflictBody}</p>
        <div className="mt-4 flex flex-col gap-4">
          <ChangeList title={editor.conflictTheirsTitle} changes={conflict.remoteChanges} />
          <ChangeList title={editor.conflictYoursTitle} changes={conflict.localChanges} />
        </div>
        <p className="mt-4 text-sm text-eui-magenta">{editor.conflictOverwriteHint}</p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button type="button" className={pillGhost} onClick={copy}>{editor.copyLocalJson}</button>
          <button type="button" className={pillGhost} onClick={onReload}>{editor.reloadDraft}</button>
          <button type="button" className={pillGhost} onClick={() => setConflict(null)}>{editor.conflictCancel}</button>
          <button type="button" disabled={saving} className={`${pillPrimary} disabled:opacity-50`} onClick={() => runSave(conflict.remoteRev)}>{editor.conflictOverwrite}</button>
        </div>
      </div>
    </div> : null}
    {blocker.state === "blocked" ? <div role="dialog" aria-modal="true" aria-label={editor.leaveDialogAria} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 font-eui-ui">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
        <h2 className="font-eui-display text-lg font-medium">{editor.leaveTitle}</h2>
        <p className="mt-1 text-sm text-eui-slate-500">{editor.leaveBody}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={pillGhost} onClick={() => blocker.reset()}>{editor.leaveStay}</button>
          <button type="button" className={pillPrimary} onClick={() => blocker.proceed()}>{editor.leaveConfirm}</button>
        </div>
      </div>
    </div> : null}
    {copyFallback ? <div role="dialog" aria-modal="true" aria-label={editor.copyDialogAria} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"><div className="w-full max-w-3xl rounded-2xl bg-eui-lilac-100 p-5 shadow-xl"><h2 className="font-eui-display text-lg font-medium">{editor.copyDialogTitle}</h2><p role="status" className="mt-1 font-eui-ui text-sm text-eui-magenta">{editor.copyUnavailable}</p><textarea ref={fallbackRef} readOnly className="mt-4 h-96 w-full rounded-xl border border-eui-ink/15 bg-white p-3 font-mono text-xs" value={JSON.stringify(state.doc, null, 2)} /><button type="button" className={`${pillGhost} mt-3 font-eui-ui`} onClick={() => setCopyFallback(false)}>{editor.close}</button></div></div> : null}
  </main>;
}
