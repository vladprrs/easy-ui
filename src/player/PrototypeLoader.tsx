import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { ApiError, type PrototypeComponentPin, type PrototypeDraft } from "../api/client";
import { docSurfaces, surfaceDesignSystem } from "../prototype/surfaces";
import { useApi } from "../api/hooks";
import type { CustomPlayerRuntime } from "../catalog/runtime";
import { loadCustomComponents } from "../customComponents/loader";
import { loadPrototypeDraft, loadPrototypeVersion } from "../prototype/loader";
import { buildPrototypeRouteBase } from "./navigation";
import { pillGhost, pillPrimary } from "../app/chrome";
import { EmptyState, ErrorState, Skeleton } from "../app/states";
import { common, formatApiError } from "../app/strings/common";
import { loader } from "../app/strings/player";
import { useDocumentTitle } from "../app/useDocumentTitle";

/** Колонка под состояние: сами блоки приходят из общего `app/states.tsx`. */
const loaderColumn = "mx-auto w-full max-w-xl";

export function MissingPrototype() {
  useDocumentTitle(loader.missingTitle);
  return <main className={loaderColumn}>
    <EmptyState
      title={loader.missingTitle}
      description={loader.missingBody}
      primary={<Link className={pillPrimary} to="/">{common.backToGallery}</Link>}
    />
  </main>;
}

/**
 * Архивная ревизия. Состояние рисуется и на всю страницу, и внутри превью карточки
 * галереи (196px), поэтому это компактная панель без мотив-кругов и дисплейного
 * заголовка — иначе в плитке оно не помещается.
 */
export function ArchivedPrototype() {
  useDocumentTitle(loader.archivedTitle);
  return <main className={`${loaderColumn} rounded-panel bg-white p-5 text-center`} data-prototype-archived="true" role="status">
    <h1 className="text-base font-medium">{loader.archivedTitle}</h1>
    <p className="mt-2 text-[13px] text-eui-slate-500">{loader.archivedBody}</p>
    <Link className={`${pillGhost} mt-4`} to="/">{common.backToGallery}</Link>
  </main>;
}

// version_not_found (W0-4): the prototype exists, but the requested published version does not.
// «Открыть текущую» keeps the surface (player/CJM/screen) by stripping the /v/{version} segment.
export function MissingVersion({ protoId, version }: { protoId: string; version: number }) {
  useDocumentTitle(loader.missingVersionTitle(version));
  const location = useLocation();
  const currentPath = location.pathname.replace(`/v/${version}`, "") || buildPrototypeRouteBase(protoId);
  return <main className={loaderColumn}>
    <EmptyState
      circles={false}
      title={loader.missingVersionTitle(version)}
      description={loader.missingVersionBody(version)}
      primary={<Link className={pillPrimary} to={currentPath}>{loader.openCurrent}</Link>}
      secondary={<Link className={pillGhost} to="/">{loader.toGallery}</Link>}
    />
  </main>;
}

export function LoadError({ error, retry }: { error: unknown; retry: () => void }) {
  useDocumentTitle(loader.loadErrorTitle);
  const message = error instanceof ApiError
    ? formatApiError(error.code, { message: error.message, status: error.status, currentRev: error.currentRev, currentVersion: error.currentVersion })
    : error instanceof Error ? error.message : String(error);
  return <main className={loaderColumn}>
    <ErrorState
      title={loader.loadErrorTitle}
      description={<span className="whitespace-pre-wrap">{message}</span>}
      retryLabel={common.retry}
      onRetry={retry}
    />
  </main>;
}

/** Одна пульсирующая панель вместо абзаца «Загрузка…»: тот же ритм, что в галерее. */
function LoaderSkeleton({ label }: { label: string }) {
  return <main className={loaderColumn}>
    <Skeleton label={label} count={1} previewHeight={320} gridClassName="grid gap-5" />
  </main>;
}

export interface PrototypeLoaderResult {
  loaded: PrototypeDraft;
  custom?: CustomPlayerRuntime;
  runtimeKey: string;
  routeBase: string;
}

/**
 * Дизайн-системы документа (план multi-surface, D8): ДС каждой поверхности, без повторов, в
 * порядке поверхностей. Документ без `surfaces` даёт ровно `[doc.designSystem]`.
 */
export function documentDesignSystems(doc: PrototypeDraft["doc"]): string[] {
  const systems = docSurfaces(doc).map((surface) => surfaceDesignSystem(surface, doc) ?? doc.designSystem);
  return [...new Set(systems)];
}

/**
 * Ключ рантайм-сессии. На дуо-доке в него входят **все** ДС документа: смена ДС любой
 * поверхности обязана пересоздать реестры, стор и тему. Одно-поверхностный документ даёт
 * ту же строку, что и раньше (единственная ДС — `doc.designSystem`).
 */
export function prototypeRuntimeKey(loaded: PrototypeDraft): string {
  const revision = "version" in loaded ? `v${(loaded as { version: number }).version}` : `r${loaded.rev}`;
  return `${loaded.doc.id}:${revision}:${loaded.componentManifestHash}:${documentDesignSystems(loaded.doc).join("+")}`;
}

/**
 * `имя компонента → его ДС` из пинов ревизии (D8). Сервер поле не обязан отдавать —
 * тогда карта пуста и per-surface реестры не сужаются (см. `scopeCustomRuntime`).
 */
export function pinDesignSystems(pins: readonly PrototypeComponentPin[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const pin of pins) if (pin.designSystem !== undefined) map[pin.name] = pin.designSystem;
  return map;
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
  if (customState.status === "loading") return <LoaderSkeleton label={loader.loadingComponents} />;
  if (customState.status === "error") return <LoadError error={customState.error} retry={customState.reload} />;
  return children({ loaded, custom: customState.data, runtimeKey: prototypeRuntimeKey(loaded), routeBase });
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
  if (prototypeState.status === "loading") return <LoaderSkeleton label={loader.loadingPrototype} />;
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
  const runtimeKey = prototypeRuntimeKey(prototypeState.data);
  return <LoadedPrototype key={runtimeKey} loaded={prototypeState.data} routeBase={buildPrototypeRouteBase(protoId, version)}>{children}</LoadedPrototype>;
}
