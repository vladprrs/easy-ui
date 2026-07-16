import { useCallback, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { useApi } from "../api/hooks";
import { getDesignSystemById, getDesignSystemVersion, getPrototypeDraft, getPrototypeRevisionFull, getPrototypeVersion, type PrototypeComponentPin, type ThemeContent } from "../api/client";
import type { PrototypeDoc } from "../prototype/schema";
import { loadCustomComponents } from "../customComponents/loader";
import type { CustomPlayerRuntime } from "../catalog/runtime";
import { toRuntimeSpec } from "../prototype/runtimeSpec";
import { canonicalViewport } from "../designSystems/deviceMetrics";
import { ThemeStyle } from "../designSystems/theme";
import { SurfaceSpacingScope } from "../designSystems/SurfaceSpacingScope";
import { HostStageSurface } from "../catalog/hostPrimitives";
import { CaptureSurface } from "./CaptureSurface";
import { CaptureStyle, useCaptureTheme, usePublishError, usePublishOnSettle } from "./CaptureChrome";
import { bootstrapRendererBuild } from "./readiness";
import type { CaptureReady } from "./protocol";

interface LoadedPrototype {
  doc: PrototypeDoc;
  rev: number;
  prototypeInstanceId: string;
  componentManifestHash: string;
  builtinCatalogHash: string;
  components: PrototypeComponentPin[];
  dsMetaVersion: number | null;
  theme: ThemeContent | null;
}

async function loadTheme(designSystem: string, metaVersion: number | null, signal: AbortSignal): Promise<ThemeContent | null> {
  try {
    const data = metaVersion != null ? await getDesignSystemVersion(designSystem, metaVersion, signal) : await getDesignSystemById(designSystem, signal);
    return { tokens: data.tokens ?? {}, fonts: data.fonts ?? [], icons: data.icons ?? [] };
  } catch { return null; }
}

async function loadPrototype(id: string, rev: number | undefined, version: number | undefined, signal: AbortSignal): Promise<LoadedPrototype> {
  const base = version !== undefined ? await getPrototypeVersion(id, version, signal)
    : rev !== undefined ? await getPrototypeRevisionFull(id, rev, signal)
    : await getPrototypeDraft(id, signal);
  const dsMetaVersion = base.designSystemMetaVersion ?? null;
  if(!base.prototypeInstanceId) throw new Error("Prototype response is missing prototypeInstanceId");
  const theme = await loadTheme(base.doc.designSystem, dsMetaVersion, signal);
  return { doc: base.doc, rev: base.rev, prototypeInstanceId: base.prototypeInstanceId, componentManifestHash: base.componentManifestHash, builtinCatalogHash: base.builtinCatalogHash, components: base.components, dsMetaVersion, theme };
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
  usePublishOnSettle(ref, (): CaptureReady => ({
    status: "ready", kind: "prototype", revision: loaded.rev,
    prototypeInstanceId: loaded.prototypeInstanceId,
    componentManifestHash: loaded.componentManifestHash, builtinCatalogHash: loaded.builtinCatalogHash,
    dsMetaVersion: loaded.dsMetaVersion, rendererBuild: bootstrapRendererBuild(),
  }));

  if (!screen || !tree) return <div ref={ref} data-capture-error="screen-not-found" />;
  const size = screen.canvas ?? canonicalViewport[doc.device] ?? null;
  const style = {
    position: "relative" as const,
    ...(screen.canvas
      ? { width: screen.canvas.width, height: screen.canvas.height }
      : size ? { width: size.width, height: size.height } : { width: "100%" as const }),
  };
  return <SurfaceSpacingScope systemId={doc.designSystem} themeTokens={loaded.theme?.tokens}>
    <div ref={setSurfaceRef} id="eui-capture-surface" className="bg-background text-foreground" style={style}>
      <ThemeStyle content={loaded.theme} />
      <HostStageSurface stageHostRef={stageHostRef}>
        <CaptureSurface designSystem={doc.designSystem} custom={custom} tree={tree} initialState={doc.state} screenIds={screenIds} canvas={screen.canvas} hostPrimitivesAllowed={doc.device !== "desktop" || screen.canvas !== undefined} />
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

  const state = useApi((signal) => loadPrototype(protoId ?? "", rev, version, signal), [protoId, rev, version]);
  usePublishError(state.status === "error" ? errorMessage(state.error) : null);

  return <>
    <CaptureStyle />
    {state.status === "loading" ? <div id="eui-capture-loading" />
      : state.status === "error" ? <div data-capture-error="load" />
      : <WithCustom loaded={state.data} screenId={screenId ?? ""} />}
  </>;
}
