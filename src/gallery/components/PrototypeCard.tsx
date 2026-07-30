import type { ReactElement } from "react";
import { Link } from "react-router";
import { prototypeKindOf, type PrototypeStatus, type PrototypeSummary } from "../../api/client";
import { pillGhost } from "../../app/chrome";
import { deviceNames, gallery } from "../../app/strings/gallery";
import { loader } from "../../app/strings/player";
import { prototypeStatusBadge } from "../../library/statusBadge";
import { formatGalleryUpdatedAt } from "../galleryFormat";
import { GalleryPreview } from "../GalleryPreview";
import { CardActionsMenu } from "./CardActionsMenu";
import { VersionsMenu } from "./VersionsMenu";

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

function PrototypeStatusBadge({ status }: { status: PrototypeStatus }): ReactElement {
  const badge = prototypeStatusBadge(status);
  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${badge.className}`} title={badge.title}>{badge.label}</span>;
}

/** Мета-факт карточки: 13px приглушённым, без собственного фона. */
function Meta({ label, children }: { label: string; children: ReactElement | string }) {
  return <div className="flex min-w-0 items-center">
    <dt className="sr-only">{label}</dt>
    <dd className="max-w-full truncate">{children}</dd>
  </div>;
}

export function PrototypeCard({ prototype, isOwner, systemName, previewsEnabled, index, onShare, onChanged }: PrototypeCardProps): ReactElement {
  const { latestVersion } = prototype;
  const kind = prototypeKindOf(prototype);
  const previewTint = index % 2 === 0 ? "bg-pay-lavender" : "bg-pay-lavender-light";
  return <li className="group relative flex min-w-0 flex-col rounded-panel bg-white focus-within:z-20">
    <div className={`relative flex h-[196px] items-end overflow-hidden rounded-t-panel px-4 pt-4 ${previewTint}`}>
      {prototype.status === "archived"
        ? <section className="mb-4 w-full rounded-inset bg-white/70 p-5 text-center" data-prototype-archived="true" role="status">
            <h3 className="text-base font-medium">{loader.archivedTitle}</h3>
            <p className="mt-2 text-[13px] text-eui-slate-500">{loader.archivedBody}</p>
          </section>
        : previewsEnabled ? <GalleryPreview prototypeId={prototype.id} wrapperClassName="w-full" /> : null}
      <div className="absolute left-4 top-4 z-10 flex flex-wrap gap-2">
        <PrototypeStatusBadge status={prototype.status} />
        {!isOwner ? <span className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-eui-ink">{gallery.ownerBadge(prototype.owner.name)}</span> : null}
      </div>
    </div>
    <div className="flex min-w-0 flex-1 flex-col p-5">
      <h2 className="min-w-0 text-[18px] font-medium [overflow-wrap:anywhere]">
        <Link
          className="after:absolute after:inset-0 after:rounded-panel after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-pay-red"
          to={`/p/${prototype.id}`}
        >{prototype.name}</Link>
      </h2>
      <p className="mt-1.5 min-h-10 text-[13px] text-eui-slate-500 line-clamp-2 [overflow-wrap:anywhere]">{prototype.description ?? gallery.noDescription}</p>
      <dl className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-eui-slate-500">
        <Meta label={gallery.screensLabel}>{String(prototype.screenCount)}</Meta>
        <span aria-hidden="true">·</span>
        <Meta label={gallery.deviceLabel}>{deviceNames[prototype.device]}</Meta>
        <span aria-hidden="true">·</span>
        <Meta label={gallery.updatedLabel}><time dateTime={prototype.updatedAt}>{formatGalleryUpdatedAt(prototype.updatedAt)}</time></Meta>
        {kind === "product-flow" ? null : <>
          <span aria-hidden="true">·</span>
          <div className="flex min-w-0 items-center" data-prototype-kind={kind}>
            <dt className="sr-only">{gallery.kindLabel}</dt>
            <dd className="max-w-full truncate">{gallery.kindNames[kind] ?? kind}</dd>
          </div>
        </>}
        {prototype.tags?.length ? <>
          <span aria-hidden="true">·</span>
          <Meta label={gallery.tagsLabel}>{prototype.tags.join(", ")}</Meta>
        </> : null}
      </dl>
      <dl className="mt-3">
        <dt className="sr-only">{gallery.systemLabel}</dt>
        <dd className="inline-flex max-w-full rounded-full bg-pay-lavender px-2.5 py-1 text-xs font-medium text-eui-ink">
          <span className="truncate">{systemName}</span>
        </dd>
      </dl>
      {prototype.derivedFrom ? <p className="mt-2 min-w-0 text-xs text-eui-slate-500 [overflow-wrap:anywhere]">{gallery.derivedFrom(prototype.derivedFrom)}</p> : null}
      <div className="relative z-10 mt-auto flex flex-wrap items-center gap-2 pt-4 text-[13px]">
        <Link className={`${pillGhost} px-3 py-1.5 text-[13px]`} to={`/p/${prototype.id}/present`}>{gallery.presentLink}</Link>
        <Link className={`${pillGhost} px-3 py-1.5 text-[13px]`} to={`/p/${prototype.id}/cjm`}>CJM</Link>
        {isOwner ? <Link className={`${pillGhost} px-3 py-1.5 text-[13px]`} to={`/p/${prototype.id}/edit`}>{gallery.editorLink}</Link> : null}
        {isOwner && latestVersion !== null ? <button type="button" className={`${pillGhost} px-3 py-1.5 text-[13px]`} title={gallery.qrOnPhone} aria-label={gallery.qrOnPhone} onClick={() => onShare(prototype.id, latestVersion)}>{gallery.qrOnPhone}</button> : null}
        {latestVersion !== null || isOwner ? <VersionsMenu prototype={prototype} isOwner={isOwner} /> : null}
        {isOwner || latestVersion !== null ? <CardActionsMenu prototype={prototype} isOwner={isOwner} onChanged={onChanged} /> : null}
      </div>
    </div>
  </li>;
}
