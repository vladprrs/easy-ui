import { useCallback, useMemo, useState, type ReactNode } from "react";
import { getAssetUsage, listAllAssets, type AssetListItem, type AssetUsageGraph } from "../api/assetsApi";
import { useApi } from "../api/hooks";
import { chip, chipActive, headingBar, inputBase, kicker } from "../app/chrome";
import { EmptyState, ErrorState, Skeleton } from "../app/states";
import { assetsStrings } from "../app/strings/assets";
import { useDocumentTitle } from "../app/useDocumentTitle";
import { probeLoadedImage, UNKNOWN_PROBE, type AssetProbe } from "./assetProbe";
import {
  EMPTY_FILTERS, filterAssets, formatBytes, isImage, isUnused, mimeFacets, rasterOverSvgWarnings,
  sameImageCandidates, shortAssetId, usageTotal, warningsByRasterId, type AssetFilters, type RasterOverSvgWarning,
} from "./assetsModel";

const EMPTY_ASSETS: AssetListItem[] = [];
/** Шахматка под превью: без неё прозрачный PNG неотличим от белого. */
const CHECKERBOARD = "repeating-conic-gradient(rgba(0,0,0,0.06) 0% 25%, transparent 0% 50%) 50% / 12px 12px";

export function AssetsPage() {
  useDocumentTitle(assetsStrings.title);
  const list = useApi(listAllAssets, []);
  const assets = list.status === "ready" ? list.data.assets : EMPTY_ASSETS;
  const truncated = list.status === "ready" && list.data.truncated;

  const [filters, setFilters] = useState<AssetFilters>(EMPTY_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, AssetProbe>>({});
  const recordProbe = useCallback((id: string, probe: AssetProbe) => {
    setProbes((previous) => previous[id] ? previous : { ...previous, [id]: probe });
  }, []);

  const visible = useMemo(() => filterAssets(assets, filters), [assets, filters]);
  const facets = useMemo(() => mimeFacets(assets), [assets]);
  const warnings = useMemo(() => rasterOverSvgWarnings(assets), [assets]);
  const warningById = useMemo(() => warningsByRasterId(warnings), [warnings]);
  const duplicates = useMemo(() => sameImageCandidates(assets), [assets]);
  const selected = visible.find((asset) => asset.id === selectedId) ?? null;

  return <main className="flex h-full min-h-0 flex-col font-eui-ui lg:flex-row">
    <aside className="w-full shrink-0 border-b p-5 lg:w-80 lg:overflow-y-auto lg:border-b-0 lg:border-r">
      <h1 className={headingBar}>{assetsStrings.title}</h1>
      <p className="mt-2 text-sm leading-6 text-eui-slate-500">{assetsStrings.subtitle}</p>

      <div className="mt-5 flex flex-col gap-3" aria-label={assetsStrings.filtersAria}>
        <label className="flex flex-col gap-1 text-sm">
          <span className={kicker}>{assetsStrings.searchLabel}</span>
          <input
            className={inputBase}
            type="search"
            value={filters.query}
            placeholder={assetsStrings.searchPlaceholder}
            onChange={(event) => setFilters((previous) => ({ ...previous, query: event.target.value }))}
          />
        </label>
        <div className="flex flex-wrap gap-2" aria-label={assetsStrings.mimeFacetsAria}>
          <button type="button" aria-pressed={filters.mime === null} className={filters.mime === null ? chipActive : `${chip} hover:bg-eui-lilac-100/60`} onClick={() => setFilters((previous) => ({ ...previous, mime: null }))}>{assetsStrings.mimeAll}</button>
          {facets.map((facet) => <button
            key={facet.mime}
            type="button"
            aria-pressed={filters.mime === facet.mime}
            className={filters.mime === facet.mime ? chipActive : `${chip} hover:bg-eui-lilac-100/60`}
            onClick={() => setFilters((previous) => ({ ...previous, mime: previous.mime === facet.mime ? null : facet.mime }))}
          >{facet.mime} · {facet.count}</button>)}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={filters.unusedOnly} onChange={(event) => setFilters((previous) => ({ ...previous, unusedOnly: event.target.checked }))} />
          {assetsStrings.unusedOnly}
        </label>
      </div>

      {list.status === "ready" ? <>
        <p className="mt-4 text-sm text-eui-slate-500">{assetsStrings.countSummary(visible.length, assets.length)}</p>
        {truncated ? <p className="mt-2 rounded-inset bg-eui-lilac-100 p-3 text-sm text-eui-slate-500">{assetsStrings.truncated(assets.length)}</p> : null}
        <p className="mt-2 text-xs leading-5 text-eui-slate-400">{assetsStrings.visibilityNote}</p>
        <DuplicatesPanel groups={duplicates} onSelect={setSelectedId} />
        <RasterOverSvgPanel warnings={warnings} assets={assets} onSelect={setSelectedId} />
      </> : null}
    </aside>

    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 lg:overflow-y-auto">
      {list.status === "loading" ? <Skeleton label={assetsStrings.loading} count={2} previewHeight={110} gridClassName="grid gap-3 sm:grid-cols-2" /> : null}
      {list.status === "error" ? <ErrorState title={assetsStrings.unavailable} retryLabel={assetsStrings.retry} onRetry={list.reload} /> : null}
      {list.status === "ready" && !assets.length ? <EmptyState title={assetsStrings.emptyTitle} description={assetsStrings.empty} /> : null}
      {list.status === "ready" && assets.length && !visible.length ? <EmptyState circles={false} title={assetsStrings.emptyFiltered} /> : null}
      {visible.length ? <ul className="grid grid-cols-2 gap-3 max-sm:grid-cols-1 xl:grid-cols-3" aria-label={assetsStrings.gridAria}>
        {visible.map((asset) => <li key={asset.id}>
          <AssetCard
            asset={asset}
            probe={probes[asset.id]}
            warning={warningById.get(asset.id)}
            selected={asset.id === selected?.id}
            onSelect={() => setSelectedId(asset.id)}
            onProbe={recordProbe}
          />
        </li>)}
      </ul> : null}
    </section>

    <aside className="w-full shrink-0 border-t p-4 lg:w-96 lg:overflow-y-auto lg:border-t-0 lg:border-l" aria-label={assetsStrings.detailsAria}>
      {selected
        ? <AssetDetails key={selected.id} asset={selected} probe={probes[selected.id] ?? UNKNOWN_PROBE} warning={warningById.get(selected.id)} />
        : <p className="text-sm text-eui-slate-500">{assetsStrings.selectAsset}</p>}
    </aside>
  </main>;
}

function AssetCard({ asset, probe, warning, selected, onSelect, onProbe }: {
  asset: AssetListItem;
  probe: AssetProbe | undefined;
  warning: RasterOverSvgWarning | undefined;
  selected: boolean;
  onSelect: () => void;
  onProbe: (id: string, probe: AssetProbe) => void;
}) {
  const usages = usageTotal(asset);
  return <button
    type="button"
    aria-pressed={selected}
    onClick={onSelect}
    className={`flex w-full flex-col gap-2 rounded-popover p-3 text-left ${selected ? "bg-eui-lilac-100 outline-2 outline-eui-brand" : "bg-eui-lav hover:bg-eui-lilac-100/60"}`}
  >
    <AssetPreview asset={asset} onProbe={onProbe} />
    <span className="truncate text-sm font-bold">{asset.originalName ?? shortAssetId(asset.id)}</span>
    <span className="font-mono text-xs text-eui-slate-500">{shortAssetId(asset.id)}</span>
    <span className="flex flex-wrap items-center gap-1 text-xs text-eui-slate-500">
      <span>{asset.mime}</span>
      <span>· {formatBytes(asset.size)}</span>
      <span>· {dimensionsLabel(asset, probe)}</span>
    </span>
    <span className="flex flex-wrap gap-1 text-xs">
      {isUnused(asset)
        ? <span className="rounded-full bg-eui-ink/10 px-2 py-0.5 font-bold">{assetsStrings.usageUnusedBadge}</span>
        : <span className="rounded-full bg-eui-ink/5 px-2 py-0.5">{assetsStrings.usageTitle}: {usages}</span>}
      {warning ? <span className="rounded-full bg-eui-lilac-100 px-2 py-0.5 font-bold text-eui-brand">{assetsStrings.rasterOverSvgBadge} · {assetsStrings.heuristicBadge}</span> : null}
    </span>
  </button>;
}

function AssetPreview({ asset, onProbe }: { asset: AssetListItem; onProbe: (id: string, probe: AssetProbe) => void }) {
  const [failed, setFailed] = useState(false);
  if (!isImage(asset.mime) || failed) {
    return <span className="flex h-28 items-center justify-center rounded-inset bg-white text-xs text-eui-slate-400">
      {failed ? assetsStrings.previewFailed : assetsStrings.previewUnavailable}
    </span>;
  }
  return <span className="flex h-28 items-center justify-center overflow-hidden rounded-inset bg-white" style={{ background: CHECKERBOARD }}>
    <img
      className="max-h-28 max-w-full object-contain"
      src={asset.url}
      alt={assetsStrings.previewAlt(asset.originalName ?? shortAssetId(asset.id))}
      loading="lazy"
      onLoad={(event) => onProbe(asset.id, probeLoadedImage(event.currentTarget))}
      onError={() => setFailed(true)}
    />
  </span>;
}

function dimensionsLabel(asset: AssetListItem, probe: AssetProbe | undefined): string {
  if (probe?.naturalWidth && probe.naturalHeight) return `${probe.naturalWidth}×${probe.naturalHeight}`;
  if (asset.width && asset.height) return `${asset.width}×${asset.height}`;
  return assetsStrings.dimensionsUnknown;
}

const ALPHA_LABEL = {
  alpha: assetsStrings.alphaAlpha,
  opaque: assetsStrings.alphaOpaque,
  unknown: assetsStrings.alphaUnknown,
} as const;

function AssetDetails({ asset, probe, warning }: { asset: AssetListItem; probe: AssetProbe; warning: RasterOverSvgWarning | undefined }) {
  const usage = useApi((signal) => getAssetUsage(asset.id, signal), [asset.id]);
  return <div className="flex flex-col gap-4">
    <div>
      <p className={kicker}>{assetsStrings.fullId}</p>
      <div className="mt-1 flex items-start gap-2">
        <code className="min-w-0 grow break-all rounded-item bg-eui-lav px-2 py-1 font-mono text-xs">{asset.id}</code>
        <CopyIdButton id={asset.id} />
      </div>
      <h2 className="mt-3 pay-display text-xl">{asset.originalName ?? <span className="text-eui-slate-400">{assetsStrings.metaNoName}</span>}</h2>
    </div>

    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <Meta label={assetsStrings.metaMime}>{asset.mime}</Meta>
      <Meta label={assetsStrings.metaSize}>{formatBytes(asset.size)} <span className="text-eui-slate-400">({asset.size})</span></Meta>
      <Meta label={assetsStrings.metaServerDimensions}>{asset.width && asset.height ? `${asset.width}×${asset.height}` : assetsStrings.dimensionsUnknown}</Meta>
      <Meta label={assetsStrings.metaClientDimensions}>{probe.naturalWidth && probe.naturalHeight ? `${probe.naturalWidth}×${probe.naturalHeight}` : isImage(asset.mime) ? assetsStrings.measuring : assetsStrings.dimensionsUnknown}</Meta>
      <Meta label={assetsStrings.alphaLabel}>{ALPHA_LABEL[probe.alpha]}</Meta>
      <Meta label={assetsStrings.metaCreatedAt}>{asset.createdAt}</Meta>
    </dl>
    <p className="text-xs text-eui-slate-400">{assetsStrings.alphaHint}</p>

    {warning ? <section className="rounded-popover bg-eui-lilac-100 p-3 text-sm">
      <p className="font-bold">{assetsStrings.rasterOverSvgTitle} <Badge heuristic /></p>
      <p className="mt-1 text-eui-slate-500">{assetsStrings.rasterOverSvgNote}</p>
      <p className="mt-1 text-eui-slate-500">{assetsStrings.rasterOverSvgFor(warning.key)}: {warning.svgIds.map(shortAssetId).join(", ")}</p>
    </section> : null}

    <section>
      <h3 className="flex items-center gap-2 pay-display text-lg">{assetsStrings.usageTitle} <Badge /></h3>
      {usage.status === "loading" ? <p className="mt-2 text-sm text-eui-slate-500" role="status">{assetsStrings.usageLoading}</p> : null}
      {usage.status === "error" ? <p className="mt-2 text-sm text-eui-slate-500" role="alert">
        {assetsStrings.usageUnavailable} <button type="button" className="font-bold underline" onClick={usage.reload}>{assetsStrings.retry}</button>
      </p> : null}
      {usage.status === "ready" ? <UsageGraph usage={usage.data} /> : null}
    </section>
  </div>;
}

function UsageGraph({ usage }: { usage: AssetUsageGraph }) {
  const empty = !usage.prototypes.length && !usage.components.length && !usage.visualReferences.length && !usage.visualRuns.length;
  if (empty) return <p className="mt-2 rounded-inset bg-eui-lav p-3 text-sm text-eui-slate-500">{assetsStrings.usageNone}</p>;
  return <div className="mt-2 flex flex-col gap-3 text-sm">
    {usage.prototypes.length ? <UsageSection title={assetsStrings.usagePrototypes}>
      {usage.prototypes.map((prototype) => <li key={prototype.id}>
        <span className="font-bold">{prototype.name}</span>{" "}
        <span className="text-eui-slate-500">{assetsStrings.usageRevisions(prototype.revCount)} · {prototype.pinnedAtHead ? assetsStrings.usagePinnedAtHead : assetsStrings.usagePinnedHistorical}</span>
      </li>)}
    </UsageSection> : null}
    {usage.components.length ? <UsageSection title={assetsStrings.usageComponents}>
      {usage.components.map((component) => <li key={component.id}>
        <span className="font-bold">{component.name}</span> <span className="text-eui-slate-500">{assetsStrings.usageVersions(component.versions)}</span>
      </li>)}
    </UsageSection> : null}
    {usage.visualReferences.length ? <UsageSection title={assetsStrings.usageVisualReferences}>
      {usage.visualReferences.map((reference) => <li key={reference.id} className="font-mono text-xs">
        {reference.id}{reference.deleted ? ` · ${assetsStrings.usageReferenceDeleted}` : ""}
      </li>)}
    </UsageSection> : null}
    {usage.visualRuns.length ? <UsageSection title={assetsStrings.usageVisualRuns}>
      {usage.visualRuns.map((run) => <li key={`${run.id}:${run.role}`} className="font-mono text-xs">
        {run.id} · {assetsStrings.usageRunRole[run.role] ?? run.role}
      </li>)}
    </UsageSection> : null}
  </div>;
}

function UsageSection({ title, children }: { title: string; children: ReactNode }) {
  return <section>
    <h4 className={kicker}>{title}</h4>
    <ul className="mt-1 space-y-1">{children}</ul>
  </section>;
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return <>
    <dt className="text-eui-slate-500">{label}</dt>
    <dd className="break-words">{children}</dd>
  </>;
}

/** Явная маркировка «точно» / «эвристика» — требование волны 7.4. */
function Badge({ heuristic = false }: { heuristic?: boolean }) {
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${heuristic ? "bg-eui-brand/10 text-eui-brand" : "bg-eui-ink/10 text-eui-ink"}`}>
    {heuristic ? assetsStrings.heuristicBadge : assetsStrings.exactBadge}
  </span>;
}

function CopyIdButton({ id }: { id: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return <button
    type="button"
    className={`${chip} shrink-0 whitespace-nowrap hover:bg-eui-lilac-100/60`}
    onClick={() => {
      const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
      if (!clipboard) { setState("failed"); return; }
      void clipboard.writeText(id).then(() => setState("copied"), () => setState("failed"));
    }}
  >{state === "copied" ? assetsStrings.copied : state === "failed" ? assetsStrings.copyFailed : assetsStrings.copyId}</button>;
}

function DuplicatesPanel({ groups, onSelect }: { groups: { key: string; assets: AssetListItem[] }[]; onSelect: (id: string) => void }) {
  return <section className="mt-5">
    <h2 className="flex items-center gap-2 text-sm font-bold">{assetsStrings.duplicatesTitle} <Badge /></h2>
    <p className="mt-1 text-xs leading-5 text-eui-slate-500">{assetsStrings.duplicatesExactNote}</p>
    <h3 className="mt-3 flex items-center gap-2 text-sm font-bold">{assetsStrings.duplicatesHeuristicTitle} <Badge heuristic /></h3>
    <p className="mt-1 text-xs leading-5 text-eui-slate-500">{assetsStrings.duplicatesHeuristicNote}</p>
    {groups.length
      ? <ul className="mt-2 space-y-2">{groups.map((group) => <li key={group.key}>
        <p className="text-xs font-bold">{group.key} · {assetsStrings.duplicatesGroup(group.assets.length)}</p>
        <ul className="mt-1 space-y-0.5">{group.assets.map((asset) => <li key={asset.id}>
          <button type="button" className="font-mono text-xs text-eui-slate-500 underline" onClick={() => onSelect(asset.id)}>{shortAssetId(asset.id)}</button>
          <span className="ml-1 text-xs text-eui-slate-400">{formatBytes(asset.size)}</span>
        </li>)}</ul>
      </li>)}</ul>
      : <p className="mt-2 text-xs text-eui-slate-400">{assetsStrings.duplicatesNone}</p>}
  </section>;
}

function RasterOverSvgPanel({ warnings, assets, onSelect }: { warnings: RasterOverSvgWarning[]; assets: AssetListItem[]; onSelect: (id: string) => void }) {
  const nameById = new Map(assets.map((asset) => [asset.id, asset.originalName ?? shortAssetId(asset.id)]));
  return <section className="mt-5">
    <h2 className="flex items-center gap-2 text-sm font-bold">{assetsStrings.rasterOverSvgTitle} <Badge heuristic /></h2>
    <p className="mt-1 text-xs leading-5 text-eui-slate-500">{assetsStrings.rasterOverSvgNote}</p>
    {warnings.length
      ? <ul className="mt-2 space-y-1">{warnings.map((warning) => <li key={warning.rasterId} className="text-xs">
        <button type="button" className="underline" onClick={() => onSelect(warning.rasterId)}>{nameById.get(warning.rasterId) ?? shortAssetId(warning.rasterId)}</button>
        <span className="ml-1 text-eui-slate-400">→ {warning.svgIds.map((id) => nameById.get(id) ?? shortAssetId(id)).join(", ")}</span>
      </li>)}</ul>
      : <p className="mt-2 text-xs text-eui-slate-400">{assetsStrings.rasterOverSvgNone}</p>}
  </section>;
}
