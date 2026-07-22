import type { ReactElement } from "react";
import { Link } from "react-router";
import type { PrototypeStatus, PrototypeSummary } from "../../api/client";
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
  onShare: (prototypeId: string, latestVersion: number) => void;
  onChanged: () => void;
}

function PrototypeStatusBadge({ status }: { status: PrototypeStatus }): ReactElement {
  const badge = prototypeStatusBadge(status);
  return <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${badge.className}`} title={badge.title}>{badge.label}</span>;
}

export function PrototypeCard({ prototype, isOwner, systemName, previewsEnabled, onShare, onChanged }: PrototypeCardProps): ReactElement {
  const { latestVersion } = prototype;
  return <li className="group relative flex min-w-0 flex-col rounded-3xl bg-white ring-1 ring-eui-ink/5 transition hover:-translate-y-0.5 hover:shadow-xl focus-within:z-20 focus-within:shadow-xl motion-reduce:transform-none">
    <div className="relative overflow-hidden rounded-t-3xl bg-eui-lav p-4">
      {prototype.status === "archived"
        ? <section className="rounded-2xl bg-eui-lilac-100 p-5 text-center" data-prototype-archived="true" role="status">
            <h3 className="font-eui-display text-lg font-bold">{loader.archivedTitle}</h3>
            <p className="mt-2 text-sm text-eui-slate-500">{loader.archivedBody}</p>
          </section>
        : previewsEnabled ? <GalleryPreview prototypeId={prototype.id} wrapperClassName="" /> : null}
      <div className="absolute left-4 top-4 z-10 flex flex-wrap gap-2">
        <PrototypeStatusBadge status={prototype.status} />
        {!isOwner ? <span className="rounded-full bg-white px-2.5 py-1 text-xs font-bold text-eui-ink">{gallery.ownerBadge(prototype.owner.name)}</span> : null}
      </div>
    </div>
    <div className="flex min-w-0 flex-1 flex-col p-5">
      <h2 className="min-w-0 font-eui-display text-lg font-medium [overflow-wrap:anywhere]">
        <Link
          className="after:absolute after:inset-0 after:rounded-3xl after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-eui-brand"
          to={`/p/${prototype.id}`}
        >{prototype.name}</Link>
      </h2>
      <p className="mt-2 min-h-10 text-sm text-eui-slate-500 line-clamp-2 [overflow-wrap:anywhere]">{prototype.description ?? gallery.noDescription}</p>
      <dl className="mt-4 flex flex-wrap gap-1.5 text-xs">
        <div className="inline-flex items-center gap-1 rounded-full bg-eui-lav px-2.5 py-1">
          <dt className="sr-only">{gallery.deviceLabel}</dt>
          <dd>{deviceNames[prototype.device]}</dd>
        </div>
        <div className="inline-flex items-center gap-1 rounded-full bg-eui-lav px-2.5 py-1">
          <dt className="sr-only">{gallery.screensLabel}</dt>
          <dd>{prototype.screenCount}</dd>
        </div>
        <div className="inline-flex min-w-0 items-center gap-1 rounded-full bg-eui-lilac-200 px-2.5 py-1">
          <dt className="sr-only">{gallery.systemLabel}</dt>
          <dd className="max-w-full break-all">{systemName}</dd>
        </div>
        <div className="inline-flex items-center gap-1 rounded-full bg-eui-lav px-2.5 py-1">
          <dt className="sr-only">{gallery.updatedLabel}</dt>
          <dd><time dateTime={prototype.updatedAt}>{formatGalleryUpdatedAt(prototype.updatedAt)}</time></dd>
        </div>
      </dl>
      <div className="relative z-10 mt-auto flex flex-wrap items-center gap-2 pt-4">
        <Link className={`${pillGhost} bg-white ring-1 ring-eui-brand/30 text-eui-brand`} to={`/p/${prototype.id}/present`}>{gallery.presentLink}</Link>
        <Link className={pillGhost} to={`/p/${prototype.id}/cjm`}>CJM</Link>
        {isOwner ? <Link className={pillGhost} to={`/p/${prototype.id}/edit`}>{gallery.editorLink}</Link> : null}
        {isOwner && latestVersion !== null ? <button type="button" className={pillGhost} title={gallery.qrOnPhone} aria-label={gallery.qrOnPhone} onClick={() => onShare(prototype.id, latestVersion)}>{gallery.qrOnPhone}</button> : null}
        {latestVersion !== null || isOwner ? <VersionsMenu prototype={prototype} isOwner={isOwner} /> : null}
        {isOwner || latestVersion !== null ? <CardActionsMenu prototype={prototype} isOwner={isOwner} onChanged={onChanged} /> : null}
      </div>
    </div>
  </li>;
}
