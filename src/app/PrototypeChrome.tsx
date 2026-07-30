import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { buildPrototypeRouteBase } from "../player/navigation";
import { segmentActive, segmentIdle, segmentTrack } from "./chrome";
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
  /** Явный экран плеера для возврата из CJM со scenario step. */
  playerPath?: string;
  /**
   * Слот статуса вью: dirty-индикатор, «Сохранено/Не сохранено» и т.п.
   * Рендерится рядом с сегментами, слева от actions.
   */
  status?: ReactNode;
  /** Слот действий вью: Назад/Начать сначала/Сохранить и т.п. (правый край). */
  actions?: ReactNode;
}

function Segment({ active, to, children }: { active: boolean; to: string; children: ReactNode }) {
  return <Link aria-current={active ? "page" : undefined} className={active ? segmentActive : segmentIdle} to={to}>{children}</Link>;
}

/**
 * Между вью прототипа переносится только явный allowlist параметров: сценарный
 * контекст (`flow`/`step`) и режим CJM (`view`). Последний — липкость режима
 * (план 2026-07-29 §7 T2b): без него уход из дорожек в плеер и обратно молча
 * возвращал бы пользователя в дефолтные «Сценарии».
 */
function transferScenarioQuery(path: string, search: string): string {
  const source = new URLSearchParams(search);
  const target = new URLSearchParams();
  const flow = source.get("flow");
  const step = source.get("step");
  const view = source.get("view");
  if (flow !== null) target.set("flow", flow);
  if (step !== null) target.set("step", step);
  if (view !== null) target.set("view", view);
  const query = target.toString();
  return query === "" ? path : `${path}?${query}`;
}

export function PrototypeChrome({ prototypeId, prototypeName, view, version, playerPath, status, actions }: PrototypeChromeProps) {
  const routeBase = buildPrototypeRouteBase(prototypeId, version);
  const location = useLocation();
  const playerTarget = transferScenarioQuery(playerPath ?? routeBase, location.search);
  const cjmTarget = transferScenarioQuery(`${routeBase}/cjm`, location.search);
  return <header className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-white px-5 py-3 font-pay-text sm:px-6">
    <nav aria-label={prototypeChrome.breadcrumbAria} className="flex min-w-0 items-center gap-2 text-sm">
      <Link className="shrink-0 text-eui-slate-500 transition-colors duration-100 hover:text-eui-ink" to="/">{prototypeChrome.gallery}</Link>
      <span aria-hidden="true" className="text-eui-slate-400">/</span>
      <h1 className="truncate text-base font-medium text-eui-ink">{prototypeName}</h1>
      {version === undefined ? null : <span className="shrink-0 rounded-full bg-pay-lavender px-2.5 py-0.5 text-xs font-medium text-eui-ink">{prototypeChrome.versionBadge(version)}</span>}
    </nav>
    <nav aria-label={prototypeChrome.viewsAria} className={segmentTrack}>
      <Segment active={view === "player"} to={playerTarget}>{prototypeChrome.player}</Segment>
      <Segment active={view === "cjm"} to={cjmTarget}>{prototypeChrome.cjm}</Segment>
      <Segment active={view === "editor"} to={`/p/${encodeURIComponent(prototypeId)}/edit`}>
        {prototypeChrome.editor}
        {version === undefined ? null : <span className="ml-1.5 rounded-full bg-pay-lavender px-1.5 py-px text-[10px] font-medium text-eui-ink">{prototypeChrome.draftBadge}</span>}
      </Segment>
    </nav>
    <div className="ml-auto flex flex-wrap items-center gap-3">
      {status === undefined || status === null ? null : <div data-testid="chrome-status" className="flex items-center gap-2">{status}</div>}
      {actions === undefined || actions === null ? null : <div data-testid="chrome-actions" className="flex items-center gap-2">{actions}</div>}
    </div>
  </header>;
}
