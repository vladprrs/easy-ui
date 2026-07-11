import { JSONUIProvider } from "@json-render/react";
import { lazy, Suspense, useEffect, useMemo, useRef } from "react";
import { Outlet, useParams } from "react-router";
import { createPlayerRuntime, type CustomPlayerRuntime } from "../catalog/runtime";
import type { PrototypeDoc } from "../prototype/schema";
import { PlayerNavigationProvider, usePlayerNavigation } from "./navigation";
import { PrototypeLoader } from "./PrototypeLoader";
export { LoadError, MissingPrototype } from "./PrototypeLoader";

const Devtools = lazy(async () => ({ default: (await import("@json-render/devtools-react")).JsonRenderDevtools }));

export interface PlayerOutletContext {
  doc: PrototypeDoc;
  registry: ReturnType<typeof createPlayerRuntime>["registry"];
}

function LoadedPlayer({ doc, custom, runtimeKey }: { doc: PrototypeDoc; custom?: CustomPlayerRuntime; runtimeKey: string }) {
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

  return <JSONUIProvider key={`${runtimeKey}:${navigation.sessionNonce}`} registry={runtime.registry} handlers={runtime.handlers} initialState={doc.state}>
    <Outlet context={{ doc, registry: runtime.registry } satisfies PlayerOutletContext} />
    {import.meta.env.DEV && import.meta.env.MODE !== "test" ? <Suspense fallback={null}><Devtools /></Suspense> : null}
  </JSONUIProvider>;
}

function ReadyPlayer({ doc, custom, runtimeKey, routeBase }: { doc: PrototypeDoc; custom?: CustomPlayerRuntime; runtimeKey: string; routeBase: string }) {
  return <PlayerNavigationProvider key={runtimeKey} startScreen={doc.startScreen} routeBase={routeBase}>
    <LoadedPlayer key={runtimeKey} doc={doc} custom={custom} runtimeKey={runtimeKey} />
  </PlayerNavigationProvider>;
}

export function PlayerShell() {
  const { protoId, version } = useParams();
  const numericVersion = version === undefined ? undefined : Number(version);
  return <PrototypeLoader protoId={protoId} version={numericVersion}>
    {({ loaded, custom, runtimeKey, routeBase }) => <ReadyPlayer doc={loaded.doc} custom={custom} runtimeKey={runtimeKey} routeBase={routeBase} />}
  </PrototypeLoader>;
}
