import type { ReactElement } from "react";
import { Link } from "react-router";
import { prototypeKindOf, type PrototypeSummary } from "../../api/client";
import { gallery } from "../../app/strings/gallery";
import { loader } from "../../app/strings/player";
import { prototypeStatusBadge } from "../../library/statusBadge";
import { formatGalleryUpdatedAt } from "../galleryFormat";
import { GalleryPreview } from "../GalleryPreview";
import { CardActionsMenu } from "./CardActionsMenu";

export interface PrototypeCardProps {
  prototype: PrototypeSummary;
  isOwner: boolean;
  /** Уже разрешённое имя ДС (или legacy-текст) — резолвит контейнер. */
  systemName: string;
  previewsEnabled: boolean;
  /** Позиция в гриде: превью-зоны чередуют два лавандовых тона (макет 01). */
  index: number;
  onShare: (prototypeId: string, latestVersion: number) => void;
  onChanged: () => void;
}

/** Лавандовый чип-факт: система, вид, владелец. */
function Fact({ children, title }: { children: string; title?: string }): ReactElement {
  return <span className="inline-flex max-w-full rounded-full bg-pay-lavender px-2.5 py-1 text-xs font-medium text-eui-ink" title={title}>
    <span className="truncate">{children}</span>
  </span>;
}

/**
 * Карточка прототипа (макет 01): превью-зона 196px, имя, одна мета-строка и «⋯».
 *
 * Мета отвечает ровно на вопрос «что это»: сколько экранов, сколько сценариев и
 * когда обновляли. Устройство, теги и происхождение с карточки убраны — они не
 * помогают выбрать прототип в гриде и видны на его странице. Действий на карточке
 * нет вовсе: клик по карточке открывает плеер, всё остальное — в «⋯».
 */
export function PrototypeCard({ prototype, isOwner, systemName, previewsEnabled, index, onShare, onChanged }: PrototypeCardProps): ReactElement {
  const kind = prototypeKindOf(prototype);
  const previewTint = index % 2 === 0 ? "bg-pay-lavender" : "bg-pay-lavender-light";
  // `private` — состояние по умолчанию: чип на каждой карточке был шумом, его нет.
  const badge = prototype.status === "private" ? null : prototypeStatusBadge(prototype.status);
  return <li className="group relative flex min-w-0 flex-col rounded-panel bg-white focus-within:z-20">
    <div className={`relative flex h-[196px] items-end overflow-hidden rounded-t-panel px-4 pt-4 ${previewTint}`}>
      {prototype.status === "archived"
        ? <section className="mb-4 w-full rounded-inset bg-white/70 p-5 text-center" data-prototype-archived="true" role="status">
            <h3 className="text-base font-medium">{loader.archivedTitle}</h3>
            <p className="mt-2 text-[13px] text-eui-slate-500">{loader.archivedBody}</p>
          </section>
        : previewsEnabled ? <GalleryPreview prototypeId={prototype.id} wrapperClassName="w-full" /> : null}
      {badge ? <span className={`absolute left-4 top-4 z-10 rounded-full px-2.5 py-1 text-xs font-medium ${badge.className}`} title={badge.title}>{badge.label}</span> : null}
    </div>
    <div className="flex min-w-0 flex-1 flex-col p-5">
      <div className="flex min-w-0 items-start gap-3">
        <h2 className="min-w-0 flex-1 text-[18px] font-medium [overflow-wrap:anywhere]">
          <Link
            className="after:absolute after:inset-0 after:rounded-panel after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-pay-red"
            to={`/p/${prototype.id}`}
          >{prototype.name}</Link>
        </h2>
        <div className="relative z-10 shrink-0">
          <CardActionsMenu prototype={prototype} isOwner={isOwner} onShare={onShare} onChanged={onChanged} />
        </div>
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-[13px] text-eui-slate-500">
        <span>{gallery.cardScreens(prototype.screenCount)}</span>
        <span aria-hidden="true">·</span>
        <span>{gallery.cardFlows(prototype.flowCount ?? 0)}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={prototype.updatedAt}>{gallery.cardUpdated(formatGalleryUpdatedAt(prototype.updatedAt))}</time>
      </p>
      {prototype.description ? <p className="mt-2 min-w-0 text-[13px] text-eui-slate-500 line-clamp-2 [overflow-wrap:anywhere]">{prototype.description}</p> : null}
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
        <Fact title={gallery.systemLabel}>{systemName}</Fact>
        {kind === "product-flow" ? null : <span data-prototype-kind={kind}><Fact title={gallery.kindLabel}>{gallery.kindNames[kind] ?? kind}</Fact></span>}
        {isOwner ? null : <Fact>{gallery.ownerBadge(prototype.owner.name)}</Fact>}
      </div>
    </div>
  </li>;
}
