import { useMemo } from "react";
import { Link } from "react-router";
import type { CustomPlayerRuntime } from "../catalog/runtime";
import { createPlayerRuntime } from "../catalog/runtime";
import type { PrototypeDoc } from "../prototype/schema";
import { CjmScreenTile } from "./CjmScreenTile";
import { createCjmRegistry } from "./cjmRegistry";

export function CjmView({ doc, custom, runtimeKey, routeBase, editable }: { doc: PrototypeDoc; custom?: CustomPlayerRuntime; runtimeKey: string; routeBase: string; editable: boolean }) {
  const runtime = useMemo(() => createPlayerRuntime({ navigate() {}, back() {}, openUrl() {}, restart() {} }, custom, doc.designSystem), [custom, doc.designSystem]);
  const registry = useMemo(() => createCjmRegistry(runtime.registry), [runtime.registry]);
  return <main className="min-h-screen bg-muted/30 p-6 sm:p-8">
    <header className="mx-auto flex max-w-[1600px] items-start justify-between gap-6">
      <div><h1 className="text-3xl font-bold">{doc.name}</h1>{doc.description ? <p className="mt-2 max-w-2xl text-muted-foreground">{doc.description}</p> : null}</div>
      <div className="flex shrink-0 gap-2">{editable ? <Link className="rounded-md border bg-background px-4 py-2 font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" to={`/p/${doc.id}/edit`}>Редактировать</Link> : null}<Link className="rounded-md border bg-background px-4 py-2 font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" to={routeBase}>Открыть плеер</Link></div>
    </header>
    <ol className="mx-auto mt-10 flex max-w-[1600px] items-start gap-16 overflow-x-auto pb-8" aria-label="CJM screens">
      {doc.screens.map((screen, index) => <li className="relative shrink-0" key={screen.id}>
        <CjmScreenTile doc={doc} screen={screen} registry={registry} handlers={runtime.handlers} runtimeKey={runtimeKey} routeBase={routeBase} />
        {index < doc.screens.length - 1 ? <svg aria-hidden="true" className="absolute left-[calc(100%+1rem)] top-48 h-6 w-8 text-muted-foreground" viewBox="0 0 32 24" fill="none"><path d="M1 12h27m-7-7 7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg> : null}
      </li>)}
    </ol>
  </main>;
}
