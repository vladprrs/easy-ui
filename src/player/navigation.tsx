import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { pillGhost } from "../app/chrome";
import { loader, player } from "../app/strings/player";
import { docSurfaces, primarySurface, surfaceOf, type SurfaceAwareDoc } from "../prototype/surfaces";

/**
 * Причина входа на экран (W1-5, сквозное решение 3):
 * - `flow` — действия прототипа (navigate/back/restart) и стейт флоу валиден;
 * - `browse` — «браузерная» навигация вокруг флоу (сайдбар, стрелки), replace вне flowDepth;
 * - `bootstrap` — холодный вход (deep-link, reload, восстановление вкладки): стейт флоу сброшен.
 */
export type PlayerEntryReason = "bootstrap" | "browse" | "flow";

export interface PlayerLocationState {
  sessionNonce: string;
  flowDepth: number;
  entryReason: PlayerEntryReason;
  documentNonce: string;
}

export interface PlayerNavigation {
  sessionNonce: string;
  flowDepth: number;
  entryReason: PlayerEntryReason;
  /** Flow-переход (действие прототипа): push с ростом flowDepth. */
  navigate: (screenId: string) => void;
  /**
   * Браузерная навигация (сайдбар/стрелки/шаг сценария): replace вне flowDepth.
   * `companions` (D5) — экраны других поверхностей: guided browse выставляет обе
   * панели **одним** replace, а не двумя записями истории.
   */
  browseToScreen: (screenId: string, companions?: Record<string, string>) => void;
  goToScreen: (screenId: string) => void;
  back: () => void;
  restart: () => void;
  /**
   * Карта «поверхность → её текущий экран», прочитанная из URL (D6): path несёт
   * экран сфокусированной поверхности, query — `on.<surfaceId>` остальных.
   * Документ без `doc.surfaces` даёт одну синтетическую primary-запись.
   */
  screenBySurface: SurfaceScreenMap;
  /** Поверхность, чей экран стоит в path: хром, стрелки и зум работают по ней. */
  focusedSurfaceId: string;
  /** Перенос фокуса на поверхность без смены её экрана (replace). */
  focusSurface: (surfaceId: string) => void;
  /** Баннер «Состояние флоу сброшено»: bootstrap-вход не на стартовом экране. */
  flowResetVisible: boolean;
  dismissFlowReset: () => void;
}

const NavigationContext = createContext<PlayerNavigation | null>(null);

function newNonce() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

/**
 * Document-lifetime nonce (W1-5): генерируется один раз на загрузку документа.
 * location.state переживает reload/восстановление вкладки через `history.state.usr`,
 * поэтому одного entryReason недостаточно: несовпадение documentNonce в
 * восстановленном state означает reload ⇒ вход трактуется как `bootstrap`.
 */
export const documentLifetimeNonce = newNonce();

const entryReasons: readonly PlayerEntryReason[] = ["bootstrap", "browse", "flow"];

export function isPlayerLocationState(value: unknown): value is PlayerLocationState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return typeof state.sessionNonce === "string"
    && Number.isInteger(state.flowDepth) && Number(state.flowDepth) >= 0
    && entryReasons.includes(state.entryReason as PlayerEntryReason)
    && typeof state.documentNonce === "string";
}

export function buildPlayerPath(routeBase: string, screenId: string) {
  return `${routeBase}/s/${encodeURIComponent(screenId)}`;
}

export function buildPrototypeRouteBase(protoId: string, version?: number): string {
  return `/p/${encodeURIComponent(protoId)}${version === undefined ? "" : `/v/${version}`}`;
}

/**
 * Карта поверхностей в URL (план multi-surface, D6). **URL — источник истины**: path
 * несёт экран сфокусированной поверхности (`/p/:id/s/:screenId`), query — экраны
 * остальных (`?on.<surfaceId>=<screenId>`). Отсюда её восстанавливают share-ссылка,
 * deep-link, Back/Forward и переход из CJM; рантайм действий карту не хранит.
 */
export const SURFACE_QUERY_PREFIX = "on.";
export const surfaceQueryKey = (surfaceId: string) => `${SURFACE_QUERY_PREFIX}${surfaceId}`;

/** Поверхность → её текущий экран. */
export type SurfaceScreenMap = Readonly<Record<string, string>>;

export interface SurfaceLocation {
  screenBySurface: SurfaceScreenMap;
  focusedSurfaceId: string;
}

const searchOf = (search: string): URLSearchParams => new URLSearchParams(search);
const searchString = (params: URLSearchParams): string => {
  const next = params.toString();
  return next === "" ? "" : `?${next}`;
};

/** Удаляет всю карту поверхностей из query (restart, инвалидация сессии). */
export function stripSurfaceSearch(search: string): string {
  const params = searchOf(search);
  for (const key of [...params.keys()]) if (key.startsWith(SURFACE_QUERY_PREFIX)) params.delete(key);
  return searchString(params);
}

/**
 * Читает карту из актуальных path+query. Неизвестный, чужой или отсутствующий
 * `on.<surface>` — фолбэк на `startScreen` поверхности (D6: stale-query после
 * переключения версий не должен показывать несуществующий экран).
 */
export function readSurfaceLocation(doc: SurfaceAwareDoc, screenId: string | undefined, search: string): SurfaceLocation {
  const surfaces = docSurfaces(doc);
  const focused = screenId === undefined ? primarySurface(doc) : surfaceOf(doc, screenId);
  const params = searchOf(search);
  const known = new Set(doc.screens.map((screen) => screen.id));
  const screenBySurface: Record<string, string> = {};
  for (const surface of surfaces) {
    if (surface.id === focused.id) {
      screenBySurface[surface.id] = screenId ?? surface.startScreen;
      continue;
    }
    const requested = params.get(surfaceQueryKey(surface.id));
    screenBySurface[surface.id] = requested !== null && known.has(requested) && surfaceOf(doc, requested).id === surface.id
      ? requested
      : surface.startScreen;
  }
  return { screenBySurface, focusedSurfaceId: focused.id };
}

/**
 * Переписывает `on.*` под новую карту, сохраняя прочий query (`flow`/`step`/`debug`).
 * Экран сфокусированной поверхности живёт в path и в query не дублируется; документ
 * без `doc.surfaces` (одна синтетическая поверхность) не получает `on.*` вовсе —
 * его URL байт-в-байт прежний.
 */
export function writeSurfaceSearch(doc: SurfaceAwareDoc, search: string, screenBySurface: SurfaceScreenMap, focusedSurfaceId: string): string {
  const params = searchOf(stripSurfaceSearch(search));
  for (const surface of docSurfaces(doc)) {
    if (surface.id === focusedSurfaceId) continue;
    const screenId = screenBySurface[surface.id];
    // Экран по умолчанию (`startScreen` поверхности) в query не пишется: URL несёт
    // только отклонения от старта, поэтому restart и deep-link без карты дают
    // одинаковую — и минимальную — ссылку.
    if (screenId !== undefined && screenId !== surface.startScreen) params.set(surfaceQueryKey(surface.id), screenId);
  }
  return searchString(params);
}

/** Снимок навигации, читаемый действиями: карта, фокус, глубина и query. */
interface NavigationSnapshot {
  screenBySurface: SurfaceScreenMap;
  focusedSurfaceId: string;
  flowDepth: number;
  search: string;
}

export function PlayerNavigationProvider({ startScreen, routeBase, doc, children }: {
  startScreen: string;
  routeBase: string;
  /**
   * Документ — источник поверхностей (D6). Опционален: без него провайдер работает
   * с одной синтетической primary-поверхностью, то есть ровно как до фичи.
   */
  doc?: SurfaceAwareDoc | undefined;
  children: ReactNode;
}) {
  const routerNavigate = useNavigate();
  const location = useLocation();
  const { protoId, screenId } = useParams();
  // Query string (в т.ч. ?debug=1) сохраняется всеми переходами (W1-5).
  const search = location.search;
  const rawState = isPlayerLocationState(location.state) ? location.state : null;
  // Чужой documentNonce = state восстановлен после reload — не доверяем ему.
  const state = rawState && rawState.documentNonce === documentLifetimeNonce ? rawState : null;
  const [sessionNonce, setSessionNonce] = useState(() => state?.sessionNonce ?? newNonce());
  const [flowResetDismissed, setFlowResetDismissed] = useState(false);
  const isBootstrap = !state;
  const isStale = Boolean(state && state.sessionNonce !== sessionNonce);

  const surfaceDoc = useMemo<SurfaceAwareDoc>(() => doc ?? { startScreen, screens: [] }, [doc, startScreen]);
  const { screenBySurface, focusedSurfaceId } = useMemo(
    () => readSurfaceLocation(surfaceDoc, screenId, search),
    [screenId, search, surfaceDoc],
  );

  /**
   * Актуальное состояние навигации для обработчиков (D6, R1-B1b/R4-m1). Два `navigate`
   * в одном событии происходят **до** ре-рендера, поэтому карта и `flowDepth` берутся
   * не из React-замыкания, а из снапшота, который каждый переход обновляет немедленно;
   * после коммита снапшот пересинхронизируется с фактическим URL.
   */
  const navRef = useRef<NavigationSnapshot>({ screenBySurface, focusedSurfaceId, flowDepth: state?.flowDepth ?? 0, search });
  const flowDepth = state?.flowDepth ?? 0;
  useEffect(() => {
    navRef.current = { screenBySurface, focusedSurfaceId, flowDepth, search };
  }, [flowDepth, focusedSurfaceId, screenBySurface, search]);

  useEffect(() => {
    if (!protoId || (!isBootstrap && !isStale)) return;
    // stale (Back в историю до restart) — инвалидация: редирект на startScreen;
    // bootstrap (deep-link/reload) — остаёмся на запрошенном экране, сброс объясняет баннер.
    const target = isStale ? startScreen : (screenId ?? startScreen);
    // Карта нормализуется вместе с path: неизвестный `on.*` уезжает на startScreen
    // своей поверхности, отсутствующий — дописывается (deep-link без карты).
    const base = isStale ? stripSurfaceSearch(search) : search;
    const entry = readSurfaceLocation(surfaceDoc, target, base);
    const nextSearch = writeSurfaceSearch(surfaceDoc, base, entry.screenBySurface, entry.focusedSurfaceId);
    routerNavigate({ pathname: buildPlayerPath(routeBase, target), search: nextSearch }, {
      replace: true,
      state: { sessionNonce, flowDepth: 0, entryReason: "bootstrap", documentNonce: documentLifetimeNonce } satisfies PlayerLocationState,
    });
  }, [isBootstrap, isStale, protoId, routeBase, routerNavigate, screenId, search, sessionNonce, startScreen, surfaceDoc]);

  const navigate = useCallback((target: string) => {
    if (!protoId || isBootstrap || isStale) return;
    const current = navRef.current;
    const targetSurfaceId = surfaceOf(surfaceDoc, target).id;
    // Ранний выход — «target уже открыт на своей поверхности **и** она сфокусирована»:
    // иначе переход обязан хотя бы перенести фокус на панель цели.
    if (current.screenBySurface[targetSurfaceId] === target && current.focusedSurfaceId === targetSurfaceId) return;
    const nextMap = { ...current.screenBySurface, [targetSurfaceId]: target };
    const nextSearch = writeSurfaceSearch(surfaceDoc, current.search, nextMap, targetSurfaceId);
    const nextDepth = current.flowDepth + 1;
    navRef.current = { screenBySurface: nextMap, focusedSurfaceId: targetSurfaceId, flowDepth: nextDepth, search: nextSearch };
    routerNavigate({ pathname: buildPlayerPath(routeBase, target), search: nextSearch }, {
      state: { sessionNonce, flowDepth: nextDepth, entryReason: "flow", documentNonce: documentLifetimeNonce } satisfies PlayerLocationState,
    });
  }, [isBootstrap, isStale, protoId, routeBase, routerNavigate, sessionNonce, surfaceDoc]);

  const browseToScreen = useCallback((target: string, companions?: Record<string, string>) => {
    if (!protoId || isBootstrap || isStale) return;
    const current = navRef.current;
    const targetSurfaceId = surfaceOf(surfaceDoc, target).id;
    const nextMap: Record<string, string> = { ...current.screenBySurface, [targetSurfaceId]: target };
    for (const [surfaceId, companionScreen] of Object.entries(companions ?? {})) {
      // Чужие/неизвестные записи игнорируются: карта резолвится вызывающим
      // (`resolveStepCompanions`), но stored-документ мог прийти из другой версии формата.
      if (surfaceId === targetSurfaceId || nextMap[surfaceId] === undefined) continue;
      if (surfaceOf(surfaceDoc, companionScreen).id === surfaceId) nextMap[surfaceId] = companionScreen;
    }
    const unchanged = targetSurfaceId === current.focusedSurfaceId
      && Object.entries(nextMap).every(([surfaceId, value]) => current.screenBySurface[surfaceId] === value);
    if (unchanged) return;
    const nextSearch = writeSurfaceSearch(surfaceDoc, current.search, nextMap, targetSurfaceId);
    navRef.current = { ...current, screenBySurface: nextMap, focusedSurfaceId: targetSurfaceId, search: nextSearch };
    routerNavigate({ pathname: buildPlayerPath(routeBase, target), search: nextSearch }, {
      replace: true,
      state: { sessionNonce, flowDepth: current.flowDepth, entryReason: "browse", documentNonce: documentLifetimeNonce } satisfies PlayerLocationState,
    });
  }, [isBootstrap, isStale, protoId, routeBase, routerNavigate, sessionNonce, surfaceDoc]);

  const focusSurface = useCallback((surfaceId: string) => {
    const current = navRef.current;
    if (current.focusedSurfaceId === surfaceId) return;
    const target = current.screenBySurface[surfaceId];
    if (target !== undefined) browseToScreen(target);
  }, [browseToScreen]);

  const back = useCallback(() => {
    if (isBootstrap || isStale || (state?.flowDepth ?? 0) === 0) return;
    routerNavigate(-1);
  }, [isBootstrap, isStale, routerNavigate, state?.flowDepth]);

  const restart = useCallback(() => {
    if (!protoId) return;
    const nonce = newNonce();
    setSessionNonce(nonce);
    setFlowResetDismissed(false);
    // Все поверхности — на свои startScreen; карта из query вычищается (D6).
    const nextSearch = stripSurfaceSearch(navRef.current.search);
    const surfaces = docSurfaces(surfaceDoc);
    navRef.current = {
      screenBySurface: Object.fromEntries(surfaces.map((surface) => [surface.id, surface.startScreen])),
      focusedSurfaceId: primarySurface(surfaceDoc).id,
      flowDepth: 0,
      search: nextSearch,
    };
    routerNavigate({ pathname: buildPlayerPath(routeBase, startScreen), search: nextSearch }, {
      replace: true,
      state: { sessionNonce: nonce, flowDepth: 0, entryReason: "flow", documentNonce: documentLifetimeNonce } satisfies PlayerLocationState,
    });
  }, [protoId, routeBase, routerNavigate, startScreen, surfaceDoc]);

  const dismissFlowReset = useCallback(() => setFlowResetDismissed(true), []);
  const entryReason = state?.entryReason ?? "bootstrap";
  const flowResetVisible = entryReason === "bootstrap" && !flowResetDismissed
    && screenId !== undefined && screenId !== startScreen;

  const value = useMemo<PlayerNavigation>(() => ({
    sessionNonce,
    flowDepth: state?.flowDepth ?? 0,
    entryReason,
    navigate,
    browseToScreen,
    goToScreen: browseToScreen,
    back,
    restart,
    screenBySurface,
    focusedSurfaceId,
    focusSurface,
    flowResetVisible,
    dismissFlowReset,
  }), [back, browseToScreen, dismissFlowReset, entryReason, flowResetVisible, focusSurface, focusedSurfaceId, navigate, restart, screenBySurface, sessionNonce, state?.flowDepth]);

  if (isBootstrap || isStale) return <div role="status" aria-label={loader.loadingPrototype} />;
  return <NavigationContext value={value}>{children}</NavigationContext>;
}

export function usePlayerNavigation() {
  const navigation = useContext(NavigationContext);
  if (!navigation) throw new Error("usePlayerNavigation must be used inside PlayerNavigationProvider");
  return navigation;
}

const dismissButton = "rounded-full p-1 leading-none text-eui-slate-500 transition-colors duration-100 hover:bg-pay-lavender hover:text-eui-ink";

/**
 * Баннер «Состояние флоу сброшено» (W1-5): показывается при bootstrap-входе
 * (deep-link, reload, восстановление вкладки) не на стартовом экране —
 * получатель ссылки на середину флоу видит объяснение вместо противоречивого
 * экрана. «Начать сначала» ведёт на startScreen со свежим стейтом; крестик скрывает.
 */
export function FlowResetBanner({ compact = false }: { compact?: boolean }) {
  const navigation = usePlayerNavigation();
  if (!navigation.flowResetVisible) return null;
  const frame = compact
    ? "absolute left-1/2 top-3 z-20 flex max-w-[92%] -translate-x-1/2 items-center gap-2 rounded-full bg-white px-3 py-1.5 text-xs text-eui-ink"
    : "flex flex-wrap items-center gap-3 bg-pay-lavender px-5 py-2 text-sm text-eui-ink";
  return (
    <div role="status" data-testid="flow-reset-banner" className={frame}>
      <span className="min-w-0 truncate text-eui-slate-700">{player.flowResetMessage}</span>
      <button type="button" onClick={navigation.restart} className={compact ? "shrink-0 rounded-full px-2 py-0.5 font-medium text-pay-red underline-offset-2 hover:underline" : `${pillGhost} shrink-0 px-3 py-1.5 text-[13px]`}>
        {player.flowResetRestart}
      </button>
      <button type="button" aria-label={player.flowResetDismiss} title={player.flowResetDismiss} onClick={navigation.dismissFlowReset} className={`${dismissButton} shrink-0`}>
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}
