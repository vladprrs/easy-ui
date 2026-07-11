import type { ReactNode } from "react";
import { Link } from "react-router";
import { ApiError, type PrototypeDraft } from "../api/client";
import { useApi } from "../api/hooks";
import type { CustomPlayerRuntime } from "../catalog/runtime";
import { loadCustomComponents } from "../customComponents/loader";
import { loadPrototypeDraft, loadPrototypeVersion } from "../prototype/loader";
import { buildPrototypeRouteBase } from "./navigation";

export function MissingPrototype() {
  return <main className="mx-auto max-w-xl p-8"><h1 className="text-2xl font-bold">Prototype not found</h1><p className="mt-2">This prototype does not exist.</p><Link className="mt-4 inline-block underline" to="/">Back to gallery</Link></main>;
}

export function LoadError({ error, retry }: { error: unknown; retry: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  return <main className="mx-auto max-w-xl p-8" role="alert"><h1 className="text-2xl font-bold">Could not load prototype</h1><p className="mt-2 whitespace-pre-wrap">{message}</p><button className="mt-4 underline" onClick={retry}>Retry</button></main>;
}

export interface PrototypeLoaderResult {
  loaded: PrototypeDraft;
  custom?: CustomPlayerRuntime;
  runtimeKey: string;
  routeBase: string;
}

interface PrototypeLoaderProps {
  protoId?: string;
  version?: number;
  children: (result: PrototypeLoaderResult) => ReactNode;
}

function LoadedPrototype({ loaded, routeBase, children }: {
  loaded: PrototypeDraft;
  routeBase: string;
  children: PrototypeLoaderProps["children"];
}) {
  const customState = useApi(
    () => loaded.components.length ? loadCustomComponents(loaded.components) : Promise.resolve(undefined),
    [loaded.componentManifestHash],
  );
  if (customState.status === "loading") return <div role="status" aria-label="Loading components" />;
  if (customState.status === "error") return <LoadError error={customState.error} retry={customState.reload} />;
  const revision = "version" in loaded ? `v${loaded.version}` : `r${loaded.rev}`;
  const runtimeKey = `${loaded.doc.id}:${revision}:${loaded.componentManifestHash}:${loaded.doc.designSystem}`;
  return children({ loaded, custom: customState.data, runtimeKey, routeBase });
}

export function PrototypeLoader({ protoId, version, children }: PrototypeLoaderProps) {
  const prototypeState = useApi(
    (signal) => version === undefined
      ? loadPrototypeDraft(protoId ?? "", signal)
      : loadPrototypeVersion(protoId ?? "", version, signal),
    [protoId, version],
  );
  if (!protoId || (version !== undefined && (!Number.isInteger(version) || version < 1))) return <MissingPrototype />;
  if (prototypeState.status === "loading") return <div role="status" aria-label="Loading prototype" />;
  if (prototypeState.status === "error") {
    if (prototypeState.error instanceof ApiError && prototypeState.error.status === 404) return <MissingPrototype />;
    return <LoadError error={prototypeState.error} retry={prototypeState.reload} />;
  }
  const revision = "version" in prototypeState.data ? `v${prototypeState.data.version}` : `r${prototypeState.data.rev}`;
  const runtimeKey = `${prototypeState.data.doc.id}:${revision}:${prototypeState.data.componentManifestHash}:${prototypeState.data.doc.designSystem}`;
  return <LoadedPrototype key={runtimeKey} loaded={prototypeState.data} routeBase={buildPrototypeRouteBase(protoId, version)}>{children}</LoadedPrototype>;
}
