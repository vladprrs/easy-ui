import { useMemo, useRef } from "react";
import { useParams, useSearchParams } from "react-router";
import { useApi } from "../api/hooks";
import { getPrototypeDraft, getPrototypeRevisionFull, getPrototypeVersion, type PrototypeComponentPin } from "../api/client";
import type { PrototypeDoc } from "../prototype/schema";
import { loadCustomComponents } from "../customComponents/loader";
import type { CustomPlayerRuntime } from "../catalog/runtime";
import { toRuntimeSpec } from "../prototype/runtimeSpec";
import { CaptureSurface } from "./CaptureSurface";
import { CaptureStyle, useCaptureTheme, usePublishError, usePublishOnSettle } from "./CaptureChrome";
import { bootstrapRendererBuild } from "./readiness";
import type { CaptureReady } from "./protocol";

interface LoadedPrototype {
  doc: PrototypeDoc;
  rev: number;
  componentManifestHash: string;
  builtinCatalogHash: string;
  components: PrototypeComponentPin[];
}

const deviceSizes: Record<string, { width: number; height: number } | null> = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 834, height: 1112 },
  desktop: null,
};

async function loadPrototype(id: string, rev: number | undefined, version: number | undefined, signal: AbortSignal): Promise<LoadedPrototype> {
  if (version !== undefined) { const v = await getPrototypeVersion(id, version, signal); return { doc: v.doc, rev: v.rev, componentManifestHash: v.componentManifestHash, builtinCatalogHash: v.builtinCatalogHash, components: v.components }; }
  if (rev !== undefined) { const r = await getPrototypeRevisionFull(id, rev, signal); return { doc: r.doc, rev: r.rev, componentManifestHash: r.componentManifestHash, builtinCatalogHash: r.builtinCatalogHash, components: r.components }; }
  const d = await getPrototypeDraft(id, signal); return { doc: d.doc, rev: d.rev, componentManifestHash: d.componentManifestHash, builtinCatalogHash: d.builtinCatalogHash, components: d.components };
}

function LoadedPrototypeCapture({ loaded, custom, screenId }: { loaded: LoadedPrototype; custom?: CustomPlayerRuntime; screenId: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { doc } = loaded;
  const screen = doc.screens.find((s) => s.id === screenId);
  const customTypes = useMemo(() => new Set(Object.keys(custom?.definitions ?? {})), [custom]);
  const tree = useMemo(() => (screen ? toRuntimeSpec(screen.spec, { customTypes }) : null), [screen, customTypes]);
  const screenIds = useMemo(() => new Set(doc.screens.map((s) => s.id)), [doc]);

  usePublishError(screen ? null : `Screen not found: ${screenId}`);
  usePublishOnSettle(ref, (): CaptureReady => ({
    status: "ready", kind: "prototype", revision: loaded.rev,
    componentManifestHash: loaded.componentManifestHash, builtinCatalogHash: loaded.builtinCatalogHash,
    dsMetaVersion: null, rendererBuild: bootstrapRendererBuild(),
  }));

  if (!screen || !tree) return <div ref={ref} data-capture-error="screen-not-found" />;
  const size = screen.canvas ?? deviceSizes[doc.device] ?? null;
  const style = screen.canvas
    ? { width: screen.canvas.width, height: screen.canvas.height }
    : size ? { width: size.width, height: size.height } : { width: "100%" as const };
  return <div ref={ref} id="eui-capture-surface" className="bg-background text-foreground" style={style}>
    <CaptureSurface designSystem={doc.designSystem} custom={custom} tree={tree} initialState={doc.state} screenIds={screenIds} canvas={screen.canvas} />
  </div>;
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
