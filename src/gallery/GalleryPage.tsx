import { Link } from "react-router";
import { listPrototypes } from "../api/client";
import { useApi } from "../api/hooks";

const deviceNames = {
  mobile: "Mobile",
  tablet: "Tablet",
  desktop: "Desktop",
} as const;

export function GalleryPage() {
  const prototypes = useApi(listPrototypes, []);
  return <main className="mx-auto max-w-6xl p-6 sm:p-8">
    <h1 className="text-3xl font-bold">Prototype gallery</h1>
    <p className="mt-2 text-muted-foreground">Choose a flow to open its first screen.</p>
    {prototypes.status === "loading" ? <p className="mt-8 rounded-lg border border-dashed p-6" aria-live="polite">Loading prototypes…</p> : null}
    {prototypes.status === "error" ? <div className="mt-8 rounded-lg border border-destructive p-6" role="alert"><p>API недоступен</p><button className="mt-3 rounded-md border px-3 py-1.5" type="button" onClick={prototypes.reload}>Retry</button></div> : null}
    {prototypes.status === "ready" && prototypes.data.length ? <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {prototypes.data.map((prototype) => <li className="rounded-xl border bg-card p-5 text-card-foreground shadow-sm" key={prototype.id}>
        <Link className="block transition hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" to={`/p/${prototype.id}`}>
          <h2 className="text-xl font-semibold">{prototype.name}</h2>
          <p className="mt-2 min-h-10 text-sm text-muted-foreground">{prototype.description ?? "No description"}</p>
          <dl className="mt-5 flex gap-4 text-sm">
            <div><dt className="text-muted-foreground">Device</dt><dd className="font-medium">{deviceNames[prototype.device]}</dd></div>
            <div><dt className="text-muted-foreground">Screens</dt><dd className="font-medium">{prototype.screenCount}</dd></div>
          </dl>
        </Link>
        {prototype.latestVersion !== null ? <Link className="mt-4 inline-block rounded-full border px-2.5 py-1 text-xs font-medium hover:bg-muted" to={`/p/${prototype.id}/v/${prototype.latestVersion}`}>Published v{prototype.latestVersion}</Link> : null}
      </li>)}
    </ul> : null}
    {prototypes.status === "ready" && !prototypes.data.length ? <p className="mt-8 rounded-lg border border-dashed p-6">No prototypes found.</p> : null}
  </main>;
}
