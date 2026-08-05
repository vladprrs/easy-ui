import { isServicePrototypeKind, prototypeKindOf, type PrototypeKind, type PrototypeSummary } from "../api/client";

export type GallerySort = "updated" | "name";
/**
 * «service» — витрина служебных видов (fixtures/evidence/галереи), скрытых из основных табов.
 * «all» — админский раздел «Все» (план 2026-08-05): показывает всё, что вернул `?scope=all`,
 * включая чужие private/archived и прототипы без владельца.
 */
export type GalleryTab = "mine" | "shared" | "archive" | "service" | "all";

export interface GalleryFilters {
  tab: GalleryTab;
  userId: string;
  systemId: string | null;
  query: string;
  sort: GallerySort;
  /** null/undefined — «все виды» текущего таба. */
  kind?: PrototypeKind | null;
}

/**
 * Виды, которые показывает таб: служебные — только в «Служебные», продуктовые — во всех остальных.
 * «Архив» и админский «Все» — сквозные разделы и перечисляют всю таксономию.
 */
export function kindsForTab(tab: GalleryTab, kinds: readonly PrototypeKind[]): PrototypeKind[] {
  if (tab === "archive" || tab === "all") return [...kinds];
  return kinds.filter((kind) => isServicePrototypeKind(kind) === (tab === "service"));
}

export function filterAndSortPrototypes(prototypes: PrototypeSummary[], filters: GalleryFilters): PrototypeSummary[] {
  const { tab, userId, systemId, query, sort, kind = null } = filters;
  const normalizedQuery = query.trim().toLocaleLowerCase("ru");
  // Прототип без владельца приезжает с `owner.id === ""` (админский `?scope=all`): пустой
  // userId неаутентифицированного состояния не должен «усыновлять» такие карточки в «Мои».
  const owned = (ownerId: string) => userId !== "" && ownerId === userId;
  const filtered = prototypes
    .filter((prototype) => tab === "all"
      ? true
      : tab === "mine"
        ? owned(prototype.owner.id) && prototype.status !== "archived"
        : tab === "shared"
          ? prototype.status === "published"
          : tab === "service"
            ? (owned(prototype.owner.id) || prototype.status === "published") && prototype.status !== "archived"
            : owned(prototype.owner.id) && prototype.status === "archived")
    // Служебные виды живут только в своём табе; архив и «Все» показывают всю таксономию.
    .filter((prototype) => tab === "archive" || tab === "all" || isServicePrototypeKind(prototypeKindOf(prototype)) === (tab === "service"))
    .filter((prototype) => kind === null || prototypeKindOf(prototype) === kind)
    .filter((prototype) => systemId === null || prototype.designSystem === systemId)
    .filter((prototype) => !normalizedQuery || prototype.name.toLocaleLowerCase("ru").includes(normalizedQuery));
  return [...filtered].sort(sort === "name"
      ? (left, right) => left.name.localeCompare(right.name, "ru", { numeric: true, sensitivity: "base" })
      : (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.name.localeCompare(right.name, "ru", { numeric: true, sensitivity: "base" }));
}
