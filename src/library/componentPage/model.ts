import type { ComponentMeta, ComponentStatus, ComponentVersion, ComponentVersionSummary } from "../../api/client";
import type { PropsValidation } from "../../propsForm";

export const renderableStatuses = new Set<ComponentStatus>(["active", "deprecated", "superseded"]);

export type VersionQuery = { kind: "auto" } | { kind: "version"; version: number } | { kind: "invalid" };

export function parseVersionQuery(search: URLSearchParams): VersionQuery {
  const entries = [...search.entries()];
  if (entries.length === 0) return { kind: "auto" };
  if (entries.length !== 1 || entries[0]![0] !== "v") return { kind: "invalid" };
  const raw = entries[0]![1];
  if (!/^[1-9][0-9]*$/.test(raw)) return { kind: "invalid" };
  const version = Number(raw);
  return Number.isSafeInteger(version) ? { kind: "version", version } : { kind: "invalid" };
}

export function newestRenderableVersion(versions: readonly ComponentVersionSummary[]): number | null {
  return versions
    .filter((entry) => renderableStatuses.has(entry.status))
    .reduce<number | null>((latest, entry) => latest === null || entry.version > latest ? entry.version : latest, null);
}

export function resolveSelectedVersion(meta: ComponentMeta, query: VersionQuery): number | null {
  if (query.kind === "invalid") return null;
  if (query.kind === "version") return query.version;
  if (meta.publishedVersion != null) return meta.publishedVersion;
  return newestRenderableVersion(meta.versions);
}

export function statusForVersion(meta: ComponentMeta, version: number): ComponentVersionSummary | undefined {
  return meta.versions.find((entry) => entry.version === version);
}

export type PreviewTreeElement = {
  type: string;
  props: Record<string, unknown>;
  children?: string[];
  slot?: string;
};

export function buildPreviewSpec(name: string, props: Record<string, unknown>, version: ComponentVersion, placeholderName: string) {
  const elements: Record<string, PreviewTreeElement> = { component: { type: name, props } };
  const children: string[] = [];
  if (version.slots.length > 0) {
    children.push("placeholder-default");
    elements["placeholder-default"] = { type: placeholderName, props: { slot: "default" } };
    if (version.capabilities?.namedSlots) {
      for (const slot of [...new Set(version.slots)].filter((name) => name !== "default")) {
        const key = `placeholder-${children.length}`;
        children.push(key);
        elements[key] = { type: placeholderName, props: { slot }, slot };
      }
    }
  }
  if (children.length) elements.component.children = children;
  return { root: "component", elements };
}

export function initialCandidate(version: ComponentVersion): Record<string, unknown> {
  return version.example ?? {};
}

export function validationMessage(validation: PropsValidation): string | null {
  if (validation.ok) return null;
  return validation.form ?? (Object.values(validation.fields).join("; ") || null);
}
