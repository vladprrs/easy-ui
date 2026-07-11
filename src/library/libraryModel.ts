import type { AtomicLevel, CatalogComponent, DesignSystemSummary } from "../api/client";
import { parseStorybookTitle, type StorybookEntry } from "./storybookIndex";

export type LibrarySelection =
  | { kind: "story"; storyId: string }
  | { kind: "custom"; componentId: string; designSystem: string };

export interface LibrarySystemGroup {
  system: DesignSystemSummary;
  stories: StorybookEntry[];
  components: CatalogComponent[];
}

export const atomicLevelLabel = (level?: AtomicLevel) => level
  ? `${level[0].toUpperCase()}${level.slice(1)}s`
  : "Other";

export function groupLibraryEntries(
  systems: DesignSystemSummary[],
  stories: StorybookEntry[],
  components: CatalogComponent[],
): LibrarySystemGroup[] {
  const groups = systems.map((system) => ({ system, stories: [] as StorybookEntry[], components: [] as CatalogComponent[] }));
  const aliases = new Map(groups.flatMap((group) => [group.system.id, group.system.name]
    .map((value) => [value.toLocaleLowerCase(), group] as const)));
  for (const story of stories) aliases.get(parseStorybookTitle(story).system.toLocaleLowerCase())?.stories.push(story);
  const byId = new Map(groups.map((group) => [group.system.id, group]));
  for (const component of components) byId.get(component.designSystem)?.components.push(component);
  for (const group of groups) {
    group.stories.sort((a, b) => parseStorybookTitle(a).name.localeCompare(parseStorybookTitle(b).name));
    group.components.sort((a, b) => a.name.localeCompare(b.name));
  }
  return groups.sort((a, b) => a.system.name.localeCompare(b.system.name));
}

export const selectionForStory = (story: StorybookEntry): LibrarySelection => ({ kind: "story", storyId: story.id });
export const selectionForComponent = (component: CatalogComponent): LibrarySelection => ({
  kind: "custom", componentId: component.id, designSystem: component.designSystem,
});

export function selectionKey(selection: LibrarySelection): string {
  return selection.kind === "story" ? `story:${selection.storyId}` : `custom:${selection.componentId}:${selection.designSystem}`;
}
