import { Link } from "react-router";
import { prototypes } from "../prototype/loader";

const deviceNames = {
  mobile: "Mobile",
  tablet: "Tablet",
  desktop: "Desktop",
} as const;

export function GalleryPage() {
  return <main className="mx-auto max-w-6xl p-6 sm:p-8">
    <h1 className="text-3xl font-bold">Prototype gallery</h1>
    <p className="mt-2 text-muted-foreground">Choose a flow to open its first screen.</p>
    {prototypes.length ? <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {prototypes.map((prototype) => <li key={prototype.id}>
        <Link className="block h-full rounded-xl border bg-card p-5 text-card-foreground shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" to={`/p/${prototype.id}`}>
          <h2 className="text-xl font-semibold">{prototype.name}</h2>
          <p className="mt-2 min-h-10 text-sm text-muted-foreground">{prototype.description ?? "No description"}</p>
          <dl className="mt-5 flex gap-4 text-sm">
            <div><dt className="text-muted-foreground">Device</dt><dd className="font-medium">{deviceNames[prototype.device]}</dd></div>
            <div><dt className="text-muted-foreground">Screens</dt><dd className="font-medium">{prototype.screens.length}</dd></div>
          </dl>
        </Link>
      </li>)}
    </ul> : <p className="mt-8 rounded-lg border border-dashed p-6">No valid prototypes found.</p>}
  </main>;
}
