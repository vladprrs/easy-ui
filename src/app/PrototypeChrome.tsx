import type { ReactNode } from "react";
import { Link } from "react-router";
import { buildPrototypeRouteBase } from "../player/navigation";
import { prototypeChrome } from "./strings/common";

/** Вью прототипа, между которыми переключает сегмент-контрол хрома. */
export type PrototypeViewId = "player" | "cjm" | "editor";

/**
 * Slot-контракт единого хрома /p/* (план 2026-07-13, WF-4, «Сквозные решения» п.2).
 *
 * PrototypeChrome — единственный хедер на вью прототипа: крошка
 * «Галерея / {Имя}», сегмент «Плеер · CJM · Редактор» и два стабильных слота.
 * Вью (плеер/CJM/редактор) поставляют содержимое слотов через props и НЕ
 * добавляют собственных шапок: тело вью — только stage. Последующие задачи
 * (W1/W2/W3) наполняют слоты, не меняя сам PrototypeChrome.
 *
 * Version-route политика: на /p/:id/v/N сегменты «Плеер» и «CJM» сохраняют
 * /v/N в ссылках; «Редактор» всегда ведёт в draft-редактор (/p/:id/edit) и в
 * version-контексте получает явный бейдж «черновик» — тихая потеря
 * version-контекста запрещена. Бейдж vN хром рендерит сам по props.version.
 */
export interface PrototypeChromeProps {
  prototypeId: string;
  prototypeName: string;
  /** Активная вью — её сегмент получает aria-current="page". */
  view: PrototypeViewId;
  /** Опубликованная версия из /p/:id/v/N; undefined = draft-контекст. */
  version?: number | undefined;
  /**
   * Слот статуса вью: dirty-индикатор, «Сохранено/Не сохранено» и т.п.
   * Рендерится рядом с сегментами, слева от actions.
   */
  status?: ReactNode;
  /** Слот действий вью: Назад/Начать сначала/Сохранить и т.п. (правый край). */
  actions?: ReactNode;
}

const segmentBase = "inline-flex items-center rounded-full px-3 py-1 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-eui-brand";
const segmentActive = `${segmentBase} bg-white font-bold text-eui-ink shadow-sm`;
const segmentIdle = `${segmentBase} text-eui-slate-500 hover:text-eui-ink`;

function Segment({ active, to, children }: { active: boolean; to: string; children: ReactNode }) {
  return <Link aria-current={active ? "page" : undefined} className={active ? segmentActive : segmentIdle} to={to}>{children}</Link>;
}

export function PrototypeChrome({ prototypeId, prototypeName, view, version, status, actions }: PrototypeChromeProps) {
  const routeBase = buildPrototypeRouteBase(prototypeId, version);
  return <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-eui-ink/10 bg-white px-4 py-2 font-eui-ui sm:px-6">
    <nav aria-label={prototypeChrome.breadcrumbAria} className="flex min-w-0 items-center gap-2 text-sm">
      <Link className="shrink-0 text-eui-slate-500 hover:text-eui-brand" to="/">{prototypeChrome.gallery}</Link>
      <span aria-hidden="true" className="text-eui-slate-400">/</span>
      <h1 className="truncate font-eui-display text-base font-medium text-eui-ink">{prototypeName}</h1>
      {version === undefined ? null : <span className="shrink-0 rounded-full bg-eui-lilac-100 px-2.5 py-0.5 text-xs text-eui-slate-500">{prototypeChrome.versionBadge(version)}</span>}
    </nav>
    <nav aria-label={prototypeChrome.viewsAria} className="flex items-center gap-1 rounded-full bg-eui-lilac-100 p-1 text-sm">
      <Segment active={view === "player"} to={routeBase}>{prototypeChrome.player}</Segment>
      <Segment active={view === "cjm"} to={`${routeBase}/cjm`}>{prototypeChrome.cjm}</Segment>
      <Segment active={view === "editor"} to={`/p/${encodeURIComponent(prototypeId)}/edit`}>
        {prototypeChrome.editor}
        {version === undefined ? null : <span className="ml-1.5 rounded-full border border-eui-magenta/40 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-eui-magenta">{prototypeChrome.draftBadge}</span>}
      </Segment>
    </nav>
    <div className="ml-auto flex flex-wrap items-center gap-3">
      {status === undefined || status === null ? null : <div data-testid="chrome-status" className="flex items-center gap-2">{status}</div>}
      {actions === undefined || actions === null ? null : <div data-testid="chrome-actions" className="flex items-center gap-2">{actions}</div>}
    </div>
  </header>;
}
