import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link } from "react-router";
import { ApiError, savePrototype, type PrototypeDraft } from "../api/client";
import type { CustomPlayerRuntime } from "../catalog/runtime";
import { createPlayerRuntime } from "../catalog/runtime";
import { getDesignSystem } from "../designSystems";
import { prototypeDocSchema } from "../prototype/schema";
import { validatePrototype } from "../prototype/validate";
import { EditorCanvas } from "./EditorCanvas";
import { editorReducer, type EditorState } from "./editorReducer";
import { EditorScreenStrip } from "./EditorScreenStrip";
import { InspectorPanel } from "./InspectorPanel";

type DisplayIssue = { path: string; message: string };
function normalizeIssues(issues: unknown[] | undefined): DisplayIssue[] {
  return (issues ?? []).map((value) => {
    const issue = value && typeof value === "object" ? value as { path?: unknown; message?: unknown } : {};
    const path = Array.isArray(issue.path) ? `/${issue.path.map(String).join("/")}` : typeof issue.path === "string" ? issue.path : "/";
    return { path, message: typeof issue.message === "string" ? issue.message : String(value) };
  });
}

function Issues({ issues }: { issues: DisplayIssue[] }) {
  return issues.length ? <div role="alert" className="max-h-28 overflow-y-auto text-sm text-destructive"><p className="font-medium">Исправьте ошибки:</p><ul className="list-disc pl-5">{issues.map((issue, index) => <li key={`${issue.path}:${index}`}><code>{issue.path}</code>: {issue.message}</li>)}</ul></div> : null;
}

export function EditorView({ loaded, custom, runtimeKey, onReload }: { loaded: PrototypeDraft; custom?: CustomPlayerRuntime; runtimeKey: string; onReload: () => void }) {
  const [state, dispatch] = useReducer(editorReducer, loaded, ({ doc, rev }): EditorState => ({
    doc, baseRev: rev, dirty: false, stateEpoch: 0,
    selection: { screenId: doc.screens.some((screen) => screen.id === doc.startScreen) ? doc.startScreen : doc.screens[0]!.id, elementKey: null },
  }));
  const [issues, setIssues] = useState<DisplayIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const [conflictRev, setConflictRev] = useState<number | null>(null);
  const [copyFallback, setCopyFallback] = useState(false);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const runtime = useMemo(() => createPlayerRuntime({ navigate() {}, back() {}, openUrl() {}, restart() {} }, custom, state.doc.designSystem), [custom, state.doc.designSystem]);
  const definitions = useMemo(() => ({ ...getDesignSystem(state.doc.designSystem).definitions, ...custom?.definitions }), [custom, state.doc.designSystem]);
  const screen = state.doc.screens.find((item) => item.id === state.selection.screenId) ?? state.doc.screens[0]!;

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (state.dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [state.dirty]);
  useEffect(() => { if (copyFallback) fallbackRef.current?.select(); }, [copyFallback]);

  const save = async () => {
    setIssues([]); setConflictRev(null);
    const parsed = prototypeDocSchema.safeParse(state.doc);
    if (!parsed.success) { setIssues(normalizeIssues(parsed.error.issues)); return; }
    const validated = validatePrototype(parsed.data, { definitions });
    if (validated.errors.length) { setIssues(normalizeIssues(validated.errors)); return; }
    setSaving(true);
    try {
      const result = await savePrototype(state.doc.id, parsed.data, state.baseRev);
      dispatch({ type: "saved", rev: result.rev, doc: parsed.data });
      setIssues([]);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setConflictRev(error.currentRev ?? state.baseRev);
      else if (error instanceof ApiError && error.status === 422) setIssues(normalizeIssues(error.issues));
      else setIssues([{ path: "/", message: error instanceof Error ? error.message : String(error) }]);
    } finally { setSaving(false); }
  };
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API недоступен");
      await navigator.clipboard.writeText(JSON.stringify(state.doc, null, 2));
    } catch { setCopyFallback(true); }
  };

  return <main className="flex h-screen min-h-0 flex-col bg-muted/20">
    <header className="flex flex-wrap items-center justify-between gap-4 border-b bg-background px-6 py-3">
      <div className="flex items-center gap-4"><Link className="text-sm underline" to={`/p/${state.doc.id}/cjm`}>← Назад к CJM</Link><h1 className="text-xl font-semibold">{state.doc.name}{state.dirty ? <span className="ml-2 text-primary" aria-label="Есть несохранённые изменения">●</span> : null}</h1></div>
      <div className="flex items-center gap-3"><span aria-live="polite" className="text-sm text-muted-foreground">{saving ? "Сохранение…" : state.dirty ? "Не сохранено" : "Сохранено"}</span><button type="button" disabled={saving} onClick={save} className="rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50">Сохранить</button></div>
      <div className="basis-full"><Issues issues={issues} />{conflictRev !== null ? <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md border border-destructive p-3"><strong>Черновик изменён (rev {conflictRev})</strong><button type="button" className="underline" onClick={copy}>Скопировать локальный JSON</button><button type="button" className="underline" onClick={onReload}>Перезагрузить черновик (правки будут потеряны)</button></div> : null}</div>
    </header>
    <EditorScreenStrip doc={state.doc} registry={runtime.registry} handlers={runtime.handlers} runtimeKey={runtimeKey} stateEpoch={state.stateEpoch} selectedScreenId={screen.id} onSelect={(screenId) => dispatch({ type: "select-screen", screenId })} />
    <div className="flex min-h-0 flex-1"><section className="min-w-0 flex-1 overflow-auto p-6" aria-label="Холст редактора"><EditorCanvas doc={state.doc} screen={screen} registry={runtime.registry} handlers={runtime.handlers} runtimeKey={runtimeKey} stateEpoch={state.stateEpoch} selectedKey={state.selection.elementKey} onSelect={(elementKey) => dispatch({ type: "select-element", elementKey })} /></section><InspectorPanel state={state} definitions={definitions} dispatch={dispatch} /></div>
    {copyFallback ? <div role="dialog" aria-modal="true" aria-label="Локальный JSON" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"><div className="w-full max-w-3xl rounded-lg bg-background p-5 shadow-xl"><h2 className="text-lg font-semibold">Скопируйте локальный JSON вручную</h2><p role="status" className="mt-1 text-sm text-muted-foreground">Автоматическое копирование недоступно.</p><textarea ref={fallbackRef} readOnly className="mt-4 h-96 w-full rounded border p-3 font-mono text-xs" value={JSON.stringify(state.doc, null, 2)} /><button type="button" className="mt-3 rounded border px-3 py-2" onClick={() => setCopyFallback(false)}>Закрыть</button></div></div> : null}
  </main>;
}
