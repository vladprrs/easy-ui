import type { ComponentStatus, LibraryCatalogStatus, PrototypeStatus } from "../api/client";
import { componentStatusLabels, library } from "../app/strings/library";

// Visual status badge for a custom component version (K.3). `active` (and lifecycle-internal
// staging/failed) render no badge; deprecated/superseded/rejected/archived show a coloured pill
// whose title carries the operator-supplied reason. Kept pure so it can be unit-tested in isolation.
export interface ComponentStatusBadge { label: string; className: string; title: string }

const BADGES: Partial<Record<ComponentStatus, { label: string; className: string }>> = {
  deprecated: { label: componentStatusLabels.deprecated, className: "bg-pay-lavender text-eui-ink" },
  superseded: { label: componentStatusLabels.superseded, className: "bg-pay-lavender-tint text-eui-slate-700" },
  rejected: { label: componentStatusLabels.rejected, className: "bg-pay-red text-white" },
  archived: { label: componentStatusLabels.archived, className: "bg-pay-lavender-tint text-eui-slate-500" },
};

export function componentStatusBadge(status: ComponentStatus, reason?: string | null): ComponentStatusBadge | null {
  const badge = BADGES[status];
  if (!badge) return null;
  return { label: badge.label, className: badge.className, title: reason?.trim() ? `${badge.label}: ${reason.trim()}` : badge.label };
}

/**
 * Бейдж приёмки (RFC candidate-acceptance §7, волна R3c). Отдельный от жизненного цикла версии
 * (`componentStatusBadge`) и от визуального `verified`: он говорит ровно одно — «у активной версии
 * есть acceptance-evidence». Отсутствие признака бейджа не рисует: пока promote с кандидатом не
 * вошёл в практику, признак пуст у всего каталога, и «не принят» на каждой карточке был бы шумом.
 */
export function acceptanceBadge(status: Pick<LibraryCatalogStatus, "accepted">): ComponentStatusBadge | null {
  if (!status.accepted) return null;
  return { label: library.acceptedBadge, className: "bg-pay-valid text-white", title: library.acceptedBadgeTitle };
}

const PROTOTYPE_BADGES: Record<PrototypeStatus, { label: string; className: string }> = {
  private: { label: "Личный", className: "bg-white text-eui-slate-500" },
  published: { label: "Общий", className: "bg-pay-deep text-white" },
  archived: { label: "В архиве", className: "bg-pay-lavender-tint text-eui-slate-500" },
};

export function prototypeStatusBadge(status: PrototypeStatus): ComponentStatusBadge {
  const badge = PROTOTYPE_BADGES[status];
  return { ...badge, title: badge.label };
}
