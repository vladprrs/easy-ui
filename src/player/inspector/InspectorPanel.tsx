import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { InspectorEntry, InspectorLog } from "./log";
import { inspector } from "../../app/strings/player";

// Interaction inspector panel (plan H.1, feedback §12). Rendered by the player
// shell when the route carries `?debug=1`: a collapsible floating ledger on the
// right edge with the latest entries first, a kind filter, a clear button and a
// live `document.fonts` status section.

const FILTERS = ["all", "event", "action", "runtime-error", "font-status"] as const;
type Filter = (typeof FILTERS)[number];

const fmt = (value: unknown): string => {
  if (value === undefined) return "undefined";
  try { return JSON.stringify(value); } catch { return String(value); }
};

interface FontStatus { family: string; status: string }

/** Mirrors `document.fonts` into state and logs status transitions as font-status entries. */
function useFontStatuses(log: InspectorLog): FontStatus[] {
  const [fonts, setFonts] = useState<FontStatus[]>([]);
  const seen = useRef(new Map<string, string>());
  useEffect(() => {
    const fontSet = (document as { fonts?: FontFaceSet }).fonts;
    if (!fontSet || typeof fontSet.addEventListener !== "function") return;
    const read = () => {
      const list = Array.from(fontSet as unknown as Iterable<FontFace>).map((font) => ({ family: font.family, status: String(font.status) }));
      setFonts(list);
      for (const { family, status } of list) {
        if (seen.current.get(family) !== status) {
          seen.current.set(family, status);
          log.logFontStatus(family, status);
        }
      }
    };
    read();
    const events = ["loading", "loadingdone", "loadingerror"] as const;
    for (const event of events) fontSet.addEventListener(event, read);
    return () => { for (const event of events) fontSet.removeEventListener(event, read); };
  }, [log]);
  return fonts;
}

function Field({ label, value }: { label: string; value: string }) {
  return <div className="break-all"><span className="text-white/50">{label}: </span>{value}</div>;
}

function EntryView({ entry }: { entry: InspectorEntry }) {
  switch (entry.kind) {
    case "event":
      return <>
        <Field label="component" value={entry.component} />
        <Field label="event" value={entry.event} />
        <Field label="payload" value={fmt(entry.payload)} />
        <Field label="element" value={entry.elementId} />
        {entry.payloadValid ? null : <div className="text-eui-orange">{inspector.payloadInvalid}</div>}
      </>;
    case "action":
      return <>
        <Field label="action" value={entry.action} />
        {entry.result.type === "state" ? <>
          <Field label="path" value={entry.result.statePath} />
          <Field label="previous" value={fmt(entry.result.previous)} />
          <Field label="next" value={fmt(entry.result.next)} />
        </> : null}
        {entry.result.type === "nav" ? <Field label="target" value={entry.result.target} /> : null}
        {entry.result.type === "url" ? <Field label="url" value={entry.result.url} /> : null}
        {entry.result.type === "skipped" ? <div className="text-white/50">{inspector.skipped}</div> : null}
        {entry.result.type === "error" ? <div className="text-eui-orange">{entry.result.message}</div> : null}
        {Object.keys(entry.params).length > 0 && entry.result.type !== "state" ? <Field label="params" value={fmt(entry.params)} /> : null}
      </>;
    case "runtime-error":
      return <>
        <div className="text-eui-orange">{entry.message}</div>
        {entry.detail ? <Field label="detail" value={fmt(entry.detail)} /> : null}
      </>;
    case "font-status":
      return <Field label={entry.family} value={entry.status} />;
  }
}

const kindLabel: Record<InspectorEntry["kind"], string> = {
  event: "event",
  action: "action",
  "runtime-error": "error",
  "font-status": "font",
};

export function InspectorPanel({ log }: { log: InspectorLog }) {
  const entries = useSyncExternalStore(log.subscribe, log.getSnapshot, log.getSnapshot);
  const fonts = useFontStatuses(log);
  const [open, setOpen] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");

  if (!open) {
    return <button
      type="button"
      onClick={() => setOpen(true)}
      className="fixed right-3 top-16 z-50 rounded-full border border-white/20 bg-eui-graphite/95 px-3 py-1 font-mono text-xs text-white shadow-lg"
    >{inspector.collapsedButton(entries.length)}</button>;
  }

  const visible = [...entries].reverse().filter((entry) => filter === "all" || entry.kind === filter);

  return <aside
    aria-label={inspector.panelAria}
    className="fixed bottom-3 right-3 top-16 z-50 flex w-80 flex-col overflow-hidden rounded-xl border border-white/20 bg-eui-graphite/95 font-mono text-xs text-white shadow-2xl"
  >
    <header className="flex items-center gap-2 border-b border-white/15 px-3 py-2">
      <span className="font-semibold">{inspector.title}</span>
      <select
        aria-label={inspector.filterAria}
        value={filter}
        onChange={(event) => setFilter(event.target.value as Filter)}
        className="ml-auto rounded border border-white/20 bg-transparent px-1 py-0.5 text-xs"
      >
        {FILTERS.map((item) => <option key={item} value={item} className="bg-eui-graphite">{item}</option>)}
      </select>
      <button type="button" onClick={log.clear} className="rounded border border-white/20 px-2 py-0.5 hover:bg-white/10">{inspector.clear}</button>
      <button type="button" aria-label={inspector.collapse} onClick={() => setOpen(false)} className="rounded border border-white/20 px-2 py-0.5 hover:bg-white/10">—</button>
    </header>
    <ol aria-label={inspector.entriesAria} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
      {visible.length === 0 ? <li className="py-2 text-white/50">{inspector.empty}</li> : null}
      {visible.map((entry) => <li key={entry.id} className="border-b border-white/10 py-2 last:border-b-0">
        <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wide text-white/40">
          <span>{kindLabel[entry.kind]}</span>
          {"correlationId" in entry && entry.correlationId ? <span>#{entry.correlationId}</span> : null}
          <span className="ml-auto">{new Date(entry.time).toLocaleTimeString()}</span>
        </div>
        <EntryView entry={entry} />
      </li>)}
    </ol>
    <section aria-label={inspector.fontsAria} className="border-t border-white/15 px-3 py-2">
      <h2 className="mb-1 text-[10px] uppercase tracking-wide text-white/40">{inspector.fontsTitle}</h2>
      {fonts.length === 0
        ? <p className="text-white/50">{inspector.fontsEmpty}</p>
        : fonts.map((font, index) => <Field key={`${font.family}-${index}`} label={font.family} value={font.status} />)}
    </section>
  </aside>;
}
