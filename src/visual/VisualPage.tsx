import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "../api/hooks";
import {
  getComponentMeta, getPrototypeMeta, getPrototypeRevision, getPrototypeVersion, listComponents, listPrototypeRevisions, listPrototypes,
  type PrototypeDraft,
} from "../api/client";
import { chip, chipActive, headingBar, headingPage, inputBase, kicker, pillGhost, pillPrimary, plate } from "../app/chrome";
import {
  checkVisualReference, deleteVisualReference, enqueueComponentScreenshot, enqueuePrototypeScreenshot, getScreenshotJob,
  getVisualReference, getVisualRun, listVisualReferences, putVisualReference,
  type RunReport, type VisualReference, type VisualReferenceDetail,
} from "./api";
import { describeFingerprint, evidenceDenominator, formatPercent, parseThresholdPercent, referenceScope, statusLabel, statusTone } from "./visualModel";
import { common, formatApiError } from "../app/strings/common";
import { visual } from "../app/strings/visual";
import { useDocumentTitle } from "../app/useDocumentTitle";
import { ApiError } from "../api/client";
import { canonicalViewport } from "../designSystems/deviceMetrics";

const scopeFilters: { id: string | null; label: string }[] = [
  { id: null, label: visual.scopeAll },
  { id: "prototype-screen", label: visual.scopePrototypeScreens },
  { id: "component", label: visual.scopeComponents },
];

const errorText = (caught: unknown): string => caught instanceof ApiError
  ? formatApiError(caught.code, { message: caught.message, status: caught.status })
  : caught instanceof Error ? caught.message : String(caught);

const referenceMutationErrorText = (caught: unknown): string => caught instanceof ApiError && caught.status === 409 && caught.code === "baseline_managed"
  ? visual.baselineManaged
  : errorText(caught);

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
        <CaptureReference onCreated={(id) => { references.reload(); setSelectedId(id); }} />
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
      <section>{selected ? <ReferenceDetail id={selected} onChanged={references.reload} onDeleted={() => { setSelectedId(null); references.reload(); }} /> : <div className="flex h-full items-center justify-center rounded-3xl bg-eui-lav p-6 text-eui-slate-500">{visual.selectReference}</div>}</section>
    </div>
  </main>;
}

function ReferenceDetail({ id, onChanged, onDeleted }: { id: string; onChanged: () => void; onDeleted: () => void }) {
  const detail = useApi((signal) => getVisualReference(id, signal), [id]);
  const [threshold, setThreshold] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveRun, setLiveRun] = useState<RunReport | null>(null);

  const runCheck = useCallback(async () => {
    const parsedThreshold = parseThresholdPercent(threshold);
    if (parsedThreshold === null) { setError(visual.thresholdInvalid); return; }
    setBusy(true); setError(null); setLiveRun(null);
    try {
      const { runId } = await checkVisualReference(id, parsedThreshold);
      let report = await getVisualRun(runId);
      for (let i = 0; i < 240 && report.status === "running"; i++) { await new Promise((r) => setTimeout(r, 500)); report = await getVisualRun(runId); }
      setLiveRun(report);
      detail.reload(); onChanged();
    } catch (caught) { setError(errorText(caught)); }
    finally { setBusy(false); }
  }, [detail, id, onChanged, threshold]);

  const remove = async () => {
    if (!window.confirm(visual.deleteConfirm)) return;
    setBusy(true); setError(null);
    try { await deleteVisualReference(id); onDeleted(); }
    catch (caught) { setError(referenceMutationErrorText(caught)); }
    finally { setBusy(false); }
  };

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
        <label className="text-sm text-eui-slate-500">{visual.thresholdLabel}<input className={`${inputBase} ml-2 w-20`} value={threshold} inputMode="decimal" aria-invalid={parseThresholdPercent(threshold) === null} onChange={(e) => setThreshold(e.target.value)} /></label>
        <button type="button" className={pillPrimary} disabled={busy} onClick={runCheck}>{busy ? visual.checking : visual.check}</button>
        <button type="button" className={pillGhost} disabled={busy} onClick={remove}>{visual.deleteReference}</button>
      </div>
      {error ? <p className="mt-3 text-sm text-eui-magenta" role="alert">{error}</p> : null}
    </header>

    {lastRun ? <RunDetail report={lastRun} /> : <p className="rounded-3xl bg-eui-lav p-5 text-sm text-eui-slate-500">{visual.runNowHint}</p>}

    <section>
      <h3 className={kicker}>{visual.runHistory}</h3>
      <ul className="mt-2 space-y-1">
        {reference.runs.length ? reference.runs.map((run) => <li key={run.runId} className="flex flex-wrap items-center gap-3 rounded-xl bg-eui-lav px-3 py-2 text-sm">
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusTone(run.status)}`}>{statusLabel(run.status)}</span>
          <span className="text-eui-slate-500">{run.referenceStatus === "unknown" ? visual.referenceUnknown : run.metric ?? "—"}</span>
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
      <Frame title={visual.frameReference} url={report.reference?.url} sha={report.reference?.sha256} dims={report.reference} unavailable={report.referenceStatus === "unknown" ? visual.referenceUnknown : undefined} />
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

function Frame({ title, url, sha, dims, unavailable }: { title: string; url?: string | null; sha?: string; dims?: { width: number | null; height: number | null } | null; unavailable?: string }) {
  return <figure className="rounded-2xl bg-white p-3">
    <figcaption className={kicker}>{title}</figcaption>
    {url ? <img className="mt-2 max-h-64 w-full rounded-lg object-contain" src={url} alt={visual.screenshotAlt(title)} /> : <div className="mt-2 flex h-24 items-center justify-center rounded-lg bg-eui-lav px-3 text-center text-xs text-eui-slate-500">{unavailable ?? visual.frameUnavailable}</div>}
    {dims && dims.width !== null ? <p className="mt-2 text-xs text-eui-slate-500">{dims.width}×{dims.height}</p> : null}
    {sha ? <p className="mt-1 truncate text-[10px] text-eui-slate-500" title={sha}>sha256 {sha.slice(0, 16)}…</p> : null}
  </figure>;
}

function Evidence({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-eui-slate-500">{label}</dt><dd className="mt-1 break-all font-medium">{value}</dd></div>;
}

type ReferenceScope = "prototype-screen" | "component";
type CaptureProgress = { jobId: string; status: "queued" | "running"; fingerprint: Record<string, unknown>; stopped: boolean };

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function fingerprintViewport(reference: VisualReference | undefined): { width: number; height: number } | null {
  const value = reference?.fingerprint.viewport;
  if (!value || typeof value !== "object") return null;
  const { width, height } = value as { width?: unknown; height?: unknown };
  return typeof width === "number" && typeof height === "number" ? { width, height } : null;
}

function CaptureReference({ onCreated }: { onCreated: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<ReferenceScope>("prototype-screen");
  const [prototypeId, setPrototypeId] = useState("");
  const [prototypeTarget, setPrototypeTarget] = useState("");
  const [screenId, setScreenId] = useState("");
  const [componentId, setComponentId] = useState("");
  const [componentVersion, setComponentVersion] = useState("");
  const [dsf, setDsf] = useState("1");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<CaptureProgress | null>(null);
  const pollingGeneration = useRef(0);
  const pollingAbort = useRef<AbortController | null>(null);
  useEffect(() => () => { pollingGeneration.current += 1; pollingAbort.current?.abort(); }, []);

  const prototypes = useApi((signal) => listPrototypes(signal), []);
  const components = useApi((signal) => listComponents(signal), []);
  const references = useApi((signal) => listVisualReferences(null, signal), []);
  const resolvedPrototypeId = prototypeId || (prototypes.status === "ready" ? prototypes.data[0]?.id ?? "" : "");
  const prototypeMeta = useApi((signal) => resolvedPrototypeId ? getPrototypeMeta(resolvedPrototypeId, signal) : Promise.resolve(null), [resolvedPrototypeId]);
  const revisions = useApi((signal) => resolvedPrototypeId ? listPrototypeRevisions(resolvedPrototypeId, { limit: 100, signal }) : Promise.resolve([]), [resolvedPrototypeId]);
  const activePrototypeMeta = prototypeMeta.status === "ready" && prototypeMeta.data?.id === resolvedPrototypeId ? prototypeMeta.data : null;
  const defaultTarget = activePrototypeMeta ? `rev:${activePrototypeMeta.headRev}` : "";
  const resolvedTarget = prototypeTarget || defaultTarget;
  const [targetKind, targetNumberText] = resolvedTarget.split(":");
  const targetNumber = Number(targetNumberText);
  const prototypeSnapshot = useApi<PrototypeDraft | null>((signal) => {
    if (!resolvedPrototypeId || !Number.isInteger(targetNumber) || targetNumber < 1) return Promise.resolve(null);
    return targetKind === "version"
      ? getPrototypeVersion(resolvedPrototypeId, targetNumber, signal)
      : getPrototypeRevision(resolvedPrototypeId, targetNumber, signal);
  }, [resolvedPrototypeId, resolvedTarget]);
  const loadedSnapshot = prototypeSnapshot.status === "ready" ? prototypeSnapshot.data : null;
  const snapshotMatchesTarget = loadedSnapshot?.doc.id === resolvedPrototypeId && (targetKind === "version"
    ? (loadedSnapshot as PrototypeDraft & { version?: number }).version === targetNumber
    : loadedSnapshot.rev === targetNumber);
  const snapshot = snapshotMatchesTarget ? loadedSnapshot : null;
  const resolvedScreenId = screenId || snapshot?.doc.screens[0]?.id || "";

  const resolvedComponentId = componentId || (components.status === "ready" ? components.data[0]?.id ?? "" : "");
  const componentMeta = useApi((signal) => resolvedComponentId ? getComponentMeta(resolvedComponentId, signal) : Promise.resolve(null), [resolvedComponentId]);
  const activeComponentMeta = componentMeta.status === "ready" && componentMeta.data?.id === resolvedComponentId ? componentMeta.data : null;
  const defaultComponentVersion = activeComponentMeta
    ? activeComponentMeta.versions.reduce((latest, item) => Math.max(latest, item.version), 0)
    : 0;
  const resolvedComponentVersion = Number(componentVersion || defaultComponentVersion);
  const allReferences = references.status === "ready" ? references.data.references : [];

  const existingPrototypeReference = allReferences.find((reference) => {
    const fp = reference.fingerprint;
    return fp.scope === "prototype-screen" && fp.prototypeId === resolvedPrototypeId && fp.screenId === resolvedScreenId
      && fp.refRevision === snapshot?.rev && fp.theme === theme && fp.deviceScaleFactor === Number(dsf);
  });
  const existingComponentReference = allReferences.find((reference) => {
    const fp = reference.fingerprint;
    return fp.scope === "component" && fp.componentId === resolvedComponentId && fp.refVersion === resolvedComponentVersion
      && fp.theme === theme && fp.deviceScaleFactor === Number(dsf);
  });
  const selectedScreen = snapshot?.doc.screens.find((screen) => screen.id === resolvedScreenId);
  const prototypeViewport = selectedScreen?.canvas ?? (snapshot ? canonicalViewport[snapshot.doc.device] : null) ?? fingerprintViewport(existingPrototypeReference);
  const componentViewport = fingerprintViewport(existingComponentReference) ?? canonicalViewport.mobile;
  const viewport = scope === "prototype-screen" ? prototypeViewport : componentViewport;

  const fingerprint = useMemo<Record<string, unknown> | null>(() => {
    const base = viewport ? { viewport, deviceScaleFactor: Number(dsf), theme } : null;
    if (!base) return null;
    if (scope === "prototype-screen") {
      if (!resolvedPrototypeId || !resolvedScreenId || !snapshot) return null;
      return { scope, prototypeId: resolvedPrototypeId, screenId: resolvedScreenId, refRevision: snapshot.rev, ...base };
    }
    if (!resolvedComponentId || !Number.isInteger(resolvedComponentVersion) || resolvedComponentVersion < 1) return null;
    return { scope, componentId: resolvedComponentId, refVersion: resolvedComponentVersion, ...base };
  }, [dsf, resolvedComponentId, resolvedComponentVersion, resolvedPrototypeId, resolvedScreenId, scope, snapshot, theme, viewport]);

  const waitForCapture = async (jobId: string, capturedFingerprint: Record<string, unknown>, existingGeneration?: number) => {
    const generation = existingGeneration ?? ++pollingGeneration.current;
    setBusy(true); setError(null);
    try {
      for (;;) {
        if (pollingGeneration.current !== generation) return;
        const controller = new AbortController();
        pollingAbort.current = controller;
        const job = await getScreenshotJob(jobId, controller.signal);
        if (pollingAbort.current === controller) pollingAbort.current = null;
        if (pollingGeneration.current !== generation) return;
        if (job.status === "error") throw new Error(job.error?.message ?? visual.captureFailed);
        if (job.status === "done") {
          if (!job.result) throw new Error(visual.captureMissingResult);
          const reference = await putVisualReference(capturedFingerprint, job.result.assetId, note || undefined);
          if (pollingGeneration.current !== generation) return;
          setProgress(null); setOpen(false); onCreated(reference.id);
          return;
        }
        setProgress({ jobId, status: job.status, fingerprint: capturedFingerprint, stopped: false });
        await delay(500);
      }
    } catch (caught) {
      if (pollingGeneration.current === generation) { setError(referenceMutationErrorText(caught)); setProgress(null); }
    } finally {
      if (pollingGeneration.current === generation) setBusy(false);
    }
  };

  const submit = async () => {
    if (!fingerprint || !viewport) { setError(visual.viewportUnavailable); return; }
    const generation = ++pollingGeneration.current;
    setBusy(true); setError(null);
    try {
      const options = { viewport, deviceScaleFactor: Number(dsf), theme, waitForFonts: true };
      const accepted = scope === "prototype-screen"
        ? await enqueuePrototypeScreenshot(resolvedPrototypeId, resolvedScreenId, targetKind === "version" ? { version: targetNumber } : { rev: snapshot!.rev }, options)
        : await enqueueComponentScreenshot(resolvedComponentId, resolvedComponentVersion, options);
      if (pollingGeneration.current !== generation) { setBusy(false); return; }
      setProgress({ jobId: accepted.jobId, status: "queued", fingerprint, stopped: false });
      void waitForCapture(accepted.jobId, fingerprint, generation);
    } catch (caught) {
      if (pollingGeneration.current === generation) { setError(errorText(caught)); setBusy(false); }
    }
  };

  const stopWaiting = () => {
    pollingGeneration.current += 1;
    pollingAbort.current?.abort(); pollingAbort.current = null;
    setBusy(false);
    setProgress((current) => current ? { ...current, stopped: true } : null);
  };
  const close = () => { stopWaiting(); setProgress(null); setOpen(false); };

  if (!open) return <button type="button" className={`${pillGhost} w-full bg-eui-lav`} onClick={() => setOpen(true)}>{visual.captureReference}</button>;
  const loadingOptions = prototypes.status === "loading" || components.status === "loading" || references.status === "loading";
  return <div className="rounded-2xl bg-eui-lav p-4">
    <div className="flex items-center justify-between"><h2 className={kicker}>{visual.newReference}</h2><button type="button" className="text-sm text-eui-slate-500 underline" onClick={close}>{visual.close}</button></div>
    <div className="mt-3 space-y-3 text-sm">
      <label className="block"><span className={kicker}>{visual.modeLabel}</span><select aria-label={visual.modeLabel} className={`${inputBase} mt-1`} value={scope} disabled={busy} onChange={(event) => { setScope(event.target.value as ReferenceScope); setError(null); }}><option value="prototype-screen">{visual.optionPrototypeScreen}</option><option value="component">{visual.optionComponent}</option></select></label>
      {scope === "prototype-screen" ? <>
        <label className="block"><span className={kicker}>{visual.prototypeLabel}</span><select aria-label={visual.prototypeLabel} className={`${inputBase} mt-1`} value={resolvedPrototypeId} disabled={busy || prototypes.status !== "ready"} onChange={(event) => { setPrototypeId(event.target.value); setPrototypeTarget(""); setScreenId(""); }}><option value="">{visual.selectPrototype}</option>{prototypes.status === "ready" ? prototypes.data.map((prototype) => <option key={prototype.id} value={prototype.id}>{prototype.name}</option>) : null}</select></label>
        <label className="block"><span className={kicker}>{visual.snapshotLabel}</span><select aria-label={visual.snapshotLabel} className={`${inputBase} mt-1`} value={resolvedTarget} disabled={busy || !activePrototypeMeta || revisions.status !== "ready"} onChange={(event) => { setPrototypeTarget(event.target.value); setScreenId(""); }}>
          {revisions.status === "ready" ? revisions.data.map((revision) => <option key={`rev:${revision.rev}`} value={`rev:${revision.rev}`}>{visual.revisionOption(revision.rev)}</option>) : null}
          {activePrototypeMeta ? activePrototypeMeta.versions.map((version) => <option key={`version:${version.version}`} value={`version:${version.version}`}>{visual.versionOption(version.version, version.rev)}</option>) : null}
        </select></label>
        <label className="block"><span className={kicker}>{visual.screenLabel}</span><select aria-label={visual.screenLabel} className={`${inputBase} mt-1`} value={resolvedScreenId} disabled={busy || !snapshot} onChange={(event) => setScreenId(event.target.value)}>{snapshot?.doc.screens.map((screen) => <option key={screen.id} value={screen.id}>{screen.name}</option>)}</select></label>
      </> : <>
        <label className="block"><span className={kicker}>{visual.componentLabel}</span><select aria-label={visual.componentLabel} className={`${inputBase} mt-1`} value={resolvedComponentId} disabled={busy || components.status !== "ready"} onChange={(event) => { setComponentId(event.target.value); setComponentVersion(""); }}><option value="">{visual.selectComponent}</option>{components.status === "ready" ? components.data.map((component) => <option key={component.id} value={component.id}>{component.name}</option>) : null}</select></label>
        <label className="block"><span className={kicker}>{visual.versionLabel}</span><select aria-label={visual.versionLabel} className={`${inputBase} mt-1`} value={resolvedComponentVersion || ""} disabled={busy || !activeComponentMeta} onChange={(event) => setComponentVersion(event.target.value)}>{activeComponentMeta ? activeComponentMeta.versions.map((version) => <option key={version.version} value={version.version}>{visual.componentVersionOption(version.version)}</option>) : null}</select></label>
      </>}
      <div className="flex gap-2">
        <label className="min-w-0 flex-1"><span className={kicker}>{visual.scaleLabel}</span><select aria-label={visual.scaleLabel} className={`${inputBase} mt-1`} value={dsf} disabled={busy} onChange={(event) => setDsf(event.target.value)}><option value="1">1×</option><option value="2">2×</option><option value="3">3×</option></select></label>
        <label className="min-w-0 flex-1"><span className={kicker}>{visual.themeLabel}</span><select aria-label={visual.themeLabel} className={`${inputBase} mt-1`} value={theme} disabled={busy} onChange={(event) => setTheme(event.target.value as typeof theme)}><option value="light">{visual.themeLight}</option><option value="dark">{visual.themeDark}</option></select></label>
      </div>
      <p className="rounded-xl bg-white px-3 py-2 text-eui-slate-500">{viewport ? visual.viewportValue(viewport.width, viewport.height) : visual.viewportUnavailable}</p>
      <label className="block"><span className={kicker}>{visual.noteLabel}</span><input className={`${inputBase} mt-1`} placeholder={visual.notePlaceholder} value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} /></label>
      {loadingOptions ? <p className="text-eui-slate-500" aria-live="polite">{visual.loadingCaptureOptions}</p> : null}
      {progress ? <div className="rounded-xl bg-white p-3" role="status" aria-live="polite"><p>{progress.stopped ? visual.waitingStopped : progress.status === "queued" ? visual.captureQueued : visual.captureRunning}</p><p className="mt-1 truncate text-xs text-eui-slate-500">{progress.jobId}</p>{progress.stopped ? <button type="button" className={`${pillGhost} mt-2`} disabled={busy} onClick={() => void waitForCapture(progress.jobId, progress.fingerprint)}>{visual.resumeWaiting}</button> : <button type="button" className={`${pillGhost} mt-2`} onClick={stopWaiting}>{visual.stopWaiting}</button>}</div> : null}
      {error ? <p className="text-eui-magenta" role="alert">{error}</p> : null}
      <button type="button" className={`${pillPrimary} w-full`} disabled={busy || !fingerprint || progress !== null} onClick={submit}>{busy ? visual.capturing : visual.captureBaseline}</button>
    </div>
  </div>;
}
