import type { PrototypeSummary } from "../api/client";

export type GallerySort = "updated" | "name";
export type GalleryTab = "mine" | "shared" | "archive";

export interface GalleryFilters {
  tab: GalleryTab;
  userId: string;
  systemId: string | null;
  query: string;
  sort: GallerySort;
}

export function filterAndSortPrototypes(prototypes: PrototypeSummary[], filters: GalleryFilters): PrototypeSummary[] {
  const { tab, userId, systemId, query, sort } = filters;
  const normalizedQuery = query.trim().toLocaleLowerCase("ru");
  const filtered = prototypes
    .filter((prototype) => tab === "mine"
      ? prototype.owner.id === userId && prototype.status !== "archived"
      : tab === "shared"
        ? prototype.status === "published"
        : prototype.owner.id === userId && prototype.status === "archived")
    .filter((prototype) => systemId === null || prototype.designSystem === systemId)
    .filter((prototype) => !normalizedQuery || prototype.name.toLocaleLowerCase("ru").includes(normalizedQuery));
  return [...filtered].sort(sort === "name"
      ? (left, right) => left.name.localeCompare(right.name, "ru", { numeric: true, sensitivity: "base" })
      : (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.name.localeCompare(right.name, "ru", { numeric: true, sensitivity: "base" }));
}
