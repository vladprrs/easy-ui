import { useRef, useState, type ChangeEvent } from "react";
import { importBundle } from "../api/bundles";
import { pillGhost, pillPrimary } from "../app/chrome";
import { common } from "../app/strings/common";
import { gallery } from "../app/strings/gallery";
import type { ImportReport, ImportReportItem } from "../bundle/schema";

type DialogState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "preview"; report: ImportReport }
  | { status: "applying"; report: ImportReport }
  | { status: "done"; report: ImportReport }
  | { status: "error"; message: string };

function ReportTable({ items }: { items: ImportReportItem[] }) {
  if (!items.length) return <p className="mt-3 text-sm text-eui-slate-500">{gallery.importSummary(0, 0, 0, 0)}</p>;
  return <div className="mt-3 overflow-x-auto">
    <table className="w-full border-collapse text-left text-sm">
      <thead>
        <tr className="text-xs text-eui-slate-500">
          <th className="py-1 pr-3 font-medium">{gallery.importColType}</th>
          <th className="py-1 pr-3 font-medium">{gallery.importColId}</th>
          <th className="py-1 pr-3 font-medium">{gallery.importColAction}</th>
          <th className="py-1 font-medium">{gallery.importColDetail}</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item, index) => {
          const isError = item.action === "error";
          const details = [
            item.detail,
            item.remappedTo ? gallery.importRemappedTo(item.remappedTo) : null,
            item.version !== undefined ? `v${item.version}` : null,
          ].filter((value): value is string => Boolean(value));
          return <tr key={`${item.type}:${item.id}:${index}`} className={`border-t border-eui-ink/10 ${isError ? "text-eui-magenta" : ""}`}>
            <td className="py-1.5 pr-3 align-top">{gallery.importItemTypes[item.type]}</td>
            <td className="py-1.5 pr-3 align-top break-all font-mono text-xs">{item.name ? `${item.name} (${item.id})` : item.id}</td>
            <td className="py-1.5 pr-3 align-top font-medium">{gallery.importActions[item.action]}</td>
            <td className="py-1.5 align-top break-words">{details.join(" · ") || "—"}</td>
          </tr>;
        })}
      </tbody>
    </table>
  </div>;
}

export function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [state, setState] = useState<DialogState>({ status: "idle" });
  const fileRef = useRef<HTMLInputElement>(null);
  const selectedFileRef = useRef<File | null>(null);

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    selectedFileRef.current = file;
    setState({ status: "checking" });
    try {
      const report = await importBundle(file, "dry-run");
      setState({ status: "preview", report });
    } catch (cause) {
      setState({ status: "error", message: cause instanceof Error ? cause.message : gallery.importError });
    }
  };

  const apply = async () => {
    const file = selectedFileRef.current;
    if (!file) return;
    setState((current) => current.status === "preview" ? { status: "applying", report: current.report } : current);
    try {
      const report = await importBundle(file, "apply");
      setState({ status: "done", report });
    } catch (cause) {
      setState({ status: "error", message: cause instanceof Error ? cause.message : gallery.importError });
    }
  };

  const finish = () => { onImported(); onClose(); };

  const busy = state.status === "checking" || state.status === "applying";
  const previewReport = state.status === "preview" ? state.report : null;

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
    <section role="dialog" aria-modal="true" aria-label={gallery.importDialogAria} className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-3xl bg-white p-6 shadow-2xl">
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-eui-display text-2xl font-medium">{gallery.importDialogTitle}</h2>
        <button type="button" aria-label={common.close} title={common.close} disabled={busy} onClick={onClose} className="rounded-full px-2 py-1 text-xl hover:bg-eui-lilac-100 disabled:opacity-50">×</button>
      </div>

      <div className="mt-5 min-h-0 flex-1 overflow-y-auto">
        {state.status === "idle" ? <p className="text-sm text-eui-slate-500">{gallery.importIntro}</p> : null}
        {state.status === "checking" ? <p className="text-sm text-eui-slate-500" aria-live="polite">{gallery.importChecking}</p> : null}
        {state.status === "applying" ? <p className="text-sm text-eui-slate-500" aria-live="polite">{gallery.importApplying}</p> : null}
        {state.status === "error" ? <p role="alert" className="text-sm text-eui-magenta">{state.message}</p> : null}

        {previewReport ? <div>
          <h3 className="font-eui-display text-lg font-medium">{gallery.importPreviewTitle}</h3>
          <p className="mt-1 text-xs text-eui-slate-500">{gallery.importPreviewNote}</p>
          {!previewReport.ok ? <p role="alert" className="mt-2 text-sm text-eui-magenta">{gallery.importPreviewFailedNote}</p> : null}
          <p className="mt-2 text-sm text-eui-ink">{gallery.importSummary(previewReport.summary.created, previewReport.summary.reused, previewReport.summary.skipped, previewReport.summary.errors)}</p>
          <ReportTable items={previewReport.items} />
        </div> : null}

        {state.status === "done" ? <div>
          <h3 className="font-eui-display text-lg font-medium">{gallery.importResultTitle}</h3>
          {!state.report.ok ? <p role="alert" className="mt-2 text-sm text-eui-magenta">{gallery.importFailedNote}</p> : null}
          <p className="mt-2 text-sm text-eui-ink">{gallery.importSummary(state.report.summary.created, state.report.summary.reused, state.report.summary.skipped, state.report.summary.errors)}</p>
          <ReportTable items={state.report.items} />
        </div> : null}
      </div>

      <div className="mt-5 flex flex-wrap justify-end gap-2 pt-1">
        <input ref={fileRef} type="file" accept=".zip,application/zip" aria-label={gallery.importFileInputLabel} className="sr-only" onChange={(event) => void onFile(event)} />
        {state.status === "idle" ? <button type="button" className={pillPrimary} onClick={() => fileRef.current?.click()}>{gallery.importChooseFile}</button> : null}
        {state.status === "error" ? <button type="button" className={pillPrimary} onClick={() => fileRef.current?.click()}>{gallery.importChangeFile}</button> : null}
        {state.status === "preview" ? <>
          <button type="button" className={pillGhost} onClick={() => fileRef.current?.click()}>{gallery.importChangeFile}</button>
          <button type="button" className={pillPrimary} disabled={!previewReport?.ok} onClick={() => void apply()}>{gallery.importApply}</button>
        </> : null}
        {state.status === "done" ? <button type="button" className={pillPrimary} onClick={finish}>{gallery.importDone}</button> : null}
        {state.status !== "done" ? <button type="button" className={pillGhost} disabled={busy} onClick={onClose}>{gallery.cancel}</button> : null}
      </div>
    </section>
  </div>;
}
