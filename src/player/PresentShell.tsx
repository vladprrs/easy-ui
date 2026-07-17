import { JSONUIProvider } from "@json-render/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useNavigationType, useParams } from "react-router";
import { createPlayerRuntime, type CustomPlayerRuntime } from "../catalog/runtime";
import { ThemeStyle, useDesignSystemTheme } from "../designSystems/theme";
import type { PrototypeDoc } from "../prototype/schema";
import { toRuntimeSpec } from "../prototype/runtimeSpec";
import { pillGhostOnDark } from "../app/chrome";
import { player, present, presentDocumentTitle, share as shareStrings, shareDocumentTitle } from "../app/strings/player";
import { useDocumentTitle } from "../app/useDocumentTitle";
import type { ThemeContent } from "../api/client";
import { EasyUiActionRuntime } from "./actionRuntime";
import { DeviceFrame, isPlayerHelpHotkey, isPlayerHotkeyEvent, type StageZoom } from "./DeviceFrame";
import { FluidStage } from "./FluidStage";
import { useMobilePresent } from "./mobilePresent";
import { buildPlayerPath, FlowResetBanner, PlayerNavigationProvider, usePlayerNavigation } from "./navigation";
import { PresentHud } from "./PresentHud";
import { PrototypeLoader } from "./PrototypeLoader";
import { PlayerHotkeysHelp, ScreenErrorBoundary } from "./ScreenView";
import { ScreenSurface } from "./ScreenSurface";

/** Презентация всегда вписывает фрейм в вьюпорт — зум-контролов нет (W1-2). */
const fitZoom: StageZoom = { mode: "fit", zoom: 1 };

/**
 * Режим презентации (W1-2, P0 «показать прототип заказчику»): маршруты
 * `/p/:id(/v/:version)/present(/s/:screenId)` живут вне Layout и вне
 * PrototypeChrome — на экране только прототип и минимальная оснастка
 * (пейджер-точки, «Начать сначала», выход). Рендер экрана — общая
 * поверхность {@link ScreenSurface} с полноценным интерактивным
 * {@link EasyUiActionRuntime}; капчер-протокол (capture-session, postMessage)
 * сюда не подключён и не раскрывается.
 *
 * Выход: Esc возвращает в плеер на тот же экран. При прямом входе по ссылке
 * дополнительно показывается кнопка «Открыть в easy-ui» с тем же маршрутом.
 */
export function PresentShell({ share = false }: { share?: boolean }) {
  const { protoId, version } = useParams();
  const numericVersion = version === undefined ? undefined : Number(version);
  const navigationType = useNavigationType();
  const mobile = useMobilePresent();
  // Латч на маунт шелла: bootstrap-replace навигации внутри презентации не
  // должен перекрасить прямой вход в «внутренний».
  const [directEntry] = useState(() => navigationType === "POP");
  return <PrototypeLoader protoId={protoId} version={numericVersion} allowArchivedPlaceholder={!share}>
    {({ loaded, custom, runtimeKey, routeBase }) => (
      <PlayerNavigationProvider key={runtimeKey} startScreen={loaded.doc.startScreen} routeBase={`${share ? `/share/p/${encodeURIComponent(loaded.doc.id)}/v/${numericVersion}` : routeBase}/present`}>
        <LoadedPresent key={runtimeKey} doc={loaded.doc} custom={custom} runtimeKey={runtimeKey} playerBase={routeBase} metaVersion={loaded.designSystemMetaVersion} version={numericVersion} directEntry={directEntry} share={share} mobile={mobile} />
      </PlayerNavigationProvider>
    )}
  </PrototypeLoader>;
}

interface LoadedPresentProps {
  doc: PrototypeDoc;
  custom?: CustomPlayerRuntime | undefined;
  runtimeKey: string;
  playerBase: string;
  metaVersion: number | null | undefined;
  version: number | undefined;
  directEntry: boolean;
  share: boolean;
  mobile: boolean;
}

function LoadedPresent(props: LoadedPresentProps) {
  // A published version with no theme pin means "no theme at publish time". The normal player
  // still resolves latest-head themes for drafts, but scoped share must not read that mutable API.
  if (props.share && props.metaVersion == null) return <LoadedPresentContent {...props} themeContent={null} />;
  return <ThemedLoadedPresent {...props} />;
}

function ThemedLoadedPresent(props: LoadedPresentProps) {
  const themeContent = useDesignSystemTheme(props.doc.designSystem, props.metaVersion);
  return <LoadedPresentContent {...props} themeContent={themeContent} />;
}

function LoadedPresentContent({ doc, custom, runtimeKey, playerBase, version, directEntry, share, mobile, themeContent }: LoadedPresentProps & { themeContent: ThemeContent | null }) {
  const { screenId } = useParams();
  const navigation = usePlayerNavigation();
  const routerNavigate = useNavigate();
  const [hotkeysVisible, setHotkeysVisible] = useState(false);
  const [hudOpen, setHudOpen] = useState(false);
  const navigationRef = useRef(navigation);
  useEffect(() => { navigationRef.current = navigation; }, [navigation]);
  useDocumentTitle(share && version !== undefined ? shareDocumentTitle(doc.name, version) : presentDocumentTitle(doc.name, version));

  // eslint-disable-next-line react-hooks/refs
  const runtime = useMemo(() => createPlayerRuntime({
    navigate: (target) => navigationRef.current.navigate(target),
    back: () => navigationRef.current.back(),
    openUrl: (url) => { window.open(url, "_blank", "noopener,noreferrer"); },
    restart: () => navigationRef.current.restart(),
  }, custom, doc.designSystem), [custom, doc.designSystem]);
  const customDefinitions = useMemo(() => custom?.definitions ?? {}, [custom]);
  const customTypes = useMemo(() => new Set(Object.keys(customDefinitions)), [customDefinitions]);
  const onError = useMemo(() => (message: string, detail?: Record<string, unknown>) => {
    if (import.meta.env.MODE !== "test") console.error(`[present] ${message}`, detail ?? "");
  }, []);
  // Свежий store на каждый рестарт сессии (sessionNonce) — как в плеере.
  // eslint-disable-next-line react-hooks/refs
  const actionRuntime = useMemo(() => new EasyUiActionRuntime({
    initialState: doc.state,
    screenIds: new Set(doc.screens.map((screen) => screen.id)),
    deps: {
      navigate: (target) => navigationRef.current.navigate(target),
      back: () => navigationRef.current.back(),
      openUrl: (url) => { window.open(url, "_blank", "noopener,noreferrer"); },
      restart: () => navigationRef.current.restart(),
    },
    onError,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [doc, onError, navigation.sessionNonce]);

  const screen = doc.screens.find((item) => item.id === screenId);
  const tree = useMemo(() => (screen ? toRuntimeSpec(screen.spec, { customTypes }) : null), [screen, customTypes]);
  // Возврат в плеер — на тот же экран, что открыт в презентации.
  // Query string (в т.ч. ?debug=1) сохраняется переходом (W1-5).
  const location = useLocation();
  const exitPath = `${screen ? buildPlayerPath(playerBase, screen.id) : playerBase}${location.search}`;

  const currentIndex = screen ? doc.screens.indexOf(screen) : -1;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPlayerHotkeyEvent(event)) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const offset = event.key === "ArrowLeft" ? -1 : 1;
        const target = doc.screens[currentIndex + offset];
        if (!target) return;
        event.preventDefault();
        navigation.browseToScreen(target.id);
      } else if (event.key.toLowerCase() === "r") {
        event.preventDefault();
        navigation.restart();
      } else if (event.key === "Escape") {
        if (hotkeysVisible) {
          event.preventDefault();
          setHotkeysVisible(false);
        } else if (hudOpen) {
          event.preventDefault();
          setHudOpen(false);
        } else if (!share) {
          event.preventDefault();
          void routerNavigate(exitPath);
        }
      } else if (isPlayerHelpHotkey(event)) {
        event.preventDefault();
        setHotkeysVisible((visible) => !visible);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [currentIndex, doc.screens, exitPath, hotkeysVisible, hudOpen, navigation, routerNavigate, share]);

  const content = screen && tree
    ? <ScreenErrorBoundary key={screen.id} prototypeId={doc.id} screenId={screen.id} restart={navigation.restart}>
        <ScreenSurface registry={runtime.registry} runtime={actionRuntime} customDefinitions={customDefinitions} onError={onError} tree={tree} canvas={screen.canvas} hostPrimitivesAllowed={doc.device !== "desktop" || screen.canvas !== undefined} />
      </ScreenErrorBoundary>
    : <section role="alert" className="m-6 rounded-2xl bg-white/10 p-6 text-eui-orange">
        <h1 className="font-eui-display text-xl font-bold">{player.screenMissingTitle}</h1>
        <p className="mt-2 text-sm text-eui-ondark-2">{player.screenMissingBody(doc.name)}</p>
      </section>;

  return <JSONUIProvider key={`${runtimeKey}:${navigation.sessionNonce}`} registry={runtime.registry} handlers={runtime.handlers} store={actionRuntime.store}>
    <ThemeStyle content={themeContent} />
    <main className={mobile
      ? "flex h-dvh min-h-0 flex-col bg-background font-eui-ui text-foreground"
      : "flex h-dvh min-h-0 flex-col bg-eui-graphite font-eui-ui text-white"}>
      {hotkeysVisible && <PlayerHotkeysHelp present canExitPresent={!share} onClose={() => setHotkeysVisible(false)} />}
      <div className="relative flex min-h-0 min-w-0 flex-1">
        {/* Компактный баннер сброса (W1-5): deep-link в середину флоу презентации. */}
        <FlowResetBanner compact />
        {mobile ? <FluidStage canvas={screen?.canvas} designSystem={doc.designSystem} themeTokens={themeContent?.tokens} resetKey={screen?.id}>
          {content}
        </FluidStage> : <DeviceFrame device={doc.device} canvas={screen?.canvas} zoom={fitZoom} designSystem={doc.designSystem} themeTokens={themeContent?.tokens}>
          {content}
        </DeviceFrame>}
        {mobile && <PresentHud open={hudOpen} onOpenChange={setHudOpen} navigation={navigation} current={currentIndex + 1} total={doc.screens.length} exitPath={exitPath} directEntry={directEntry} share={share} />}
      </div>
      {!mobile && <footer className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 px-4 py-2.5">
        <nav aria-label={present.pagerAria} className="flex max-w-full flex-wrap items-center justify-center gap-1.5">
          {doc.screens.map((item) => (
            <span
              key={item.id}
              title={present.screenDot(item.name)}
              aria-current={item.id === screen?.id ? "step" : undefined}
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${item.id === screen?.id ? "bg-white" : "bg-white/30"}`}
            />
          ))}
        </nav>
        <span className="text-xs tabular-nums text-eui-ondark-2">{present.counter(currentIndex + 1, doc.screens.length)}</span>
        <button type="button" onClick={navigation.restart} className={pillGhostOnDark}>{player.restart}</button>
        {share ? <span className="text-xs text-eui-ondark-2">{shareStrings.viewerLabel}</span>
          : directEntry
          ? <Link className={pillGhostOnDark} to={exitPath}>{present.openInApp}</Link>
          : <span className="text-xs text-eui-ondark-2">{present.exitHint}</span>}
      </footer>}
    </main>
  </JSONUIProvider>;
}
