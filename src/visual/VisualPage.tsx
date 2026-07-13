import { useCallback, useMemo, useRef, useState } from "react";
import { useApi } from "../api/hooks";
import { chip, chipActive, headingBar, headingPage, inputBase, kicker, pillGhost, pillPrimary, plate } from "../app/chrome";
import {
  checkVisualReference, getVisualReference, getVisualRun, listVisualReferences, putVisualReference, uploadPngAsset,
  type RunReport, type VisualReferenceDetail,
} from "./api";
import { describeFingerprint, evidenceDenominator, formatPercent, referenceScope, statusLabel, statusTone } from "./visualModel";
import { common, formatApiError } from "../app/strings/common";
import { visual } from "../app/strings/visual";
import { useDocumentTitle } from "../app/useDocumentTitle";
import { ApiError } from "../api/client";

const scopeFilters: { id: string | null; label: string }[] = [
  { id: null, label: visual.scopeAll },
  { id: "prototype-screen", label: visual.scopePrototypeScreens },
  { id: "component", label: visual.scopeComponents },
];

const errorText = (caught: unknown): string => caught instanceof ApiError
  ? formatApiError(caught.code, { message: caught.message, status: caught.status })
  : caught instanceof Error ? caught.message : String(caught);

export function VisualPage() {
  useDocumentTitle(visual.title);
  const [scope, setScope] = useState<string | null>(null);
  const references = useApi((signal) => listVisualReferences(scope, signal), [scope]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const list = references.status === "ready" ? references.data.references : [];
  const selected = selectedId ?? list[0]?.id ?? null;

  return <main className="mx-auto h-full w-full max-w-6xl p-6 font-eui-ui sm:p-8">
    <h1 className={headingPage}>{visual.title}</h1>
    <p className="mt-2 text-eui-slate-500">{visual.subtitle}</p>

    <div className="mt-6 flex flex-wrap gap-2" aria-label={visual.scopeAria}>
      {scopeFilters.map((filter) => <button key={filter.label} type="button" aria-pressed={scope === filter.id} className={scope === filter.id ? chipActive : chip} onClick={() => setScope(filter.id)}>{filter.label}</button>)}
    </div>

    {references.status === "loading" ? <p className={`${plate} mt-8 text-eui-slate-500`} aria-live="polite">{visual.loadingReferences}</p> : null}
    {references.status === "error" ? <div className={`${plate} mt-8 text-eui-magenta`} role="alert"><p>{visual.referencesUnavailable}</p><button className={`${pillGhost} mt-3`} type="button" onClick={references.reload}>{common.retry}</button></div> : null}

    <div className="mt-6 grid gap-6 lg:grid-cols-[20rem_1fr]">
      <aside className="space-y-2">
        <UploadReference onCreated={(id) => { references.reload(); setSelectedId(id); }} />
        {references.status === "ready" && !list.length ? <p className="rounded-xl bg-eui-lav p-3 text-sm text-eui-slate-500">{visual.noReferences}</p> : null}
        <ul className="space-y-2">
          {list.map((reference) => <li key={reference.id}>
            <button type="button" onClick={() => setSelectedId(reference.id)} aria-pressed={selected === reference.id}
              className={`w-full rounded-2xl p-3 text-left ${selected === reference.id ? "bg-eui-lilac-100" : "bg-eui-lav hover:bg-eui-lilac-100/60"}`}>
              <span className={kicker}>{referenceScope(reference)}</span>
              <span className="mt-1 block text-sm font-medium">{describeFingerprint(reference.fingerprint)}</span>
              {reference.lastRun ? <span className={`mt-2 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${statusTone(reference.lastRun.status)}`}>{statusLabel(reference.lastRun.status)}</span> : <span className="mt-2 inline-block text-xs text-eui-slate-500">{visual.noRunsYet}</span>}
            </button>
          </li>)}
        </ul>
      </aside>
      <section>{selected ? <ReferenceDetail id={selected} onChanged={references.reload} /> : <div className="flex h-full items-center justify-center rounded-3xl bg-eui-lav p-6 text-eui-slate-500">{visual.selectReference}</div>}</section>
    </div>
  </main>;
}

function ReferenceDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const detail = useApi((signal) => getVisualReference(id, signal), [id]);
  const [threshold, setThreshold] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveRun, setLiveRun] = useState<RunReport | null>(null);

  const runCheck = useCallback(async () => {
    setBusy(true); setError(null); setLiveRun(null);
    try {
      const { runId } = await checkVisualReference(id, Number(threshold) || 0);
      let report = await getVisualRun(runId);
      for (let i = 0; i < 240 && report.status === "running"; i++) { await new Promise((r) => setTimeout(r, 500)); report = await getVisualRun(runId); }
      setLiveRun(report);
      detail.reload(); onChanged();
    } catch (caught) { setError(errorText(caught)); }
    finally { setBusy(false); }
  }, [detail, id, onChanged, threshold]);

  if (detail.status === "loading") return <p className={`${plate} text-eui-slate-500`}>{visual.loadingReference}</p>;
  if (detail.status === "error") return <div className={`${plate} text-eui-magenta`} role="alert">{visual.referenceUnavailable}</div>;
  const reference: VisualReferenceDetail = detail.data;
  const lastRun = liveRun ?? reference.lastRun;

  return <article className="space-y-5">
    <header className="rounded-3xl bg-eui-lav p-5">
      <p className={kicker}>{referenceScope(reference)}</p>
      <h2 className={`${headingBar} mt-1`}>{describeFingerprint(reference.fingerprint)}</h2>
      {reference.note ? <p className="mt-2 text-sm text-eui-slate-500">{reference.note}</p> : null}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="text-sm text-eui-slate-500">{visual.thresholdLabel}<input className={`${inputBase} ml-2 w-20`} value={threshold} inputMode="decimal" onChange={(e) => setThreshold(e.target.value)} /></label>
        <button type="button" className={pillPrimary} disabled={busy} onClick={runCheck}>{busy ? visual.checking : visual.check}</button>
      </div>
      {error ? <p className="mt-3 text-sm text-eui-magenta" role="alert">{error}</p> : null}
    </header>

    {lastRun ? <RunDetail report={lastRun} /> : <p className="rounded-3xl bg-eui-lav p-5 text-sm text-eui-slate-500">{visual.runNowHint}</p>}

    <section>
      <h3 className={kicker}>{visual.runHistory}</h3>
      <ul className="mt-2 space-y-1">
        {reference.runs.length ? reference.runs.map((run) => <li key={run.runId} className="flex flex-wrap items-center gap-3 rounded-xl bg-eui-lav px-3 py-2 text-sm">
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusTone(run.status)}`}>{statusLabel(run.status)}</span>
          <span className="text-eui-slate-500">{run.metric ?? "—"}</span>
          <span className="font-medium">{formatPercent(run.diffPercent)}</span>
          <span className="ml-auto text-eui-slate-500">{run.createdAt ? new Date(run.createdAt).toLocaleString() : ""}</span>
        </li>) : <li className="text-sm text-eui-slate-500">{visual.noRunsRecorded}</li>}
      </ul>
    </section>
  </article>;
}

function RunDetail({ report }: { report: RunReport }) {
  const denominator = evidenceDenominator(report);
  return <section className="rounded-3xl bg-eui-lav p-5">
    <div className="flex flex-wrap items-center gap-3">
      <span className={`rounded-full px-2.5 py-1 text-sm font-medium ${statusTone(report.status)}`}>{statusLabel(report.status)}</span>
      <span className="text-sm text-eui-slate-500">{report.metric ?? visual.noMetric}</span>
      <span className="text-sm font-medium">{formatPercent(report.diffPercent)}</span>
    </div>
    <div className="mt-4 grid gap-3 sm:grid-cols-3">
      <Frame title={visual.frameReference} url={report.reference?.url} sha={report.reference?.sha256} dims={report.reference} />
      <Frame title={visual.frameCandidate} url={report.candidate?.url} sha={report.candidate?.sha256} dims={report.candidate} />
      <Frame title={visual.frameDiff} url={report.diff?.url} sha={undefined} dims={undefined} />
    </div>
    <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
      <Evidence label="pixelmatch-v1" value={report.metrics?.["pixelmatch-v1"] ? `${report.metrics["pixelmatch-v1"].diffPixels} / ${report.metrics["pixelmatch-v1"].totalPixels} px (${formatPercent(report.metrics["pixelmatch-v1"].diffPercent)})` : "—"} />
      <Evidence label="exact-rgba" value={report.metrics?.["exact-rgba"] ? `${report.metrics["exact-rgba"].diffPixels} / ${report.metrics["exact-rgba"].totalPixels} px (${formatPercent(report.metrics["exact-rgba"].diffPercent)})` : "—"} />
      <Evidence label={visual.evidenceDiffPixels} value={report.diffPixels !== null && report.diffPixels !== undefined && denominator !== null ? `${report.diffPixels} / ${denominator}` : "—"} />
      <Evidence label={visual.evidenceMetricOptions} value={report.metricOptions ? JSON.stringify(report.metricOptions) : "—"} />
      <Evidence label={visual.evidenceCandidateMeta} value={report.candidateMeta ? JSON.stringify(report.candidateMeta) : "—"} />
    </dl>
  </section>;
}

function Frame({ title, url, sha, dims }: { title: string; url?: string | null; sha?: string; dims?: { width: number | null; height: number | null } | null }) {
  return <figure className="rounded-2xl bg-white p-3">
    <figcaption className={kicker}>{title}</figcaption>
    {url ? <img className="mt-2 max-h-64 w-full rounded-lg object-contain" src={url} alt={visual.screenshotAlt(title)} /> : <div className="mt-2 flex h-24 items-center justify-center rounded-lg bg-eui-lav text-xs text-eui-slate-500">{visual.frameUnavailable}</div>}
    {dims && dims.width !== null ? <p className="mt-2 text-xs text-eui-slate-500">{dims.width}×{dims.height}</p> : null}
    {sha ? <p className="mt-1 truncate text-[10px] text-eui-slate-500" title={sha}>sha256 {sha.slice(0, 16)}…</p> : null}
  </figure>;
}

function Evidence({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-eui-slate-500">{label}</dt><dd className="mt-1 break-all font-medium">{value}</dd></div>;
}

function UploadReference({ onCreated }: { onCreated: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<"prototype-screen" | "component">("prototype-screen");
  const [fields, setFields] = useState({ prototypeId: "", screenId: "", componentId: "", ref: "1", width: "390", height: "844", dsf: "1", theme: "light", note: "" });
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setFields((f) => ({ ...f, [key]: e.target.value }));

  const fingerprint = useMemo(() => {
    const base = { viewport: { width: Number(fields.width), height: Number(fields.height) }, deviceScaleFactor: Number(fields.dsf), theme: fields.theme };
    return scope === "prototype-screen"
      ? { scope, prototypeId: fields.prototypeId, screenId: fields.screenId, refRevision: Number(fields.ref), ...base }
      : { scope, componentId: fields.componentId, refVersion: Number(fields.ref), ...base };
  }, [fields, scope]);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const file = fileRef.current?.files?.[0];
      if (!file) throw new Error(visual.choosePngFirst);
      const asset = await uploadPngAsset(file);
      const reference = await putVisualReference(fingerprint as unknown as Record<string, unknown>, asset.id, fields.note || undefined);
      onCreated(reference.id);
      setOpen(false);
    } catch (caught) { setError(errorText(caught)); }
    finally { setBusy(false); }
  };

  if (!open) return <button type="button" className={`${pillGhost} w-full bg-eui-lav`} onClick={() => setOpen(true)}>{visual.uploadReference}</button>;
  return <div className="rounded-2xl bg-eui-lav p-4">
    <div className="flex items-center justify-between"><h2 className={kicker}>{visual.newReference}</h2><button type="button" className="text-sm text-eui-slate-500 underline" onClick={() => setOpen(false)}>{visual.close}</button></div>
    <div className="mt-3 space-y-2 text-sm">
      <select className={inputBase} value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}><option value="prototype-screen">{visual.optionPrototypeScreen}</option><option value="component">{visual.optionComponent}</option></select>
      {scope === "prototype-screen" ? <>
        <input className={inputBase} placeholder="prototypeId" value={fields.prototypeId} onChange={set("prototypeId")} />
        <input className={inputBase} placeholder="screenId" value={fields.screenId} onChange={set("screenId")} />
      </> : <input className={inputBase} placeholder="componentId" value={fields.componentId} onChange={set("componentId")} />}
      <div className="flex gap-2">
        <input className={inputBase} placeholder={scope === "prototype-screen" ? "rev" : "version"} value={fields.ref} onChange={set("ref")} />
        <select className={inputBase} value={fields.dsf} onChange={set("dsf")}><option value="1">1x</option><option value="2">2x</option><option value="3">3x</option></select>
        <select className={inputBase} value={fields.theme} onChange={set("theme")}><option value="light">light</option><option value="dark">dark</option></select>
      </div>
      <div className="flex gap-2"><input className={inputBase} placeholder="width" value={fields.width} onChange={set("width")} /><input className={inputBase} placeholder="height" value={fields.height} onChange={set("height")} /></div>
      <input className={inputBase} placeholder={visual.notePlaceholder} value={fields.note} onChange={set("note")} />
      <input ref={fileRef} type="file" accept="image/png" className="block w-full text-xs text-eui-slate-500" />
      {error ? <p className="text-eui-magenta" role="alert">{error}</p> : null}
      <button type="button" className={`${pillPrimary} w-full`} disabled={busy} onClick={submit}>{busy ? visual.uploading : visual.saveReference}</button>
    </div>
  </div>;
}
