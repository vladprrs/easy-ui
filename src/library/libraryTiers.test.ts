import { describe, expect, it } from "vitest";
import type { LibraryCatalogEntry } from "../api/client";
import { RECOMMENDED_LIMIT, libraryEntryKey, partitionTiers, previewPriorityFor, rankRecommended, tierOf, type LibraryTier } from "./libraryTiers";

type EntryPatch = Partial<LibraryCatalogEntry> & { id: string };

const entry = (patch: EntryPatch): LibraryCatalogEntry => ({
  kind: "component",
  name: patch.id,
  designSystem: "ds",
  version: 1,
  bundleUrl: `/api/components/${patch.id}/versions/1/bundle.js`,
  bundleHash: "hash",
  hostAbiVersion: 4,
  description: "",
  layoutNeutral: false,
  canonicalFor: [],
  deprecated: false,
  headUsageCount: 0,
  status: { published: true, verified: false, visualPending: true, blocked: false, rejected: false },
  figma: null,
  preview: null,
  ...patch,
});

const verified = { published: true, verified: true, visualPending: false, blocked: false, rejected: false };
const pending = { published: true, verified: false, visualPending: true, blocked: false, rejected: false };

const ids = (entries: LibraryCatalogEntry[]) => entries.map((item) => item.id);

describe("rankRecommended", () => {
  it("orders by role, usage, visual status, assembly level, name and key", () => {
    const ordered = [
      entry({ id: "role", name: "Zzz", canonicalFor: ["nav"], headUsageCount: 0 }),
      entry({ id: "usage-high", name: "Zzz", headUsageCount: 9 }),
      entry({ id: "verified", name: "Zzz", headUsageCount: 3, status: verified }),
      entry({ id: "page", name: "Zeta", headUsageCount: 3, status: pending, atomicLevel: "page" }),
      entry({ id: "organism-a", name: "Alpha", headUsageCount: 3, status: pending, atomicLevel: "organism" }),
      entry({ id: "organism-b", name: "Beta", headUsageCount: 3, status: pending, atomicLevel: "organism" }),
      entry({ id: "same-name", name: "Gamma", designSystem: "aa", headUsageCount: 3, status: pending, atomicLevel: "organism" }),
      entry({ id: "same-name", name: "Gamma", designSystem: "zz", headUsageCount: 3, status: pending, atomicLevel: "organism" }),
    ];
    const expected = ordered.map(libraryEntryKey);
    const shuffled = [ordered[5], ordered[0], ordered[7], ordered[3], ordered[6], ordered[1], ordered[4], ordered[2]];
    const reversed = [...ordered].reverse();

    expect(rankRecommended(shuffled).map(libraryEntryKey)).toEqual(expected);
    // Порядок полный: любой вход даёт тот же выход, ничьих, разрешаемых порядком входа, нет.
    expect(rankRecommended(reversed).map(libraryEntryKey)).toEqual(expected);
  });

  it("excludes retired, rejected and blocked entries even with the highest usage", () => {
    const entries = [
      entry({ id: "alive", headUsageCount: 1 }),
      entry({ id: "deprecated", headUsageCount: 99, deprecated: true }),
      entry({ id: "replaced", headUsageCount: 96, replacement: "alive" }),
      entry({ id: "rejected", headUsageCount: 98, status: { ...pending, rejected: true } }),
      entry({ id: "blocked", headUsageCount: 97, status: { ...pending, blocked: true } }),
    ];
    expect(ids(rankRecommended(entries))).toEqual(["alive"]);
  });

  it("caps the shelf at 12", () => {
    const entries = Array.from({ length: 15 }, (_, index) => entry({ id: `c${index}`, name: `C${String(index).padStart(2, "0")}` }));
    const ranked = rankRecommended(entries);
    expect(ranked).toHaveLength(12);
    expect(ids(ranked)).toEqual(entries.slice(0, 12).map((item) => item.id));
  });

  it("deduplicates by (designSystem, id) and keeps a same-id entry from another system", () => {
    const entries = [
      entry({ id: "card", name: "Card", headUsageCount: 5 }),
      entry({ id: "card", name: "Card", headUsageCount: 5 }),
      entry({ id: "card", name: "Card", designSystem: "other", headUsageCount: 5 }),
    ];
    expect(rankRecommended(entries).map(libraryEntryKey)).toEqual(["ds card", "other card"]);
  });
});

describe("partitionTiers", () => {
  const entries = [
    entry({ id: "page", atomicLevel: "page" }),
    entry({ id: "template", atomicLevel: "template" }),
    entry({ id: "organism", atomicLevel: "organism" }),
    entry({ id: "molecule", atomicLevel: "molecule" }),
    entry({ id: "unclassified" }),
    entry({ id: "atom", atomicLevel: "atom" }),
    entry({ id: "wrapper", atomicLevel: "organism", layoutNeutral: true }),
    entry({ id: "neutral-unclassified", layoutNeutral: true }),
    entry({ id: "deprecated-organism", atomicLevel: "organism", deprecated: true }),
    entry({ id: "replaced-atom", atomicLevel: "atom", replacement: "atom" }),
  ];

  /**
   * Витрина «Рекомендуем» — повышение: попав на неё, запись уходит из своего яруса. Чтобы нижние
   * ярусы вообще было на чём проверять, шельф целиком занимают заведомые фавориты — записи с
   * использованием, какого у образцов выше нет.
   */
  const shelf = Array.from({ length: RECOMMENDED_LIMIT }, (_, index) => entry({
    id: `top${index}`, name: `Top${String(index).padStart(2, "0")}`, atomicLevel: "organism", headUsageCount: 100,
  }));
  const catalog = [...entries, ...shelf];

  it("assigns every entry to exactly one lower tier", () => {
    const tiers = partitionTiers(catalog);
    expect(tiers.high.map((item) => item.id)).toEqual(["organism", "page", "template"]);
    expect(tiers.molecules.map((item) => item.id)).toEqual(["molecule", "unclassified"]);
    // layoutNeutral идёт в атомы независимо от уровня сборки: показывать в превью нечего.
    expect(tiers.atoms.map((item) => item.id)).toEqual(["atom", "neutral-unclassified", "wrapper"]);
    // Списание перевешивает и уровень, и layoutNeutral.
    expect(tiers.retired.map((item) => item.id)).toEqual(["deprecated-organism", "replaced-atom"]);

    const lower = [...tiers.high, ...tiers.molecules, ...tiers.atoms, ...tiers.retired];
    expect(lower).toHaveLength(entries.length);
    expect(new Set(lower.map(libraryEntryKey)).size).toBe(entries.length);
    expect([...new Set(lower.map(libraryEntryKey))].sort()).toEqual([...new Set(entries.map(libraryEntryKey))].sort());
  });

  it("promotes a recommended entry out of its lower tier: every entry renders exactly once", () => {
    const tiers = partitionTiers(catalog);
    const lower = [...tiers.high, ...tiers.molecules, ...tiers.atoms, ...tiers.retired];
    const lowerKeys = new Set(lower.map(libraryEntryKey));

    expect(tiers.recommended).toHaveLength(RECOMMENDED_LIMIT);
    for (const promoted of tiers.recommended) expect(lowerKeys.has(libraryEntryKey(promoted))).toBe(false);

    // Сумма всех пяти ярусов — весь каталог, и каждая запись в ней ровно одна.
    const rendered = [...tiers.recommended, ...lower].map(libraryEntryKey);
    expect(rendered).toHaveLength(catalog.length);
    expect(new Set(rendered).size).toBe(catalog.length);

    // Списанное на витрину не попадает, поэтому и остаётся в своём ярусе.
    expect(ids(tiers.recommended)).not.toContain("deprecated-organism");
    expect(ids(tiers.retired)).toContain("deprecated-organism");
  });

  it("takes a promoted atom out of the compact index", () => {
    const promotedAtom = entry({ id: "star-atom", atomicLevel: "atom", headUsageCount: 100 });
    const tiers = partitionTiers([promotedAtom, ...entries]);
    expect(ids(tiers.recommended)).toContain("star-atom");
    expect(ids(tiers.atoms)).not.toContain("star-atom");
  });

  it("tierOf agrees with the partition for every entry that stayed in its tier", () => {
    const tiers = partitionTiers(catalog);
    for (const item of entries) expect(tiers[tierOf(item)].map(libraryEntryKey)).toContain(libraryEntryKey(item));
  });
});

describe("previewPriorityFor", () => {
  const molecule = entry({ id: "molecule", atomicLevel: "molecule" });
  const atom = entry({ id: "atom", atomicLevel: "atom" });
  const wrapper = entry({ id: "wrapper", atomicLevel: "organism", layoutNeutral: true });

  it("maps intent to the scheduler priority", () => {
    const cases: [LibraryCatalogEntry, Parameters<typeof previewPriorityFor>[1], number | null][] = [
      [molecule, "explicit", 0],
      [atom, "explicit", 0],
      [atom, "atoms", null],
      [molecule, "recommended", 1],
      [molecule, "high", 1],
      [molecule, "molecules", 2],
      [molecule, "prefetch", 3],
      [atom, "prefetch", null],
      [molecule, "retired", 3],
    ];
    for (const [item, intent, priority] of cases) expect([item.id, intent, previewPriorityFor(item, intent)]).toEqual([item.id, intent, priority]);
  });

  /**
   * Приоритет 0 значит «выбрано пользователем», а не «атом»: атом и лэйаут-обёртка не грузятся
   * сами ни в одном ярусе, включая витрину, — иначе повышенный атом уехал бы вперёд организмов.
   */
  it("never auto-enqueues an atom or a layout-neutral wrapper, in any tier", () => {
    const tiers: LibraryTier[] = ["recommended", "high", "molecules", "atoms", "retired"];
    for (const tier of tiers) {
      expect([tier, previewPriorityFor(atom, tier)]).toEqual([tier, null]);
      expect([tier, previewPriorityFor(wrapper, tier)]).toEqual([tier, null]);
    }
    // Раскрыть его по кнопке по-прежнему можно, и тогда очередь короткая — приоритет 0.
    expect(previewPriorityFor(atom, "explicit")).toBe(0);
    expect(previewPriorityFor(wrapper, "explicit")).toBe(0);
  });

  it("never loads a retired molecule ahead of live cards", () => {
    expect(previewPriorityFor(entry({ id: "old", atomicLevel: "molecule", deprecated: true }), "retired")).toBe(3);
  });

  it("answers for every tier", () => {
    const tiers: LibraryTier[] = ["recommended", "high", "molecules", "atoms", "retired"];
    for (const tier of tiers) expect([0, 1, 2, 3, null]).toContain(previewPriorityFor(molecule, tier));
  });
});
