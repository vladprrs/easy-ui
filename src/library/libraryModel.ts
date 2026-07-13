import type { AtomicLevel, CatalogComponent, ComponentVersionSummary, DesignSystemSummary, VisualReference } from "../api/client";
import { libraryStatusLabels } from "../app/strings/library";
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

// --- Library status filters (plan §H.2) ---
//
// A custom component maps to a boolean status vector derived from its version history and its
// latest passing visual run. The mapping is intentionally fixed and documented so the filter
// chips are unambiguous:
//   published     = the component has at least one active version.
//   rejected      = its latest (highest-numbered) version is rejected.
//   blocked       = its latest version is deprecated | superseded | archived.
//   verified      = published AND the active version has a passing last visual run for its
//                   component reference (fingerprint {scope:"component", componentId, refVersion}).
//   visualPending = published AND not verified.
// Note that rejected/blocked describe the *latest* version even when an older active version keeps
// the component present in the manifest, so a manifest entry can still read as blocked/rejected.
export const LIBRARY_STATUS_KEYS = ["published", "verified", "visual-pending", "blocked", "rejected"] as const;
export type LibraryStatusKey = (typeof LIBRARY_STATUS_KEYS)[number];
export const libraryStatusLabel: Record<LibraryStatusKey, string> = libraryStatusLabels;

export interface ComponentLibraryStatus { published: boolean; rejected: boolean; blocked: boolean; verified: boolean; visualPending: boolean }

const BLOCKED_STATUSES = new Set(["deprecated", "superseded", "archived"]);

export function componentLibraryStatus(
  componentId: string,
  activeVersion: number,
  versions: ComponentVersionSummary[],
  references: VisualReference[],
): ComponentLibraryStatus {
  const published = versions.some((version) => version.status === "active");
  const latest = versions.reduce<ComponentVersionSummary | null>((max, version) => (!max || version.version > max.version ? version : max), null);
  const rejected = latest?.status === "rejected";
  const blocked = latest !== null && BLOCKED_STATUSES.has(latest.status);
  const verified = published && references.some((reference) =>
    reference.fingerprint.scope === "component"
    && (reference.fingerprint as { componentId?: string }).componentId === componentId
    && (reference.fingerprint as { refVersion?: number }).refVersion === activeVersion
    && reference.lastRun?.status === "pass");
  return { published, rejected, blocked, verified, visualPending: published && !verified };
}

export function matchesLibraryFilter(status: ComponentLibraryStatus, filter: LibraryStatusKey): boolean {
  switch (filter) {
    case "published": return status.published;
    case "verified": return status.verified;
    case "visual-pending": return status.visualPending;
    case "blocked": return status.blocked;
    case "rejected": return status.rejected;
  }
}
