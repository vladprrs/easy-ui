import { useRef, useState, type ReactElement } from "react";
import { ApiError, setPrototypeStatus, type PrototypeStatus, type PrototypeSummary } from "../../api/client";
import { downloadBundle } from "../../api/bundles";
import { pillGhost } from "../../app/chrome";
import { gallery } from "../../app/strings/gallery";
import { useDismissableDetails } from "../useDismissableDetails";

export interface CardActionsMenuProps {
  prototype: PrototypeSummary;
  isOwner: boolean;
  onChanged: () => void;
}

const menuItem = "block w-full rounded-xl px-3 py-2 text-left text-sm hover:bg-eui-lav focus-visible:outline-2 focus-visible:outline-eui-brand disabled:opacity-50";

export function CardActionsMenu({ prototype, isOwner, onChanged }: CardActionsMenuProps): ReactElement | null {
  const ref = useRef<HTMLDetailsElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
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

  return <>
    <details ref={ref} className="relative">
      <summary aria-label={gallery.overflowActionsAria} className={`${pillGhost} cursor-pointer list-none bg-white [&::-webkit-details-marker]:hidden`}>
        <span aria-hidden="true" className="text-lg leading-none">⋯</span>
      </summary>
      <div className="absolute right-0 z-20 mt-2 w-56 rounded-2xl border border-eui-ink/10 bg-white p-2 shadow-xl">
        {isOwner ? <>
          {prototype.status === "private" ? <button type="button" className={menuItem} disabled={busy} onClick={() => void changeStatus("published")}>{gallery.publish}</button> : null}
          {prototype.status === "published" ? <button type="button" className={menuItem} disabled={busy} onClick={() => void changeStatus("private")}>{gallery.unpublish}</button> : null}
          {prototype.status !== "archived" ? <button type="button" className={menuItem} disabled={busy} onClick={() => void changeStatus("archived")}>{gallery.archive}</button> : null}
          {prototype.status === "archived" ? <button type="button" className={menuItem} disabled={busy} onClick={() => void changeStatus("private")}>{gallery.restore}</button> : null}
        </> : <button type="button" className={menuItem} disabled={downloading} onClick={() => void runExport()}>{downloading ? gallery.exporting : gallery.exportLatest}</button>}
      </div>
    </details>
    {busy ? <span role="status" className="self-center text-xs text-eui-slate-500">{gallery.statusChanging}</span> : null}
    {error ? <p role="alert" className="basis-full text-xs text-eui-magenta">{error}</p> : null}
    {exportError ? <p role="alert" className="basis-full text-xs text-eui-magenta">{exportError}</p> : null}
  </>;
}
