import { useEffect, useMemo, useRef } from "react";
import { useParams, useSearchParams } from "react-router";
import { useApi } from "../api/hooks";
import { getComponentMeta, getComponentVersion, type ComponentVersion } from "../api/client";
import { loadCustomComponents } from "../customComponents/loader";
import type { CustomPlayerRuntime } from "../catalog/runtime";
import { toRuntimeSpec } from "../prototype/runtimeSpec";
import { CaptureSurface } from "./CaptureSurface";
import { CaptureStyle, useCaptureTheme, usePublishError } from "./CaptureChrome";
import { bootstrapRendererBuild, publishReady, readBootstrap, settleSurface } from "./readiness";
import { propsHashBrowser } from "./propsHash";

interface LoadedComponent {
  id: string;
  name: string;
  version: ComponentVersion;
  props: Record<string, unknown>;
}

async function loadComponent(id: string, version: number, propsFromUrlExample: boolean, signal: AbortSignal): Promise<LoadedComponent> {
  const [meta, versionDto] = await Promise.all([getComponentMeta(id, signal), getComponentVersion(id, version, signal)]);
  const bootstrap = readBootstrap();
  const props = bootstrap?.kind === "component" && bootstrap.props
    ? bootstrap.props
    : propsFromUrlExample && versionDto.example ? versionDto.example : {};
  return { id, name: meta.name, version: versionDto, props };
}

function LoadedComponentCapture({ loaded, custom }: { loaded: LoadedComponent; custom: CustomPlayerRuntime }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { name, props, version } = loaded;
  const tree = useMemo(() => toRuntimeSpec(
    { root: "c", elements: { c: { type: name, props } } } as Parameters<typeof toRuntimeSpec>[0],
    { customTypes: new Set([name]) },
  ), [name, props]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const propsHash = await propsHashBrowser(props);
        await settleSurface(ref.current ?? document);
        if (!cancelled) publishReady({
          status: "ready", kind: "component", componentId: loaded.id, version: version.version,
          bundleHash: version.bundleHash, propsHash, dsMetaVersion: null, rendererBuild: bootstrapRendererBuild(),
        });
      } catch (error) {
        if (!cancelled) publishReady({ status: "error", error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={ref} id="eui-capture-surface" className="bg-background text-foreground inline-block">
    <CaptureSurface designSystem={version.designSystem} custom={custom} tree={tree} initialState={{}} screenIds={new Set()} />
  </div>;
}

function WithComponent({ loaded }: { loaded: LoadedComponent }) {
  const custom = useApi((signal) => loadComponentRuntime(loaded, signal), [loaded.id, loaded.version.version]);
  usePublishError(custom.status === "error" ? errorMessage(custom.error) : null);
  if (custom.status === "loading") return <div id="eui-capture-loading" />;
  if (custom.status === "error") return <div data-capture-error="components" />;
  return <LoadedComponentCapture loaded={loaded} custom={custom.data} />;
}

async function loadComponentRuntime(loaded: LoadedComponent, signal: AbortSignal): Promise<CustomPlayerRuntime> {
  const result = await loadCustomComponents([{
    id: loaded.id, name: loaded.name, version: loaded.version.version,
    bundleUrl: `/api/components/${encodeURIComponent(loaded.id)}/versions/${loaded.version.version}/bundle.js`,
    bundleHash: loaded.version.bundleHash,
  }]);
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  return result;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export function CaptureComponent() {
  const { id, version } = useParams();
  const [search] = useSearchParams();
  const theme = search.get("theme") === "dark" ? "dark" : "light";
  useCaptureTheme(theme);
  const versionNumber = version !== undefined && /^[1-9][0-9]*$/.test(version) ? Number(version) : undefined;
  const wantsExample = search.get("props") === "example";

  const state = useApi((signal) => loadComponent(id ?? "", versionNumber ?? 0, wantsExample, signal), [id, versionNumber, wantsExample]);
  usePublishError(state.status === "error" ? errorMessage(state.error) : versionNumber === undefined ? "Invalid version" : null);

  return <>
    <CaptureStyle />
    {versionNumber === undefined ? <div data-capture-error="version" />
      : state.status === "loading" ? <div id="eui-capture-loading" />
      : state.status === "error" ? <div data-capture-error="load" />
      : <WithComponent loaded={state.data} />}
  </>;
}
