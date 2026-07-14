import { JSONUIProvider } from "@json-render/react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useParams, useSearchParams } from "react-router";
import { createPlayerRuntime, type CustomPlayerRuntime } from "../catalog/runtime";
import type { ComponentDefinition } from "../catalog/definitions";
import { ThemeStyle, useDesignSystemTheme } from "../designSystems/theme";
import type { PrototypeDoc } from "../prototype/schema";
import { EasyUiActionRuntime } from "./actionRuntime";
import { InspectorLog, InspectorLoggerSink } from "./inspector/log";
import { PlayerNavigationProvider, usePlayerNavigation } from "./navigation";
import { PrototypeLoader } from "./PrototypeLoader";
export { LoadError, MissingPrototype } from "./PrototypeLoader";

const Devtools = lazy(async () => ({ default: (await import("@json-render/devtools-react")).JsonRenderDevtools }));

export interface PlayerOutletContext {
  doc: PrototypeDoc;
  registry: ReturnType<typeof createPlayerRuntime>["registry"];
  runtime: EasyUiActionRuntime;
  customTypes: ReadonlySet<string>;
  customDefinitions: Record<string, ComponentDefinition>;
  onError: (message: string, detail?: Record<string, unknown>) => void;
  inspector: {
    enabled: boolean;
    visible: boolean;
    log: InspectorLog;
    toggle: () => void;
  };
}

function LoadedPlayer({ doc, custom, runtimeKey, metaVersion, debug }: { doc: PrototypeDoc; custom?: CustomPlayerRuntime; runtimeKey: string; metaVersion: number | null | undefined; debug: boolean }) {
  const themeContent = useDesignSystemTheme(doc.designSystem, metaVersion);
  const navigation = usePlayerNavigation();
  const navigationRef = useRef(navigation);
  useEffect(() => { navigationRef.current = navigation; }, [navigation]);
  // eslint-disable-next-line react-hooks/refs
  const runtime = useMemo(() => createPlayerRuntime({
    navigate: (screenId) => navigationRef.current.navigate(screenId),
    back: () => navigationRef.current.back(),
    openUrl: (url) => { window.open(url, "_blank", "noopener,noreferrer"); },
    restart: () => navigationRef.current.restart(),
  }, custom, doc.designSystem), [custom, doc.designSystem]);

  const customDefinitions = useMemo(() => custom?.definitions ?? {}, [custom]);
  const customTypes = useMemo(() => new Set(Object.keys(customDefinitions)), [customDefinitions]);
  const onError = useMemo(() => (message: string, detail?: Record<string, unknown>) => {
    if (import.meta.env.MODE !== "test") console.error(`[player] ${message}`, detail ?? "");
  }, []);

  // Runtime, store and inspector ledger have exactly the session lifetime. The
  // panel toggle only connects its stable logger sink and changes visibility.
  const inspectorSession = useMemo(() => {
    const log = new InspectorLog();
    const sink = new InspectorLoggerSink();
    // Runtime callbacks dereference navigation only when an action is dispatched.
    // eslint-disable-next-line react-hooks/refs
    const actionRuntime = new EasyUiActionRuntime({
      initialState: doc.state,
      screenIds: new Set(doc.screens.map((screen) => screen.id)),
      deps: {
        navigate: (screenId) => navigationRef.current.navigate(screenId),
        back: () => navigationRef.current.back(),
        openUrl: (url) => { window.open(url, "_blank", "noopener,noreferrer"); },
        restart: () => navigationRef.current.restart(),
      },
      onError,
      logger: sink,
    });
    return { log, sink, actionRuntime };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, onError, navigation.sessionNonce]);
  const [inspectorHidden, setInspectorHidden] = useState(false);
  const inspectorVisible = debug && !inspectorHidden;
  useEffect(() => {
    inspectorSession.sink.connect(debug && inspectorVisible ? inspectorSession.log : null);
    return () => inspectorSession.sink.connect(null);
  }, [debug, inspectorSession, inspectorVisible]);
  useEffect(() => {
    const onImageError = (event: Event) => {
      if (!(event.target instanceof HTMLImageElement)) return;
      const image = event.target;
      inspectorSession.sink.logRuntimeError("img-error", { src: image.currentSrc || image.src, alt: image.alt });
    };
    document.addEventListener("error", onImageError, true);
    return () => document.removeEventListener("error", onImageError, true);
  }, [inspectorSession]);
  const toggleInspector = useCallback(() => setInspectorHidden((hidden) => !hidden), []);

  return <JSONUIProvider key={`${runtimeKey}:${navigation.sessionNonce}`} registry={runtime.registry} handlers={runtime.handlers} store={inspectorSession.actionRuntime.store}>
    <ThemeStyle content={themeContent} />
    <Outlet context={{
      doc,
      registry: runtime.registry,
      runtime: inspectorSession.actionRuntime,
      customTypes,
      customDefinitions,
      onError,
      inspector: { enabled: debug, visible: inspectorVisible, log: inspectorSession.log, toggle: toggleInspector },
    } satisfies PlayerOutletContext} />
    {import.meta.env.DEV && import.meta.env.MODE !== "test" ? <Suspense fallback={null}><Devtools /></Suspense> : null}
  </JSONUIProvider>;
}

function ReadyPlayer({ doc, custom, runtimeKey, routeBase, metaVersion, debug }: { doc: PrototypeDoc; custom?: CustomPlayerRuntime; runtimeKey: string; routeBase: string; metaVersion: number | null | undefined; debug: boolean }) {
  return <PlayerNavigationProvider key={runtimeKey} startScreen={doc.startScreen} routeBase={routeBase}>
    <LoadedPlayer key={runtimeKey} doc={doc} custom={custom} runtimeKey={runtimeKey} metaVersion={metaVersion} debug={debug} />
  </PlayerNavigationProvider>;
}

export function PlayerShell() {
  const { protoId, version } = useParams();
  // Interaction inspector (H.1): ?debug=1 enables the panel. Навигация плеера
  // сохраняет query string во всех переходах (W1-5); латч остаётся страховкой
  // на случай внешних переходов, теряющих query (история, ручная правка URL).
  const [search] = useSearchParams();
  const debugParam = search.get("debug") === "1";
  const [debug, setDebug] = useState(debugParam);
  if (debugParam && !debug) setDebug(true); // render-time latch (never turns back off)
  const numericVersion = version === undefined ? undefined : Number(version);
  return <PrototypeLoader protoId={protoId} version={numericVersion}>
    {({ loaded, custom, runtimeKey, routeBase }) => <ReadyPlayer doc={loaded.doc} custom={custom} runtimeKey={runtimeKey} routeBase={routeBase} metaVersion={loaded.designSystemMetaVersion} debug={debug} />}
  </PrototypeLoader>;
}
