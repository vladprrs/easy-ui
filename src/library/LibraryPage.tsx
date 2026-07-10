import { useEffect, useMemo, useState } from "react";
import { fetchStorybookIndex, type StorybookEntry } from "./storybookIndex";

export function LibraryPage() {
  const [entries, setEntries] = useState<StorybookEntry[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchStorybookIndex().then((index) => {
      if (!active) return;
      const stories = index ? Object.values(index.entries).filter((entry) => entry.type === "story") : null;
      setEntries(stories);
      setSelectedId(stories?.[0]?.id ?? null);
      setLoaded(true);
    });
    return () => { active = false; };
  }, []);

  const groups = useMemo(() => entries?.reduce<Record<string, StorybookEntry[]>>((result, entry) => {
    (result[entry.title] ??= []).push(entry);
    return result;
  }, {}), [entries]);

  if (!loaded) return <main className="p-8"><p role="status">Loading component library…</p></main>;
  if (!entries?.length || !groups) return <main className="mx-auto max-w-2xl p-8">
    <h1 className="text-3xl font-bold">Component library</h1>
    <div className="mt-6 rounded-lg border border-dashed p-6">
      <p>Storybook is unavailable or contains no stories.</p>
      <p className="mt-2 text-sm text-muted-foreground">Run <code className="rounded bg-muted px-1.5 py-0.5">npm run storybook</code> and reload this page.</p>
    </div>
  </main>;

  const iframeUrl = `/storybook/iframe.html?id=${encodeURIComponent(selectedId!)}&viewMode=story`;
  return <main className="flex min-h-[calc(100vh-4rem)] flex-col lg:flex-row">
    <aside className="w-full border-b p-5 lg:w-72 lg:border-b-0 lg:border-r">
      <h1 className="text-2xl font-bold">Component library</h1>
      <nav className="mt-5 space-y-4" aria-label="Stories">
        {Object.entries(groups).map(([title, stories]) => <section key={title}>
          <h2 className="text-sm font-semibold">{title}</h2>
          <ul className="mt-1 space-y-1">{stories.map((story) => <li key={story.id}>
            <button type="button" className={`w-full rounded px-2 py-1 text-left text-sm ${selectedId === story.id ? "bg-accent font-medium" : "hover:bg-muted"}`} onClick={() => setSelectedId(story.id)}>{story.name}</button>
          </li>)}</ul>
        </section>)}
      </nav>
    </aside>
    <section className="flex min-h-[36rem] flex-1 flex-col p-4">
      <div className="mb-3 text-right"><a className="text-sm underline" href={iframeUrl} target="_blank" rel="noreferrer">Open in Storybook</a></div>
      <iframe className="min-h-0 flex-1 rounded border" title="Story preview" src={iframeUrl} />
    </section>
  </main>;
}
