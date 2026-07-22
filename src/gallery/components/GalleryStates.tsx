import type { ReactElement } from "react";
import { Link } from "react-router";
import { pillGhost, pillPrimary, plate } from "../../app/chrome";
import { common } from "../../app/strings/common";
import { gallery } from "../../app/strings/gallery";

export function GallerySkeletons(): ReactElement {
  return (
    <div className="mt-8" aria-live="polite">
      <p className="sr-only">{gallery.loading}</p>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <div
            key={index}
            className="h-72 rounded-3xl bg-eui-lav animate-pulse motion-reduce:animate-none"
          />
        ))}
      </div>
    </div>
  );
}

export function GalleryFailed({ onRetry }: { onRetry: () => void }): ReactElement {
  return (
    <div className={`${plate} mt-8 text-eui-magenta`} role="alert">
      <p>{gallery.apiUnavailable}</p>
      <button type="button" className={`${pillGhost} mt-3`} onClick={onRetry}>
        {common.retry}
      </button>
    </div>
  );
}

export function NoUsableSystems(): ReactElement {
  return (
    <section className={`${plate} mt-8`}>
      <h2 className="font-eui-display text-xl font-medium">{gallery.noUsableSystemsTitle}</h2>
      <p className="mt-2 text-eui-slate-500">{gallery.noUsableSystemsBody}</p>
      <Link className={`${pillPrimary} mt-5`} to="/library">
        {gallery.createDesignSystem}
      </Link>
    </section>
  );
}

export function GalleryEmpty(props: {
  variant: "search" | "filtered" | "none";
  canCreate: boolean;
  onCreate: () => void;
}): ReactElement {
  const { variant, canCreate, onCreate } = props;
  if (variant === "search") {
    return <p className={`${plate} mt-8 text-eui-slate-500`}>{gallery.emptySearch}</p>;
  }
  if (variant === "filtered") {
    return <p className={`${plate} mt-8 text-eui-slate-500`}>{gallery.emptyFiltered}</p>;
  }
  return (
    <section className={`${plate} mt-8`}>
      <h2 className="font-eui-display text-xl font-medium">{gallery.emptyTitle}</h2>
      <p className="mt-2 text-eui-slate-500">{gallery.empty}</p>
      {canCreate ? (
        <button type="button" className={`${pillPrimary} mt-5`} onClick={onCreate}>
          {gallery.newPrototype}
        </button>
      ) : null}
    </section>
  );
}
