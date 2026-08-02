import { useEffect, useState, useSyncExternalStore } from "react";
import type { InspectorEntry, InspectorLog } from "./log";
import { inspector } from "../../app/strings/player";
import type { ComponentDefinition } from "../../catalog/definitions";
import type { ComponentPinInfo, ScreenSpec } from "../../architecture/screenTree";
import { TreeTab } from "./TreeTab";

// Interaction inspector panel (plan H.1, feedback §12). Rendered by the player
// shell when the route carries `?debug=1`: a ledger in the player stage with
// the latest entries first, a kind filter, a clear button and a
// live `document.fonts` status section. Волна 1 (план 2026-07-27) добавила
// вкладку «Дерево» — архитектурное дерево экрана с подсветкой DOM по data-eui-key.

const FILTERS = ["all", "event", "action", "runtime-error"] as const;
type Filter = (typeof FILTERS)[number];

const fmt = (value: unknown): string => {
  if (value === undefined) return "undefined";
  try { return JSON.stringify(value); } catch { return String(value); }
};

interface FontStatus { family: string; status: string }

/** Mirrors `document.fonts` into a diagnostic section without polluting the event ledger. */
function useFontStatuses(): FontStatus[] {
  const [fonts, setFonts] = useState<FontStatus[]>([]);
  useEffect(() => {
    const fontSet = (document as { fonts?: FontFaceSet }).fonts;
    if (!fontSet || typeof fontSet.addEventListener !== "function") return;
    const read = () => {
      const list = Array.from(fontSet as unknown as Iterable<FontFace>).map((font) => ({ family: font.family, status: String(font.status) }));
      setFonts(list);
    };
    read();
    const events = ["loading", "loadingdone", "loadingerror"] as const;
    for (const event of events) fontSet.addEventListener(event, read);
    return () => { for (const event of events) fontSet.removeEventListener(event, read); };
  }, []);
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
          {entry.result.computed ? <Field label="computed" value={fmt(entry.result.computed)} /> : null}
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
  }
}

const kindLabel: Record<InspectorEntry["kind"], string> = {
  event: "event",
  action: "action",
  "runtime-error": "error",
};

const TABS = ["log", "tree"] as const;
type Tab = (typeof TABS)[number];
const tabLabel: Record<Tab, string> = { log: inspector.tabLog, tree: inspector.tabTree };

export function InspectorPanel({ log, spec, definitions, pins }: {
  log: InspectorLog;
  /** Authored-спека текущего экрана — источник вкладки «Дерево» (волна 1). */
  spec?: ScreenSpec;
  definitions?: Record<string, ComponentDefinition>;
  pins?: readonly ComponentPinInfo[];
}) {
  const entries = useSyncExternalStore(log.subscribe, log.getSnapshot, log.getSnapshot);
  const fonts = useFontStatuses();
  const [filter, setFilter] = useState<Filter>("all");
  const [tab, setTab] = useState<Tab>("log");

  const visible = [...entries].reverse().filter((entry) => filter === "all" || entry.kind === filter);

  return <aside
    aria-label={inspector.panelAria}
    className="flex h-full w-80 shrink-0 flex-col overflow-hidden border-l border-white/20 bg-eui-graphite font-mono text-xs text-white"
  >
    <div role="tablist" aria-label={inspector.tabsAria} className="flex shrink-0 border-b border-white/15">
      {TABS.map((item) => <button
        key={item}
        type="button"
        role="tab"
        aria-selected={tab === item}
        onClick={() => setTab(item)}
        className="flex-1 px-3 py-1.5 text-white/60 aria-selected:border-b-2 aria-selected:border-eui-brand aria-selected:font-semibold aria-selected:text-white"
      >{tabLabel[item]}</button>)}
    </div>
    {tab === "tree"
      ? <TreeTab spec={spec} definitions={definitions} pins={pins} />
      : <LogTab
        visible={visible}
        fonts={fonts}
        filter={filter}
        onFilter={setFilter}
        onClear={log.clear}
      />}
  </aside>;
}

function LogTab({ visible, fonts, filter, onFilter, onClear }: {
  visible: InspectorEntry[];
  fonts: FontStatus[];
  filter: Filter;
  onFilter: (filter: Filter) => void;
  onClear: () => void;
}) {
  return <>
    <header className="flex items-center gap-2 border-b border-white/15 px-3 py-2">
      <span className="font-semibold">{inspector.title}</span>
      <select
        aria-label={inspector.filterAria}
        value={filter}
        onChange={(event) => onFilter(event.target.value as Filter)}
        className="ml-auto rounded border border-white/20 bg-transparent px-1 py-0.5 text-xs"
      >
        {FILTERS.map((item) => <option key={item} value={item} className="bg-eui-graphite">{item}</option>)}
      </select>
      <button type="button" onClick={onClear} className="rounded border border-white/20 px-2 py-0.5 hover:bg-white/10">{inspector.clear}</button>
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
  </>;
}
