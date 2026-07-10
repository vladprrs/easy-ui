import { JSONUIProvider } from "@json-render/react";
import { lazy, Suspense, useEffect, useMemo, useRef } from "react";
import { Link, Outlet, useParams } from "react-router";
import { createPlayerRuntime } from "../catalog/runtime";
import { prototypesById } from "../prototype/loader";
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

function LoadedPlayer({ doc }: { doc: PrototypeDoc }) {
  const navigation = usePlayerNavigation();
  const navigationRef = useRef(navigation);
  useEffect(() => { navigationRef.current = navigation; }, [navigation]);
  // The runtime is intentionally created once. ActionProvider captures handlers
  // at mount, while these callbacks read the latest router API when invoked.
  // eslint-disable-next-line react-hooks/refs
  const runtime = useMemo(() => createPlayerRuntime({
    navigate: (screenId) => navigationRef.current.navigate(screenId),
    back: () => navigationRef.current.back(),
    openUrl: (url) => { window.open(url, "_blank", "noopener,noreferrer"); },
    restart: () => navigationRef.current.restart(),
  }), []);

  return (
    <JSONUIProvider key={`${doc.id}:${navigation.sessionNonce}`} registry={runtime.registry} handlers={runtime.handlers} initialState={doc.state}>
      <Outlet context={{ doc, registry: runtime.registry } satisfies PlayerOutletContext} />
      {import.meta.env.DEV ? <Suspense fallback={null}><Devtools /></Suspense> : null}
    </JSONUIProvider>
  );
}

export function PlayerShell() {
  const { protoId } = useParams();
  const doc = protoId ? prototypesById.get(protoId) : undefined;
  if (!doc) return <MissingPrototype />;
  return <PlayerNavigationProvider key={doc.id} startScreen={doc.startScreen}><LoadedPlayer doc={doc} /></PlayerNavigationProvider>;
}
