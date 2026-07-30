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
 * «Галерея / {Имя} / {Сценарий}», сегмент «Плеер · Сценарии · Редактор» и два
 * стабильных слота. Вью (плеер/разбор/редактор) поставляют содержимое слотов
 * через props и НЕ добавляют собственных шапок: тело вью — только stage.
 *
 * Сегмент называет *место*, а не режим: переключатель «Сценарии/Дорожки» живёт
 * в канве самого разбора (план 2026-07-31, S1). Хром рендерится ещё из плеера и
 * редактора, где `layout`/`doc.flows` неизвестны, поэтому режимного сегмента
 * здесь быть не может — иначе на линейном документе он был бы мёртвым.
 *
 * Version-route политика: на /p/:id/v/N сегменты «Плеер» и «Сценарии» сохраняют
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
  /** Явный экран плеера для возврата из разбора со scenario step. */
  playerPath?: string;
  /**
   * Имя активного сценария — третий уровень крошки. Передаёт только вью разбора:
   * в плеере сценарный контекст показывает своя полоса, и проп не приходит.
   */
  scenarioName?: string;
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
 * контекст (`flow`/`step`) и режим разбора (`view`).
 *
 * Политика `view` задаётся явно (план 2026-07-31, W1-3): сегменты хрома — это
 * смена *места*, поэтому режим они **сохраняют** (`keep`) — липкость режима из
 * плана 2026-07-29 §7 T2b: без неё уход из дорожек в плеер и обратно молча
 * возвращал бы пользователя в дефолтные «Сценарии». Ставит и снимает `view`
 * только сам переключатель режима в канве разбора; `drop` оставлен для ссылок,
 * которым режим противопоказан.
 */
function transferScenarioQuery(path: string, search: string, view: "keep" | "drop"): string {
  const source = new URLSearchParams(search);
  const target = new URLSearchParams();
  const flow = source.get("flow");
  const step = source.get("step");
  const mode = source.get("view");
  if (flow !== null) target.set("flow", flow);
  if (step !== null) target.set("step", step);
  if (view === "keep" && mode !== null) target.set("view", mode);
  const query = target.toString();
  return query === "" ? path : `${path}?${query}`;
}

export function PrototypeChrome({ prototypeId, prototypeName, view, version, playerPath, scenarioName, status, actions }: PrototypeChromeProps) {
  const routeBase = buildPrototypeRouteBase(prototypeId, version);
  const location = useLocation();
  const playerTarget = transferScenarioQuery(playerPath ?? routeBase, location.search, "keep");
  const cjmTarget = transferScenarioQuery(`${routeBase}/cjm`, location.search, "keep");
  // Редактор всегда draft-маршрут (version-политика), но сценарный контекст и режим
  // переносит наравне с остальными сегментами — иначе возврат из редактора терял бы шаг.
  const editorTarget = transferScenarioQuery(`/p/${encodeURIComponent(prototypeId)}/edit`, location.search, "keep");
  return <header className="flex flex-wrap items-center gap-5 bg-white px-5 py-3 font-pay-text">
    <nav aria-label={prototypeChrome.breadcrumbAria} className="flex min-w-0 items-center gap-2 text-sm">
      <Link className="shrink-0 text-eui-slate-500 transition-colors duration-100 hover:text-eui-ink" to="/">{prototypeChrome.gallery}</Link>
      <span aria-hidden="true" className="text-eui-slate-400">/</span>
      <h1 className="truncate text-base font-medium text-eui-ink">{prototypeName}</h1>
      {scenarioName === undefined ? null : <>
        <span aria-hidden="true" className="text-eui-slate-400">/</span>
        <span className="truncate text-eui-slate-500">{scenarioName}</span>
      </>}
      {version === undefined ? null : <span className="shrink-0 rounded-full bg-pay-lavender px-2.5 py-0.5 text-xs font-medium text-eui-ink">{prototypeChrome.versionBadge(version)}</span>}
    </nav>
    <nav aria-label={prototypeChrome.viewsAria} className={segmentTrack}>
      <Segment active={view === "player"} to={playerTarget}>{prototypeChrome.player}</Segment>
      <Segment active={view === "cjm"} to={cjmTarget}>{prototypeChrome.cjm}</Segment>
      <Segment active={view === "editor"} to={editorTarget}>
        {prototypeChrome.editor}
        {version === undefined ? null : <span className="ml-1.5 rounded-full bg-pay-lavender px-1.5 py-px text-[10px] font-medium text-eui-ink">{prototypeChrome.draftBadge}</span>}
      </Segment>
    </nav>
    <div className="ml-auto flex flex-wrap items-center gap-5">
      {/* Внутри группы кнопки стоят плотно (8): 20 — это gap между панелями и группами, а не между соседними пилюлями. */}
      {status === undefined || status === null ? null : <div data-testid="chrome-status" className="flex items-center gap-2">{status}</div>}
      {actions === undefined || actions === null ? null : <div data-testid="chrome-actions" className="flex items-center gap-2">{actions}</div>}
    </div>
  </header>;
}
