import { useMemo, useState } from "react";
import { useLocation } from "react-router";
import { getCatalogManifest, listDesignSystems, listPrototypes, type PrototypeKind } from "../api/client";
import { useApi } from "../api/hooks";
import { AgentAuthoringDialog } from "../app/AgentAuthoringDialog";
import { gallery } from "../app/strings/gallery";
import { useDocumentTitle } from "../app/useDocumentTitle";
import { useAuth } from "../auth";
import { hasUsableComponents } from "./prototypeTemplates";
import { GALLERY_PREVIEWS_ENABLED } from "./GalleryPreview";
import { GalleryShareDialog } from "./GalleryShareDialog";
import { ImportDialog } from "./ImportDialog";
import { filterAndSortPrototypes, type GallerySort, type GalleryTab } from "./galleryModel";
import { GalleryHero } from "./components/GalleryHero";
import { GalleryToolbar } from "./components/GalleryToolbar";
import { PrototypeCard } from "./components/PrototypeCard";
import { GalleryEmpty, GalleryFailed, GallerySkeletons, NoUsableSystems } from "./components/GalleryStates";

export { filterAndSortPrototypes } from "./galleryModel";
export type { GalleryFilters, GallerySort, GalleryTab } from "./galleryModel";
export { formatGalleryUpdatedAt } from "./galleryFormat";

export function GalleryPage() {
  useDocumentTitle(gallery.title);
  const { user, loading: authLoading } = useAuth();
  const location = useLocation();
  const [tab, setTab] = useState<GalleryTab>("mine");
  // Админский раздел «Все» — единственный потребитель `?scope=all`: остальные вкладки (и все
  // прочие потребители списка) ходят прежним запросом, поэтому смена вкладки перезапрашивает
  // список только на переходе в/из «Все».
  const adminScope = tab === "all";
  const prototypes = useApi((signal) => adminScope ? listPrototypes(signal, undefined, { scope: "all" }) : listPrototypes(signal), [adminScope]);
  const designSystems = useApi(listDesignSystems, []);
  const catalog = useApi(getCatalogManifest, []);
  const [selectedSystem, setSelectedSystem] = useState<string | null>(null);
  const [selectedKind, setSelectedKind] = useState<PrototypeKind | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<GallerySort>("updated");
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [sharePrototypeId, setSharePrototypeId] = useState<string | null>(null);
  const [shareLatestVersion, setShareLatestVersion] = useState<number | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const systems = useMemo(() => {
    if (prototypes.status !== "ready" || designSystems.status !== "ready") return [];
    const registered = designSystems.data.designSystems.map(({ id, name }) => ({ id, name }));
    const ids = new Set(registered.map(({ id }) => id));
    const legacy = prototypes.data
      .flatMap((prototype) => prototype.designSystem ? [prototype.designSystem] : [])
      .filter((id) => !ids.has(id))
      .filter((id, index, values) => values.indexOf(id) === index)
      .map((id) => ({ id, name: id }));
    return [...registered, ...legacy];
  }, [designSystems, prototypes]);
  const systemNames = useMemo(() => new Map(systems.map(({ id, name }) => [id, name])), [systems]);
  const usableSystems = useMemo(() => catalog.status === "ready"
    ? systems.filter((system) => hasUsableComponents(system.id, catalog.data.components))
    : [], [catalog, systems]);
  const visiblePrototypes = useMemo(() => prototypes.status === "ready"
    ? filterAndSortPrototypes(prototypes.data, { tab, userId: user?.userId ?? "", systemId: selectedSystem, query, sort, kind: selectedKind })
    : [], [prototypes, query, selectedKind, selectedSystem, sort, tab, user?.userId]);
  const previewsEnabled = GALLERY_PREVIEWS_ENABLED && new URLSearchParams(location.search).get("galleryPreviews") !== "off";
  const loading = authLoading || prototypes.status === "loading" || designSystems.status === "loading" || catalog.status === "loading";
  const failed = prototypes.status === "error" || designSystems.status === "error" || catalog.status === "error";
  const reload = () => { prototypes.reload(); designSystems.reload(); catalog.reload(); };
  // Раздел (вкладку) сброс не трогает: пользователь выбирал её осознанно, а
  // «ничего не найдено» вызывают поиск, система и вид.
  const resetFilters = () => { setQuery(""); setSelectedKind(null); setSelectedSystem(null); };
  const notice = typeof location.state === "object" && location.state && "notice" in location.state && typeof location.state.notice === "string"
    ? location.state.notice
    : null;
  const ready = prototypes.status === "ready" && !loading && !failed;
  const heroCount = ready ? visiblePrototypes.length : null;

  // Канва и gutter приходят из Layout: страница — только колонка панелей с gap 20.
  return <main className="mx-auto flex h-full w-full max-w-[1400px] flex-col gap-5 font-pay-text" data-gallery-ready={!loading && !failed ? "true" : "false"}>
    <GalleryHero
      count={heroCount}
      showActions={!loading && !failed}
      onBuild={() => setAgentDialogOpen(true)}
      onImport={() => setImportOpen(true)}
      notice={notice}
    />
    {loading ? <GallerySkeletons /> : null}
    {failed ? <GalleryFailed onRetry={reload} /> : null}
    {/* Плашка про системы нужна только когда есть что показывать рядом: на пустой
        галерее тот же смысл живёт внутри GalleryEmpty, вторым состоянием подряд. */}
    {!loading && !failed && catalog.status === "ready" && !usableSystems.length && visiblePrototypes.length ? <NoUsableSystems onBuild={() => setAgentDialogOpen(true)} /> : null}
    {!loading && !failed ? <GalleryToolbar
      tab={tab}
      onTabChange={(next) => { setTab(next); setSelectedKind(null); }}
      systems={systems}
      selectedSystem={selectedSystem}
      onSystemChange={setSelectedSystem}
      kind={selectedKind}
      onKindChange={setSelectedKind}
      query={query}
      onQueryChange={setQuery}
      sort={sort}
      onSortChange={setSort}
      showSearch={prototypes.status === "ready" && prototypes.data.length > 0}
      isAdmin={user?.isAdmin === true}
    /> : null}
    {!loading && !failed && visiblePrototypes.length ? <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {visiblePrototypes.map((prototype, index) => <PrototypeCard
        key={prototype.id}
        index={index}
        prototype={prototype}
        isOwner={prototype.owner.id === user?.userId}
        systemName={prototype.designSystem ? systemNames.get(prototype.designSystem) ?? prototype.designSystem : gallery.legacySystem}
        previewsEnabled={previewsEnabled}
        onShare={(id, latestVersion) => { setSharePrototypeId(id); setShareLatestVersion(latestVersion); }}
        onChanged={prototypes.reload}
      />)}
    </ul> : null}
    {!loading && !failed && visiblePrototypes.length ? <p className="text-[13px] text-eui-slate-500">
      <a className="underline decoration-pay-lavender-light underline-offset-4 hover:text-eui-ink" href="/api/bundles/export">{gallery.exportAll}</a>
    </p> : null}
    {!loading && !failed && !visiblePrototypes.length ? <GalleryEmpty
      variant={prototypes.status === "ready" && prototypes.data.length ? (query.trim() ? "search" : "filtered") : "none"}
      hasUsableSystems={usableSystems.length > 0}
      onBuild={() => setAgentDialogOpen(true)}
      onImport={() => setImportOpen(true)}
      onReset={resetFilters}
    /> : null}
    {agentDialogOpen ? <AgentAuthoringDialog onClose={() => setAgentDialogOpen(false)} /> : null}
    {sharePrototypeId !== null && shareLatestVersion !== null ? <GalleryShareDialog
      prototypeId={sharePrototypeId}
      latestVersion={shareLatestVersion}
      onClose={() => { setSharePrototypeId(null); setShareLatestVersion(null); }}
    /> : null}
    {importOpen ? <ImportDialog onClose={() => setImportOpen(false)} onImported={reload} /> : null}
  </main>;
}
