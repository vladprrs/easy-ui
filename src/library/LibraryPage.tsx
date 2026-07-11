import { useEffect, useMemo, useState } from "react";
import { chip, chipActive, headingBar, kicker } from "../app/chrome";
import { fetchStorybookIndex, parseStorybookTitle, type StorybookEntry } from "./storybookIndex";

const levelOrder = ["Layout", "Atoms", "Molecules", "Organisms", "Templates", "Pages", "Other"];

export function LibraryPage() {
  const [entries, setEntries] = useState<StorybookEntry[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeSystem, setActiveSystem] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchStorybookIndex().then((index) => {
      if (!active) return;
      const stories = index ? Object.values(index.entries).filter((entry) => entry.type === "story") : null;
      setEntries(stories);
      const firstSystem = stories?.map(parseStorybookTitle).map(({ system }) => system).sort((a, b) => a.localeCompare(b))[0] ?? null;
      setActiveSystem(firstSystem);
      setSelectedId(stories?.find((entry) => parseStorybookTitle(entry).system === firstSystem)?.id ?? null);
      setLoaded(true);
    });
    return () => { active = false; };
  }, []);

  const systems = useMemo(() => [...new Set(entries?.map((entry) => parseStorybookTitle(entry).system) ?? [])].sort((a, b) => a.localeCompare(b)), [entries]);
  const groups = useMemo(() => entries?.filter((entry) => parseStorybookTitle(entry).system === activeSystem).reduce<Record<string, StorybookEntry[]>>((result, entry) => {
    const { level } = parseStorybookTitle(entry);
    (result[levelOrder.includes(level) ? level : "Other"] ??= []).push(entry);
    return result;
  }, {}), [activeSystem, entries]);

  if (!loaded) return <main className="flex h-full min-h-0 items-center justify-center p-8"><p className="rounded-3xl bg-eui-lav p-6 font-eui-ui text-eui-slate-500" role="status">Loading component library…</p></main>;
  if (!entries?.length || !groups) return <main className="flex h-full min-h-0 items-center justify-center p-8">
    <div className="w-full max-w-2xl rounded-3xl bg-eui-lav p-6 font-eui-ui text-eui-slate-500">
    <h1 className={headingBar}>Component library</h1>
    <div className="mt-6">
      <p>Storybook is unavailable or contains no stories.</p>
      <p className="mt-2 text-sm">Run <code className="rounded bg-eui-lilac-100 px-1.5 py-0.5">npm run storybook</code> and reload this page.</p>
    </div>
    </div>
  </main>;

  const iframeUrl = `/storybook/iframe.html?id=${encodeURIComponent(selectedId!)}&viewMode=story`;
  const selectedStory = entries.find((entry) => entry.id === selectedId);
  const selectedTitle = selectedStory ? parseStorybookTitle(selectedStory) : null;
  return <main className="flex h-full min-h-0 flex-col lg:flex-row">
    <aside className="w-full shrink-0 border-b p-5 font-eui-ui lg:w-72 lg:border-b-0 lg:border-r">
      <h1 className={headingBar}>Component library</h1>
      <div className="mt-4 flex flex-wrap gap-2" aria-label="Design systems">
      {systems.map((system) => <button type="button" key={system} aria-pressed={activeSystem === system} className={activeSystem === system ? chipActive : `${chip} hover:bg-eui-lilac-100/60`} onClick={() => {
        setActiveSystem(system);
        setSelectedId(entries.find((entry) => parseStorybookTitle(entry).system === system)?.id ?? null);
      }}>{system}</button>)}
      </div>
      <nav className="mt-5 space-y-4" aria-label="Stories">
        {levelOrder.filter((level) => groups[level]?.length).map((level) => <section key={level}>
          <h2 className={kicker}>{level}</h2>
          <ul className="mt-1 space-y-1">{groups[level].map((story) => <li key={story.id}>
            <button type="button" className={`w-full rounded-lg px-2 py-1 text-left text-sm ${selectedId === story.id ? "bg-eui-lilac-100 font-bold" : "text-eui-slate-500 hover:bg-eui-lilac-100/60"}`} onClick={() => setSelectedId(story.id)}>{parseStorybookTitle(story).name}</button>
          </li>)}</ul>
        </section>)}
      </nav>
    </aside>
    <section className="flex min-h-0 flex-1 flex-col p-4 font-eui-ui">
      <div className="mb-3 flex items-center gap-3 text-sm">
        <span className="font-bold">{selectedTitle ? `${selectedTitle.name} · ${selectedTitle.level}` : ""}</span>
        <a className="ml-auto text-eui-slate-500 underline hover:text-eui-brand" href={iframeUrl} target="_blank" rel="noreferrer">Open in Storybook</a>
      </div>
      <iframe className="min-h-0 flex-1 overflow-hidden rounded-3xl border border-eui-ink/10" title="Story preview" src={iframeUrl} />
    </section>
  </main>;
}
