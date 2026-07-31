import { useId, useRef, useState, type ChangeEvent } from "react";
import { importBundle } from "../api/bundles";
import { ConfirmModal, Modal } from "../app/Modal";
import { pillGhost, pillPrimary } from "../app/chrome";
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
          return <tr key={`${item.type}:${item.id}:${index}`} className={`border-t border-eui-ink/10 ${isError ? "text-pay-red" : ""}`}>
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
  const [confirming, setConfirming] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const selectedFileRef = useRef<File | null>(null);
  // Причина, по которой «Импортировать» недоступна, лежит абзацем выше кнопки и
  // раньше с ней никак не была связана: скринридер читал только «недоступно».
  const failedNoteId = useId();

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
    setConfirming(false);
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

  return <>
    <Modal
      title={gallery.importDialogTitle}
      onClose={onClose}
      className="max-h-[90vh] overflow-y-auto"
      footer={<>
        <input ref={fileRef} type="file" accept=".zip,application/zip" aria-label={gallery.importFileInputLabel} className="sr-only" onChange={(event) => void onFile(event)} />
        {state.status === "idle" ? <button type="button" className={pillPrimary} onClick={() => fileRef.current?.click()}>{gallery.importChooseFile}</button> : null}
        {state.status === "error" ? <button type="button" className={pillPrimary} onClick={() => fileRef.current?.click()}>{gallery.importChangeFile}</button> : null}
        {state.status === "preview" ? <>
          <button type="button" className={pillGhost} onClick={() => fileRef.current?.click()}>{gallery.importChangeFile}</button>
          <button
            type="button"
            className={pillPrimary}
            disabled={!previewReport?.ok}
            aria-describedby={previewReport?.ok === false ? failedNoteId : undefined}
            onClick={() => setConfirming(true)}
          >{gallery.importApply}</button>
        </> : null}
        {state.status === "done" ? <button type="button" className={pillPrimary} onClick={finish}>{gallery.importDone}</button> : null}
        {state.status !== "done" ? <button type="button" className={pillGhost} disabled={busy} onClick={onClose}>{gallery.cancel}</button> : null}
      </>}
    >
      <div className="mt-5">
        {state.status === "idle" ? <p className="text-sm text-eui-slate-500">{gallery.importIntro}</p> : null}
        {state.status === "checking" ? <p className="text-sm text-eui-slate-500" aria-live="polite">{gallery.importChecking}</p> : null}
        {state.status === "applying" ? <p className="text-sm text-eui-slate-500" aria-live="polite">{gallery.importApplying}</p> : null}
        {state.status === "error" ? <p role="alert" className="text-sm text-pay-red">{state.message}</p> : null}

        {previewReport ? <div>
          <h3 className="text-base font-medium">{gallery.importPreviewTitle}</h3>
          <p className="mt-1 text-xs text-eui-slate-500">{gallery.importPreviewNote}</p>
          {!previewReport.ok ? <p id={failedNoteId} role="alert" className="mt-2 text-sm text-pay-red">{gallery.importPreviewFailedNote}</p> : null}
          <p className="mt-2 text-sm text-eui-ink">{gallery.importSummary(previewReport.summary.created, previewReport.summary.reused, previewReport.summary.skipped, previewReport.summary.errors)}</p>
          <ReportTable items={previewReport.items} />
        </div> : null}

        {state.status === "done" ? <div>
          <h3 className="text-base font-medium">{gallery.importResultTitle}</h3>
          {!state.report.ok ? <p role="alert" className="mt-2 text-sm text-pay-red">{gallery.importFailedNote}</p> : null}
          <p className="mt-2 text-sm text-eui-ink">{gallery.importSummary(state.report.summary.created, state.report.summary.reused, state.report.summary.skipped, state.report.summary.errors)}</p>
          <ReportTable items={state.report.items} />
        </div> : null}
      </div>
    </Modal>
    {/* Импорт пишет в общую базу продукта — последний шаг подтверждается отдельно. */}
    {confirming ? <ConfirmModal
      title={gallery.importConfirmTitle}
      body={gallery.importConfirmBody}
      confirmLabel={gallery.importConfirmAction}
      cancelLabel={gallery.cancel}
      onConfirm={() => void apply()}
      onClose={() => setConfirming(false)}
    /> : null}
  </>;
}
