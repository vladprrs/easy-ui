import { useCallback, useState } from "react";
import { Link } from "react-router";
import { getComposition, getCompositionUsages, listCompositions, type CompositionSummary, type CompositionUsageReport } from "../api/client";
import { useApi } from "../api/hooks";
import { chip, kicker } from "../app/chrome";
import { compositions as strings } from "../app/strings/library";
import { componentStatusBadge } from "./statusBadge";

/**
 * Витрина версионированных композиций (волна 5): список + read-only деталь.
 * Авторинг живёт в редакторе прототипа, здесь только «что объявлено» и «где используется».
 */
export function CompositionsSection() {
  const list = useApi(listCompositions, []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const items = list.status === "ready" ? list.data : [];
  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null;

  return <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
    <aside className="w-full shrink-0 border-b p-5 font-eui-ui lg:w-72 lg:border-b-0 lg:border-r">
      <h2 className={kicker}>{strings.title}</h2>
      {list.status === "loading" ? <p className="mt-3 text-sm text-eui-slate-500" role="status">{strings.loading}</p> : null}
      {list.status === "error" ? <p className="mt-3 rounded-xl bg-eui-lilac-100 p-3 text-sm text-eui-slate-500" role="alert">{strings.unavailable} <button type="button" className="font-bold underline" onClick={list.reload}>{strings.retry}</button></p> : null}
      {items.length ? <nav className="mt-3" aria-label={strings.listAria}>
        <ul className="space-y-1">{items.map((item) => <li key={item.id}>
          <button type="button" aria-pressed={selected?.id === item.id} className={`flex w-full flex-col items-start rounded-lg px-2 py-1 text-left text-sm ${selected?.id === item.id ? "bg-eui-lilac-100 font-bold" : "text-eui-slate-500 hover:bg-eui-lilac-100/60"}`} onClick={() => setSelectedId(item.id)}>
            <span>{item.name}</span>
            <span className={kicker}>{item.latestVersion === null ? strings.notPublished : strings.versionValue(item.latestVersion)}</span>
          </button>
        </li>)}</ul>
      </nav> : null}
    </aside>
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 font-eui-ui">
      {list.status === "ready" && !items.length ? <EmptyCompositions /> : null}
      {selected ? <CompositionDetail key={selected.id} summary={selected} /> : null}
    </section>
  </div>;
}

function EmptyCompositions() {
  return <div className="flex flex-1 items-center justify-center rounded-3xl bg-eui-lav p-6">
    <div className="max-w-xl">
      <p className={kicker}>{strings.emptyGuideTitle}</p>
      <h3 className="mt-2 font-eui-display text-2xl font-medium">{strings.emptyTitle}</h3>
      <p className="mt-3 text-sm leading-6 text-eui-slate-500">{strings.emptyDescription}</p>
      <ol className="mt-5 space-y-3 text-sm">
        <li><span className="font-bold">1.</span> {strings.emptyCreateStep} <code className="rounded bg-white px-1.5 py-0.5">POST /api/compositions</code></li>
        <li><span className="font-bold">2.</span> {strings.emptyPublishStep} <code className="rounded bg-white px-1.5 py-0.5">POST /api/compositions/&#123;id&#125;/publish</code></li>
      </ol>
      <a className="mt-6 inline-flex rounded-full bg-eui-brand px-4 py-2 text-sm font-bold text-white hover:opacity-90" href="/api/openapi.json">{strings.emptyApiLink}</a>
    </div>
  </div>;
}

const formatDefault = (value: unknown): string => value === undefined ? strings.paramNoDefault : JSON.stringify(value) ?? strings.paramNoDefault;

function CompositionDetail({ summary }: { summary: CompositionSummary }) {
  const load = useCallback((signal?: AbortSignal) => getComposition(summary.id, signal), [summary.id]);
  const meta = useApi(load, [summary.id]);
  const doc = meta.status === "ready" ? meta.data.doc : null;
  // Пока деталь грузится, параметры и слоты показываем по summary — там только имена.
  const params: [string, { type: string; required?: boolean; default?: unknown; description?: string }][] = doc
    ? Object.entries(doc.params)
    : summary.params.map((name) => [name, { type: "" }] as [string, { type: string }]);
  const slots = doc ? doc.slots : summary.slots;
  const latestVersion = meta.status === "ready" ? meta.data.publishedVersion : summary.latestVersion;

  return <article className="max-w-2xl rounded-3xl bg-eui-lav p-6">
    <div className="flex flex-wrap items-center gap-2">
      <p className={kicker}>{strings.title}</p>
      <span className={chip}>{summary.designSystem}</span>
      <span className={chip}>{strings.headRevValue(summary.headRev)}</span>
      <span className={chip}>{latestVersion === null ? strings.notPublished : strings.versionValue(latestVersion)}</span>
    </div>
    <h3 className="mt-2 font-eui-display text-2xl font-medium">{summary.name}</h3>
    {meta.status === "loading" ? <p className="mt-2 text-sm text-eui-slate-500" role="status">{strings.loadingDetail}</p> : null}
    {meta.status === "error" ? <p className="mt-2 text-sm text-eui-slate-500" role="alert">{strings.detailUnavailable} <button type="button" className="font-bold underline" onClick={meta.reload}>{strings.retry}</button></p> : null}
    <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
      <Metadata label={strings.metaId} value={summary.id} />
      <Metadata label={strings.metaSystem} value={summary.designSystem} />
      <Metadata label={strings.metaHeadRev} value={strings.headRevValue(summary.headRev)} />
      <Metadata label={strings.metaLatestVersion} value={latestVersion === null ? strings.notPublished : strings.versionValue(latestVersion)} />
      <Metadata label={strings.description} value={(doc?.description ?? summary.description) || strings.noDescription} />
      <Metadata label={strings.metaUpdatedAt} value={new Date(summary.updatedAt).toLocaleDateString("ru-RU")} />
    </dl>

    <section className="mt-5" aria-labelledby={`composition-params-${summary.id}`}>
      <h4 id={`composition-params-${summary.id}`} className={kicker}>{strings.paramsTitle}</h4>
      {params.length ? <ul className="mt-2 space-y-1 text-sm" aria-label={strings.paramsAria}>
        {params.map(([name, param]) => <li key={name} className="flex flex-wrap items-baseline gap-2">
          <code className="rounded bg-white px-1.5 py-0.5 font-bold">{name}</code>
          {param.type ? <span className="text-eui-slate-500">{param.type}</span> : null}
          <span className={kicker}>{param.required ? strings.paramRequired : strings.paramOptional}</span>
          <span className="text-eui-slate-500">{strings.paramDefault}: {formatDefault(param.default)}</span>
          {param.description ? <span className="basis-full text-eui-slate-500">{param.description}</span> : null}
        </li>)}
      </ul> : <p className="mt-2 text-sm text-eui-slate-500">{strings.paramsNone}</p>}
    </section>

    <section className="mt-5" aria-labelledby={`composition-slots-${summary.id}`}>
      <h4 id={`composition-slots-${summary.id}`} className={kicker}>{strings.slotsTitle}</h4>
      {slots.length ? <ul className="mt-2 flex flex-wrap gap-2 text-sm" aria-label={strings.slotsAria}>
        {slots.map((slot) => <li key={slot}><code className="rounded bg-white px-1.5 py-0.5">{slot}</code></li>)}
      </ul> : <p className="mt-2 text-sm text-eui-slate-500">{strings.slotsNone}</p>}
    </section>

    <CompositionUsages compositionId={summary.id} />

    <section className="mt-5" aria-labelledby={`composition-versions-${summary.id}`}>
      <h4 id={`composition-versions-${summary.id}`} className={kicker}>{strings.versionsTitle}</h4>
      {meta.status === "ready" && meta.data.versions.length
        ? <ul className="mt-2 space-y-1 text-sm" aria-label={strings.versionsAria}>{meta.data.versions.map((version) => {
          const badge = componentStatusBadge(version.status, version.statusReason);
          return <li key={version.version} className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{strings.versionEntry(version.version, version.rev)}</span>
            {badge ? <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${badge.className}`} title={badge.title}>{badge.label}</span> : null}
          </li>;
        })}</ul>
        : meta.status === "ready" ? <p className="mt-2 text-sm text-eui-slate-500">{strings.versionsNone}</p> : null}
    </section>
  </article>;
}

/** «Где используется»: head-ревизии прототипов + зафиксированные публикации. */
function CompositionUsages({ compositionId }: { compositionId: string }) {
  const load = useCallback((signal?: AbortSignal) => getCompositionUsages(compositionId, signal), [compositionId]);
  const usages = useApi(load, [compositionId]);
  const report: CompositionUsageReport | null = usages.status === "ready" ? usages.data : null;

  return <section className="mt-5" aria-labelledby={`composition-usage-${compositionId}`}>
    <div className="flex flex-wrap items-center gap-2">
      <h4 id={`composition-usage-${compositionId}`} className={kicker}>{strings.usageTitle}</h4>
      {report ? <span className="text-sm font-bold">{strings.usageCount(report.currentHeadUsages.length)}</span> : null}
    </div>
    {usages.status === "loading" ? <p className="mt-2 text-sm text-eui-slate-500" role="status">{strings.usageLoading}</p> : null}
    {usages.status === "error" ? <p className="mt-2 text-sm text-eui-slate-500" role="alert">{strings.usageError} <button type="button" className="font-bold underline" onClick={usages.reload}>{strings.retry}</button></p> : null}
    {report && !report.currentHeadUsages.length ? <p className="mt-2 text-sm text-eui-slate-500">{report.safeToRemove ? strings.usageSafeToRemove : strings.usageNone}</p> : null}
    {report?.currentHeadUsages.length ? <ul className="mt-2 space-y-1 text-sm" aria-label={strings.usageAria}>
      {report.currentHeadUsages.map((usage) => <li key={usage.prototypeId} className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{usage.name}</span>
        <span className={kicker}>{strings.usageEntryMeta(usage.kind, usage.rev, usage.version)}</span>
        <Link className="underline" to={`/p/${encodeURIComponent(usage.prototypeId)}/edit`}>{strings.openInEditor}</Link>
        <Link className="underline" to={`/p/${encodeURIComponent(usage.prototypeId)}`}>{strings.openInPlayer}</Link>
      </li>)}
    </ul> : null}
    {report?.immutableUsages.length ? <div className="mt-3">
      <h5 className={kicker}>{strings.immutableTitle}</h5>
      <ul className="mt-1 space-y-1 text-sm text-eui-slate-500">{report.immutableUsages.map((usage) => <li key={`${usage.prototypeId}@${usage.version}`}>{strings.immutableEntry(usage.prototypeId, usage.version, usage.compositionVersion)}</li>)}</ul>
    </div> : null}
  </section>;
}

function Metadata({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-eui-slate-500">{label}</dt><dd className="mt-1 font-medium break-words">{value}</dd></div>;
}
