import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { PrototypeChrome } from "../app/PrototypeChrome";
import { cjm, cjmDocumentTitle } from "../app/strings/cjm";
import { useDocumentTitle } from "../app/useDocumentTitle";
import type { CustomPlayerRuntime } from "../catalog/runtime";
import { createPlayerRuntime } from "../catalog/runtime";
import { resolveBuiltinSystem } from "../designSystems";
import type { PrototypeDoc } from "../prototype/schema";
import { CjmScreenTile } from "./CjmScreenTile";
import { createCjmRegistry } from "./cjmRegistry";

interface ConnectorGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
  sourceY: number;
  targetY: number;
}

function sameGeometry(left: ConnectorGeometry | null, right: ConnectorGeometry): boolean {
  return left !== null && Object.keys(right).every((key) => left[key as keyof ConnectorGeometry] === right[key as keyof ConnectorGeometry]);
}

/** Connects the measured centers of two adjacent tiles; it does not encode a flow edge. */
function CjmConnector({ sourceScreenId, targetScreenId }: { sourceScreenId: string; targetScreenId: string }) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [geometry, setGeometry] = useState<ConnectorGeometry | null>(null);
  useLayoutEffect(() => {
    const source = anchorRef.current?.parentElement;
    const target = source?.nextElementSibling;
    if (!(source instanceof HTMLElement) || !(target instanceof HTMLElement) || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const sourceRect = source.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const sourceCenter = sourceRect.height / 2;
      const targetCenter = targetRect.top - sourceRect.top + targetRect.height / 2;
      const top = Math.min(sourceCenter, targetCenter) - 12;
      const next = {
        left: sourceRect.width,
        top,
        width: Math.max(0, targetRect.left - sourceRect.right),
        height: Math.abs(targetCenter - sourceCenter) + 24,
        sourceY: sourceCenter - top,
        targetY: targetCenter - top,
      };
      setGeometry((current) => sameGeometry(current, next) ? current : next);
    });
    observer.observe(source);
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  return <>
    <span ref={anchorRef} className="sr-only" />
    {geometry === null || geometry.width === 0 ? null : <svg
      aria-hidden="true"
      className="cjm-connector pointer-events-none absolute z-10 overflow-visible"
      data-source-screen-id={sourceScreenId}
      data-target-screen-id={targetScreenId}
      data-testid="cjm-connector"
      style={{ left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height }}
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      fill="none"
    >
      <path data-testid="cjm-connector-line" d={`M0 ${geometry.sourceY} L${geometry.width} ${geometry.targetY}`} stroke="#844EDC" strokeWidth="2.5" strokeLinecap="round" />
      <path d={`M${geometry.width - 8} ${geometry.targetY - 7} L${geometry.width} ${geometry.targetY} L${geometry.width - 8} ${geometry.targetY + 7}`} stroke="#844EDC" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>}
  </>;
}

export function CjmView({ doc, custom, runtimeKey, routeBase, version }: { doc: PrototypeDoc; custom?: CustomPlayerRuntime; runtimeKey: string; routeBase: string; version?: number }) {
  useDocumentTitle(cjmDocumentTitle(doc.name, version));
  const runtime = useMemo(() => createPlayerRuntime({ navigate() {}, back() {}, openUrl() {}, restart() {} }, custom, doc.designSystem), [custom, doc.designSystem]);
  const registry = useMemo(() => createCjmRegistry(runtime.registry), [runtime.registry]);
  const customTypes = useMemo(() => new Set(Object.keys(custom?.definitions ?? {})), [custom]);
  const designSystemName = resolveBuiltinSystem(doc.designSystem).name;
  const metadata = <dl aria-label={cjm.metadataAria} className="flex flex-wrap items-center gap-2 font-eui-ui text-xs text-eui-slate-500">
    <div><dt className="sr-only">{cjm.screensLabel}</dt><dd className="rounded-full bg-eui-lilac-100 px-2.5 py-1">{cjm.screensCount(doc.screens.length)}</dd></div>
    <div><dt className="sr-only">{cjm.designSystemLabel}</dt><dd className="rounded-full bg-eui-lilac-100 px-2.5 py-1">{designSystemName}</dd></div>
  </dl>;
  // Единый хром /p/* (WF-4): навигация Плеер/Редактор живёт в сегментах хрома,
  // тело вью — только stage (описание + лента экранов).
  return <main className="cjm-root flex h-full min-h-0 flex-col">
    <PrototypeChrome prototypeId={doc.id} prototypeName={doc.name} view="cjm" version={version} status={metadata} />
    <div className="cjm-stage min-h-0 flex-1 overflow-y-auto bg-eui-lav p-6 sm:p-8">
      {doc.description ? <p className="mx-auto max-w-[1600px] font-eui-ui text-eui-slate-500">{doc.description}</p> : null}
      <ol className="cjm-list mx-auto mt-8 flex items-start gap-16 overflow-x-auto pb-8" aria-label={cjm.screensAria}>
      {doc.screens.map((screen, index) => <li className="relative shrink-0" key={screen.id} data-screen-id={screen.id}>
        <CjmScreenTile doc={doc} screen={screen} registry={registry} handlers={runtime.handlers} runtimeKey={runtimeKey} routeBase={routeBase} customTypes={customTypes} customDefinitions={custom?.definitions} />
        {index < doc.screens.length - 1 ? <CjmConnector sourceScreenId={screen.id} targetScreenId={doc.screens[index + 1]!.id} /> : null}
      </li>)}
      </ol>
    </div>
  </main>;
}
