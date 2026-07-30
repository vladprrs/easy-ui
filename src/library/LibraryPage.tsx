import { useMemo, useState, type ReactNode } from "react";
import { getCatalogManifest, getComponentMeta, listDesignSystems, listVisualReferences, type CatalogComponent, type ComponentVersionSummary, type FigmaProvenance, type VisualReference } from "../api/client";
import { useApi } from "../api/hooks";
import { kicker } from "../app/chrome";
import { levelSection, library } from "../app/strings/library";
import { useDocumentTitle } from "../app/useDocumentTitle";
import { CompositionsSection } from "./CompositionsSection";
import { ComponentCard } from "./components/ComponentCard";
import { LibraryHero } from "./components/LibraryHero";
import { LibraryEmpty, LibraryFailed, LibraryNoMatches, LibrarySkeletons, PublishDialog } from "./components/LibraryStates";
import { LibraryToolbar, type LibraryTab } from "./components/LibraryToolbar";
import { applicableLibraryStatusKeys, atomicLevelLabel, componentLibraryStatus, groupLibraryEntries, matchesLibraryFilter, searchComponents, tokenize, type ComponentLibraryStatus, type LibraryStatusKey } from "./libraryModel";

const levelOrder = ["Layout", "Atoms", "Molecules", "Organisms", "Templates", "Pages", "Other"];

interface LibraryStatusEntry { status: ComponentLibraryStatus; figma: FigmaProvenance | null }
const EMPTY_STATUS = new Map<string, LibraryStatusEntry>();

// Статус и связь с Figma живут не в манифесте, а в истории версий и визуальных прогонах,
// поэтому подгружаются отдельно и best-effort: карточка рисуется и без них.
async function loadLibraryStatuses(components: CatalogComponent[], signal: AbortSignal): Promise<Map<string, LibraryStatusEntry>> {
  const map = new Map<string, LibraryStatusEntry>();
  if (!components.length) return map;
  const references: VisualReference[] = (await listVisualReferences({ scope: "component" }, signal)).references;
  await Promise.all(components.map(async (component) => {
    let versions: ComponentVersionSummary[] = [];
    let figma: FigmaProvenance | null = null;
    try { const meta = await getComponentMeta(component.id, signal); versions = meta.versions; figma = meta.figma ?? null; }
    catch { /* статус best-effort: нерешённый компонент остаётся видимым */ }
    map.set(component.id, { status: componentLibraryStatus(component.id, component.version, versions, references), figma });
  }));
  return map;
}

/**
 * Библиотека компонентов (макет 06).
 *
 * Экран отвечает на один вопрос: «какой компонент взять и можно ли ему верить».
 * Поэтому это витрина карточек с живым превью, а не список имён: сортировка по
 * уровням Atomic Design, фильтры системы и статуса на канве, а всё, что нужно
 * читать подробно (параметры, исходник, использования), живёт на странице
 * компонента — карточка целиком ведёт туда.
 */
export function LibraryPage() {
  useDocumentTitle(library.title);
  const registry = useApi(listDesignSystems, []);
  const manifest = useApi(getCatalogManifest, []);
  const [tab, setTab] = useState<LibraryTab>("components");
  const [selectedSystem, setSelectedSystem] = useState<string | null>(null);
  const [status, setStatus] = useState<LibraryStatusKey | null>(null);
  const [query, setQuery] = useState("");
  const [publishOpen, setPublishOpen] = useState(false);

  const loading = registry.status === "loading" || manifest.status === "loading";
  const failed = registry.status === "error" || manifest.status === "error";
  const reload = () => { registry.reload(); manifest.reload(); };

  const components = useMemo(() => manifest.status === "ready" ? manifest.data.components : [], [manifest.data, manifest.status]);
  const groups = useMemo(() => registry.status === "ready"
    ? groupLibraryEntries(registry.data.designSystems, components).filter((group) => group.components.length)
    : [], [components, registry.data, registry.status]);
  const systems = useMemo(() => groups.map((group) => ({ id: group.system.id, name: group.system.name, count: group.components.length })), [groups]);
  const systemNames = useMemo(() => new Map(groups.map((group) => [group.system.id, group.system.name])), [groups]);
  const total = useMemo(() => groups.reduce((sum, group) => sum + group.components.length, 0), [groups]);

  // Область показа: одна система или все сразу (по умолчанию — все, чтобы экран
  // сразу отвечал на «что вообще есть», а не заставлял угадывать систему).
  const scoped = useMemo(() => {
    const list = selectedSystem === null
      ? groups.flatMap((group) => group.components)
      : groups.find((group) => group.system.id === selectedSystem)?.components ?? [];
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [groups, selectedSystem]);

  const statusSignature = scoped.map((component) => `${component.id}@${component.version}`).join(",");
  const statuses = useApi((signal) => loadLibraryStatuses(scoped, signal), [statusSignature]);
  const statusMap = statuses.status === "ready" ? statuses.data : EMPTY_STATUS;
  const statusKeys = useMemo(() => statuses.status === "ready"
    ? applicableLibraryStatusKeys(scoped.flatMap((component) => {
      const entry = statusMap.get(component.id);
      return entry ? [entry.status] : [];
    }))
    : [], [scoped, statusMap, statuses.status]);
  const activeStatus = status !== null && statusKeys.includes(status) ? status : null;

  const filtered = useMemo(() => {
    if (activeStatus === null) return scoped;
    return scoped.filter((component) => {
      const entry = statusMap.get(component.id);
      return entry ? matchesLibraryFilter(entry.status, activeStatus) : true; // не прячем, пока статус не разрешён
    });
  }, [activeStatus, scoped, statusMap]);
  const searching = tokenize(query).length > 0;
  const visible = useMemo(() => searchComponents(filtered, query), [filtered, query]);
  const byLevel = useMemo(() => visible.reduce<Record<string, CatalogComponent[]>>((result, component) => {
    (result[atomicLevelLabel(component.atomicLevel)] ??= []).push(component);
    return result;
  }, {}), [visible]);

  const toolbar = <LibraryToolbar
    tab={tab}
    onTabChange={setTab}
    systems={systems}
    selectedSystem={selectedSystem}
    onSystemChange={setSelectedSystem}
    statusKeys={statusKeys}
    activeStatus={activeStatus}
    onStatusChange={setStatus}
    query={query}
    onQueryChange={setQuery}
    showFilters={tab === "components" && total > 0}
  />;

  const reset = () => { setQuery(""); setStatus(null); setSelectedSystem(null); };
  const cardsFor = (list: CatalogComponent[]) => list.map((component) => <ComponentCard
    key={`${component.designSystem}:${component.id}`}
    component={component}
    systemName={systemNames.get(component.designSystem) ?? component.designSystem}
    showSystem={selectedSystem === null && systems.length > 1}
    status={statusMap.get(component.id)?.status ?? null}
    figma={statusMap.get(component.id)?.figma ?? null}
  />);

  // Канва и gutter приходят из Layout: страница — только колонка панелей с gap 20.
  return <main className="mx-auto flex h-full w-full max-w-[1400px] flex-col gap-5 font-pay-text" data-library-ready={!loading && !failed ? "true" : "false"}>
    <LibraryHero counts={loading || failed ? null : { components: total, systems: systems.length }} onPublish={() => setPublishOpen(true)} />
    {toolbar}
    {tab === "compositions" ? <CompositionsSection /> : <>
      {loading ? <LibrarySkeletons /> : null}
      {failed ? <LibraryFailed label={library.unavailable} onRetry={reload} /> : null}
      {!loading && !failed && !total ? <LibraryEmpty onPublish={() => setPublishOpen(true)} /> : null}
      {!loading && !failed && total > 0 && !visible.length ? <LibraryNoMatches searching={searching} onReset={reset} /> : null}
      {!loading && !failed && visible.length ? (searching
        ? <Section title={library.foundTitle(visible.length)}>{cardsFor(visible)}</Section>
        : levelOrder.filter((level) => byLevel[level]?.length).map((level) => <Section
          key={level}
          title={levelSection(level)}
          meta={library.levelCount(byLevel[level].length)}
        >{cardsFor(byLevel[level])}</Section>)) : null}
    </>}
    {publishOpen ? <PublishDialog onClose={() => setPublishOpen(false)} /> : null}
  </main>;
}

/** Секция грида: заголовок уровня Atomic Design (или результата поиска) и карточки 3×N. */
function Section({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return <section>
    <h2 className={`${kicker} flex flex-wrap items-baseline gap-2`}>
      <span className="text-base font-medium text-eui-ink">{title}</span>
      {meta ? <span>{meta}</span> : null}
    </h2>
    <ul className="mt-3 grid gap-5 sm:grid-cols-2 lg:grid-cols-3" aria-label={title}>{children}</ul>
  </section>;
}
