import { useCallback } from "react";
import { Link } from "react-router";
import { listPrototypeRevisions, listPrototypeVersions, type PrototypeRevisionSummary, type PrototypeVersionSummary } from "../api/client";
import { useApi } from "../api/hooks";
import { pillGhost } from "../app/chrome";
import { common } from "../app/strings/common";
import { editor } from "../app/strings/editor";

type HistoryData = { revisions: PrototypeRevisionSummary[]; versions: PrototypeVersionSummary[] };

const formatDate = (value: string) => new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
}).format(new Date(value));

export function HistoryPanel({ prototypeId, headRev, refreshKey, restoringRev, onRestore }: {
  prototypeId: string;
  headRev: number;
  refreshKey: number;
  restoringRev: number | null;
  onRestore: (rev: number, label: string) => void;
}) {
  const load = useCallback((signal: AbortSignal) => Promise.all([
    listPrototypeRevisions(prototypeId, { limit: 100, signal }),
    listPrototypeVersions(prototypeId, signal),
  ]).then(([revisions, versions]) => ({ revisions, versions })), [prototypeId]);
  const history = useApi<HistoryData>(load, [load, refreshKey]);

  if (history.status === "loading") return <section aria-label={editor.historyPanelAria} className="border-b border-eui-ink/10 bg-eui-lav px-6 py-4 font-eui-ui"><p aria-live="polite" className="text-sm text-eui-slate-500">{editor.historyLoading}</p></section>;
  if (history.status === "error") return <section aria-label={editor.historyPanelAria} className="border-b border-eui-ink/10 bg-eui-lav px-6 py-4 font-eui-ui"><p role="alert" className="text-sm text-eui-magenta">{editor.historyLoadFailed}</p><button type="button" className={`${pillGhost} mt-2`} onClick={history.reload}>{common.retry}</button></section>;

  const versionsByRev = new Map<number, PrototypeVersionSummary[]>();
  for (const version of history.data.versions) versionsByRev.set(version.rev, [...(versionsByRev.get(version.rev) ?? []), version]);
  return <section aria-label={editor.historyPanelAria} className="max-h-72 overflow-auto border-b border-eui-ink/10 bg-eui-lav px-6 py-4 font-eui-ui">
    <div className="grid gap-6 lg:grid-cols-2">
      <div>
        <h2 className="font-eui-display text-lg font-medium">{editor.draftRevisionsTitle}</h2>
        <ol className="mt-3 space-y-2">
          {history.data.revisions.map((revision) => {
            const published = versionsByRev.get(revision.rev) ?? [];
            const isHead = revision.rev === headRev;
            return <li key={revision.rev} className="flex items-start justify-between gap-3 rounded-xl bg-white p-3 text-sm">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{editor.revisionLabel(revision.rev)}</span>{isHead ? <span className="rounded-full bg-eui-lilac-100 px-2 py-0.5 text-xs">{editor.currentRevision}</span> : null}{published.map((version) => <span key={version.version} className="rounded-full bg-eui-lilac-200 px-2 py-0.5 text-xs">v{version.version}</span>)}</div>
                <p className="mt-1 break-words text-eui-slate-500">{revision.message ?? editor.noRevisionMessage}</p>
                <time className="mt-1 block text-xs text-eui-slate-500" dateTime={revision.createdAt}>{formatDate(revision.createdAt)}</time>
              </div>
              <button type="button" className={`${pillGhost} shrink-0 disabled:opacity-50`} disabled={isHead || restoringRev !== null} onClick={() => onRestore(revision.rev, editor.restoreRevisionLabel(revision.rev))}>{restoringRev === revision.rev ? editor.restoring : editor.restore}</button>
            </li>;
          })}
        </ol>
      </div>
      <div>
        <h2 className="font-eui-display text-lg font-medium">{editor.publishedVersionsTitle}</h2>
        {history.data.versions.length ? <ol className="mt-3 space-y-2">{history.data.versions.map((version) => <li key={version.version} className="flex items-center justify-between gap-3 rounded-xl bg-white p-3 text-sm"><div><Link className="font-medium text-eui-brand hover:underline" to={`/p/${encodeURIComponent(prototypeId)}/v/${version.version}`}>v{version.version}</Link><p className="mt-1 text-xs text-eui-slate-500">{editor.versionRevision(version.rev)} · <time dateTime={version.publishedAt}>{formatDate(version.publishedAt)}</time></p></div><button type="button" className={`${pillGhost} shrink-0 disabled:opacity-50`} disabled={version.rev === headRev || restoringRev !== null} onClick={() => onRestore(version.rev, editor.versionLabel(version.version))}>{restoringRev === version.rev ? editor.restoring : editor.restore}</button></li>)}</ol> : <p className="mt-3 text-sm text-eui-slate-500">{editor.noPublishedVersions}</p>}
      </div>
    </div>
  </section>;
}
