import { useMemo, useState } from "react";
import { Link } from "react-router";
import { listDesignSystems, listPrototypes } from "../api/client";
import { useApi } from "../api/hooks";

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

  return <main className="mx-auto max-w-6xl p-6 sm:p-8">
    <h1 className="text-3xl font-bold">Prototype gallery</h1>
    <p className="mt-2 text-muted-foreground">Choose a flow to open its first screen.</p>
    {loading ? <p className="mt-8 rounded-lg border border-dashed p-6" aria-live="polite">Loading prototypes…</p> : null}
    {failed ? <div className="mt-8 rounded-lg border border-destructive p-6" role="alert"><p>API недоступен</p><button className="mt-3 rounded-md border px-3 py-1.5" type="button" onClick={reload}>Retry</button></div> : null}
    {!loading && !failed ? <div className="mt-6 flex flex-wrap gap-2" aria-label="Design systems">
      <button type="button" aria-pressed={selectedSystem === null} className={`rounded-full border px-3 py-1.5 text-sm font-medium ${selectedSystem === null ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`} onClick={() => setSelectedSystem(null)}>All</button>
      {systems.map((system) => <button type="button" key={system.id} aria-pressed={selectedSystem === system.id} className={`rounded-full border px-3 py-1.5 text-sm font-medium ${selectedSystem === system.id ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`} onClick={() => setSelectedSystem(system.id)}>{system.name}</button>)}
    </div> : null}
    {!loading && !failed && visiblePrototypes.length ? <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {visiblePrototypes.map((prototype) => <li className="rounded-xl border bg-card p-5 text-card-foreground shadow-sm" key={prototype.id}>
        <Link className="block transition hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" to={`/p/${prototype.id}`}>
          <h2 className="text-xl font-semibold">{prototype.name}</h2>
          <p className="mt-2 min-h-10 text-sm text-muted-foreground">{prototype.description ?? "No description"}</p>
          <dl className="mt-5 flex flex-wrap gap-4 text-sm">
            <div><dt className="text-muted-foreground">Device</dt><dd className="font-medium">{deviceNames[prototype.device]}</dd></div>
            <div><dt className="text-muted-foreground">Screens</dt><dd className="font-medium">{prototype.screenCount}</dd></div>
            <div><dt className="text-muted-foreground">System</dt><dd className="mt-0.5 rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{systemNames.get(prototype.designSystem ?? "shadcn") ?? prototype.designSystem ?? "shadcn"}</dd></div>
          </dl>
        </Link>
        {prototype.latestVersion !== null ? <Link className="mt-4 inline-block rounded-full border px-2.5 py-1 text-xs font-medium hover:bg-muted" to={`/p/${prototype.id}/v/${prototype.latestVersion}`}>Published v{prototype.latestVersion}</Link> : null}
      </li>)}
    </ul> : null}
    {!loading && !failed && !visiblePrototypes.length ? <p className="mt-8 rounded-lg border border-dashed p-6">{prototypes.status === "ready" && prototypes.data.length ? "No prototypes match this design system." : "No prototypes found."}</p> : null}
  </main>;
}
