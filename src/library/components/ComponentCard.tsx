import type { ReactElement } from "react";
import { Link } from "react-router";
import type { CatalogComponent, FigmaProvenance } from "../../api/client";
import { figmaBadgeTitle, levelSection, library } from "../../app/strings/library";
import { atomicLevelLabel, type ComponentLibraryStatus } from "../libraryModel";
import { ComponentPreview, ComponentPreviewMissing } from "./ComponentPreview";

export interface ComponentCardProps {
  component: CatalogComponent;
  /** Имя дизайн-системы; показывается, когда в гриде смешаны системы. */
  systemName: string;
  showSystem: boolean;
  /** Статус и Figma подгружаются лениво: пока их нет, строка статуса не рисуется. */
  status: ComponentLibraryStatus | null;
  figma: FigmaProvenance | null;
}

/** Лавандовый чип-факт: версия, уровень, система. */
function Fact({ children, title }: { children: string; title?: string }): ReactElement {
  return <span className="inline-flex max-w-full rounded-full bg-pay-lavender px-2.5 py-1 text-xs font-medium text-eui-ink" title={title}>
    <span className="truncate">{children}</span>
  </span>;
}

/**
 * Карточка компонента (макет 06): превью-зона 170px с живым рендером,
 * ниже — имя, назначение и ровно те факты, по которым компонент выбирают.
 * Вся карточка — одна ссылка на страницу компонента (stretched link), поэтому
 * внутри нет конкурирующих кнопок.
 */
export function ComponentCard({ component, systemName, showSystem, status, figma }: ComponentCardProps): ReactElement {
  const example = component.example ? null : Object.keys(component.examples ?? {}).sort()[0] ?? undefined;
  const usageCount = component.headUsageCount ?? 0;
  return <li className="group relative flex min-w-0 flex-col rounded-panel bg-white focus-within:z-20">
    <div className="relative flex h-[170px] items-center justify-center overflow-hidden rounded-t-panel bg-pay-lavender-tint">
      {example === undefined
        ? <ComponentPreviewMissing />
        : <ComponentPreview componentId={component.id} componentName={component.name} version={component.version} example={example} />}
      <div className="absolute left-4 top-4 z-10 flex flex-wrap gap-2">
        {component.canonicalFor?.length
          ? <span className="rounded-full bg-pay-red px-2.5 py-1 text-xs font-medium text-white" title={library.canonicalBadgeTitle(component.canonicalFor)}>{library.canonicalBadge}</span>
          : null}
        {component.deprecated
          ? <span className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-pay-red" title={library.deprecatedBadgeTitle}>{library.deprecatedBadge}</span>
          : null}
        {figma ? <span className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-eui-ink" title={figmaBadgeTitle(figma.fileKey, figma.nodeIds.length)}>Figma</span> : null}
      </div>
    </div>
    <div className="flex min-w-0 flex-1 flex-col p-5">
      <h3 className="min-w-0 text-[16px] font-medium [overflow-wrap:anywhere]">
        <Link
          className="after:absolute after:inset-0 after:rounded-panel after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-pay-red"
          to={`/library/c/${encodeURIComponent(component.id)}?v=${component.version}`}
        >{component.name}</Link>
      </h3>
      <p className="mt-1.5 min-h-10 text-[13px] text-eui-slate-500 line-clamp-2 [overflow-wrap:anywhere]">
        {component.description || library.noDescription}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Fact>{library.cardVersion(component.version)}</Fact>
        <Fact>{levelSection(atomicLevelLabel(component.atomicLevel))}</Fact>
        {showSystem ? <Fact>{systemName}</Fact> : null}
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 pt-4 text-[13px] text-eui-slate-500">
        {status ? <span className="flex items-center gap-1.5" title={status.published ? library.statusTitleReady : library.statusTitleDraft}>
          <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${status.published ? "bg-pay-valid" : "bg-pay-lavender-light"}`} />
          {status.published ? library.statusReady : library.statusDraft}
        </span> : null}
        {status ? <span aria-hidden="true">·</span> : null}
        <span>{library.cardUsage(usageCount)}</span>
        {component.replacement ? <>
          <span aria-hidden="true">·</span>
          <span title={library.deprecatedBadgeTitle}>{library.replacementLink(component.replacement)}</span>
        </> : null}
      </div>
    </div>
  </li>;
}
