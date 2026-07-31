import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { getLibraryCatalog, type LibraryCatalogEntry, type ThemeContent } from "../api/client";
import { useApi } from "../api/hooks";
import { kicker } from "../app/chrome";
import { library } from "../app/strings/library";
import { useDocumentTitle } from "../app/useDocumentTitle";
import { ThemeStyle } from "../designSystems/theme";
import { themeCache } from "../designSystems/themeCache";
import { CompositionsSection } from "./CompositionsSection";
import { CompactIndex } from "./components/CompactIndex";
import { ComponentCard } from "./components/ComponentCard";
import { LibraryHero } from "./components/LibraryHero";
import { LibraryEmpty, LibraryFailed, LibraryNoMatches, LibrarySkeletons, PublishDialog } from "./components/LibraryStates";
import { LibraryToolbar, type LibraryTab } from "./components/LibraryToolbar";
import { applicableLibraryStatusKeys, matchesLibraryFilter, searchComponents, tokenize, type LibraryStatusKey } from "./libraryModel";
import { libraryEntryKey, partitionTiers, previewPriorityFor, type PreviewIntent } from "./libraryTiers";

/**
 * Библиотека компонентов (макет 06).
 *
 * Экран отвечает на один вопрос: «какой компонент взять и можно ли ему верить».
 * Поэтому это витрина карточек с живым превью, а не список имён: ярусы вместо плоского
 * списка уровней, фильтры системы и статуса на канве, а всё, что нужно читать подробно
 * (параметры, исходник, использования), живёт на странице компонента — карточка целиком ведёт туда.
 *
 * Данных ровно один запрос — read-model `/api/catalog/library` (план 2026-07-31 §4.6).
 * Раньше страница делала `getComponentMeta()` на каждый компонент ради статуса; теперь статус
 * приходит в записи, поэтому `data-library-ready` и поиск по метаданным доступны до того,
 * как загрузится хоть одно превью.
 */
export function LibraryPage() {
  useDocumentTitle(library.title);
  const catalog = useApi((signal) => getLibraryCatalog({}, signal), []);
  const location = useLocation();
  const [tab, setTab] = useState<LibraryTab>("components");
  const [selectedSystem, setSelectedSystem] = useState<string | null>(null);
  const [status, setStatus] = useState<LibraryStatusKey | null>(null);
  const [query, setQuery] = useState("");
  const [publishOpen, setPublishOpen] = useState(false);

  const loading = catalog.status === "loading";
  const failed = catalog.status === "error";
  const previewsEnabled = new URLSearchParams(location.search).get("libraryPreviews") !== "off";

  const entries = useMemo(() => catalog.status === "ready" ? catalog.data.components : [], [catalog.data, catalog.status]);
  const systems = useMemo(() => catalog.status === "ready" ? catalog.data.systems : [], [catalog.data, catalog.status]);
  const systemNames = useMemo(() => new Map(systems.map((system) => [system.id, system.name])), [systems]);

  const dominantTheme = useDominantTheme(systems);

  // Область показа: одна система или все сразу (по умолчанию — все, чтобы экран
  // сразу отвечал на «что вообще есть», а не заставлял угадывать систему).
  const scoped = useMemo(() => selectedSystem === null ? entries : entries.filter((entry) => entry.designSystem === selectedSystem), [entries, selectedSystem]);
  const statusKeys = useMemo(() => applicableLibraryStatusKeys(scoped.map((entry) => entry.status)), [scoped]);
  const activeStatus = status !== null && statusKeys.includes(status) ? status : null;

  const filtered = useMemo(() => activeStatus === null
    ? scoped
    : scoped.filter((entry) => matchesLibraryFilter(entry.status, activeStatus)), [activeStatus, scoped]);
  const searching = tokenize(query).length > 0;
  const visible = useMemo(() => searchComponents(filtered, query), [filtered, query]);
  // Поиск идёт по всем ярусам сразу, поэтому его результат — плоская выдача, а не ярусы.
  const tiers = useMemo(() => partitionTiers(visible), [visible]);

  const toolbar = <LibraryToolbar
    tab={tab}
    onTabChange={setTab}
    systems={systems}
    selectedSystem={selectedSystem}
    onSystemChange={setSelectedSystem}
    statusKeys={statusKeys}
    activeStatus={activeStatus}
    onStatusChange={setStatus}
    query={query}
    onQueryChange={setQuery}
    showFilters={tab === "components" && entries.length > 0}
  />;

  const reset = () => { setQuery(""); setStatus(null); setSelectedSystem(null); };
  const showSystem = selectedSystem === null && systems.length > 1;
  // Выбранный результат поиска и раскрытый атом — интент `explicit`: приоритет 0 доезжает до
  // задачи планировщика через `reprioritize` внутри самого превью, даже если оно уже в очереди.
  const cardsFor = (list: LibraryCatalogEntry[], intent: PreviewIntent) => list.map((entry) => <ComponentCard
    key={libraryEntryKey(entry)}
    entry={entry}
    systemName={systemNames.get(entry.designSystem) ?? entry.designSystem}
    showSystem={showSystem}
    priority={previewPriorityFor(entry, intent)}
    previewsEnabled={previewsEnabled}
  />);
  const compact = (list: LibraryCatalogEntry[], label: string) => <CompactIndex
    entries={list}
    label={label}
    systemNames={systemNames}
    showSystem={showSystem}
    previewsEnabled={previewsEnabled}
  />;

  // Канва и gutter приходят из Layout: страница — только колонка панелей с gap 20.
  return <main className="mx-auto flex h-full w-full max-w-[1400px] flex-col gap-5 font-pay-text" data-library-ready={!loading && !failed ? "true" : "false"}>
    {dominantTheme}
    <LibraryHero counts={loading || failed ? null : { components: entries.length, systems: systems.length }} onPublish={() => setPublishOpen(true)} />
    {toolbar}
    {tab === "compositions" ? <CompositionsSection /> : <>
      {loading ? <LibrarySkeletons /> : null}
      {failed ? <LibraryFailed label={library.unavailable} onRetry={catalog.reload} /> : null}
      {!loading && !failed && !entries.length ? <LibraryEmpty onPublish={() => setPublishOpen(true)} /> : null}
      {!loading && !failed && entries.length > 0 && !visible.length ? <LibraryNoMatches searching={searching} onReset={reset} /> : null}
      {!loading && !failed && visible.length ? (searching
        ? <Section title={library.foundTitle(visible.length)}>{cardsFor(visible, "explicit")}</Section>
        : <>
          {tiers.recommended.length ? <Section title={library.tierRecommended} meta={library.levelCount(tiers.recommended.length)}>{cardsFor(tiers.recommended, "recommended")}</Section> : null}
          {tiers.high.length ? <Section title={library.tierHigh} meta={library.levelCount(tiers.high.length)}>{cardsFor(tiers.high, "high")}</Section> : null}
          {tiers.molecules.length ? <Section title={library.tierMolecules} meta={library.levelCount(tiers.molecules.length)}>{cardsFor(tiers.molecules, "molecules")}</Section> : null}
          {tiers.atoms.length ? <CompactSection title={library.tierAtoms} meta={library.levelCount(tiers.atoms.length)}>{compact(tiers.atoms, library.tierAtoms)}</CompactSection> : null}
          {tiers.retired.length ? <CompactSection title={library.tierRetired} meta={library.levelCount(tiers.retired.length)}>{compact(tiers.retired, library.tierRetired)}</CompactSection> : null}
        </>) : null}
    </>}
    {publishOpen ? <PublishDialog onClose={() => setPublishOpen(false)} /> : null}
  </main>;
}

/**
 * Один документный владелец темы на всю библиотеку (план §4.3.1).
 *
 * `token()` и `Icon` опубликованных бандлов читают единственный глобальный снапшот
 * `__easyUiShared`, поэтому per-card темы для них технически не существует. Владельцем
 * назначается система с наибольшим числом записей в **нефильтрованном** каталоге, и
 * пересчёта при смене фильтра тулбара нет: переключение снапшота на лету оставило бы уже
 * смонтированные карточки с чужими иконками. Шрифты владелец не эмитит (`fonts={false}`) —
 * `@font-face` целиком у `fontRegistry`, иначе тема переопределила бы шрифт всей страницы.
 */
function useDominantTheme(systems: { id: string; count: number }[]): ReactNode {
  const dominant = useMemo(() => [...systems]
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))[0]?.id ?? null, [systems]);
  const [theme, setTheme] = useState<ThemeContent | null>(null);

  useEffect(() => {
    if (dominant === null) return;
    let disposed = false;
    void themeCache.get(dominant).then((loaded) => { if (!disposed) setTheme(loaded.content); });
    return () => { disposed = true; };
  }, [dominant]);

  return <ThemeStyle content={theme} fonts={false} />;
}

/** Секция грида: заголовок яруса (или результата поиска) и карточки 3×N. */
function Section({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return <section>
    <SectionHeading title={title} meta={meta} />
    <ul className="mt-3 grid gap-5 sm:grid-cols-2 lg:grid-cols-3" aria-label={title}>{children}</ul>
  </section>;
}

/** Секция компактного индекса: тот же заголовок, но список строк вместо грида карточек. */
function CompactSection({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return <section>
    <SectionHeading title={title} meta={meta} />
    <div className="mt-3">{children}</div>
  </section>;
}

function SectionHeading({ title, meta }: { title: string; meta?: string }) {
  return <h2 className={`${kicker} flex flex-wrap items-baseline gap-2`}>
    <span className="text-base font-medium text-eui-ink">{title}</span>
    {meta ? <span>{meta}</span> : null}
  </h2>;
}
