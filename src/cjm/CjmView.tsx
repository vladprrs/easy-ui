import { useMemo } from "react";
import { Link } from "react-router";
import { pillPrimary } from "../app/chrome";
import { cjm, cjmDocumentTitle } from "../app/strings/cjm";
import { useDocumentTitle } from "../app/useDocumentTitle";
import type { CustomPlayerRuntime } from "../catalog/runtime";
import { createPlayerRuntime } from "../catalog/runtime";
import type { PrototypeDoc } from "../prototype/schema";
import { CjmScreenTile } from "./CjmScreenTile";
import { createCjmRegistry } from "./cjmRegistry";

export function CjmView({ doc, custom, runtimeKey, routeBase, editable, version }: { doc: PrototypeDoc; custom?: CustomPlayerRuntime; runtimeKey: string; routeBase: string; editable: boolean; version?: number }) {
  useDocumentTitle(cjmDocumentTitle(doc.name, version));
  const runtime = useMemo(() => createPlayerRuntime({ navigate() {}, back() {}, openUrl() {}, restart() {} }, custom, doc.designSystem), [custom, doc.designSystem]);
  const registry = useMemo(() => createCjmRegistry(runtime.registry), [runtime.registry]);
  return <main className="h-full min-h-0 bg-eui-lav p-6 sm:p-8">
    <header className="mx-auto flex max-w-[1600px] items-start justify-between gap-6">
      <div><h1 className="font-eui-display text-2xl font-medium">{doc.name}</h1>{doc.description ? <p className="mt-2 max-w-2xl font-eui-ui text-eui-slate-500">{doc.description}</p> : null}</div>
      <div className="flex shrink-0 gap-2">{editable ? <Link className={`${pillPrimary} font-eui-ui`} to={`/p/${doc.id}/edit`}>{cjm.edit}</Link> : null}<Link className="inline-flex items-center justify-center rounded-full bg-white px-4 py-2 font-eui-ui text-sm font-medium text-eui-ink transition-colors hover:bg-eui-lilac-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-eui-brand" to={routeBase}>{cjm.openPlayer}</Link></div>
    </header>
    <ol className="mx-auto mt-10 flex max-w-[1600px] items-start gap-16 overflow-x-auto pb-8" aria-label={cjm.screensAria}>
      {doc.screens.map((screen, index) => <li className="relative shrink-0" key={screen.id}>
        <CjmScreenTile doc={doc} screen={screen} registry={registry} handlers={runtime.handlers} runtimeKey={runtimeKey} routeBase={routeBase} />
        {index < doc.screens.length - 1 ? <svg aria-hidden="true" className="absolute left-[calc(100%+1rem)] top-48 h-6 w-8" viewBox="0 0 32 24" fill="none"><path d="M1 12h27m-7-7 7 7-7 7" stroke="#844EDC" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg> : null}
      </li>)}
    </ol>
  </main>;
}
