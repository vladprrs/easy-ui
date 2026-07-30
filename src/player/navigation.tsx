import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { pillGhost } from "../app/chrome";
import { loader, player } from "../app/strings/player";

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
  /** Браузерная навигация (сайдбар/стрелки): replace вне flowDepth. */
  browseToScreen: (screenId: string) => void;
  goToScreen: (screenId: string) => void;
  back: () => void;
  restart: () => void;
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

export function PlayerNavigationProvider({ startScreen, routeBase, children }: { startScreen: string; routeBase: string; children: ReactNode }) {
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

  useEffect(() => {
    if (!protoId || (!isBootstrap && !isStale)) return;
    // stale (Back в историю до restart) — инвалидация: редирект на startScreen;
    // bootstrap (deep-link/reload) — остаёмся на запрошенном экране, сброс объясняет баннер.
    const target = isStale ? startScreen : (screenId ?? startScreen);
    routerNavigate({ pathname: buildPlayerPath(routeBase, target), search }, {
      replace: true,
      state: { sessionNonce, flowDepth: 0, entryReason: "bootstrap", documentNonce: documentLifetimeNonce } satisfies PlayerLocationState,
    });
  }, [isBootstrap, isStale, protoId, routeBase, routerNavigate, screenId, search, sessionNonce, startScreen]);

  const navigate = useCallback((target: string) => {
    if (!protoId || target === screenId || isBootstrap || isStale) return;
    routerNavigate({ pathname: buildPlayerPath(routeBase, target), search }, {
      state: { sessionNonce, flowDepth: (state?.flowDepth ?? 0) + 1, entryReason: "flow", documentNonce: documentLifetimeNonce } satisfies PlayerLocationState,
    });
  }, [isBootstrap, isStale, protoId, routeBase, routerNavigate, screenId, search, sessionNonce, state?.flowDepth]);

  const browseToScreen = useCallback((target: string) => {
    if (!protoId || target === screenId || isBootstrap || isStale) return;
    routerNavigate({ pathname: buildPlayerPath(routeBase, target), search }, {
      replace: true,
      state: { sessionNonce, flowDepth: state?.flowDepth ?? 0, entryReason: "browse", documentNonce: documentLifetimeNonce } satisfies PlayerLocationState,
    });
  }, [isBootstrap, isStale, protoId, routeBase, routerNavigate, screenId, search, sessionNonce, state?.flowDepth]);

  const back = useCallback(() => {
    if (isBootstrap || isStale || (state?.flowDepth ?? 0) === 0) return;
    routerNavigate(-1);
  }, [isBootstrap, isStale, routerNavigate, state?.flowDepth]);

  const restart = useCallback(() => {
    if (!protoId) return;
    const nonce = newNonce();
    setSessionNonce(nonce);
    setFlowResetDismissed(false);
    routerNavigate({ pathname: buildPlayerPath(routeBase, startScreen), search }, {
      replace: true,
      state: { sessionNonce: nonce, flowDepth: 0, entryReason: "flow", documentNonce: documentLifetimeNonce } satisfies PlayerLocationState,
    });
  }, [protoId, routeBase, routerNavigate, search, startScreen]);

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
    flowResetVisible,
    dismissFlowReset,
  }), [back, browseToScreen, dismissFlowReset, entryReason, flowResetVisible, navigate, restart, sessionNonce, state?.flowDepth]);

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
