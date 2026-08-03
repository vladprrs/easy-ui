import { useCallback, useState } from "react";
import { Link } from "react-router";
import { getComposition, getCompositionUsages, listCompositions, searchCompositionCandidates, type CompositionSummary, type CompositionUsageReport } from "../api/client";
import type { CompositionDoc } from "../prototype/composition";
import { useApi } from "../api/hooks";
import { chip, kicker, panel, panelPadded, transition } from "../app/chrome";
import { gallery } from "../app/strings/gallery";
import { compositions as strings } from "../app/strings/library";
import { componentStatusBadge } from "./statusBadge";
import { compositionSlotNames } from "../prototype/composition";

/**
 * Витрина версионированных композиций (волна 5): список + read-only деталь.
 * Авторинг живёт в редакторе прототипа, здесь только «что объявлено» и «где используется».
 */
export function CompositionsSection() {
  const list = useApi(listCompositions, []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const items = list.status === "ready" ? list.data : [];
  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null;

  // `max-lg:`-варианты, а не `lg:`-оверрайды: compat-CSS глушит responsive-переопределения
  // базовых утилит (см. memory shadcn-compat-css-cascade).
  return <div className="flex min-h-0 flex-1 flex-row gap-5 max-lg:flex-col">
    <aside className={`${panel} w-72 shrink-0 p-6 max-lg:w-full`}>
      <h2 className={kicker}>{strings.title}</h2>
      {list.status === "loading" ? <p className="mt-3 text-sm text-eui-slate-500" role="status">{strings.loading}</p> : null}
      {list.status === "error" ? <p className="mt-3 rounded-inset bg-pay-lavender p-3 text-sm text-eui-ink" role="alert">{strings.unavailable} <button type="button" className="font-medium underline" onClick={list.reload}>{strings.retry}</button></p> : null}
      {items.length ? <nav className="mt-3" aria-label={strings.listAria}>
        <ul className="space-y-1">{items.map((item) => <li key={item.id}>
          <button type="button" aria-pressed={selected?.id === item.id} className={`flex w-full flex-col items-start rounded-item px-3 py-1.5 text-left text-sm ${transition} ${selected?.id === item.id ? "bg-pay-lavender font-medium text-eui-ink" : "text-eui-slate-500 hover:bg-pay-lavender-tint"}`} onClick={() => setSelectedId(item.id)}>
            <span>{item.name}</span>
            <span className={kicker}>{item.latestVersion === null ? strings.notPublished : strings.versionValue(item.latestVersion)}</span>
          </button>
        </li>)}</ul>
      </nav> : null}
    </aside>
    <section className="flex min-h-0 flex-1 flex-col gap-5">
      {list.status === "ready" && !items.length ? <EmptyCompositions /> : null}
      {selected ? <CompositionDetail key={selected.id} summary={selected} /> : null}
    </section>
  </div>;
}

function EmptyCompositions() {
  return <div className={`${panelPadded} flex flex-1 items-center justify-center`}>
    <div className="max-w-xl">
      <h3 className="pay-display text-[30px] leading-[0.9]">{strings.emptyTitle}</h3>
      <p className="mt-3 text-sm leading-6 text-eui-slate-500">{strings.emptyDescription}</p>
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
  const slots = doc ? compositionSlotNames(doc.slots) : summary.slots;
  const latestVersion = meta.status === "ready" ? meta.data.publishedVersion : summary.latestVersion;

  return <article className={`${panelPadded} max-w-2xl`}>
    <div className="flex flex-wrap items-center gap-2">
      <p className={kicker}>{strings.title}</p>
      <span className={chip}>{summary.designSystem}</span>
      <span className={chip}>{strings.headRevValue(summary.headRev)}</span>
      <span className={chip}>{latestVersion === null ? strings.notPublished : strings.versionValue(latestVersion)}</span>
    </div>
    <h3 className="mt-2 text-2xl font-medium">{summary.name}</h3>
    {meta.status === "loading" ? <p className="mt-2 text-sm text-eui-slate-500" role="status">{strings.loadingDetail}</p> : null}
    {meta.status === "error" ? <p className="mt-2 text-sm text-eui-slate-500" role="alert">{strings.detailUnavailable} <button type="button" className="font-medium underline" onClick={meta.reload}>{strings.retry}</button></p> : null}
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
          <code className="rounded-item bg-pay-lavender-tint px-1.5 py-0.5 font-medium">{name}</code>
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
        {slots.map((slot) => <li key={slot}><code className="rounded-item bg-pay-lavender-tint px-1.5 py-0.5">{slot}</code></li>)}
      </ul> : <p className="mt-2 text-sm text-eui-slate-500">{strings.slotsNone}</p>}
    </section>

    <CompositionUsages compositionId={summary.id} />
    <SimilarCatalogArtifacts summary={summary} doc={doc} />

    <section className="mt-5" aria-labelledby={`composition-versions-${summary.id}`}>
      <h4 id={`composition-versions-${summary.id}`} className={kicker}>{strings.versionsTitle}</h4>
      {meta.status === "ready" && meta.data.versions.length
        ? <ul className="mt-2 space-y-1 text-sm" aria-label={strings.versionsAria}>{meta.data.versions.map((version) => {
          const badge = componentStatusBadge(version.status, version.statusReason);
          return <li key={version.version} className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{strings.versionEntry(version.version, version.rev)}</span>
            {badge ? <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`} title={badge.title}>{badge.label}</span> : null}
          </li>;
        })}</ul>
        : meta.status === "ready" ? <p className="mt-2 text-sm text-eui-slate-500">{strings.versionsNone}</p> : null}
    </section>
  </article>;
}

/**
 * Минимальный блок workbench'а (план 2026-08-03 W9): чем композиция похожа на то, что уже есть
 * в каталоге. Ответ **рекомендательный** — сервер ничего не запрещает, поэтому блок и выглядит
 * как подсказка, а не как ошибка. Полноценный визуальный workbench в объём волны не входит.
 *
 * Запрос уходит только когда есть осмысленный `intent`: серверная валидация требует ≥8 символов
 * и токен вне стоп-набора, а показывать пользователю 422 за пустое описание незачем.
 */
function SimilarCatalogArtifacts({ summary, doc }: { summary: CompositionSummary; doc: CompositionDoc | null }) {
  const intent = `${summary.name} ${doc?.description ?? summary.description ?? ""}`.trim();
  // Хуков за этой границей нет: пустой intent просто не создаёт блок и не шлёт запрос.
  if (intent.length < 8) return null;
  return <SimilarCatalogArtifactsList summary={summary} doc={doc} intent={intent} />;
}

function SimilarCatalogArtifactsList({ summary, doc, intent }: { summary: CompositionSummary; doc: CompositionDoc | null; intent: string }) {
  const load = useCallback((signal?: AbortSignal) => searchCompositionCandidates({
    designSystem: summary.designSystem, intent, id: summary.id, name: summary.name, limit: 5,
    ...(doc === null ? {} : { compositionDoc: doc }),
  }, signal), [doc, intent, summary.designSystem, summary.id, summary.name]);
  const result = useApi(load, [summary.id, intent, doc === null]);

  return <section className="mt-5" aria-labelledby={`composition-similar-${summary.id}`}>
    <h4 id={`composition-similar-${summary.id}`} className={kicker}>{strings.similarTitle}</h4>
    {result.status === "loading" ? <p className="mt-2 text-sm text-eui-slate-500" role="status">{strings.similarLoading}</p> : null}
    {result.status === "error" ? <p className="mt-2 text-sm text-eui-slate-500" role="alert">{strings.similarUnavailable}</p> : null}
    {result.status === "ready" ? <>
      <p className="mt-2 text-sm">
        <span className={kicker}>{strings.outcomeLabel}: </span>
        <span className="font-medium">{strings.outcomeNames[result.data.outcome] ?? result.data.outcome}</span>
      </p>
      <p className="mt-1 text-sm text-eui-slate-500">{result.data.explanation}</p>
      {result.data.matches.length ? <ul className="mt-2 space-y-1 text-sm" aria-label={strings.similarTitle}>
        {result.data.matches.map((match) => <li key={`${match.kind}:${match.id}`} className="flex flex-wrap items-baseline gap-2">
          <span className="font-medium">{match.name || match.id}</span>
          <span className={kicker}>{strings.similarEntry(match.kind, match.score)}</span>
          <span className="basis-full text-eui-slate-500">{match.why}</span>
        </li>)}
      </ul> : <p className="mt-2 text-sm text-eui-slate-500">{strings.similarNone}</p>}
    </> : null}
  </section>;
}

/** «Где используется»: head-ревизии прототипов + зафиксированные публикации. */
function CompositionUsages({ compositionId }: { compositionId: string }) {
  const load = useCallback((signal?: AbortSignal) => getCompositionUsages(compositionId, signal), [compositionId]);
  const usages = useApi(load, [compositionId]);
  const report: CompositionUsageReport | null = usages.status === "ready" ? usages.data : null;

  return <section className="mt-5" aria-labelledby={`composition-usage-${compositionId}`}>
    <div className="flex flex-wrap items-center gap-2">
      <h4 id={`composition-usage-${compositionId}`} className={kicker}>{strings.usageTitle}</h4>
      {report ? <span className="text-sm font-medium">{strings.usageCount(report.currentHeadUsages.length)}</span> : null}
    </div>
    {usages.status === "loading" ? <p className="mt-2 text-sm text-eui-slate-500" role="status">{strings.usageLoading}</p> : null}
    {usages.status === "error" ? <p className="mt-2 text-sm text-eui-slate-500" role="alert">{strings.usageError} <button type="button" className="font-medium underline" onClick={usages.reload}>{strings.retry}</button></p> : null}
    {report && !report.currentHeadUsages.length ? <p className="mt-2 text-sm text-eui-slate-500">{report.safeToRemove ? strings.usageSafeToRemove : strings.usageNone}</p> : null}
    {report?.currentHeadUsages.length ? <ul className="mt-2 space-y-1 text-sm" aria-label={strings.usageAria}>
      {report.currentHeadUsages.map((usage) => <li key={usage.prototypeId} className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{usage.name}</span>
        <span className={kicker}>{strings.usageEntryMeta(gallery.kindNames[usage.kind] ?? usage.kind, usage.rev, usage.version)}</span>
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
