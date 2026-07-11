import { useMemo, useState } from "react";
import { Link } from "react-router";
import { listDesignSystems, listPrototypes } from "../api/client";
import { useApi } from "../api/hooks";
import { chip, chipActive, headingPage, pillGhost, pillPrimary, plate } from "../app/chrome";

const deviceNames = {
  mobile: "Mobile",
  tablet: "Tablet",
  desktop: "Desktop",
} as const;

export function GalleryPage() {
  const prototypes = useApi(listPrototypes, []);
  const designSystems = useApi(listDesignSystems, []);
  const [selectedSystem, setSelectedSystem] = useState<string | null>(null);
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
  const visiblePrototypes = prototypes.status === "ready"
    ? prototypes.data.filter((prototype) => selectedSystem === null || (prototype.designSystem ?? "shadcn") === selectedSystem)
    : [];
  const loading = prototypes.status === "loading" || designSystems.status === "loading";
  const failed = prototypes.status === "error" || designSystems.status === "error";
  const reload = () => { prototypes.reload(); designSystems.reload(); };

  return <main className="mx-auto h-full w-full max-w-6xl p-6 font-eui-ui sm:p-8">
    <h1 className={headingPage}>Прототипы</h1>
    <p className="mt-2 text-eui-slate-500">Choose a flow to open its first screen.</p>
    {loading ? <p className={`${plate} mt-8 text-eui-slate-500`} aria-live="polite">Loading prototypes…</p> : null}
    {failed ? <div className={`${plate} mt-8 text-eui-magenta`} role="alert"><p>API недоступен</p><button className={`${pillGhost} mt-3`} type="button" onClick={reload}>Retry</button></div> : null}
    {!loading && !failed ? <div className="mt-6 flex flex-wrap gap-2" aria-label="Design systems">
      <button type="button" aria-pressed={selectedSystem === null} className={selectedSystem === null ? chipActive : chip} onClick={() => setSelectedSystem(null)}>All</button>
      {systems.map((system) => <button type="button" key={system.id} aria-pressed={selectedSystem === system.id} className={selectedSystem === system.id ? chipActive : chip} onClick={() => setSelectedSystem(system.id)}>{system.name}</button>)}
    </div> : null}
    {!loading && !failed && visiblePrototypes.length ? <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {visiblePrototypes.map((prototype) => <li className="flex flex-col rounded-3xl bg-eui-lav p-6" key={prototype.id}>
        <h2 className="font-eui-display text-xl font-medium">{prototype.name}</h2>
        <p className="mt-2 min-h-10 text-sm text-eui-slate-500">{prototype.description ?? "No description"}</p>
        <dl className="mt-5 flex flex-wrap gap-3 text-sm">
          <div><dt className="text-eui-slate-500">Device</dt><dd className="font-medium">{deviceNames[prototype.device]}</dd></div>
          <div><dt className="text-eui-slate-500">Screens</dt><dd className="mt-0.5 inline-flex rounded-full bg-white px-2.5 py-1 text-xs font-medium">{prototype.screenCount}</dd></div>
          <div><dt className="text-eui-slate-500">System</dt><dd className="mt-0.5 rounded-full bg-eui-lilac-200 px-2.5 py-1 text-xs font-medium">{systemNames.get(prototype.designSystem ?? "shadcn") ?? prototype.designSystem ?? "shadcn"}</dd></div>
        </dl>
        <div className="mt-5 flex flex-wrap gap-2">
          <Link className={`${pillPrimary} min-w-full`} aria-label={`Открыть «${prototype.name}»`} to={`/p/${prototype.id}`}>Открыть</Link>
          <Link className={pillGhost} to={`/p/${prototype.id}/cjm`}>CJM</Link>
          <Link className={pillGhost} to={`/p/${prototype.id}/edit`}>Редактор</Link>
          {prototype.latestVersion !== null ? <>
            <Link className={`${pillGhost} bg-white`} to={`/p/${prototype.id}/v/${prototype.latestVersion}`}>Published v{prototype.latestVersion}</Link>
            <Link className={pillGhost} aria-label={`CJM Published v${prototype.latestVersion}`} to={`/p/${prototype.id}/v/${prototype.latestVersion}/cjm`}>CJM</Link>
          </> : null}
        </div>
      </li>)}
    </ul> : null}
    {!loading && !failed && !visiblePrototypes.length ? <p className={`${plate} mt-8 text-eui-slate-500`}>{prototypes.status === "ready" && prototypes.data.length ? "No prototypes match this design system." : "No prototypes found."}</p> : null}
  </main>;
}
