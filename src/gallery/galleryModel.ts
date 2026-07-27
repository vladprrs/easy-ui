import { isServicePrototypeKind, prototypeKindOf, type PrototypeKind, type PrototypeSummary } from "../api/client";

export type GallerySort = "updated" | "name";
/** «service» — витрина служебных видов (fixtures/evidence/галереи), скрытых из основных табов. */
export type GalleryTab = "mine" | "shared" | "archive" | "service";

export interface GalleryFilters {
  tab: GalleryTab;
  userId: string;
  systemId: string | null;
  query: string;
  sort: GallerySort;
  /** null/undefined — «все виды» текущего таба. */
  kind?: PrototypeKind | null;
}

/** Виды, которые показывает таб: служебные — только в «Служебные», продуктовые — во всех остальных. */
export function kindsForTab(tab: GalleryTab, kinds: readonly PrototypeKind[]): PrototypeKind[] {
  return kinds.filter((kind) => isServicePrototypeKind(kind) === (tab === "service"));
}

export function filterAndSortPrototypes(prototypes: PrototypeSummary[], filters: GalleryFilters): PrototypeSummary[] {
  const { tab, userId, systemId, query, sort, kind = null } = filters;
  const normalizedQuery = query.trim().toLocaleLowerCase("ru");
  const filtered = prototypes
    .filter((prototype) => tab === "mine"
      ? prototype.owner.id === userId && prototype.status !== "archived"
      : tab === "shared"
        ? prototype.status === "published"
        : tab === "service"
          ? (prototype.owner.id === userId || prototype.status === "published") && prototype.status !== "archived"
          : prototype.owner.id === userId && prototype.status === "archived")
    // Служебные виды живут только в своём табе; архив показывает всё, что владелец туда убрал.
    .filter((prototype) => tab === "archive" || isServicePrototypeKind(prototypeKindOf(prototype)) === (tab === "service"))
    .filter((prototype) => kind === null || prototypeKindOf(prototype) === kind)
    .filter((prototype) => systemId === null || prototype.designSystem === systemId)
    .filter((prototype) => !normalizedQuery || prototype.name.toLocaleLowerCase("ru").includes(normalizedQuery));
  return [...filtered].sort(sort === "name"
      ? (left, right) => left.name.localeCompare(right.name, "ru", { numeric: true, sensitivity: "base" })
      : (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.name.localeCompare(right.name, "ru", { numeric: true, sensitivity: "base" }));
}
