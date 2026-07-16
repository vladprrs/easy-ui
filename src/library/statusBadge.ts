import type { ComponentStatus, PrototypeStatus } from "../api/client";
import { componentStatusLabels } from "../app/strings/library";

// Visual status badge for a custom component version (K.3). `active` (and lifecycle-internal
// staging/failed) render no badge; deprecated/superseded/rejected/archived show a coloured pill
// whose title carries the operator-supplied reason. Kept pure so it can be unit-tested in isolation.
export interface ComponentStatusBadge { label: string; className: string; title: string }

const BADGES: Partial<Record<ComponentStatus, { label: string; className: string }>> = {
  deprecated: { label: componentStatusLabels.deprecated, className: "bg-amber-100 text-amber-800" },
  superseded: { label: componentStatusLabels.superseded, className: "bg-sky-100 text-sky-800" },
  rejected: { label: componentStatusLabels.rejected, className: "bg-rose-100 text-rose-800" },
  archived: { label: componentStatusLabels.archived, className: "bg-eui-slate-200 text-eui-slate-600" },
};

export function componentStatusBadge(status: ComponentStatus, reason?: string | null): ComponentStatusBadge | null {
  const badge = BADGES[status];
  if (!badge) return null;
  return { label: badge.label, className: badge.className, title: reason?.trim() ? `${badge.label}: ${reason.trim()}` : badge.label };
}

const PROTOTYPE_BADGES: Record<PrototypeStatus, { label: string; className: string }> = {
  private: { label: "Личный", className: "bg-white text-eui-slate-600" },
  published: { label: "Общий", className: "bg-emerald-100 text-emerald-800" },
  archived: { label: "В архиве", className: "bg-eui-slate-200 text-eui-slate-600" },
};

export function prototypeStatusBadge(status: PrototypeStatus): ComponentStatusBadge {
  const badge = PROTOTYPE_BADGES[status];
  return { ...badge, title: badge.label };
}
