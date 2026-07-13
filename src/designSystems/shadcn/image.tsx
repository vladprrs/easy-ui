import { useState } from "react";
import type { BaseComponentProps } from "@json-render/react";
import type { ShadcnProps } from "@json-render/shadcn";

type ImageProps = ShadcnProps<"Image">;

function ImagePlaceholder({ alt, width, height }: { alt: string; width: number | null; height: number | null }) {
  return (
    <div
      role="img"
      aria-label={alt || undefined}
      data-testid="image-placeholder"
      className="bg-muted border border-border rounded flex flex-col items-center justify-center gap-1 overflow-hidden p-2 text-center text-xs text-muted-foreground"
      style={{ width: width ?? 80, height: height ?? 60 }}
    >
      <svg
        aria-hidden="true"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="m21 15-4.5-4.5L7 20" />
      </svg>
      {alt ? <span className="max-w-full truncate">{alt}</span> : null}
    </div>
  );
}

/**
 * Local wrapper over `@json-render/shadcn` Image (W0-2).
 *
 * The upstream component renders a plain `<img>` whenever `src` is truthy, so a
 * broken URL, a wrong MIME type or a missing `$asset` (404 from `/api/assets/...`)
 * shows the browser's broken-image glyph. This wrapper keeps the upstream pixel
 * semantics for valid images (same `<img>` markup and className) and swaps in a
 * grey placeholder with an icon and the alt text only when the image fails to
 * load or no source is provided.
 */
export function ShadcnImage({ props }: BaseComponentProps<ImageProps>) {
  const src = typeof props.src === "string" && props.src.trim() !== "" ? props.src : null;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const alt = props.alt ?? "";

  // Comparing against the failed src (instead of a boolean) auto-resets the
  // error state when the src prop changes to a new value.
  if (src !== null && failedSrc !== src) {
    return (
      <img
        src={src}
        alt={alt}
        width={props.width ?? undefined}
        height={props.height ?? undefined}
        className="rounded max-w-full"
        onError={() => setFailedSrc(src)}
      />
    );
  }

  return <ImagePlaceholder alt={alt} width={props.width ?? null} height={props.height ?? null} />;
}
