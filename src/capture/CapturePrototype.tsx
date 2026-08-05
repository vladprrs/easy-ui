import { useCallback, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { useApi } from "../api/hooks";
import { getDesignSystemById, getDesignSystemVersion, getPrototypeDraft, getPrototypeRevisionFull, getPrototypeVersion, type PrototypeComponentPin, type ThemeContent } from "../api/client";
import type { PrototypeDoc } from "../prototype/schema";
import { loadCustomComponents } from "../customComponents/loader";
import type { CustomPlayerRuntime } from "../catalog/runtime";
import { toRuntimeSpec } from "../prototype/runtimeSpec";
import { canonicalViewport } from "../designSystems/deviceMetrics";
import { surfaceDesignSystem, surfaceOf } from "../prototype/surfaces";
import { themeMetaVersion, ThemeStyle } from "../designSystems/theme";
import { SurfaceSpacingScope } from "../designSystems/SurfaceSpacingScope";
import { HostStageSurface } from "../catalog/hostPrimitives";
import { CaptureSurface } from "./CaptureSurface";
import { CaptureStyle, useCaptureTheme, usePublishError, usePublishOnSettle } from "./CaptureChrome";
import { bootstrapRendererBuild, readBootstrap } from "./readiness";
import type { CaptureReady, PrototypeBootstrapTarget, PrototypeCandidateOverlayEntry } from "./protocol";
import { ArchivedPrototype } from "../player/PrototypeLoader";

interface LoadedPrototype {
  doc: PrototypeDoc;
  rev: number;
  prototypeInstanceId: string;
  componentManifestHash: string;
  builtinCatalogHash: string;
  components: PrototypeComponentPin[];
  /**
   * Карта пинов темы ревизии (`designSystemMetaVersions`, миграция v24). Поле аддитивное:
   * ответ сервера без него читается как `{}` — handshake тогда берёт скаляр `dsMetaVersion`.
   */
  themePins: Record<string, number | null>;
  dsMetaVersion: number | null;
  /** ДС **поверхности снимаемого экрана** и её версия темы (D14): по ним грузится тема кадра. */
  screenDesignSystem: string;
  screenMetaVersion: number | null;
  theme: ThemeContent | null;
  renderable: boolean;
}

async function loadTheme(designSystem: string, metaVersion: number | null, signal: AbortSignal): Promise<ThemeContent | null> {
  try {
    const data = metaVersion != null ? await getDesignSystemVersion(designSystem, metaVersion, signal) : await getDesignSystemById(designSystem, signal);
    return { tokens: data.tokens ?? {}, fonts: data.fonts ?? [], icons: data.icons ?? [] };
  } catch { return null; }
}

/**
 * Пины, замороженные постановкой джобы (план 2026-08-02, P2.3). Для track:head-дока DTO
 * ревизии резолвит пины в момент чтения, поэтому publish компонента между enqueue и рендером
 * увёл бы и кадр, и `componentManifestHash` от frozen expected. Bootstrap-цель — существующий
 * канал (воркер инжектит её до навигации), и она в этом случае главнее DTO.
 */
function bootstrapPrototypeTarget(): PrototypeBootstrapTarget | undefined {
  const bootstrap = readBootstrap();
  if (bootstrap?.kind !== "prototype") return undefined;
  const target = bootstrap.target as unknown as PrototypeBootstrapTarget | undefined;
  return target?.kind === "prototype" && Array.isArray(target.components) ? target : undefined;
}

/**
 * Подменённые кандидатами пины overlay-джобы (план 2026-08-05 §B2.7). Поверхность их не выводит:
 * список заморожен постановкой в `expected` и лишь эхорится в ready — ровно как manifest/catalog-хэши.
 */
function bootstrapCandidateOverlay(): PrototypeCandidateOverlayEntry[] | undefined {
  const expected = readBootstrap()?.expected;
  return expected?.kind === "prototype" ? expected.candidateOverlay : undefined;
}

async function loadPrototype(id: string, screenId: string, rev: number | undefined, version: number | undefined, signal: AbortSignal): Promise<LoadedPrototype> {
  const base = version !== undefined ? await getPrototypeVersion(id, version, signal)
    : rev !== undefined ? await getPrototypeRevisionFull(id, rev, signal)
    : await getPrototypeDraft(id, signal);
  const themePins = base.designSystemMetaVersions ?? {};
  // D14: ДС и версия темы берутся у **поверхности снимаемого экрана**. Одно-поверхностный
  // документ даёт `doc.designSystem` и тот же скаляр `designSystemMetaVersion`, что и раньше.
  const screenDesignSystem = surfaceDesignSystem(surfaceOf(base.doc, screenId), base.doc) ?? base.doc.designSystem;
  const dsMetaVersion = base.designSystemMetaVersion ?? null;
  const screenMetaVersion = themeMetaVersion(themePins, screenDesignSystem, dsMetaVersion) ?? null;
  if (base.renderable === false) return { doc: base.doc, rev: base.rev, prototypeInstanceId: base.prototypeInstanceId ?? "archived", componentManifestHash: base.componentManifestHash, builtinCatalogHash: base.builtinCatalogHash, components: [], themePins, dsMetaVersion, screenDesignSystem, screenMetaVersion, theme: null, renderable: false };
  if(!base.prototypeInstanceId) throw new Error("Prototype response is missing prototypeInstanceId");
  const theme = await loadTheme(screenDesignSystem, screenMetaVersion, signal);
  const frozen = bootstrapPrototypeTarget();
  // `status` в загрузчик не едет: он диагностический, а его домен (ComponentStatus) шире
  // строки из bootstrap — пины кадра описываются id/name/version/bundleUrl/bundleHash.
  const components = frozen?.components?.map(({ id, name, version, bundleUrl, bundleHash }) => ({ id, name, version, bundleUrl, bundleHash })) ?? base.components;
  const componentManifestHash = frozen?.componentManifestHash ?? base.componentManifestHash;
  return { doc: base.doc, rev: base.rev, prototypeInstanceId: base.prototypeInstanceId, componentManifestHash, builtinCatalogHash: base.builtinCatalogHash, components, themePins, dsMetaVersion, screenDesignSystem, screenMetaVersion, theme, renderable: true };
}

function LoadedPrototypeCapture({ loaded, custom, screenId }: { loaded: LoadedPrototype; custom?: CustomPlayerRuntime; screenId: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [stageHost, setStageHost] = useState<HTMLDivElement | null>(null);
  const stageHostRef = useMemo(() => ({ current: stageHost }), [stageHost]);
  const setSurfaceRef = useCallback((node: HTMLDivElement | null) => {
    ref.current = node;
    setStageHost(node);
  }, []);
  const { doc } = loaded;
  const screen = doc.screens.find((s) => s.id === screenId);
  const customTypes = useMemo(() => new Set(Object.keys(custom?.definitions ?? {})), [custom]);
  const tree = useMemo(() => (screen ? toRuntimeSpec(screen.spec, { customTypes }) : null), [screen, customTypes]);
  const screenIds = useMemo(() => new Set(doc.screens.map((s) => s.id)), [doc]);

  usePublishError(screen ? null : `Screen not found: ${screenId}`);
  // Резолвнутая пара `(designSystem, dsMetaVersion)` **снимаемого экрана** (multi-surface D14):
  // ДС берётся от поверхности экрана, версия темы — из карты пинов ревизии. Одно-поверхностный
  // документ даёт `doc.designSystem` и тот же скаляр, что и раньше. Ровно эта же пара
  // определяет загруженную тему кадра (`loadPrototype`), поэтому handshake и пиксели не расходятся.
  const { screenDesignSystem, screenMetaVersion } = loaded;
  // D10: устройство поверхности экрана, а не `doc.device` — на дуо-доке это разные значения.
  const screenSurface = surfaceOf(doc, screenId);
  const candidateOverlay = bootstrapCandidateOverlay();
  usePublishOnSettle(ref, (): CaptureReady => ({
    status: "ready", kind: "prototype", revision: loaded.rev,
    prototypeInstanceId: loaded.prototypeInstanceId,
    componentManifestHash: loaded.componentManifestHash, builtinCatalogHash: loaded.builtinCatalogHash,
    designSystem: screenDesignSystem ?? null,
    dsMetaVersion: screenMetaVersion ?? null, rendererBuild: bootstrapRendererBuild(),
    // Эхо `expected.candidateOverlay` (план 2026-08-05 §B2.7): у джобы без подмен поля нет,
    // и пре-образ `readyToExpected` остаётся байт-в-байт прежним.
    ...(candidateOverlay === undefined ? {} : { candidateOverlay }),
  }));

  if (!screen || !tree) return <div ref={ref} data-capture-error="screen-not-found" />;
  const size = screen.canvas ?? canonicalViewport[screenSurface.device] ?? null;
  const style = {
    position: "relative" as const,
    ...(screen.canvas
      ? { width: screen.canvas.width, height: screen.canvas.height }
      : size ? { width: size.width, height: size.height } : { width: "100%" as const }),
  };
  return <SurfaceSpacingScope systemId={screenDesignSystem} themeTokens={loaded.theme?.tokens}>
    <div ref={setSurfaceRef} id="eui-capture-surface" className="bg-background text-foreground" style={style}>
      <ThemeStyle content={loaded.theme} />
      <HostStageSurface stageHostRef={stageHostRef}>
        <CaptureSurface designSystem={screenDesignSystem} custom={custom} tree={tree} initialState={doc.state} computed={doc.computed} screenIds={screenIds} canvas={screen.canvas} hostPrimitivesAllowed={screenSurface.device !== "desktop" || screen.canvas !== undefined} />
      </HostStageSurface>
    </div>
  </SurfaceSpacingScope>;
}

function WithCustom({ loaded, screenId }: { loaded: LoadedPrototype; screenId: string }) {
  const custom = useApi((signal) => loaded.components.length ? loadWithSignal(loaded.components, signal) : Promise.resolve(undefined), [loaded.componentManifestHash]);
  usePublishError(custom.status === "error" ? errorMessage(custom.error) : null);
  if (custom.status === "loading") return <div id="eui-capture-loading" />;
  if (custom.status === "error") return <div data-capture-error="components" />;
  return <LoadedPrototypeCapture loaded={loaded} custom={custom.data} screenId={screenId} />;
}

async function loadWithSignal(components: PrototypeComponentPin[], signal: AbortSignal) {
  const result = await loadCustomComponents(components);
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  return result;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export function CapturePrototype() {
  const { protoId, screenId } = useParams();
  const [search] = useSearchParams();
  const theme = search.get("theme") === "dark" ? "dark" : "light";
  useCaptureTheme(theme);
  const revParam = search.get("rev");
  const versionParam = search.get("version");
  const rev = revParam !== null && /^[1-9][0-9]*$/.test(revParam) ? Number(revParam) : undefined;
  const version = versionParam !== null && /^[1-9][0-9]*$/.test(versionParam) ? Number(versionParam) : undefined;

  const state = useApi((signal) => loadPrototype(protoId ?? "", screenId ?? "", rev, version, signal), [protoId, screenId, rev, version]);
  usePublishError(state.status === "error" ? errorMessage(state.error) : null);

  return <>
    <CaptureStyle />
    {state.status === "loading" ? <div id="eui-capture-loading" />
      : state.status === "error" ? <div data-capture-error="load" />
      : state.data.renderable === false ? <ArchivedPrototype />
        : <WithCustom loaded={state.data} screenId={screenId ?? ""} />}
  </>;
}
