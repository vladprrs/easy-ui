import { useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { ApiError, PROTOTYPE_KINDS, prototypeKindOf, setPrototypeLifecycle, setPrototypeStatus, type PrototypeKind, type PrototypeStatus, type PrototypeSummary } from "../../api/client";
import { downloadBundle } from "../../api/bundles";
import { inputBase, pillGhost, pillPrimary } from "../../app/chrome";
import { gallery } from "../../app/strings/gallery";
import { ReadinessPanel } from "../../editor/ReadinessPanel";
import { useDismissableDetails } from "../useDismissableDetails";

export interface CardActionsMenuProps {
  prototype: PrototypeSummary;
  isOwner: boolean;
  onChanged: () => void;
}

const menuItem = "block w-full rounded-xl px-3 py-2 text-left text-sm hover:bg-eui-lav focus-visible:outline-2 focus-visible:outline-eui-brand disabled:opacity-50";

type LifecycleDialogState = { kind: PrototypeKind; tags: string; saving: boolean; error: boolean };

/** «tag-a, tag-b» → ["tag-a","tag-b"]; сервер отвечает 422 на невалидные slug'и. */
export const parseTagsInput = (raw: string): string[] =>
  [...new Set(raw.split(",").map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0))];

export function CardActionsMenu({ prototype, isOwner, onChanged }: CardActionsMenuProps): ReactElement | null {
  const ref = useRef<HTMLDetailsElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<LifecycleDialogState | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  useDismissableDetails(ref, { locked: busy });

  const { latestVersion } = prototype;
  if (!isOwner && latestVersion === null) return null;

  const changeStatus = async (status: PrototypeStatus) => {
    setBusy(true);
    setError(null);
    try {
      await setPrototypeStatus(prototype.id, status);
      setBusy(false);
      if (ref.current) ref.current.open = false;
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 409 && cause.code === "prototype_not_renderable"
        ? gallery.restoreNotRenderable
        : gallery.statusChangeFailed);
      setBusy(false);
    }
  };

  const runExport = async () => {
    if (latestVersion === null) return;
    setDownloading(true);
    setExportError(null);
    try {
      await downloadBundle(`/api/prototypes/${encodeURIComponent(prototype.id)}/export?version=${latestVersion}`, `easy-ui-prototype-${prototype.id}-v${latestVersion}.zip`);
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : gallery.exportError);
    } finally {
      setDownloading(false);
    }
  };

  // Публикация из галереи — через диалог с readiness-отчётом (волна 4): решение
  // «делать прототип видимым» принимается, глядя на готовность головной ревизии.
  const openPublish = () => {
    if (ref.current) ref.current.open = false;
    setPublishOpen(true);
  };

  const openLifecycle = () => {
    if (ref.current) ref.current.open = false;
    setLifecycle({ kind: prototypeKindOf(prototype), tags: (prototype.tags ?? []).join(", "), saving: false, error: false });
  };

  const submitLifecycle = async () => {
    if (!lifecycle || lifecycle.saving) return;
    setLifecycle({ ...lifecycle, saving: true, error: false });
    try {
      await setPrototypeLifecycle(prototype.id, { kind: lifecycle.kind, tags: parseTagsInput(lifecycle.tags) });
      setLifecycle(null);
      onChanged();
    } catch {
      setLifecycle((current) => current ? { ...current, saving: false, error: true } : null);
    }
  };

  return <>
    <details ref={ref} className="relative">
      <summary aria-label={gallery.overflowActionsAria} className={`${pillGhost} cursor-pointer list-none bg-white [&::-webkit-details-marker]:hidden`}>
        <span aria-hidden="true" className="text-lg leading-none">⋯</span>
      </summary>
      <div className="absolute right-0 z-20 mt-2 w-56 rounded-2xl border border-eui-ink/10 bg-white p-2 shadow-xl">
        {isOwner ? <>
          {prototype.status === "private" ? <button type="button" className={menuItem} disabled={busy} onClick={openPublish}>{gallery.publish}</button> : null}
          {prototype.status === "published" ? <button type="button" className={menuItem} disabled={busy} onClick={() => void changeStatus("private")}>{gallery.unpublish}</button> : null}
          {prototype.status !== "archived" ? <button type="button" className={menuItem} disabled={busy} onClick={() => void changeStatus("archived")}>{gallery.archive}</button> : null}
          {prototype.status === "archived" ? <button type="button" className={menuItem} disabled={busy} onClick={() => void changeStatus("private")}>{gallery.restore}</button> : null}
          <button type="button" className={menuItem} disabled={busy} onClick={openLifecycle}>{gallery.lifecycleAction}</button>
        </> : <button type="button" className={menuItem} disabled={downloading} onClick={() => void runExport()}>{downloading ? gallery.exporting : gallery.exportLatest}</button>}
      </div>
    </details>
    {publishOpen ? createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <section role="dialog" aria-modal="true" aria-label={gallery.publishDialogAria} className="w-full max-w-lg rounded-3xl bg-white p-6 text-left shadow-2xl">
        <h2 className="font-eui-display text-xl font-medium">{gallery.publishDialogTitle}</h2>
        <p className="mt-1 text-sm text-eui-slate-500">{gallery.publishDialogBody}</p>
        <div className="-mx-6 mt-4 border-y border-eui-ink/10"><ReadinessPanel prototypeId={prototype.id} /></div>
        {error ? <p role="alert" className="mt-3 text-sm text-eui-magenta">{error}</p> : null}
        <div className="flex flex-wrap justify-end gap-2 pt-4">
          <button type="button" className={pillGhost} disabled={busy} onClick={() => setPublishOpen(false)}>{gallery.cancel}</button>
          <button type="button" className={pillPrimary} disabled={busy} onClick={() => void changeStatus("published").then(() => setPublishOpen(false))}>{busy ? gallery.publishing : gallery.publishConfirm}</button>
        </div>
      </section>
    </div>, document.body) : null}
    {lifecycle ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <section role="dialog" aria-modal="true" aria-label={gallery.lifecycleDialogAria} className="w-full max-w-md rounded-3xl bg-white p-6 text-left shadow-2xl">
        <h2 className="font-eui-display text-xl font-medium">{gallery.lifecycleDialogTitle}</h2>
        <form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void submitLifecycle(); }}>
          <label className="block text-sm font-medium">{gallery.kindLabel}
            <select className={`${inputBase} mt-1.5 w-full bg-white`} value={lifecycle.kind} disabled={lifecycle.saving}
              onChange={(event) => setLifecycle((current) => current ? { ...current, kind: event.target.value as PrototypeKind, error: false } : null)}>
              {PROTOTYPE_KINDS.map((kind) => <option key={kind} value={kind}>{gallery.kindNames[kind] ?? kind}</option>)}
            </select>
          </label>
          <label className="block text-sm font-medium">{gallery.lifecycleTagsLabel}
            <input className={`${inputBase} mt-1.5 w-full`} value={lifecycle.tags} disabled={lifecycle.saving}
              onChange={(event) => setLifecycle((current) => current ? { ...current, tags: event.target.value, error: false } : null)} />
          </label>
          <p className="text-xs text-eui-slate-500">{gallery.lifecycleTagsHint}</p>
          {lifecycle.error ? <p role="alert" className="text-sm text-eui-magenta">{gallery.lifecycleFailed}</p> : null}
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <button type="button" className={pillGhost} disabled={lifecycle.saving} onClick={() => setLifecycle(null)}>{gallery.cancel}</button>
            <button type="submit" className={pillPrimary} disabled={lifecycle.saving}>{lifecycle.saving ? gallery.lifecycleSaving : gallery.lifecycleSave}</button>
          </div>
        </form>
      </section>
    </div> : null}
    {busy ? <span role="status" className="self-center text-xs text-eui-slate-500">{gallery.statusChanging}</span> : null}
    {error ? <p role="alert" className="basis-full text-xs text-eui-magenta">{error}</p> : null}
    {exportError ? <p role="alert" className="basis-full text-xs text-eui-magenta">{exportError}</p> : null}
  </>;
}
