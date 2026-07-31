import { useId, useState, type ReactElement } from "react";
import { Link } from "react-router";
import type { LibraryCatalogEntry } from "../../api/client";
import { pillGhost } from "../../app/chrome";
import { levelSection, library } from "../../app/strings/library";
import { atomicLevelLabel } from "../libraryModel";
import { libraryEntryKey } from "../libraryTiers";
import { InlineComponentPreview } from "../preview/InlineComponentPreview";

export interface CompactIndexProps {
  entries: LibraryCatalogEntry[];
  label: string;
  systemNames: Map<string, string>;
  showSystem: boolean;
  previewsEnabled: boolean;
}

/**
 * Компактный индекс (план 2026-07-31 §4.5): ярусы, где превью почти ничего не объясняет
 * (атомы, лэйаут-обёртки, списанное), — это строки с именем и фактами, а не карточки с
 * живым рендером. Автозагрузки нет вовсе: превью раскрывается только по действию
 * пользователя и сразу с приоритетом 0 — очередь такого запроса короткая, и ждать он не должен.
 *
 * Раскрыта одновременно ровно одна строка: индекс — способ пробежать список глазами, а не
 * вторая витрина, и держать смонтированными десятки превью тут незачем.
 */
export function CompactIndex({ entries, label, systemNames, showSystem, previewsEnabled }: CompactIndexProps): ReactElement {
  const baseId = useId();
  const [expanded, setExpanded] = useState<string | null>(null);
  // Разделителей нет по правилам бренда (бордеров не бывает): строки разводит зазор канвы.
  return <ul className="flex flex-col gap-1.5" aria-label={label}>
    {entries.map((entry) => {
      const key = libraryEntryKey(entry);
      const previewId = `${baseId}-${key}`;
      const open = expanded === key;
      return <li key={key} className="rounded-panel bg-white">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3">
          <Link
            className="min-w-0 text-[15px] font-medium [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pay-red"
            to={`/library/c/${encodeURIComponent(entry.id)}?v=${entry.version}`}
          >{entry.name}</Link>
          <span className="flex flex-wrap items-center gap-2 text-xs text-eui-slate-500">
            <Badge>{library.cardVersion(entry.version)}</Badge>
            <Badge>{levelSection(atomicLevelLabel(entry.atomicLevel))}</Badge>
            {showSystem ? <Badge>{systemNames.get(entry.designSystem) ?? entry.designSystem}</Badge> : null}
            {entry.deprecated ? <Badge title={library.deprecatedBadgeTitle}>{library.deprecatedBadge}</Badge> : null}
            {entry.replacement ? <span title={library.deprecatedBadgeTitle}>{library.replacementLink(entry.replacement)}</span> : null}
          </span>
          {previewsEnabled ? <button
            type="button"
            className={`${pillGhost} ml-auto shrink-0`}
            aria-expanded={open}
            aria-controls={open ? previewId : undefined}
            onClick={() => setExpanded(open ? null : key)}
          >{library.compactShowPreview}</button> : null}
        </div>
        {open ? <div
          id={previewId}
          className="relative mx-5 mb-4 flex h-[170px] items-center justify-center overflow-hidden rounded-inset bg-pay-lavender-tint"
          aria-label={library.compactPreviewOf(entry.name)}
        >
          <InlineComponentPreview entry={entry} priority={0} />
        </div> : null}
      </li>;
    })}
  </ul>;
}

function Badge({ children, title }: { children: string; title?: string }): ReactElement {
  return <span className="inline-flex max-w-full rounded-full bg-pay-lavender px-2.5 py-1 font-medium text-eui-ink" title={title}>
    <span className="truncate">{children}</span>
  </span>;
}
