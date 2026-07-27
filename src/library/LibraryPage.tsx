import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { getCatalogManifest, getComponentMeta, getComponentUsages, listDesignSystems, listVisualReferences, type CatalogComponent, type ComponentUsageReport, type ComponentVersionSummary, type FigmaProvenance, type VisualReference } from "../api/client";
import { useApi } from "../api/hooks";
import { chip, chipActive, headingBar, inputBase, kicker, pillPrimary } from "../app/chrome";
import { figmaBadgeTitle, levelSection, library } from "../app/strings/library";
import { useDocumentTitle } from "../app/useDocumentTitle";
import { applicableLibraryStatusKeys, atomicLevelLabel, componentLibraryStatus, groupLibraryEntries, libraryStatusLabel, matchesLibraryFilter, searchComponents, selectionForComponent, selectionKey, similarComponents, tokenize, type ComponentLibraryStatus, type LibrarySelection, type LibraryStatusKey } from "./libraryModel";
import { componentStatusBadge } from "./statusBadge";
import { UsageTree } from "./UsageTree";

const levelOrder = ["Layout", "Atoms", "Molecules", "Organisms", "Templates", "Pages", "Other"];

interface LibraryStatusEntry { status: ComponentLibraryStatus; figma: FigmaProvenance | null }
const EMPTY_STATUS = new Map<string, LibraryStatusEntry>();
const componentKey = (component: CatalogComponent) => selectionKey(selectionForComponent(component));

function firstSelection(components: CatalogComponent[]): LibrarySelection | null {
  return components[0] ? selectionForComponent(components[0]) : null;
}

// Lazily resolves the status vector + Figma link for every custom component of the active system.
// Fired after the manifest so the initial paint is not blocked on N per-component fetches.
async function loadLibraryStatuses(components: CatalogComponent[], signal: AbortSignal): Promise<Map<string, LibraryStatusEntry>> {
  const map = new Map<string, LibraryStatusEntry>();
  if (!components.length) return map;
  const references: VisualReference[] = (await listVisualReferences({ scope: "component" }, signal)).references;
  await Promise.all(components.map(async (component) => {
    let versions: ComponentVersionSummary[] = [];
    let figma: FigmaProvenance | null = null;
    try { const meta = await getComponentMeta(component.id, signal); versions = meta.versions; figma = meta.figma ?? null; }
    catch { /* status stays best-effort; an unresolved component is treated as visible */ }
    map.set(componentKey(component), { status: componentLibraryStatus(component.id, component.version, versions, references), figma });
  }));
  return map;
}

export function LibraryPage() {
  useDocumentTitle(library.title);
  const registry = useApi(listDesignSystems, []);
  const manifest = useApi(getCatalogManifest, []);
  const [activeSystem, setActiveSystem] = useState<string | null>(null);
  const [selection, setSelection] = useState<LibrarySelection | null>(null);
  const [filters, setFilters] = useState<Set<LibraryStatusKey>>(new Set());
  const [query, setQuery] = useState("");
  const toggleFilter = useCallback((key: LibraryStatusKey) => setFilters((prev) => {
    const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next;
  }), []);

  const components = useMemo(() => manifest.status === "ready" ? manifest.data.components : [], [manifest.data, manifest.status]);
  const groups = useMemo(() => registry.status === "ready"
    ? groupLibraryEntries(registry.data.designSystems, components) : [], [components, registry]);
  const active = groups.find((group) => group.system.id === activeSystem) ?? groups[0];

  const statusComponents = useMemo(() => active?.components ?? [], [active]);
  const statusSignature = statusComponents.map((component) => `${component.id}@${component.version}`).join(",");
  const statuses = useApi((signal) => loadLibraryStatuses(statusComponents, signal), [statusSignature]);
  const statusMap = statuses.status === "ready" ? statuses.data : EMPTY_STATUS;
  const applicableStatusKeys = useMemo(() => statuses.status === "ready"
    ? applicableLibraryStatusKeys(statusComponents.flatMap((component) => {
      const entry = statusMap.get(componentKey(component));
      return entry ? [entry.status] : [];
    }))
    : [], [statusComponents, statusMap, statuses.status]);
  const applicableStatusSet = useMemo(() => new Set(applicableStatusKeys), [applicableStatusKeys]);

  const isVisible = useCallback((component: CatalogComponent) => {
    const activeFilters = [...filters].filter((filter) => applicableStatusSet.has(filter));
    if (!activeFilters.length) return true;
    const entry = statusMap.get(componentKey(component));
    if (!entry) return true; // not resolved yet — never hide while loading
    return activeFilters.some((filter) => matchesLibraryFilter(entry.status, filter));
  }, [applicableStatusSet, filters, statusMap]);

  // Поиск по product job ранжирует результат, поэтому при непустом запросе разбиение по
  // уровням Atomic Design заменяется одним списком в порядке ранга.
  const searched = useMemo(() => searchComponents((active?.components ?? []).filter(isVisible), query), [active, isVisible, query]);
  const searching = tokenize(query).length > 0;
  const customGroups = useMemo(() => searching ? {} : searched.reduce<Record<string, CatalogComponent[]>>((result, component) => {
    (result[atomicLevelLabel(component.atomicLevel)] ??= []).push(component);
    return result;
  }, {}), [searched, searching]);
  const available = active ? active.components.map(selectionForComponent) : [];
  const selected = selection && available.some((item) => selectionKey(item) === selectionKey(selection))
    ? selection : active ? firstSelection(active.components) : null;
  const selectedComponent = selected ? active?.components.find((component) => component.id === selected.componentId && component.designSystem === selected.designSystem) : undefined;

  return <main className="flex h-full min-h-0 flex-col lg:flex-row">
    <aside className="w-full shrink-0 border-b p-5 font-eui-ui lg:w-72 lg:border-b-0 lg:border-r">
      <h1 className={headingBar}>{library.title}</h1>
      {registry.status === "loading" ? <p className="mt-4 text-sm text-eui-slate-500" role="status">{library.loadingSystems}</p> : null}
      {registry.status === "error" ? <SourceError label={library.systemsUnavailable} retry={registry.reload} /> : null}
      <div className="mt-4 flex flex-wrap gap-2" aria-label={library.designSystemsAria}>
        {groups.map((group) => <button type="button" key={group.system.id} aria-pressed={active?.system.id === group.system.id} className={active?.system.id === group.system.id ? chipActive : `${chip} hover:bg-eui-lilac-100/60`} onClick={() => {
          setActiveSystem(group.system.id);
          setSelection(firstSelection(group.components));
          setFilters(new Set());
        }}>{group.system.name}</button>)}
      </div>
      {applicableStatusKeys.length ? <div className="mt-3 flex flex-wrap gap-2" aria-label={library.statusFiltersAria}>
        {applicableStatusKeys.map((key) => <button type="button" key={key} aria-pressed={filters.has(key)} className={filters.has(key) ? chipActive : `${chip} hover:bg-eui-lilac-100/60`} onClick={() => toggleFilter(key)}>{libraryStatusLabel[key]}</button>)}
      </div> : null}
      <label className="mt-4 block text-sm text-eui-slate-500">{library.searchLabel}
        <input type="search" className={`${inputBase} mt-1 block w-full bg-white text-eui-ink`} value={query} placeholder={library.searchPlaceholder} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <nav className="mt-5 space-y-4" aria-label={library.componentsAria}>
        {searching
          ? searched.length
            ? <EntrySection title={library.searchLabel} entries={searched.map((component) => entryFor(component, selected, setSelection, statusMap))} />
            : <p className="text-sm text-eui-slate-500" role="status">{library.searchEmpty}</p>
          : levelOrder.filter((level) => customGroups[level]?.length).map((level) => <EntrySection key={`custom-${level}`} title={`${levelSection(level)} · ${library.customSectionSuffix}`} entries={customGroups[level].map((component) => entryFor(component, selected, setSelection, statusMap))} />)}
      </nav>
    </aside>
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 font-eui-ui">
      {manifest.status === "loading" ? <p className="rounded-xl bg-eui-lav p-3 text-sm text-eui-slate-500" role="status">{library.loadingCatalog}</p> : null}
      {manifest.status === "error" ? <SourceError label={library.catalogUnavailable} retry={manifest.reload} /> : null}
      {selectedComponent ? <ComponentMetadata key={`${selectedComponent.id}@${selectedComponent.version}`} component={selectedComponent} systemName={active?.system.name ?? selectedComponent.designSystem} siblings={active?.components ?? []} onSelect={setSelection} /> : active && !active.components.length ? <EmptySystem /> : <div className="flex flex-1 items-center justify-center rounded-3xl bg-eui-lav p-6 text-center text-eui-slate-500">{library.selectComponent}</div>}
    </section>
  </main>;
}

function EmptySystem() {
  return <div className="flex flex-1 items-center justify-center rounded-3xl bg-eui-lav p-6">
    <div className="max-w-xl">
      <p className={kicker}>{library.emptySystemGuideTitle}</p>
      <h2 className="mt-2 font-eui-display text-2xl font-medium">{library.emptySystemTitle}</h2>
      <p className="mt-3 text-sm leading-6 text-eui-slate-500">{library.emptySystemDescription}</p>
      <ol className="mt-5 space-y-3 text-sm">
        <li><span className="font-bold">1.</span> {library.emptySystemCreateStep} <code className="rounded bg-white px-1.5 py-0.5">POST /api/components</code></li>
        <li><span className="font-bold">2.</span> {library.emptySystemPublishStep} <code className="rounded bg-white px-1.5 py-0.5">POST /api/components/&#123;id&#125;/publish</code></li>
      </ol>
      <a className="mt-6 inline-flex rounded-full bg-eui-brand px-4 py-2 text-sm font-bold text-white hover:opacity-90" href="/api/openapi.json">{library.emptySystemApiLink}</a>
    </div>
  </div>;
}

function SourceError({ label, retry }: { label: string; retry: () => void }) {
  return <div className="mt-3 rounded-xl bg-eui-lilac-100 p-3 text-sm text-eui-slate-500" role="alert">{label} <button type="button" className="font-bold underline" onClick={retry}>{library.retry}</button></div>;
}

function FigmaDot() {
  return <span className="ml-1 inline-block rounded px-1 text-[10px] font-bold text-eui-brand" aria-hidden="true" title={library.linkedToFigma}>F</span>;
}

function entryFor(
  component: CatalogComponent,
  selected: LibrarySelection | null,
  setSelection: (selection: LibrarySelection) => void,
  statusMap: Map<string, LibraryStatusEntry>,
) {
  return {
    key: `custom:${component.id}:${component.designSystem}`,
    name: component.name,
    active: selected?.kind === "custom" && selected.componentId === component.id && selected.designSystem === component.designSystem,
    select: () => setSelection(selectionForComponent(component)),
    badge: <>
      {component.canonicalFor?.length ? <Dot label="C" title={library.canonicalBadgeTitle(component.canonicalFor)} /> : null}
      {component.deprecated ? <Dot label="D" title={library.deprecatedBadgeTitle} /> : null}
      {statusMap.get(componentKey(component))?.figma ? <FigmaDot /> : null}
    </>,
  };
}

function Dot({ label, title }: { label: string; title: string }) {
  return <span className="ml-1 inline-block rounded px-1 text-[10px] font-bold text-eui-brand" title={title}>{label}</span>;
}

function EntrySection({ title, entries }: { title: string; entries: { key: string; name: string; active: boolean; select: () => void; badge?: ReactNode }[] }) {
  return <section><h2 className={kicker}>{title}</h2><ul className="mt-1 space-y-1">{entries.map((entry) => <li key={entry.key}><button type="button" className={`flex w-full items-center rounded-lg px-2 py-1 text-left text-sm ${entry.active ? "bg-eui-lilac-100 font-bold" : "text-eui-slate-500 hover:bg-eui-lilac-100/60"}`} onClick={entry.select}><span>{entry.name}</span>{entry.badge}</button></li>)}</ul></section>;
}

function FigmaBadge({ figma }: { figma: FigmaProvenance }) {
  const title = figmaBadgeTitle(figma.fileKey, figma.nodeIds.length);
  return <span className="rounded-full bg-eui-lilac-100 px-2 py-0.5 text-xs font-bold text-eui-brand" title={title}>Figma</span>;
}

function ComponentMetadata({ component, systemName, siblings, onSelect }: { component: CatalogComponent; systemName: string; siblings: CatalogComponent[]; onSelect: (selection: LibrarySelection) => void }) {
  const loadMeta = useCallback((signal?: AbortSignal) => getComponentMeta(component.id, signal), [component.id]);
  const meta = useApi(loadMeta, [component.id]);
  const version = meta.status === "ready" ? meta.data.versions.find((entry) => entry.version === component.version) : undefined;
  const badge = version ? componentStatusBadge(version.status, version.statusReason) : null;
  const figma = meta.status === "ready" ? meta.data.figma ?? null : null;
  const variants = useMemo(() => [
    ...(component.example ? ["default"] : []),
    ...Object.keys(component.examples ?? {}).sort(),
  ], [component.example, component.examples]);
  const [selectedVariant, setSelectedVariant] = useState<string | null>(() => variants[0] ?? null);
  // `definition.replacement` — имя компонента; ссылку строим по каталогу активной системы.
  const replacement = useMemo(() => component.replacement ? siblings.find((item) => item.name === component.replacement) ?? null : null, [component.replacement, siblings]);
  const similar = useMemo(() => similarComponents(component, siblings), [component, siblings]);
  const previewUrl = selectedVariant === null ? null
    : `/capture/component/${encodeURIComponent(component.id)}/${component.version}?${selectedVariant === "default" ? "props=example" : `example=${encodeURIComponent(selectedVariant)}`}`;
  return <article className="max-w-2xl rounded-3xl bg-eui-lav p-6">
    <div className="flex flex-wrap items-center gap-2"><p className={kicker}>{library.customBadge}</p>{badge ? <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${badge.className}`} title={badge.title}>{badge.label}</span> : null}{figma ? <FigmaBadge figma={figma} /> : null}
      {component.canonicalFor?.length ? <span className="rounded-full bg-eui-brand px-2 py-0.5 text-xs font-bold text-white" title={library.canonicalBadgeTitle(component.canonicalFor)}>{library.canonicalBadge}</span> : null}
      {component.deprecated ? <span className="rounded-full bg-eui-lilac-100 px-2 py-0.5 text-xs font-bold text-eui-magenta" title={library.deprecatedBadgeTitle}>{library.deprecatedBadge}</span> : null}
      {replacement ? <button type="button" className="rounded-full bg-eui-lilac-100 px-2 py-0.5 text-xs font-bold text-eui-brand underline" onClick={() => onSelect(selectionForComponent(replacement))}>{library.replacementLink(replacement.name)}</button> : null}
    </div>
    <h2 className="mt-2 font-eui-display text-2xl font-medium">{component.name}</h2>
    <Link className={`${pillPrimary} mt-4`} to={`/library/c/${encodeURIComponent(component.id)}?v=${component.version}`}>{library.componentPageLink}</Link>
    {variants.length ? <div className="mt-4 flex flex-wrap gap-2" aria-label={library.previewVariantsAria}>
      {variants.map((variant) => <button type="button" key={variant} aria-pressed={selectedVariant === variant} className={selectedVariant === variant ? chipActive : chip} onClick={() => setSelectedVariant(variant)}>{variant}</button>)}
    </div> : null}
    {previewUrl
      ? <iframe className="mt-3 h-64 w-full overflow-hidden rounded-2xl border border-eui-ink/10 bg-background" title={library.previewTitle(component.name)} src={previewUrl} />
      : <p className="mt-4 rounded-2xl bg-eui-lilac-100/50 p-4 text-sm text-eui-slate-500">{library.noExampleProps}</p>}
    <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
      <Metadata label={library.metaSystem} value={systemName} /><Metadata label={library.metaAtomicLevel} value={levelSection(atomicLevelLabel(component.atomicLevel))} /><Metadata label={library.metaVersion} value={`v${component.version}`} />
      <Metadata label={library.metaDescription} value={component.description || library.noDescription} /><Metadata label={library.metaEvents} value={component.events.length ? component.events.join(", ") : library.none} /><Metadata label={library.metaSlots} value={component.slots.length ? component.slots.join(", ") : library.none} />
      <Metadata label={library.metaScope} value={component.scope ?? library.none} /><Metadata label={library.metaRoles} value={component.canonicalFor?.length ? component.canonicalFor.join(", ") : library.none} />
    </dl>
    <UsageBlock componentId={component.id} headUsageCount={component.headUsageCount} />
    {similar.length ? <section className="mt-5" aria-labelledby="library-similar-title">
      <h3 id="library-similar-title" className={kicker}>{library.similarTitle}</h3>
      <div className="mt-2 flex flex-wrap gap-2">{similar.map((item) => <button type="button" key={item.id} className={chip} onClick={() => onSelect(selectionForComponent(item))}>{item.name}</button>)}</div>
    </section> : null}
  </article>;
}

/** «Используется в head» + разворачиваемое дерево usages (волна 3 §3.3). */
function UsageBlock({ componentId, headUsageCount }: { componentId: string; headUsageCount?: number }) {
  const load = useCallback((signal?: AbortSignal) => getComponentUsages(componentId, signal), [componentId]);
  const usages = useApi(load, [componentId]);
  const [expanded, setExpanded] = useState(false);
  const report: ComponentUsageReport | null = usages.status === "ready" ? usages.data : null;
  const count = report ? report.currentHeadUsages.length : headUsageCount ?? 0;
  return <section className="mt-5" aria-labelledby="library-usage-title">
    <div className="flex flex-wrap items-center gap-2">
      <h3 id="library-usage-title" className={kicker}>{library.headUsageTitle}</h3>
      <span className="text-sm font-bold">{library.headUsageCount(count)}</span>
      {report?.currentHeadUsages.length ? <button type="button" className={chip} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? library.hideUsages : library.showUsages}</button> : null}
    </div>
    {usages.status === "loading" ? <p className="mt-2 text-sm text-eui-slate-500" role="status">{library.headUsageLoading}</p> : null}
    {usages.status === "error" ? <p className="mt-2 text-sm text-eui-slate-500" role="alert">{library.headUsageError} <button type="button" className="font-bold underline" onClick={usages.reload}>{library.retry}</button></p> : null}
    {report && !report.currentHeadUsages.length ? <p className="mt-2 text-sm text-eui-slate-500">{report.safeToRemove ? library.safeToRemove : library.headUsageNone}</p> : null}
    {report?.currentHeadUsages.length ? <ul className="mt-2 space-y-1 text-sm">{report.currentHeadUsages.map((usage) => <li key={usage.prototypeId} className="flex flex-wrap items-center gap-2">
      <span className="font-medium">{usage.name}</span>
      <Link className="underline" to={`/p/${encodeURIComponent(usage.prototypeId)}/edit`}>{library.openInEditor}</Link>
      <Link className="underline" to={`/p/${encodeURIComponent(usage.prototypeId)}`}>{library.openInPlayer}</Link>
    </li>)}</ul> : null}
    {report && expanded ? <UsageTree usages={report.currentHeadUsages} /> : null}
    {report?.immutableUsages.length ? <div className="mt-3">
      <h4 className={kicker}>{library.immutableUsageTitle}</h4>
      <ul className="mt-1 space-y-1 text-sm text-eui-slate-500">{report.immutableUsages.map((usage) => <li key={`${usage.prototypeId}@${usage.version}`}>{library.immutableUsageEntry(usage.name, usage.version, usage.componentVersion)}</li>)}</ul>
    </div> : null}
  </section>;
}

function Metadata({ label, value }: { label: string; value: string }) { return <div><dt className="text-eui-slate-500">{label}</dt><dd className="mt-1 font-medium">{value}</dd></div>; }
