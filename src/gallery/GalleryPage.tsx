import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { createPrototype, getCatalogManifest, listDesignSystems, listPrototypes } from "../api/client";
import { useApi } from "../api/hooks";
import { inputBase, pillGhost, pillPrimary } from "../app/chrome";
import { gallery } from "../app/strings/gallery";
import { useDocumentTitle } from "../app/useDocumentTitle";
import { useAuth } from "../auth";
import { TEMPLATE_VERSION, buildPrototypeTemplate, createPrototypeId, hasUsableComponents } from "./prototypeTemplates";
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

type CreateDialogState = {
  name: string;
  designSystemId: string;
  status: "editing" | "creating";
  error: boolean;
};

export function GalleryPage() {
  useDocumentTitle(gallery.title);
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const prototypes = useApi(listPrototypes, []);
  const designSystems = useApi(listDesignSystems, []);
  const catalog = useApi(getCatalogManifest, []);
  const [selectedSystem, setSelectedSystem] = useState<string | null>(null);
  const [tab, setTab] = useState<GalleryTab>("mine");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<GallerySort>("updated");
  const [createDialog, setCreateDialog] = useState<CreateDialogState | null>(null);
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
    ? filterAndSortPrototypes(prototypes.data, { tab, userId: user?.userId ?? "", systemId: selectedSystem, query, sort })
    : [], [prototypes, query, selectedSystem, sort, tab, user?.userId]);
  const previewsEnabled = GALLERY_PREVIEWS_ENABLED && new URLSearchParams(location.search).get("galleryPreviews") !== "off";
  const loading = authLoading || prototypes.status === "loading" || designSystems.status === "loading" || catalog.status === "loading";
  const failed = prototypes.status === "error" || designSystems.status === "error" || catalog.status === "error";
  const reload = () => { prototypes.reload(); designSystems.reload(); catalog.reload(); };
  const openCreateDialog = () => {
    const preferred = selectedSystem && usableSystems.some((system) => system.id === selectedSystem) ? selectedSystem : usableSystems[0]?.id ?? "";
    setCreateDialog({ name: "", designSystemId: preferred, status: "editing", error: false });
  };
  const selectedCreateSystem = createDialog ? usableSystems.find((system) => system.id === createDialog.designSystemId) : undefined;
  const canCreate = Boolean(createDialog?.name.trim() && selectedCreateSystem && createDialog.status !== "creating");
  const submitCreate = async () => {
    if (!createDialog || !canCreate) return;
    const name = createDialog.name.trim();
    const id = createPrototypeId();
    const doc = buildPrototypeTemplate(createDialog.designSystemId, id, name);
    setCreateDialog((current) => current ? { ...current, status: "creating", error: false } : null);
    try {
      const created = await createPrototype(doc, gallery.initialRevisionMessage(TEMPLATE_VERSION));
      await navigate(`/p/${created.id}/edit`);
    } catch {
      setCreateDialog((current) => current ? { ...current, status: "editing", error: true } : null);
    }
  };

  const notice = typeof location.state === "object" && location.state && "notice" in location.state && typeof location.state.notice === "string"
    ? location.state.notice
    : null;
  const ready = prototypes.status === "ready" && !loading && !failed;
  const heroCount = ready && visiblePrototypes.length ? visiblePrototypes.length : null;

  return <main className="mx-auto h-full w-full max-w-6xl p-6 font-eui-ui sm:p-8" data-gallery-ready={!loading && !failed ? "true" : "false"}>
    <GalleryHero
      count={heroCount}
      showActions={!loading && !failed}
      canCreate={usableSystems.length > 0}
      onCreate={openCreateDialog}
      onImport={() => setImportOpen(true)}
      notice={notice}
    />
    {loading ? <GallerySkeletons /> : null}
    {failed ? <GalleryFailed onRetry={reload} /> : null}
    {!loading && !failed && catalog.status === "ready" && !usableSystems.length ? <NoUsableSystems /> : null}
    {!loading && !failed ? <GalleryToolbar
      tab={tab}
      onTabChange={setTab}
      systems={systems}
      selectedSystem={selectedSystem}
      onSystemChange={setSelectedSystem}
      query={query}
      onQueryChange={setQuery}
      sort={sort}
      onSortChange={setSort}
      showSearch={prototypes.status === "ready" && prototypes.data.length > 0}
    /> : null}
    {!loading && !failed && visiblePrototypes.length ? <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {visiblePrototypes.map((prototype) => <PrototypeCard
        key={prototype.id}
        prototype={prototype}
        isOwner={prototype.owner.id === user?.userId}
        systemName={prototype.designSystem ? systemNames.get(prototype.designSystem) ?? prototype.designSystem : gallery.legacySystem}
        previewsEnabled={previewsEnabled}
        onShare={(id, latestVersion) => { setSharePrototypeId(id); setShareLatestVersion(latestVersion); }}
        onChanged={prototypes.reload}
      />)}
    </ul> : null}
    {!loading && !failed && !visiblePrototypes.length ? <GalleryEmpty
      variant={prototypes.status === "ready" && prototypes.data.length ? (query.trim() ? "search" : "filtered") : "none"}
      canCreate={usableSystems.length > 0}
      onCreate={openCreateDialog}
    /> : null}
    {createDialog ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <section role="dialog" aria-modal="true" aria-label={gallery.createDialogAria} className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl">
        <h2 className="font-eui-display text-2xl font-medium">{gallery.createDialogTitle}</h2>
        <form className="mt-5 space-y-4" onSubmit={(event) => { event.preventDefault(); void submitCreate(); }}>
          <label className="block text-sm font-medium">{gallery.nameLabel}
            <input className={`${inputBase} mt-1.5 w-full`} name="prototype-name" autoFocus required placeholder={gallery.namePlaceholder} value={createDialog.name} disabled={createDialog.status === "creating"} onChange={(event) => setCreateDialog((current) => current ? { ...current, name: event.target.value, error: false } : null)} />
          </label>
          <label className="block text-sm font-medium">{gallery.systemLabelCreate}
            <select className={`${inputBase} mt-1.5 w-full bg-white`} name="design-system" value={createDialog.designSystemId} disabled={createDialog.status === "creating"} onChange={(event) => setCreateDialog((current) => current ? { ...current, designSystemId: event.target.value, error: false } : null)}>
              {usableSystems.map((system) => <option key={system.id} value={system.id}>{system.name}</option>)}
            </select>
          </label>
          <p className="text-sm text-eui-slate-500">{gallery.hostStarterReady}</p>
          {createDialog.error ? <p className="text-sm text-eui-magenta" role="alert">{gallery.createFailed}</p> : null}
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <button type="button" className={pillGhost} disabled={createDialog.status === "creating"} onClick={() => setCreateDialog(null)}>{gallery.cancel}</button>
            <button type="submit" className={pillPrimary} disabled={!canCreate}>{createDialog.status === "creating" ? gallery.creating : gallery.create}</button>
          </div>
        </form>
      </section>
    </div> : null}
    {sharePrototypeId !== null && shareLatestVersion !== null ? <GalleryShareDialog
      prototypeId={sharePrototypeId}
      latestVersion={shareLatestVersion}
      onClose={() => { setSharePrototypeId(null); setShareLatestVersion(null); }}
    /> : null}
    {importOpen ? <ImportDialog onClose={() => setImportOpen(false)} onImported={reload} /> : null}
  </main>;
}
