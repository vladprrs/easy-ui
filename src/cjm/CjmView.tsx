import { useMemo } from "react";
import { PrototypeChrome } from "../app/PrototypeChrome";
import { cjm, cjmDocumentTitle } from "../app/strings/cjm";
import { useDocumentTitle } from "../app/useDocumentTitle";
import type { CustomPlayerRuntime } from "../catalog/runtime";
import { createPlayerRuntime } from "../catalog/runtime";
import type { PrototypeDoc } from "../prototype/schema";
import { CjmScreenTile } from "./CjmScreenTile";
import { createCjmRegistry } from "./cjmRegistry";

export function CjmView({ doc, custom, runtimeKey, routeBase, version }: { doc: PrototypeDoc; custom?: CustomPlayerRuntime; runtimeKey: string; routeBase: string; version?: number }) {
  useDocumentTitle(cjmDocumentTitle(doc.name, version));
  const runtime = useMemo(() => createPlayerRuntime({ navigate() {}, back() {}, openUrl() {}, restart() {} }, custom, doc.designSystem), [custom, doc.designSystem]);
  const registry = useMemo(() => createCjmRegistry(runtime.registry), [runtime.registry]);
  const customTypes = useMemo(() => new Set(Object.keys(custom?.definitions ?? {})), [custom]);
  // Единый хром /p/* (WF-4): навигация Плеер/Редактор живёт в сегментах хрома,
  // тело вью — только stage (описание + лента экранов).
  return <main className="flex h-full min-h-0 flex-col">
    <PrototypeChrome prototypeId={doc.id} prototypeName={doc.name} view="cjm" version={version} />
    <div className="min-h-0 flex-1 overflow-y-auto bg-eui-lav p-6 sm:p-8">
      {doc.description ? <p className="mx-auto max-w-[1600px] font-eui-ui text-eui-slate-500">{doc.description}</p> : null}
      <ol className="mx-auto mt-8 flex max-w-[1600px] items-start gap-16 overflow-x-auto pb-8" aria-label={cjm.screensAria}>
      {doc.screens.map((screen, index) => <li className="relative shrink-0" key={screen.id}>
        <CjmScreenTile doc={doc} screen={screen} registry={registry} handlers={runtime.handlers} runtimeKey={runtimeKey} routeBase={routeBase} customTypes={customTypes} customDefinitions={custom?.definitions} />
        {index < doc.screens.length - 1 ? <svg aria-hidden="true" className="absolute left-[calc(100%+1rem)] top-48 h-6 w-8" viewBox="0 0 32 24" fill="none"><path d="M1 12h27m-7-7 7 7-7 7" stroke="#844EDC" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg> : null}
      </li>)}
      </ol>
    </div>
  </main>;
}
