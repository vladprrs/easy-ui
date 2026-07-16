import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { createPrototype, getCatalogManifest, listDesignSystems, listPrototypes, listPrototypeVersions, type PrototypeSummary, type PrototypeVersionSummary } from "../api/client";
import { useApi } from "../api/hooks";
import { chip, chipActive, headingPage, inputBase, pillGhost, pillPrimary, plate } from "../app/chrome";
import { common } from "../app/strings/common";
import { deviceNames, gallery, versionLink } from "../app/strings/gallery";
import { useDocumentTitle } from "../app/useDocumentTitle";
import { BUILTIN_TEMPLATE_VERSION, buildBuiltinPrototypeTemplate, buildCustomPrototypeTemplate, createPrototypeId, findCustomStarterComponent, isBuiltinDesignSystem } from "./prototypeTemplates";
import { GalleryPreview, GALLERY_PREVIEWS_ENABLED } from "./GalleryPreview";
import { GalleryShareDialog } from "./GalleryShareDialog";

export type GallerySort = "updated" | "name";

export function filterAndSortPrototypes(prototypes: PrototypeSummary[], systemId: string | null, query: string, sort: GallerySort): PrototypeSummary[] {
  const normalizedQuery = query.trim().toLocaleLowerCase("ru");
  const filtered = prototypes
    .filter((prototype) => systemId === null || (prototype.designSystem ?? "shadcn") === systemId)
    .filter((prototype) => !normalizedQuery || prototype.name.toLocaleLowerCase("ru").includes(normalizedQuery));
  return [...filtered].sort(sort === "name"
      ? (left, right) => left.name.localeCompare(right.name, "ru", { numeric: true, sensitivity: "base" })
      : (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.name.localeCompare(right.name, "ru", { numeric: true, sensitivity: "base" }));
}

const updatedAtFormatter = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function formatGalleryUpdatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : updatedAtFormatter.format(date);
}

type VersionsState =
  | { status: "idle" | "loading"; data: PrototypeVersionSummary[] }
  | { status: "ready"; data: PrototypeVersionSummary[] }
  | { status: "error"; data: PrototypeVersionSummary[] };

function VersionsMenu({ prototype }: { prototype: PrototypeSummary }) {
  const [versions, setVersions] = useState<VersionsState>({ status: "idle", data: [] });
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => controllerRef.current?.abort(), []);

  const load = () => {
    if (versions.status !== "idle" && versions.status !== "error") return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setVersions((current) => ({ status: "loading", data: current.data }));
    void listPrototypeVersions(prototype.id, controller.signal).then(
      (data) => { if (!controller.signal.aborted) setVersions({ status: "ready", data }); },
      () => { if (!controller.signal.aborted) setVersions((current) => ({ status: "error", data: current.data })); },
    );
  };
  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => { if (event.currentTarget.open) load(); };

  return <details className="relative" onToggle={onToggle}>
    <summary className={`${pillGhost} cursor-pointer list-none bg-white`}>{gallery.versionsMenu}</summary>
    <div aria-label={gallery.versionsMenuAria(prototype.name)} className="absolute right-0 z-20 mt-2 w-52 rounded-2xl border border-eui-ink/10 bg-white p-2 shadow-xl">
      {versions.status === "idle" || versions.status === "loading" ? <p className="px-2 py-1 text-xs text-eui-slate-500" aria-live="polite">{gallery.versionsLoading}</p> : null}
      {versions.status === "error" ? <><p role="alert" className="px-2 py-1 text-xs text-eui-magenta">{gallery.versionsLoadFailed}</p><button type="button" className={`${pillGhost} mt-1`} onClick={load}>{common.retry}</button></> : null}
      {versions.status === "ready" && !versions.data.length ? <p className="px-2 py-1 text-xs text-eui-slate-500">{gallery.noVersions}</p> : null}
      {versions.status === "ready" ? <ul className="space-y-1">{versions.data.map((version) => <li key={version.version}><Link className="block rounded-xl px-3 py-2 text-sm hover:bg-eui-lav focus-visible:outline-2 focus-visible:outline-eui-brand" to={`/p/${prototype.id}/v/${version.version}`}>{versionLink(version.version)}</Link></li>)}</ul> : null}
    </div>
  </details>;
}

type CreateDialogState = {
  name: string;
  designSystemId: string;
  status: "editing" | "creating";
  error: boolean;
};

export function GalleryPage() {
  useDocumentTitle(gallery.title);
  const navigate = useNavigate();
  const location = useLocation();
  const prototypes = useApi(listPrototypes, []);
  const designSystems = useApi(listDesignSystems, []);
  const catalog = useApi(getCatalogManifest, []);
  const [selectedSystem, setSelectedSystem] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<GallerySort>("updated");
  const [createDialog, setCreateDialog] = useState<CreateDialogState | null>(null);
  const [sharePrototypeId, setSharePrototypeId] = useState<string | null>(null);
  const [shareLatestVersion, setShareLatestVersion] = useState<number | null>(null);
  const systems = useMemo(() => {
    if (prototypes.status !== "ready" || designSystems.status !== "ready") return [];
    const registered = designSystems.data.designSystems.map(({ id, name }) => ({ id, name }));
    const ids = new Set(registered.map(({ id }) => id));
    const legacy = prototypes.data
      .map((prototype) => prototype.designSystem ?? "shadcn")
      .filter((id) => !ids.has(id))
      .filter((id, index, values) => values.indexOf(id) === index)
      .map((id) => ({ id, name: id }));
    return [...registered, ...legacy];
  }, [designSystems, prototypes]);
  const systemNames = useMemo(() => new Map(systems.map(({ id, name }) => [id, name])), [systems]);
  const visiblePrototypes = useMemo(() => prototypes.status === "ready"
    ? filterAndSortPrototypes(prototypes.data, selectedSystem, query, sort)
    : [], [prototypes, query, selectedSystem, sort]);
  const previewsEnabled = GALLERY_PREVIEWS_ENABLED && new URLSearchParams(location.search).get("galleryPreviews") !== "off";
  const loading = prototypes.status === "loading" || designSystems.status === "loading";
  const failed = prototypes.status === "error" || designSystems.status === "error";
  const reload = () => { prototypes.reload(); designSystems.reload(); };
  const openCreateDialog = () => {
    const preferred = selectedSystem && systems.some((system) => system.id === selectedSystem) ? selectedSystem : systems[0]?.id ?? "";
    setCreateDialog({ name: "", designSystemId: preferred, status: "editing", error: false });
  };
  const selectedCreateSystem = createDialog ? systems.find((system) => system.id === createDialog.designSystemId) : undefined;
  const customStarter = createDialog && !isBuiltinDesignSystem(createDialog.designSystemId) && catalog.status === "ready"
    ? findCustomStarterComponent(createDialog.designSystemId, catalog.data.components) : null;
  const customTemplateBlocked = Boolean(createDialog && !isBuiltinDesignSystem(createDialog.designSystemId) && !customStarter);
  const canCreate = Boolean(createDialog?.name.trim() && selectedCreateSystem && !customTemplateBlocked && createDialog.status !== "creating");
  const submitCreate = async () => {
    if (!createDialog || !canCreate) return;
    const name = createDialog.name.trim();
    const id = createPrototypeId();
    const doc = isBuiltinDesignSystem(createDialog.designSystemId)
      ? buildBuiltinPrototypeTemplate(createDialog.designSystemId, id, name)
      : buildCustomPrototypeTemplate(createDialog.designSystemId, customStarter!, id, name);
    setCreateDialog((current) => current ? { ...current, status: "creating", error: false } : null);
    try {
      const created = await createPrototype(doc, gallery.initialRevisionMessage(BUILTIN_TEMPLATE_VERSION));
      await navigate(`/p/${created.id}/edit`);
    } catch {
      setCreateDialog((current) => current ? { ...current, status: "editing", error: true } : null);
    }
  };

  return <main className="mx-auto h-full w-full max-w-6xl p-6 font-eui-ui sm:p-8" data-gallery-ready={!loading && !failed ? "true" : "false"}>
    <div className="flex flex-wrap items-center justify-between gap-4">
      <h1 className={headingPage}>{gallery.title}</h1>
      {!loading && !failed ? <button type="button" className={pillPrimary} onClick={openCreateDialog}>{gallery.newPrototype}</button> : null}
    </div>
    <p className="mt-2 text-eui-slate-500">{gallery.subtitle}</p>
    {loading ? <p className={`${plate} mt-8 text-eui-slate-500`} aria-live="polite">{gallery.loading}</p> : null}
    {failed ? <div className={`${plate} mt-8 text-eui-magenta`} role="alert"><p>{gallery.apiUnavailable}</p><button className={`${pillGhost} mt-3`} type="button" onClick={reload}>{common.retry}</button></div> : null}
    {!loading && !failed ? <div className="mt-6 flex flex-wrap gap-2" aria-label={gallery.designSystemsAria}>
      <button type="button" aria-pressed={selectedSystem === null} className={selectedSystem === null ? chipActive : chip} onClick={() => setSelectedSystem(null)}>{gallery.allSystems}</button>
      {systems.map((system) => <button type="button" key={system.id} aria-pressed={selectedSystem === system.id} className={selectedSystem === system.id ? chipActive : chip} onClick={() => setSelectedSystem(system.id)}>{system.name}</button>)}
    </div> : null}
    {!loading && !failed && prototypes.status === "ready" && prototypes.data.length ? <div className="mt-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
      <label className="min-w-0 text-sm font-medium">{gallery.searchLabel}
        <input type="search" className={`${inputBase} mt-1.5 w-full`} value={query} placeholder={gallery.searchPlaceholder} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <label className="text-sm font-medium">{gallery.sortLabel}
        <select className={`${inputBase} mt-1.5 w-full bg-white sm:w-56`} value={sort} onChange={(event) => setSort(event.target.value as GallerySort)}>
          <option value="updated">{gallery.sortUpdated}</option>
          <option value="name">{gallery.sortName}</option>
        </select>
      </label>
    </div> : null}
    {!loading && !failed && visiblePrototypes.length ? <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {visiblePrototypes.map((prototype) => <li className="relative flex min-w-0 flex-col rounded-3xl bg-eui-lav p-6 transition-shadow focus-within:shadow-lg hover:shadow-lg" key={prototype.id}>
        <h2 className="min-w-0 font-eui-display text-xl font-medium [overflow-wrap:anywhere]">
          <Link
            className="after:absolute after:inset-0 after:rounded-3xl after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-eui-brand"
            to={`/p/${prototype.id}`}
          >{prototype.name}</Link>
        </h2>
        <p className="mt-2 min-h-10 break-words text-sm text-eui-slate-500 [overflow-wrap:anywhere]">{prototype.description ?? gallery.noDescription}</p>
        {previewsEnabled && isBuiltinDesignSystem(prototype.designSystem ?? "shadcn") ? <GalleryPreview prototypeId={prototype.id} /> : null}
        <dl className="mt-5 grid min-w-0 grid-cols-2 gap-3 text-sm xl:grid-cols-4">
          <div className="flex flex-col items-start gap-1.5"><dt className="text-eui-slate-500">{gallery.deviceLabel}</dt><dd className="inline-flex rounded-full bg-white px-2.5 py-1 text-xs font-medium">{deviceNames[prototype.device]}</dd></div>
          <div className="flex flex-col items-start gap-1.5"><dt className="text-eui-slate-500">{gallery.screensLabel}</dt><dd className="inline-flex rounded-full bg-white px-2.5 py-1 text-xs font-medium">{prototype.screenCount}</dd></div>
          <div className="flex min-w-0 flex-col items-start gap-1.5"><dt className="text-eui-slate-500">{gallery.systemLabel}</dt><dd className="inline-flex max-w-full break-all rounded-full bg-eui-lilac-200 px-2.5 py-1 text-xs font-medium">{systemNames.get(prototype.designSystem ?? "shadcn") ?? prototype.designSystem ?? "shadcn"}</dd></div>
          <div className="flex flex-col items-start gap-1.5"><dt className="text-eui-slate-500">{gallery.updatedLabel}</dt><dd className="text-xs font-medium"><time dateTime={prototype.updatedAt}>{formatGalleryUpdatedAt(prototype.updatedAt)}</time></dd></div>
        </dl>
        <div className="relative z-10 mt-5 flex flex-wrap gap-2">
          <Link className={`${pillGhost} bg-white`} to={`/p/${prototype.id}/present`}>{gallery.presentLink}</Link>
          <Link className={pillGhost} to={`/p/${prototype.id}/cjm`}>CJM</Link>
          <Link className={pillGhost} to={`/p/${prototype.id}/edit`}>{gallery.editorLink}</Link>
          {prototype.latestVersion !== null ? <button type="button" className={pillGhost} title={gallery.qrOnPhone} aria-label={gallery.qrOnPhone} onClick={() => { setSharePrototypeId(prototype.id); setShareLatestVersion(prototype.latestVersion); }}>{gallery.qrOnPhone}</button> : null}
          {prototype.latestVersion !== null ? <VersionsMenu prototype={prototype} /> : null}
        </div>
      </li>)}
    </ul> : null}
    {!loading && !failed && !visiblePrototypes.length ? prototypes.status === "ready" && prototypes.data.length
      ? <p className={`${plate} mt-8 text-eui-slate-500`}>{query.trim() ? gallery.emptySearch : gallery.emptyFiltered}</p>
      : <section className={`${plate} mt-8`}>
        <h2 className="font-eui-display text-xl font-medium">{gallery.emptyTitle}</h2>
        <p className="mt-2 text-eui-slate-500">{gallery.empty}</p>
        <button type="button" className={`${pillPrimary} mt-5`} onClick={openCreateDialog}>{gallery.newPrototype}</button>
      </section> : null}
    {createDialog ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <section role="dialog" aria-modal="true" aria-label={gallery.createDialogAria} className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl">
        <h2 className="font-eui-display text-2xl font-medium">{gallery.createDialogTitle}</h2>
        <form className="mt-5 space-y-4" onSubmit={(event) => { event.preventDefault(); void submitCreate(); }}>
          <label className="block text-sm font-medium">{gallery.nameLabel}
            <input className={`${inputBase} mt-1.5 w-full`} name="prototype-name" autoFocus required placeholder={gallery.namePlaceholder} value={createDialog.name} disabled={createDialog.status === "creating"} onChange={(event) => setCreateDialog((current) => current ? { ...current, name: event.target.value, error: false } : null)} />
          </label>
          <label className="block text-sm font-medium">{gallery.systemLabelCreate}
            <select className={`${inputBase} mt-1.5 w-full bg-white`} name="design-system" value={createDialog.designSystemId} disabled={createDialog.status === "creating"} onChange={(event) => setCreateDialog((current) => current ? { ...current, designSystemId: event.target.value, error: false } : null)}>
              {systems.map((system) => <option key={system.id} value={system.id}>{system.name}</option>)}
            </select>
          </label>
          {isBuiltinDesignSystem(createDialog.designSystemId) ? <p className="text-sm text-eui-slate-500">{gallery.builtinStarterReady}</p>
            : catalog.status === "loading" ? <p className="text-sm text-eui-slate-500" role="status">{gallery.customStarterLoading}</p>
              : catalog.status === "error" ? <p className="text-sm text-eui-magenta" role="alert">{gallery.customStarterUnavailable}</p>
                : customStarter ? <p className="text-sm text-eui-slate-500">{gallery.customStarterReady(customStarter.name)}</p>
                  : <p className="text-sm text-eui-magenta" role="alert">{gallery.customStarterMissing}</p>}
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
  </main>;
}
