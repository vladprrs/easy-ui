import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { loader } from "../app/strings/player";

export interface PlayerLocationState {
  sessionNonce: string;
  flowDepth: number;
}

export interface PlayerNavigation {
  sessionNonce: string;
  flowDepth: number;
  navigate: (screenId: string) => void;
  goToScreen: (screenId: string) => void;
  back: () => void;
  restart: () => void;
}

const NavigationContext = createContext<PlayerNavigation | null>(null);

function newNonce() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

export function isPlayerLocationState(value: unknown): value is PlayerLocationState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return typeof state.sessionNonce === "string" && Number.isInteger(state.flowDepth) && Number(state.flowDepth) >= 0;
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
  const initialState = isPlayerLocationState(location.state) ? location.state : null;
  const [sessionNonce, setSessionNonce] = useState(() => initialState?.sessionNonce ?? newNonce());
  const state = isPlayerLocationState(location.state) ? location.state : null;
  const isBootstrap = !state;
  const isStale = Boolean(state && state.sessionNonce !== sessionNonce);

  useEffect(() => {
    if (!protoId || (!isBootstrap && !isStale)) return;
    const target = isStale ? startScreen : (screenId ?? startScreen);
    routerNavigate(buildPlayerPath(routeBase, target), {
      replace: true,
      state: { sessionNonce, flowDepth: 0 } satisfies PlayerLocationState,
    });
  }, [isBootstrap, isStale, protoId, routeBase, routerNavigate, screenId, sessionNonce, startScreen]);

  const navigate = useCallback((target: string) => {
    if (!protoId || target === screenId || isBootstrap || isStale) return;
    routerNavigate(buildPlayerPath(routeBase, target), {
      state: { sessionNonce, flowDepth: (state?.flowDepth ?? 0) + 1 } satisfies PlayerLocationState,
    });
  }, [isBootstrap, isStale, protoId, routeBase, routerNavigate, screenId, sessionNonce, state?.flowDepth]);

  const back = useCallback(() => {
    if (isBootstrap || isStale || (state?.flowDepth ?? 0) === 0) return;
    routerNavigate(-1);
  }, [isBootstrap, isStale, routerNavigate, state?.flowDepth]);

  const restart = useCallback(() => {
    if (!protoId) return;
    const nonce = newNonce();
    setSessionNonce(nonce);
    routerNavigate(buildPlayerPath(routeBase, startScreen), {
      replace: true,
      state: { sessionNonce: nonce, flowDepth: 0 } satisfies PlayerLocationState,
    });
  }, [protoId, routeBase, routerNavigate, startScreen]);

  const value = useMemo<PlayerNavigation>(() => ({
    sessionNonce,
    flowDepth: state?.flowDepth ?? 0,
    navigate,
    goToScreen: navigate,
    back,
    restart,
  }), [back, navigate, restart, sessionNonce, state?.flowDepth]);

  if (isBootstrap || isStale) return <div role="status" aria-label={loader.loadingPrototype} />;
  return <NavigationContext value={value}>{children}</NavigationContext>;
}

export function usePlayerNavigation() {
  const navigation = useContext(NavigationContext);
  if (!navigation) throw new Error("usePlayerNavigation must be used inside PlayerNavigationProvider");
  return navigation;
}

export function StartScreenRedirect({ startScreen }: { startScreen: string }) {
  const navigation = usePlayerNavigation();
  const { protoId } = useParams();
  useEffect(() => {
    if (!protoId) return;
    navigation.navigate(startScreen);
  }, [navigation, protoId, startScreen]);
  return <div role="status" aria-label={loader.loadingPrototype} />;
}
