import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useBlocker } from "react-router";
import { ApiError, getPrototypeDraft, getPrototypeRevisionFull, listPrototypeVersions, publishPrototype, restorePrototype, savePrototype, type FigmaProvenance, type PrototypeDraft, type ReadinessLocation } from "../api/client";
import type { CustomPlayerRuntime } from "../catalog/runtime";
import { createPlayerRuntime } from "../catalog/runtime";
import { hostPrimitiveDefinitions } from "../catalog/hostPrimitives/definitions";
import { ThemeStyle, useDesignSystemTheme } from "../designSystems/theme";
import { prototypeDocSchema } from "../prototype/schema";
import { hostKeyOf, type CompositionDoc } from "../prototype/composition";
import { validatePrototype } from "../prototype/validate";
import { inputBase, inputLabel, pillGhost, pillPrimary } from "../app/chrome";
import { ConfirmModal, Modal } from "../app/Modal";
import { PrototypeChrome } from "../app/PrototypeChrome";
import { formatApiError } from "../app/strings/common";
import { editor, editorDocumentTitle } from "../app/strings/editor";
import { useDocumentTitle } from "../app/useDocumentTitle";
import { EditorCanvas } from "./EditorCanvas";
import { compositionMapFromPins, expandForEditor } from "./compositions";
import { createEditorState, editorReducer } from "./editorReducer";
import { EditorScreenStrip } from "./EditorScreenStrip";
import { InspectorPanel } from "./InspectorPanel";
import { HistoryPanel } from "./HistoryPanel";
import { ReadinessPanel } from "./ReadinessPanel";
import { diffDocs, formatDocChange, humanizeIssues, type DisplayIssue, type DocChange } from "./docDiff";
import { DocEpochContext } from "./propsForm/PropsForm";

function Issues({ issues }: { issues: DisplayIssue[] }) {
  return issues.length ? <div role="alert" className="max-h-28 overflow-y-auto rounded-popover bg-eui-lilac-100 p-3 text-sm text-pay-red"><p className="font-medium">{editor.fixIssues}</p><ul className="list-disc pl-5">{issues.map((issue, index) => <li key={`${issue.path}:${index}`}><span className="font-medium">{issue.path}</span>: {issue.message}</li>)}</ul></div> : null;
}

/** Диалог 409 (W2-4): трёхсторонний diff base/local/remote и явное подтверждение перезаписи. */
type ConflictState = { remoteRev: number; remoteChanges: DocChange[]; localChanges: DocChange[] };
type RestoreTarget = { rev: number; label: string };

function ChangeList({ title, changes }: { title: string; changes: DocChange[] }) {
  return <section>
    <h3 className="text-sm font-medium">{title}</h3>
    {changes.length
      ? <ul className="mt-1 max-h-40 list-disc overflow-y-auto pl-5 text-sm text-eui-slate-500">{changes.map((change, index) => <li key={index}>{formatDocChange(change)}</li>)}</ul>
      : <p className="mt-1 text-sm text-eui-slate-500">{editor.conflictNoChanges}</p>}
  </section>;
}

export function EditorView({ loaded, custom, runtimeKey, onReload }: { loaded: PrototypeDraft; custom?: CustomPlayerRuntime; runtimeKey: string; onReload: () => void }) {
  // Редактор владеет **авторским** документом: раскрытые ключи `<hostKey>$<innerKey>`
  // живут только в render-пути (см. expansion ниже), а в save уходит state.doc.
  const [state, dispatch] = useReducer(editorReducer, loaded, (draft: PrototypeDraft) => createEditorState({ doc: draft.authoredDoc ?? draft.doc, rev: draft.rev }));
  useDocumentTitle(editorDocumentTitle(state.doc.name));
  const [issues, setIssues] = useState<DisplayIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishedVersion, setPublishedVersion] = useState<number | null>(null);
  const [currentFigma, setCurrentFigma] = useState<FigmaProvenance | null>(loaded.figma ?? null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [readinessOpen, setReadinessOpen] = useState(false);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [restoringRev, setRestoringRev] = useState<number | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<RestoreTarget | null>(null);
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);
  const [publishMessage, setPublishMessage] = useState("");
  // Отложенная публикация «сохранить и опубликовать» (W3-1): чистая оркестрация,
  // на рендер не влияет — живёт в ref, продолжение в success-ветке runSave.
  const publishIntentRef = useRef<{ message?: string } | null>(null);
  const [publishNotice, setPublishNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [copyFallback, setCopyFallback] = useState(false);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const runtime = useMemo(() => createPlayerRuntime({ navigate() {}, back() {}, openUrl() {}, restart() {} }, custom, state.doc.designSystem), [custom, state.doc.designSystem]);
  const definitions = useMemo(() => ({
    ...(import.meta.env.MODE === "test" ? globalThis.__EUI_LEGACY_TEST_RUNTIME__?.definitions : undefined),
    ...custom?.definitions,
    ...hostPrimitiveDefinitions,
  }), [custom]);
  const customTypes = useMemo(() => new Set(Object.keys(custom?.definitions ?? {})), [custom]);
  // Композиции: пины ревизии + созданные в этой сессии (вставка/извлечение).
  const [sessionCompositions, setSessionCompositions] = useState<Record<string, CompositionDoc>>({});
  const compositions = useMemo(
    () => ({ ...compositionMapFromPins(loaded.compositions), ...sessionCompositions }),
    [loaded.compositions, sessionCompositions],
  );
  const registerComposition = useCallback((id: string, doc: CompositionDoc) => {
    setSessionCompositions((current) => ({ ...current, [id]: doc }));
  }, []);
  // Раскрытие пересчитывается на каждую правку: холст и лента рендерят раскрытый документ.
  const expansion = useMemo(() => expandForEditor(state.doc, compositions), [compositions, state.doc]);
  const customDefinitions = custom?.definitions;
  const themeContent = useDesignSystemTheme(state.doc.designSystem, loaded.designSystemMetaVersion);
  const screen = state.doc.screens.find((item) => item.id === state.selection.screenId) ?? state.doc.screens[0]!;
  const renderedScreen = expansion.doc.screens.find((item) => item.id === screen.id) ?? screen;
  // Выделен авторский host-ключ — на холсте подсвечивается корень раскрытой композиции.
  const canvasSelectedKey = state.selection.elementKey === null
    ? null
    : expansion.hostRootKeys[state.selection.elementKey] ?? state.selection.elementKey;
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
  // Стал ли драфт новее loaded.rev (save в этой сессии) — гейт против stale-ответа
  // listPrototypeVersions, прилетевшего после сохранения.
  const savedSinceLoadRef = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    savedSinceLoadRef.current = false;
    void listPrototypeVersions(loaded.doc.id, controller.signal).then((versions) => {
      if (savedSinceLoadRef.current) return;
      const headVersion = versions.find((version) => version.rev === loaded.rev);
      setPublishedVersion(headVersion?.version ?? null);
    }).catch((error) => { if (!(error instanceof DOMException && error.name === "AbortError")) setPublishedVersion(null); });
    return () => controller.abort();
  }, [loaded.doc.id, loaded.rev]);

  // Ссылка из readiness-отчёта: выделяем экран и, если он указан, элемент.
  const selectLocation = useCallback((location: ReadinessLocation) => {
    if (location.screenId) dispatch({ type: "select-screen", screenId: location.screenId });
    if (location.elementKey) dispatch({ type: "select-element", elementKey: location.elementKey });
  }, []);

  const runPublish = useCallback(async (baseRev: number, message?: string) => {
    setIssues([]); setPublishNotice(null); setPublishing(true);
    try {
      const result = await publishPrototype(state.doc.id, baseRev, message);
      setPublishedVersion(result.version);
      setHistoryRefreshKey((key) => key + 1);
    } catch (error) {
      if (error instanceof ApiError && error.code === "publish_blocked") {
        // Гейты вернули 409: раскрываем панель, чтобы список замечаний был перед глазами.
        setReadinessOpen(true);
        const blocking = (error.report as { blocking?: string[] } | undefined)?.blocking ?? [];
        setPublishNotice(editor.readinessBlocked(blocking.map((id) => editor.readinessGateNames[id] ?? id).join(", ")));
      } else if (error instanceof ApiError && error.code === "already_published" && error.currentVersion !== undefined) {
        setPublishedVersion(error.currentVersion);
        setPublishNotice(editor.alreadyPublished(error.currentVersion));
      } else if (error instanceof ApiError) {
        setIssues([{ path: editor.diffDocLabel, message: formatApiError(error.code, { message: error.message, status: error.status, currentRev: error.currentRev, currentVersion: error.currentVersion }) }]);
      } else setIssues([{ path: editor.diffDocLabel, message: error instanceof Error ? error.message : String(error) }]);
    } finally { setPublishing(false); }
  }, [state.doc.id]);

  // Сохранение с baseRev (W2-4): обычный save идёт от state.baseRev, «Перезаписать»
  // из диалога конфликта — от свежезагруженного remote rev. Повторная гонка (снова
  // 409) честно перезапускает цикл: новый fetch remote-драфта → новый diff → диалог.
  const runSave = useCallback(async (baseRev: number) => {
    setIssues([]); setConflict(null);
    const parsed = prototypeDocSchema.safeParse(state.doc);
    if (!parsed.success) { publishIntentRef.current = null; setIssues(humanizeIssues(state.doc, parsed.error.issues)); return; }
    const validated = validatePrototype(parsed.data, { definitions });
    if (validated.errors.length) { publishIntentRef.current = null; setIssues(humanizeIssues(state.doc, validated.errors)); return; }
    setSaving(true);
    try {
      // Pass through the figma provenance that came with the draft so an editor save
      // does not erase it; null (or a legacy draft without the field) omits it (WF-5).
      const result = await savePrototype(state.doc.id, parsed.data, baseRev, currentFigma);
      dispatch({ type: "saved", rev: result.rev, doc: parsed.data });
      savedSinceLoadRef.current = true;
      setPublishedVersion(null);
      setHistoryRefreshKey((key) => key + 1);
      setIssues([]);
      const intent = publishIntentRef.current;
      if (intent) {
        publishIntentRef.current = null;
        await runPublish(result.rev, intent.message);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // Трёхсторонний diff: base = savedDoc (checkpoint загруженной ревизии),
        // local = текущие правки, remote = свежезагруженный серверный драфт.
        try {
          const remote = await getPrototypeDraft(state.doc.id);
          const remoteDoc = remote.authoredDoc ?? remote.doc;
          setConflict({ remoteRev: remote.rev, remoteChanges: diffDocs(state.savedDoc, remoteDoc), localChanges: diffDocs(state.savedDoc, parsed.data) });
        } catch {
          publishIntentRef.current = null;
          setIssues([{ path: editor.diffDocLabel, message: formatApiError(error.code, { message: error.message, status: error.status, currentRev: error.currentRev }) }]);
        }
      } else if (error instanceof ApiError && error.status === 422) { publishIntentRef.current = null; setIssues(humanizeIssues(state.doc, error.issues)); }
      else if (error instanceof ApiError) { publishIntentRef.current = null; setIssues([{ path: editor.diffDocLabel, message: formatApiError(error.code, { message: error.message, status: error.status, currentRev: error.currentRev, currentVersion: error.currentVersion }) }]); }
      else { publishIntentRef.current = null; setIssues([{ path: editor.diffDocLabel, message: error instanceof Error ? error.message : String(error) }]); }
    } finally { setSaving(false); }
  }, [currentFigma, definitions, runPublish, state.doc, state.savedDoc]);
  const save = useCallback(() => runSave(state.baseRev), [runSave, state.baseRev]);

  // Ctrl+Z / Ctrl+Shift+Z (Cmd на mac). В текстовых полях не срабатывает —
  // нативный text-undo внутри поля остаётся живым (W2-2). Ctrl/Cmd+S, напротив,
  // сохраняет и из полей инспектора; пока save выполняется, повторный PUT не стартует.
  useEffect(() => {
    const isTextTarget = (target: EventTarget | null) => target instanceof HTMLElement
      && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        if (!saving) void save();
        return;
      }
      if (key !== "z" || isTextTarget(event.target)) return;
      event.preventDefault();
      dispatch({ type: event.shiftKey ? "redo" : "undo" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [save, saving]);

  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error(editor.clipboardUnavailable);
      await navigator.clipboard.writeText(JSON.stringify(state.doc, null, 2));
    } catch { setCopyFallback(true); }
  };

  const confirmPublish = () => {
    const message = publishMessage.trim() || undefined;
    setPublishDialogOpen(false);
    setPublishMessage("");
    if (!state.dirty) { void runPublish(state.baseRev, message); return; }
    publishIntentRef.current = { message };
    void save();
  };

  const runRestore = useCallback(async ({ rev }: RestoreTarget) => {
    setRestoreTarget(null);
    setRestoringRev(rev);
    setIssues([]);
    setConflict(null);
    publishIntentRef.current = null;
    try {
      // Snapshot читается до мутации: после успешного POST не должно оставаться
      // сетевого шага, ошибка которого оставит клиент на старом baseRev.
      const revision = await getPrototypeRevisionFull(state.doc.id, rev);
      const restored = await restorePrototype(state.doc.id, rev, state.baseRev);
      dispatch({ type: "rebase", rev: restored.rev, doc: revision.authoredDoc ?? revision.doc });
      setCurrentFigma(revision.figma ?? null);
      savedSinceLoadRef.current = true;
      setPublishedVersion(null);
      setPublishNotice(null);
      setHistoryRefreshKey((key) => key + 1);
    } catch (error) {
      if (error instanceof ApiError) setIssues([{ path: editor.diffDocLabel, message: formatApiError(error.code, { message: error.message, status: error.status, currentRev: error.currentRev }) }]);
      else setIssues([{ path: editor.diffDocLabel, message: error instanceof Error ? error.message : String(error) }]);
    } finally { setRestoringRev(null); }
  }, [state.baseRev, state.doc.id]);

  const requestRestore = useCallback((rev: number, label: string) => {
    const target = { rev, label };
    if (state.dirty) setRestoreTarget(target);
    else void runRestore(target);
  }, [runRestore, state.dirty]);

  // h-dvh: на /p/*-маршрутах глобальный app-header схлопнут (WF-4), поэтому
  // редактор владеет всей высотой вьюпорта. Родительский grid (min-h-dvh) не
  // ограничивает высоту ряда — h-full здесь не работает, страница бы скроллилась,
  // а канвас+инспектор теряли бы приоритет высоты (W2-1).
  return <main className="flex h-dvh min-h-0 w-full min-w-0 max-w-[100vw] flex-col overflow-hidden bg-white">
    <ThemeStyle content={themeContent} />
    <PrototypeChrome
      prototypeId={state.doc.id}
      prototypeName={state.doc.name}
      view="editor"
      status={<>
        {state.dirty ? <span className="text-pay-red" aria-label={editor.dirtyAria}>●</span> : null}
        <span aria-live="polite" className="rounded-full bg-eui-lilac-100 px-3 py-1 text-xs text-eui-slate-500">{saving ? editor.saving : state.dirty ? editor.notSaved : editor.saved}</span>
        {publishedVersion !== null ? <span aria-live="polite" className="rounded-full bg-eui-lilac-100 px-3 py-1 text-xs text-eui-slate-500">{editor.publishedVersion(publishedVersion)}</span> : null}
      </>}
      actions={<>
        <button type="button" disabled={!canUndo} onClick={() => dispatch({ type: "undo" })} title={editor.undoTitle} aria-label={editor.undoTitle} className={`${pillGhost} disabled:opacity-50`}>{editor.undo}</button>
        <button type="button" disabled={!canRedo} onClick={() => dispatch({ type: "redo" })} title={editor.redoTitle} aria-label={editor.redoTitle} className={`${pillGhost} disabled:opacity-50`}>{editor.redo}</button>
        <button type="button" aria-expanded={historyOpen} onClick={() => setHistoryOpen((open) => !open)} className={pillGhost}>{editor.history}</button>
        <button type="button" aria-expanded={readinessOpen} onClick={() => setReadinessOpen((open) => !open)} className={pillGhost}>{editor.readiness}</button>
        <button type="button" disabled={saving} onClick={save} className={`${pillPrimary} disabled:opacity-50`}>{editor.save}</button>
        <button type="button" disabled={saving || publishing} onClick={() => { setPublishNotice(null); setPublishDialogOpen(true); }} className={`${pillPrimary} disabled:opacity-50`}>{publishing ? editor.publishing : editor.publish}</button>
      </>}
    />
    {publishNotice ? <div role="status" className="border-b border-eui-ink/10 bg-eui-lilac-100 px-6 py-3 font-eui-ui text-sm text-eui-slate-500">{publishNotice}</div> : null}
    {issues.length > 0 ? <div className="border-b border-eui-ink/10 bg-white px-6 py-3 font-eui-ui"><Issues issues={issues} /></div> : null}
    {historyOpen ? <HistoryPanel prototypeId={state.doc.id} headRev={state.baseRev} refreshKey={historyRefreshKey} restoringRev={restoringRev} onRestore={requestRestore} /> : null}
    {readinessOpen ? <ReadinessPanel prototypeId={state.doc.id} refreshKey={historyRefreshKey} onSelectLocation={selectLocation} /> : null}
    <EditorScreenStrip doc={expansion.doc} registry={runtime.registry} handlers={runtime.handlers} runtimeKey={runtimeKey} stateEpoch={state.stateEpoch} selectedScreenId={screen.id} onSelect={(screenId) => dispatch({ type: "select-screen", screenId })} customTypes={customTypes} customDefinitions={customDefinitions} compositionRefs={expansion.compositionRefs} themeContent={themeContent} />
    <div className="flex min-h-0 flex-1"><section className="min-w-0 flex-1 overflow-auto bg-eui-lav p-6" aria-label={editor.canvasAria}><EditorCanvas doc={expansion.doc} screen={renderedScreen} registry={runtime.registry} handlers={runtime.handlers} runtimeKey={runtimeKey} stateEpoch={state.stateEpoch} selectedKey={canvasSelectedKey} onSelect={(elementKey) => dispatch({ type: "select-element", elementKey: elementKey === null ? null : hostKeyOf(elementKey) })} customTypes={customTypes} customDefinitions={customDefinitions} compositionRefs={expansion.compositionRefs} themeContent={themeContent} /></section><DocEpochContext.Provider value={state.docEpoch}><InspectorPanel state={state} definitions={definitions} dispatch={dispatch} pins={loaded.components} compositions={compositions} compositionPins={loaded.compositions} onCompositionRegistered={registerComposition} /></DocEpochContext.Provider></div>
    {publishDialogOpen ? <Modal
      title={editor.publishDialogTitle}
      onClose={() => { setPublishDialogOpen(false); setPublishMessage(""); }}
      footer={<>
        <button type="button" className={pillGhost} onClick={() => { setPublishDialogOpen(false); setPublishMessage(""); }}>{editor.publishCancel}</button>
        <button type="button" className={pillPrimary} onClick={confirmPublish}>{state.dirty ? editor.saveAndPublish : editor.publishConfirm}</button>
      </>}
    >
      <p className="mt-1 text-sm text-eui-slate-500">{editor.publishDialogBody}</p>
      <div className="-mx-7 mt-5 border-y border-pay-lavender"><ReadinessPanel prototypeId={state.doc.id} refreshKey={historyRefreshKey} /></div>
      <label className={`${inputLabel} mt-5`}>{editor.publishMessageLabel}
        <textarea value={publishMessage} onChange={(event) => setPublishMessage(event.target.value)} placeholder={editor.publishMessagePlaceholder} className={`${inputBase} mt-1.5 min-h-24 w-full`} />
      </label>
    </Modal> : null}
    {restoreTarget ? <ConfirmModal
      title={editor.restoreDialogTitle(restoreTarget.label)}
      body={<><span className="block font-medium text-pay-red">{editor.restoreDiscardWarning}</span><span className="mt-1 block">{editor.restoreBody}</span></>}
      confirmLabel={editor.restoreConfirm}
      cancelLabel={editor.restoreCancel}
      onConfirm={() => void runRestore(restoreTarget)}
      onClose={() => setRestoreTarget(null)}
    /> : null}
    {conflict ? <Modal
      title={editor.conflictDialogTitle(conflict.remoteRev)}
      onClose={() => { setConflict(null); publishIntentRef.current = null; }}
      footer={<>
        <button type="button" className={pillGhost} onClick={copy}>{editor.copyLocalJson}</button>
        <button type="button" className={pillGhost} onClick={onReload}>{editor.reloadDraft}</button>
        <button type="button" className={pillGhost} onClick={() => { setConflict(null); publishIntentRef.current = null; }}>{editor.conflictCancel}</button>
        <button type="button" disabled={saving} className={`${pillPrimary} disabled:opacity-50`} onClick={() => runSave(conflict.remoteRev)}>{editor.conflictOverwrite}</button>
      </>}
    >
      <p className="mt-1 text-sm text-eui-slate-500">{editor.conflictBody}</p>
      <div className="mt-4 flex flex-col gap-4">
        <ChangeList title={editor.conflictTheirsTitle} changes={conflict.remoteChanges} />
        <ChangeList title={editor.conflictYoursTitle} changes={conflict.localChanges} />
      </div>
      <p className="mt-4 text-sm text-pay-red">{editor.conflictOverwriteHint}</p>
    </Modal> : null}
    {blocker.state === "blocked" ? <ConfirmModal
      title={editor.leaveTitle}
      body={editor.leaveBody}
      confirmLabel={editor.leaveConfirm}
      cancelLabel={editor.leaveStay}
      onConfirm={() => blocker.proceed()}
      onClose={() => blocker.reset()}
    /> : null}
    {copyFallback ? <Modal
      title={editor.copyDialogTitle}
      onClose={() => setCopyFallback(false)}
      footer={<button type="button" className={pillGhost} onClick={() => setCopyFallback(false)}>{editor.close}</button>}
    >
      <p role="status" className="mt-1 text-sm text-pay-red">{editor.copyUnavailable}</p>
      <textarea ref={fallbackRef} readOnly className={`${inputBase} mt-4 h-96 w-full font-mono text-xs`} value={JSON.stringify(state.doc, null, 2)} />
    </Modal> : null}
  </main>;
}
