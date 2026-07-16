import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { getCatalogManifest, getComponentMeta, listDesignSystems, listVisualReferences, type CatalogComponent, type ComponentVersionSummary, type FigmaProvenance, type VisualReference } from "../api/client";
import { useApi } from "../api/hooks";
import { chip, chipActive, headingBar, kicker, pillPrimary } from "../app/chrome";
import { figmaBadgeTitle, levelSection, library } from "../app/strings/library";
import { useDocumentTitle } from "../app/useDocumentTitle";
import { applicableLibraryStatusKeys, atomicLevelLabel, componentLibraryStatus, groupLibraryEntries, libraryStatusLabel, matchesLibraryFilter, selectionForComponent, selectionKey, type ComponentLibraryStatus, type LibrarySelection, type LibraryStatusKey } from "./libraryModel";
import { componentStatusBadge } from "./statusBadge";

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

  const customGroups = useMemo(() => (active?.components ?? []).filter(isVisible).reduce<Record<string, CatalogComponent[]>>((result, component) => {
    (result[atomicLevelLabel(component.atomicLevel)] ??= []).push(component);
    return result;
  }, {}) ?? {}, [active, isVisible]);
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
      <nav className="mt-5 space-y-4" aria-label={library.componentsAria}>
        {levelOrder.filter((level) => customGroups[level]?.length).map((level) => <EntrySection key={`custom-${level}`} title={`${levelSection(level)} · ${library.customSectionSuffix}`} entries={customGroups[level].map((component) => ({
          key: `custom:${component.id}:${component.designSystem}`, name: component.name, active: selected?.kind === "custom" && selected.componentId === component.id && selected.designSystem === component.designSystem, select: () => setSelection(selectionForComponent(component)),
          badge: statusMap.get(componentKey(component))?.figma ? <FigmaDot /> : undefined,
        }))} />)}
      </nav>
    </aside>
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 font-eui-ui">
      {manifest.status === "loading" ? <p className="rounded-xl bg-eui-lav p-3 text-sm text-eui-slate-500" role="status">{library.loadingCatalog}</p> : null}
      {manifest.status === "error" ? <SourceError label={library.catalogUnavailable} retry={manifest.reload} /> : null}
      {selectedComponent ? <ComponentMetadata key={`${selectedComponent.id}@${selectedComponent.version}`} component={selectedComponent} systemName={active?.system.name ?? selectedComponent.designSystem} /> : active && !active.components.length ? <EmptySystem /> : <div className="flex flex-1 items-center justify-center rounded-3xl bg-eui-lav p-6 text-center text-eui-slate-500">{library.selectComponent}</div>}
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

function EntrySection({ title, entries }: { title: string; entries: { key: string; name: string; active: boolean; select: () => void; badge?: ReactNode }[] }) {
  return <section><h2 className={kicker}>{title}</h2><ul className="mt-1 space-y-1">{entries.map((entry) => <li key={entry.key}><button type="button" className={`flex w-full items-center rounded-lg px-2 py-1 text-left text-sm ${entry.active ? "bg-eui-lilac-100 font-bold" : "text-eui-slate-500 hover:bg-eui-lilac-100/60"}`} onClick={entry.select}><span>{entry.name}</span>{entry.badge}</button></li>)}</ul></section>;
}

function FigmaBadge({ figma }: { figma: FigmaProvenance }) {
  const title = figmaBadgeTitle(figma.fileKey, figma.nodeIds.length);
  return <span className="rounded-full bg-eui-lilac-100 px-2 py-0.5 text-xs font-bold text-eui-brand" title={title}>Figma</span>;
}

function ComponentMetadata({ component, systemName }: { component: CatalogComponent; systemName: string }) {
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
  const previewUrl = selectedVariant === null ? null
    : `/capture/component/${encodeURIComponent(component.id)}/${component.version}?${selectedVariant === "default" ? "props=example" : `example=${encodeURIComponent(selectedVariant)}`}`;
  return <article className="max-w-2xl rounded-3xl bg-eui-lav p-6">
    <div className="flex items-center gap-2"><p className={kicker}>{library.customBadge}</p>{badge ? <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${badge.className}`} title={badge.title}>{badge.label}</span> : null}{figma ? <FigmaBadge figma={figma} /> : null}</div>
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
    </dl>
  </article>;
}

function Metadata({ label, value }: { label: string; value: string }) { return <div><dt className="text-eui-slate-500">{label}</dt><dd className="mt-1 font-medium">{value}</dd></div>; }
