import { useEffect, useRef, useState, type ReactElement, type ReactNode, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { ApiError, listPrototypeVersions, PROTOTYPE_KINDS, prototypeKindOf, setPrototypeLifecycle, setPrototypeStatus, type PrototypeKind, type PrototypeStatus, type PrototypeSummary, type PrototypeVersionSummary } from "../../api/client";
import { downloadBundle } from "../../api/bundles";
import { headingDialog, inputBase, inputLabel, pillGhost, pillPrimary, popover } from "../../app/chrome";
import { common } from "../../app/strings/common";
import { gallery, versionLink } from "../../app/strings/gallery";
import { ReadinessPanel } from "../../editor/ReadinessPanel";
import { useDismissableDetails } from "../useDismissableDetails";

export interface CardActionsMenuProps {
  prototype: PrototypeSummary;
  isOwner: boolean;
  onShare: (prototypeId: string, latestVersion: number) => void;
  onChanged: () => void;
}

const menuItem = "block w-full rounded-item px-3 py-2 text-left text-sm text-eui-ink transition-colors duration-100 hover:bg-pay-lavender disabled:opacity-50";
const menuGroup = "px-3 pb-1 pt-2 text-xs font-medium text-eui-slate-500";

type LifecycleDialogState = { kind: PrototypeKind; tags: string; saving: boolean; error: boolean };
type VersionsState = { status: "idle" | "loading" | "ready" | "error"; data: PrototypeVersionSummary[] };

/** `«tag-a, tag-b»` → ["tag-a","tag-b"]; сервер отвечает 422 на невалидные slug'и. */
export const parseTagsInput = (raw: string): string[] =>
  [...new Set(raw.split(",").map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0))];

/** Разделитель групп — единственная «граница» внутри поповера (1px лаванда, макет 08). */
function Group({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return <div className="border-t border-pay-lavender first:border-t-0">
    <p className={menuGroup}>{label}</p>
    {children}
  </div>;
}

/**
 * Единственное меню карточки галереи (макет 01 + 08).
 *
 * До редизайна карточка несла шесть контролов в ряд (Презентация, CJM, Редактор, QR,
 * Версии, «⋯») — они конкурировали и с самой карточкой-ссылкой, и друг с другом.
 * Теперь основной клик — сама карточка (плеер), а всё остальное лежит здесь тремя
 * группами: куда открыть · чем поделиться · что изменить.
 */
export function CardActionsMenu({ prototype, isOwner, onShare, onChanged }: CardActionsMenuProps): ReactElement {
  const ref = useRef<HTMLDetailsElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<LifecycleDialogState | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [versions, setVersions] = useState<VersionsState>({ status: "idle", data: [] });
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => controllerRef.current?.abort(), []);
  useDismissableDetails(ref, { locked: busy });

  const { latestVersion } = prototype;
  const close = () => { if (ref.current) ref.current.open = false; };

  const changeStatus = async (status: PrototypeStatus) => {
    setBusy(true);
    setError(null);
    try {
      await setPrototypeStatus(prototype.id, status);
      setBusy(false);
      close();
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 409 && cause.code === "prototype_not_renderable"
        ? gallery.restoreNotRenderable
        : gallery.statusChangeFailed);
      setBusy(false);
    }
  };

  const exportUrl = (version: number | null) => `/api/prototypes/${encodeURIComponent(prototype.id)}/export${version === null ? "" : `?version=${version}`}`;
  const exportName = (version: number | null) => `easy-ui-prototype-${prototype.id}-${version === null ? "draft" : `v${version}`}.zip`;
  const runExport = async (key: string, version: number | null) => {
    setDownloading(key);
    setExportError(null);
    try {
      await downloadBundle(exportUrl(version), exportName(version));
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : gallery.exportError);
    } finally {
      setDownloading(null);
    }
  };

  // Версии — единственный запрос этого меню; он уходит только при раскрытии подменю.
  const loadVersions = () => {
    if (versions.status === "loading" || versions.status === "ready") return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setVersions((current) => ({ status: "loading", data: current.data }));
    void listPrototypeVersions(prototype.id, controller.signal).then(
      (data) => { if (!controller.signal.aborted) setVersions({ status: "ready", data }); },
      () => { if (!controller.signal.aborted) setVersions((current) => ({ status: "error", data: current.data })); },
    );
  };

  const openPublish = () => { close(); setPublishOpen(true); };
  const openLifecycle = () => {
    close();
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
      <summary aria-label={gallery.overflowActionsAria} className={`${pillGhost} cursor-pointer list-none px-3 py-1.5 [&::-webkit-details-marker]:hidden`}>
        <span aria-hidden="true" className="text-lg leading-none">⋯</span>
      </summary>
      <div className={`${popover} absolute right-0 z-20 mt-2 w-64`}>
        <Group label={gallery.menuGroupOpen}>
          <Link className={menuItem} to={`/p/${prototype.id}`}>{gallery.playerLink}</Link>
          <Link className={menuItem} to={`/p/${prototype.id}/cjm`}>{gallery.cjmLink}</Link>
          <Link className={menuItem} to={`/p/${prototype.id}/present`}>{gallery.presentLink}</Link>
          {isOwner ? <Link className={menuItem} to={`/p/${prototype.id}/edit`}>{gallery.editorLink}</Link> : null}
        </Group>
        {isOwner || latestVersion !== null ? <Group label={gallery.menuGroupShare}>
          {isOwner && latestVersion !== null
            ? <button type="button" className={menuItem} onClick={() => { close(); onShare(prototype.id, latestVersion); }}>{gallery.qrOnPhone}</button>
            : null}
          {latestVersion !== null ? <details className="group" onToggle={(event: SyntheticEvent<HTMLDetailsElement>) => { if (event.currentTarget.open) loadVersions(); }}>
            <summary className={`${menuItem} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>
              {gallery.versionsMenu} <span aria-hidden="true" className="text-eui-slate-400 group-open:hidden">›</span>
            </summary>
            <div aria-label={gallery.versionsMenuAria(prototype.name)} className="pb-1 pl-3">
              {versions.status === "idle" || versions.status === "loading" ? <p className="px-3 py-1 text-xs text-eui-slate-500" aria-live="polite">{gallery.versionsLoading}</p> : null}
              {versions.status === "error" ? <>
                <p role="alert" className="px-3 py-1 text-xs text-pay-red">{gallery.versionsLoadFailed}</p>
                <button type="button" className={`${pillGhost} mx-3 my-1`} onClick={loadVersions}>{common.retry}</button>
              </> : null}
              {versions.status === "ready" && !versions.data.length ? <p className="px-3 py-1 text-xs text-eui-slate-500">{gallery.noVersions}</p> : null}
              {versions.status === "ready" ? <ul>{versions.data.map((version) => <li key={version.version} className="flex items-center gap-1">
                <Link className={`${menuItem} flex-1`} to={`/p/${prototype.id}/v/${version.version}`}>{versionLink(version.version)}</Link>
                <button
                  type="button"
                  disabled={downloading !== null}
                  className="rounded-item px-2 py-2 text-xs font-medium text-pay-red transition-colors duration-100 hover:bg-pay-lavender disabled:opacity-50"
                  onClick={() => void runExport(`v${version.version}`, version.version)}
                >{downloading === `v${version.version}` ? gallery.exporting : gallery.exportVersionAction(version.version)}</button>
              </li>)}</ul> : null}
            </div>
          </details> : null}
          {isOwner
            ? <button type="button" className={menuItem} disabled={downloading !== null} onClick={() => void runExport("draft", null)}>{downloading === "draft" ? gallery.exporting : gallery.exportDraft}</button>
            : latestVersion !== null
              ? <button type="button" className={menuItem} disabled={downloading !== null} onClick={() => void runExport("latest", latestVersion)}>{downloading === "latest" ? gallery.exporting : gallery.exportLatest}</button>
              : null}
        </Group> : null}
        {isOwner ? <Group label={gallery.menuGroupManage}>
          {prototype.status === "private" ? <button type="button" className={menuItem} disabled={busy} onClick={openPublish}>{gallery.publish}</button> : null}
          {prototype.status === "published" ? <button type="button" className={menuItem} disabled={busy} onClick={() => void changeStatus("private")}>{gallery.unpublish}</button> : null}
          {prototype.status !== "archived" ? <button type="button" className={menuItem} disabled={busy} onClick={() => void changeStatus("archived")}>{gallery.archive}</button> : null}
          {prototype.status === "archived" ? <button type="button" className={menuItem} disabled={busy} onClick={() => void changeStatus("private")}>{gallery.restore}</button> : null}
          <button type="button" className={menuItem} disabled={busy} onClick={openLifecycle}>{gallery.lifecycleAction}</button>
        </Group> : null}
      </div>
    </details>
    {publishOpen ? createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-pay-deep/55 p-6">
      <section role="dialog" aria-modal="true" aria-label={gallery.publishDialogAria} className="w-full max-w-[460px] rounded-panel bg-white p-7 text-left">
        <h2 className={headingDialog}>{gallery.publishDialogTitle}</h2>
        <p className="mt-1 text-sm text-eui-slate-500">{gallery.publishDialogBody}</p>
        <div className="-mx-7 mt-5 border-y border-pay-lavender"><ReadinessPanel prototypeId={prototype.id} /></div>
        {error ? <p role="alert" className="mt-3 text-sm text-pay-red">{error}</p> : null}
        <div className="flex flex-wrap justify-end gap-2 pt-4">
          <button type="button" className={pillGhost} disabled={busy} onClick={() => setPublishOpen(false)}>{gallery.cancel}</button>
          <button type="button" className={pillPrimary} disabled={busy} onClick={() => void changeStatus("published").then(() => setPublishOpen(false))}>{busy ? gallery.publishing : gallery.publishConfirm}</button>
        </div>
      </section>
    </div>, document.body) : null}
    {lifecycle ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-pay-deep/55 p-6">
      <section role="dialog" aria-modal="true" aria-label={gallery.lifecycleDialogAria} className="w-full max-w-[460px] rounded-panel bg-white p-7 text-left">
        <h2 className={headingDialog}>{gallery.lifecycleDialogTitle}</h2>
        <form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void submitLifecycle(); }}>
          <label className={inputLabel}>{gallery.kindLabel}
            <select className={`${inputBase} mt-1.5 w-full`} value={lifecycle.kind} disabled={lifecycle.saving}
              onChange={(event) => setLifecycle((current) => current ? { ...current, kind: event.target.value as PrototypeKind, error: false } : null)}>
              {PROTOTYPE_KINDS.map((kind) => <option key={kind} value={kind}>{gallery.kindNames[kind] ?? kind}</option>)}
            </select>
          </label>
          <label className={inputLabel}>{gallery.lifecycleTagsLabel}
            <input className={`${inputBase} mt-1.5 w-full`} value={lifecycle.tags} disabled={lifecycle.saving}
              onChange={(event) => setLifecycle((current) => current ? { ...current, tags: event.target.value, error: false } : null)} />
          </label>
          <p className="text-xs text-eui-slate-500">{gallery.lifecycleTagsHint}</p>
          {lifecycle.error ? <p role="alert" className="text-sm text-pay-red">{gallery.lifecycleFailed}</p> : null}
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <button type="button" className={pillGhost} disabled={lifecycle.saving} onClick={() => setLifecycle(null)}>{gallery.cancel}</button>
            <button type="submit" className={pillPrimary} disabled={lifecycle.saving}>{lifecycle.saving ? gallery.lifecycleSaving : gallery.lifecycleSave}</button>
          </div>
        </form>
      </section>
    </div> : null}
    {busy ? <span role="status" className="self-center text-xs text-eui-slate-500">{gallery.statusChanging}</span> : null}
    {error ? <p role="alert" className="basis-full text-xs text-pay-red">{error}</p> : null}
    {exportError ? <p role="alert" className="basis-full text-xs text-pay-red">{exportError}</p> : null}
  </>;
}
