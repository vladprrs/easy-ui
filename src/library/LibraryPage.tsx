import { useCallback, useMemo, useState, type ReactNode } from "react";
import { getCatalogManifest, getComponentMeta, listDesignSystems, listVisualReferences, type CatalogComponent, type ComponentVersionSummary, type FigmaProvenance, type VisualReference } from "../api/client";
import { useApi } from "../api/hooks";
import { chip, chipActive, headingBar, kicker } from "../app/chrome";
import { figmaBadgeTitle, levelSection, library } from "../app/strings/library";
import { atomicLevelLabel, componentLibraryStatus, groupLibraryEntries, LIBRARY_STATUS_KEYS, libraryStatusLabel, matchesLibraryFilter, selectionForComponent, selectionForStory, selectionKey, type ComponentLibraryStatus, type LibrarySelection, type LibraryStatusKey } from "./libraryModel";
import { componentStatusBadge } from "./statusBadge";
import { fetchStorybookIndex, parseStorybookTitle, type StorybookEntry } from "./storybookIndex";

const levelOrder = ["Layout", "Atoms", "Molecules", "Organisms", "Templates", "Pages", "Other"];
const fetchStories = () => fetchStorybookIndex();

interface LibraryStatusEntry { status: ComponentLibraryStatus; figma: FigmaProvenance | null }
const EMPTY_STATUS = new Map<string, LibraryStatusEntry>();
const componentKey = (component: CatalogComponent) => selectionKey(selectionForComponent(component));

function firstSelection(stories: StorybookEntry[], components: CatalogComponent[]): LibrarySelection | null {
  return stories[0] ? selectionForStory(stories[0]) : components[0] ? selectionForComponent(components[0]) : null;
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
  const registry = useApi(listDesignSystems, []);
  const storybook = useApi(fetchStories, []);
  const manifest = useApi(getCatalogManifest, []);
  const [activeSystem, setActiveSystem] = useState<string | null>(null);
  const [selection, setSelection] = useState<LibrarySelection | null>(null);
  const [filters, setFilters] = useState<Set<LibraryStatusKey>>(new Set());
  const toggleFilter = useCallback((key: LibraryStatusKey) => setFilters((prev) => {
    const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next;
  }), []);

  const stories = useMemo(() => storybook.status === "ready" && storybook.data
    ? Object.values(storybook.data.entries).filter((entry) => entry.type === "story") : [], [storybook.data, storybook.status]);
  const components = useMemo(() => manifest.status === "ready" ? manifest.data.components : [], [manifest.data, manifest.status]);
  const groups = useMemo(() => registry.status === "ready"
    ? groupLibraryEntries(registry.data.designSystems, stories, components) : [], [components, registry, stories]);
  const active = groups.find((group) => group.system.id === activeSystem) ?? groups[0];

  const statusComponents = active?.components ?? [];
  const statusSignature = statusComponents.map((component) => `${component.id}@${component.version}`).join(",");
  const statuses = useApi((signal) => loadLibraryStatuses(statusComponents, signal), [statusSignature]);
  const statusMap = statuses.status === "ready" ? statuses.data : EMPTY_STATUS;

  const isVisible = useCallback((component: CatalogComponent) => {
    if (!filters.size) return true;
    const entry = statusMap.get(componentKey(component));
    if (!entry) return true; // not resolved yet — never hide while loading
    return [...filters].some((filter) => matchesLibraryFilter(entry.status, filter));
  }, [filters, statusMap]);

  const storyGroups = useMemo(() => active?.stories.reduce<Record<string, StorybookEntry[]>>((result, entry) => {
    const { level } = parseStorybookTitle(entry);
    (result[levelOrder.includes(level) ? level : "Other"] ??= []).push(entry);
    return result;
  }, {}) ?? {}, [active]);
  const customGroups = useMemo(() => (active?.components ?? []).filter(isVisible).reduce<Record<string, CatalogComponent[]>>((result, component) => {
    (result[atomicLevelLabel(component.atomicLevel)] ??= []).push(component);
    return result;
  }, {}) ?? {}, [active, isVisible]);
  const available = active ? [...active.stories.map(selectionForStory), ...active.components.map(selectionForComponent)] : [];
  const selected = selection && available.some((item) => selectionKey(item) === selectionKey(selection))
    ? selection : active ? firstSelection(active.stories, active.components) : null;
  const selectedStory = selected?.kind === "story" ? active?.stories.find((story) => story.id === selected.storyId) : undefined;
  const selectedComponent = selected?.kind === "custom" ? active?.components.find((component) => component.id === selected.componentId && component.designSystem === selected.designSystem) : undefined;

  return <main className="flex h-full min-h-0 flex-col lg:flex-row">
    <aside className="w-full shrink-0 border-b p-5 font-eui-ui lg:w-72 lg:border-b-0 lg:border-r">
      <h1 className={headingBar}>{library.title}</h1>
      {registry.status === "loading" ? <p className="mt-4 text-sm text-eui-slate-500" role="status">{library.loadingSystems}</p> : null}
      {registry.status === "error" ? <SourceError label={library.systemsUnavailable} retry={registry.reload} /> : null}
      <div className="mt-4 flex flex-wrap gap-2" aria-label={library.designSystemsAria}>
        {groups.map((group) => <button type="button" key={group.system.id} aria-pressed={active?.system.id === group.system.id} className={active?.system.id === group.system.id ? chipActive : `${chip} hover:bg-eui-lilac-100/60`} onClick={() => {
          setActiveSystem(group.system.id);
          setSelection(firstSelection(group.stories, group.components));
        }}>{group.system.name}</button>)}
      </div>
      <div className="mt-3 flex flex-wrap gap-2" aria-label={library.statusFiltersAria}>
        {LIBRARY_STATUS_KEYS.map((key) => <button type="button" key={key} aria-pressed={filters.has(key)} className={filters.has(key) ? chipActive : `${chip} hover:bg-eui-lilac-100/60`} onClick={() => toggleFilter(key)}>{libraryStatusLabel[key]}</button>)}
      </div>
      <nav className="mt-5 space-y-4" aria-label={library.componentsAria}>
        {levelOrder.filter((level) => storyGroups[level]?.length).map((level) => <EntrySection key={`story-${level}`} title={levelSection(level)} entries={storyGroups[level].map((story) => ({
          key: `story:${story.id}`, name: parseStorybookTitle(story).name, active: selected?.kind === "story" && selected.storyId === story.id, select: () => setSelection(selectionForStory(story)),
        }))} />)}
        {levelOrder.filter((level) => customGroups[level]?.length).map((level) => <EntrySection key={`custom-${level}`} title={`${levelSection(level)} · ${library.customSectionSuffix}`} entries={customGroups[level].map((component) => ({
          key: `custom:${component.id}:${component.designSystem}`, name: component.name, active: selected?.kind === "custom" && selected.componentId === component.id && selected.designSystem === component.designSystem, select: () => setSelection(selectionForComponent(component)),
          badge: statusMap.get(componentKey(component))?.figma ? <FigmaDot /> : undefined,
        }))} />)}
        {active && !active.stories.length && !active.components.length && storybook.status !== "loading" && manifest.status !== "loading" ? <p className="text-sm text-eui-slate-500">{library.noComponents}</p> : null}
      </nav>
    </aside>
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4 font-eui-ui">
      {storybook.status === "loading" ? <p className="rounded-xl bg-eui-lav p-3 text-sm text-eui-slate-500" role="status">{library.loadingStorybook}</p> : null}
      {storybook.status === "error" || (storybook.status === "ready" && !storybook.data) ? <SourceError label={library.storybookUnavailable} retry={storybook.reload} /> : null}
      {manifest.status === "loading" ? <p className="rounded-xl bg-eui-lav p-3 text-sm text-eui-slate-500" role="status">{library.loadingCatalog}</p> : null}
      {manifest.status === "error" ? <SourceError label={library.catalogUnavailable} retry={manifest.reload} /> : null}
      {selectedStory ? <StoryPreview story={selectedStory} /> : selectedComponent ? <ComponentMetadata component={selectedComponent} systemName={active?.system.name ?? selectedComponent.designSystem} /> : <div className="flex flex-1 items-center justify-center rounded-3xl bg-eui-lav p-6 text-eui-slate-500">{library.selectComponent}</div>}
    </section>
  </main>;
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

function StoryPreview({ story }: { story: StorybookEntry }) {
  const parsed = parseStorybookTitle(story);
  const iframeUrl = `/storybook/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`;
  return <><div className="flex items-center gap-3 text-sm"><span className="font-bold">{parsed.name} · {parsed.level}</span><a className="ml-auto text-eui-slate-500 underline hover:text-eui-brand" href={iframeUrl} target="_blank" rel="noreferrer">{library.openInStorybook}</a></div><iframe className="min-h-0 flex-1 overflow-hidden rounded-3xl border border-eui-ink/10" title={library.storyPreviewTitle} src={iframeUrl} /></>;
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
  const previewUrl = component.example ? `/capture/component/${encodeURIComponent(component.id)}/${component.version}?props=example` : null;
  return <article className="max-w-2xl rounded-3xl bg-eui-lav p-6">
    <div className="flex items-center gap-2"><p className={kicker}>{library.customBadge}</p>{badge ? <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${badge.className}`} title={badge.title}>{badge.label}</span> : null}{figma ? <FigmaBadge figma={figma} /> : null}</div>
    <h2 className="mt-2 font-eui-display text-2xl font-medium">{component.name}</h2>
    {previewUrl
      ? <iframe className="mt-4 h-64 w-full overflow-hidden rounded-2xl border border-eui-ink/10 bg-background" title={library.previewTitle(component.name)} src={previewUrl} />
      : <p className="mt-4 rounded-2xl bg-eui-lilac-100/50 p-4 text-sm text-eui-slate-500">{library.noExampleProps}</p>}
    <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
      <Metadata label={library.metaSystem} value={systemName} /><Metadata label={library.metaAtomicLevel} value={levelSection(atomicLevelLabel(component.atomicLevel))} /><Metadata label={library.metaVersion} value={`v${component.version}`} />
      <Metadata label={library.metaDescription} value={component.description || library.noDescription} /><Metadata label={library.metaEvents} value={component.events.length ? component.events.join(", ") : library.none} /><Metadata label={library.metaSlots} value={component.slots.length ? component.slots.join(", ") : library.none} />
    </dl>
  </article>;
}

function Metadata({ label, value }: { label: string; value: string }) { return <div><dt className="text-eui-slate-500">{label}</dt><dd className="mt-1 font-medium">{value}</dd></div>; }
