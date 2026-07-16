import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { ApiError, type PrototypeDraft } from "../api/client";
import { useApi } from "../api/hooks";
import type { CustomPlayerRuntime } from "../catalog/runtime";
import { loadCustomComponents } from "../customComponents/loader";
import { loadPrototypeDraft, loadPrototypeVersion } from "../prototype/loader";
import { buildPrototypeRouteBase } from "./navigation";
import { common, formatApiError } from "../app/strings/common";
import { loader } from "../app/strings/player";
import { useDocumentTitle } from "../app/useDocumentTitle";

const loaderPlate = "mx-auto max-w-xl rounded-2xl bg-eui-lilac-100 p-6 text-center font-eui-ui text-eui-ink";

export function MissingPrototype() {
  useDocumentTitle(loader.missingTitle);
  return <main className={loaderPlate}><h1 className="text-2xl font-bold">{loader.missingTitle}</h1><p className="mt-2">{loader.missingBody}</p><Link className="mt-4 inline-block underline" to="/">{common.backToGallery}</Link></main>;
}

export function ArchivedPrototype() {
  useDocumentTitle(loader.archivedTitle);
  return <main className={loaderPlate} data-prototype-archived="true" role="status"><h1 className="text-2xl font-bold">{loader.archivedTitle}</h1><p className="mt-2">{loader.archivedBody}</p><Link className="mt-4 inline-block underline" to="/">{common.backToGallery}</Link></main>;
}

// version_not_found (W0-4): the prototype exists, but the requested published version does not.
// «Открыть текущую» keeps the surface (player/CJM/screen) by stripping the /v/{version} segment.
export function MissingVersion({ protoId, version }: { protoId: string; version: number }) {
  useDocumentTitle(loader.missingVersionTitle(version));
  const location = useLocation();
  const currentPath = location.pathname.replace(`/v/${version}`, "") || buildPrototypeRouteBase(protoId);
  return (
    <main className={loaderPlate} role="alert">
      <h1 className="text-2xl font-bold">{loader.missingVersionTitle(version)}</h1>
      <p className="mt-2">{loader.missingVersionBody(version)}</p>
      <p className="mt-4 flex justify-center gap-4">
        <Link className="underline" to={currentPath}>{loader.openCurrent}</Link>
        <Link className="underline" to="/">{loader.toGallery}</Link>
      </p>
    </main>
  );
}

export function LoadError({ error, retry }: { error: unknown; retry: () => void }) {
  useDocumentTitle(loader.loadErrorTitle);
  const message = error instanceof ApiError
    ? formatApiError(error.code, { message: error.message, status: error.status, currentRev: error.currentRev, currentVersion: error.currentVersion })
    : error instanceof Error ? error.message : String(error);
  return <main className={loaderPlate} role="alert"><h1 className="text-2xl font-bold">{loader.loadErrorTitle}</h1><p className="mt-2 whitespace-pre-wrap">{message}</p><button className="mt-4 underline" onClick={retry}>{common.retry}</button></main>;
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
  allowArchivedPlaceholder?: boolean;
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
  // Loading-title до готовности; после загрузки title ставит страница-потребитель (undefined = пропуск).
  useDocumentTitle(customState.status === "loading" ? loader.loadingPrototype : undefined);
  if (customState.status === "loading") return <div className={loaderPlate} role="status" aria-label={loader.loadingComponents}>{loader.loadingPrototype}</div>;
  if (customState.status === "error") return <LoadError error={customState.error} retry={customState.reload} />;
  const revision = "version" in loaded ? `v${loaded.version}` : `r${loaded.rev}`;
  const runtimeKey = `${loaded.doc.id}:${revision}:${loaded.componentManifestHash}:${loaded.doc.designSystem}`;
  return children({ loaded, custom: customState.data, runtimeKey, routeBase });
}

export function PrototypeLoader({ protoId, version, allowArchivedPlaceholder = true, children }: PrototypeLoaderProps) {
  const prototypeState = useApi(
    (signal) => version === undefined
      ? loadPrototypeDraft(protoId ?? "", signal)
      : loadPrototypeVersion(protoId ?? "", version, signal),
    [protoId, version],
  );
  const invalidRoute = !protoId || (version !== undefined && (!Number.isInteger(version) || version < 1));
  // Loading-title до готовности; после загрузки title ставит страница-потребитель (undefined = пропуск).
  useDocumentTitle(!invalidRoute && prototypeState.status === "loading" ? loader.loadingPrototype : undefined);
  if (invalidRoute) return <MissingPrototype />;
  if (prototypeState.status === "loading") return <div className={loaderPlate} role="status" aria-label={loader.loadingPrototype}>{loader.loadingPrototype}</div>;
  if (prototypeState.status === "error") {
    if (prototypeState.error instanceof ApiError && prototypeState.error.status === 404) {
      if (prototypeState.error.code === "version_not_found" && version !== undefined) return <MissingVersion protoId={protoId} version={version} />;
      return <MissingPrototype />;
    }
    return <LoadError error={prototypeState.error} retry={prototypeState.reload} />;
  }
  // This is the single frontend renderability gate: no component bundle is
  // requested and no runtime is created for an archived revision.
  if (prototypeState.data.renderable === false) return allowArchivedPlaceholder ? <ArchivedPrototype /> : <MissingPrototype />;
  const revision = "version" in prototypeState.data ? `v${prototypeState.data.version}` : `r${prototypeState.data.rev}`;
  const runtimeKey = `${prototypeState.data.doc.id}:${revision}:${prototypeState.data.componentManifestHash}:${prototypeState.data.doc.designSystem}`;
  return <LoadedPrototype key={runtimeKey} loaded={prototypeState.data} routeBase={buildPrototypeRouteBase(protoId, version)}>{children}</LoadedPrototype>;
}
