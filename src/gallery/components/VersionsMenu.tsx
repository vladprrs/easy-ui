import { useEffect, useRef, useState, type ReactElement, type SyntheticEvent } from "react";
import { Link } from "react-router";
import { listPrototypeVersions, type PrototypeSummary, type PrototypeVersionSummary } from "../../api/client";
import { downloadBundle } from "../../api/bundles";
import { pillGhost } from "../../app/chrome";
import { common } from "../../app/strings/common";
import { gallery, versionLink } from "../../app/strings/gallery";
import { useDismissableDetails } from "../useDismissableDetails";

export interface VersionsMenuProps {
  prototype: PrototypeSummary;
  isOwner: boolean;
}

type VersionsState =
  | { status: "idle" | "loading"; data: PrototypeVersionSummary[] }
  | { status: "ready"; data: PrototypeVersionSummary[] }
  | { status: "error"; data: PrototypeVersionSummary[] };

export function VersionsMenu({ prototype, isOwner }: VersionsMenuProps): ReactElement {
  const ref = useRef<HTMLDetailsElement>(null);
  const [versions, setVersions] = useState<VersionsState>({ status: "idle", data: [] });
  const [downloading, setDownloading] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => controllerRef.current?.abort(), []);
  useDismissableDetails(ref);

  const load = () => {
    if (versions.status !== "idle" && versions.status !== "error") return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setVersions((current) => ({ status: "loading", data: current.data }));
    void listPrototypeVersions(prototype.id, controller.signal).then(
      (data) => { if (!controller.signal.aborted) setVersions({ status: "ready", data }); },
      () => { if (!controller.signal.aborted) setVersions((current) => ({ status: "error", data: current.data })); },
    );
  };
  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => { if (event.currentTarget.open) load(); };

  const runExport = async (key: string, url: string, fallbackName: string) => {
    setDownloading(key);
    setExportError(null);
    try {
      await downloadBundle(url, fallbackName);
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : gallery.exportError);
    } finally {
      setDownloading(null);
    }
  };
  const exportUrl = (version: number | null) => `/api/prototypes/${encodeURIComponent(prototype.id)}/export${version === null ? "" : `?version=${version}`}`;
  const exportName = (version: number | null) => `easy-ui-prototype-${prototype.id}-${version === null ? "draft" : `v${version}`}.zip`;

  return <details ref={ref} className="relative" onToggle={onToggle}>
    <summary className={`${pillGhost} cursor-pointer list-none bg-white`}>{gallery.versionsMenu}</summary>
    <div aria-label={gallery.versionsMenuAria(prototype.name)} className="absolute right-0 z-20 mt-2 w-64 rounded-2xl border border-eui-ink/10 bg-white p-2 shadow-xl">
      {isOwner ? <div className="mb-1 border-b border-eui-ink/10 pb-1">
        <button type="button" disabled={downloading !== null} className="block w-full rounded-xl px-3 py-2 text-left text-sm hover:bg-eui-lav focus-visible:outline-2 focus-visible:outline-eui-brand disabled:opacity-50" onClick={() => void runExport("draft", exportUrl(null), exportName(null))}>{downloading === "draft" ? gallery.exporting : gallery.exportDraft}</button>
      </div> : null}
      {versions.status === "idle" || versions.status === "loading" ? <p className="px-2 py-1 text-xs text-eui-slate-500" aria-live="polite">{gallery.versionsLoading}</p> : null}
      {versions.status === "error" ? <><p role="alert" className="px-2 py-1 text-xs text-eui-magenta">{gallery.versionsLoadFailed}</p><button type="button" className={`${pillGhost} mt-1`} onClick={load}>{common.retry}</button></> : null}
      {versions.status === "ready" && !versions.data.length ? <p className="px-2 py-1 text-xs text-eui-slate-500">{gallery.noVersions}</p> : null}
      {versions.status === "ready" ? <ul className="space-y-1">{versions.data.map((version) => <li key={version.version} className="flex items-center gap-1">
        <Link className="block flex-1 rounded-xl px-3 py-2 text-sm hover:bg-eui-lav focus-visible:outline-2 focus-visible:outline-eui-brand" to={`/p/${prototype.id}/v/${version.version}`}>{versionLink(version.version)}</Link>
        {isOwner ? <button type="button" disabled={downloading !== null} className="rounded-xl px-2 py-2 text-xs font-medium text-eui-brand hover:bg-eui-lav focus-visible:outline-2 focus-visible:outline-eui-brand disabled:opacity-50" onClick={() => void runExport(`v${version.version}`, exportUrl(version.version), exportName(version.version))}>{downloading === `v${version.version}` ? gallery.exporting : gallery.exportVersionAction(version.version)}</button> : null}
      </li>)}</ul> : null}
      {exportError ? <p role="alert" className="mt-1 px-2 py-1 text-xs text-eui-magenta">{exportError}</p> : null}
    </div>
  </details>;
}
