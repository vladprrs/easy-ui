import { JSONUIProvider } from "@json-render/react";
import { lazy, Suspense, useEffect, useMemo, useRef } from "react";
import { Link, Outlet, useParams } from "react-router";
import { ApiError } from "../api/client";
import { useApi } from "../api/hooks";
import { createPlayerRuntime, type CustomPlayerRuntime } from "../catalog/runtime";
import { loadCustomComponents } from "../customComponents/loader";
import { loadPrototypeDraft, loadPrototypeVersion } from "../prototype/loader";
import type { PrototypeDoc } from "../prototype/schema";
import { PlayerNavigationProvider, usePlayerNavigation } from "./navigation";

const Devtools = lazy(async () => ({ default: (await import("@json-render/devtools-react")).JsonRenderDevtools }));

export interface PlayerOutletContext {
  doc: PrototypeDoc;
  registry: ReturnType<typeof createPlayerRuntime>["registry"];
}

function MissingPrototype() {
  return <main className="mx-auto max-w-xl p-8"><h1 className="text-2xl font-bold">Prototype not found</h1><p className="mt-2">This prototype does not exist.</p><Link className="mt-4 inline-block underline" to="/">Back to gallery</Link></main>;
}

function LoadError({ error, retry }: { error: unknown; retry: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  return <main className="mx-auto max-w-xl p-8" role="alert"><h1 className="text-2xl font-bold">Could not load prototype</h1><p className="mt-2 whitespace-pre-wrap">{message}</p><button className="mt-4 underline" onClick={retry}>Retry</button></main>;
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

function ReadyPlayer({ loaded, routeBase }: { loaded: Awaited<ReturnType<typeof loadPrototypeDraft>>; routeBase: string }) {
  const customState = useApi(
    () => loaded.components.length ? loadCustomComponents(loaded.components) : Promise.resolve(undefined),
    [loaded.componentManifestHash],
  );
  if (customState.status === "loading") return <div role="status" aria-label="Loading components" />;
  if (customState.status === "error") return <LoadError error={customState.error} retry={customState.reload} />;
  const revision = "version" in loaded ? `v${loaded.version}` : `r${loaded.rev}`;
  const runtimeKey = `${loaded.doc.id}:${revision}:${loaded.componentManifestHash}:${loaded.doc.designSystem}`;
  return <PlayerNavigationProvider key={runtimeKey} startScreen={loaded.doc.startScreen} routeBase={routeBase}>
    <LoadedPlayer key={runtimeKey} doc={loaded.doc} custom={customState.data} runtimeKey={runtimeKey} />
  </PlayerNavigationProvider>;
}

export function PlayerShell() {
  const { protoId, version } = useParams();
  const numericVersion = version === undefined ? undefined : Number(version);
  const prototypeState = useApi(
    (signal) => version === undefined
      ? loadPrototypeDraft(protoId ?? "", signal)
      : loadPrototypeVersion(protoId ?? "", numericVersion!, signal),
    [protoId, version],
  );
  if (!protoId || (version !== undefined && (!Number.isInteger(numericVersion) || numericVersion! < 1))) return <MissingPrototype />;
  if (prototypeState.status === "loading") return <div role="status" aria-label="Loading prototype" />;
  if (prototypeState.status === "error") {
    if (prototypeState.error instanceof ApiError && prototypeState.error.status === 404) return <MissingPrototype />;
    return <LoadError error={prototypeState.error} retry={prototypeState.reload} />;
  }
  const routeBase = `/p/${encodeURIComponent(protoId)}${version === undefined ? "" : `/v/${numericVersion}`}`;
  return <ReadyPlayer key={`${protoId}:${version ?? "draft"}`} loaded={prototypeState.data} routeBase={routeBase} />;
}
