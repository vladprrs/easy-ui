import { useEffect, useMemo, useRef } from "react";
import { useParams, useSearchParams } from "react-router";
import { useApi } from "../api/hooks";
import { getComponentMeta, getComponentVersion, getDesignSystemById, type ComponentVersion, type ThemeContent } from "../api/client";
import { loadCustomComponents } from "../customComponents/loader";
import type { CustomPlayerRuntime } from "../catalog/runtime";
import { toRuntimeSpec } from "../prototype/runtimeSpec";
import { ThemeStyle } from "../designSystems/theme";
import { SurfaceSpacingScope } from "../designSystems/SurfaceSpacingScope";
import { CaptureSurface } from "./CaptureSurface";
import { CaptureStyle, useCaptureTheme, usePublishError } from "./CaptureChrome";
import { bootstrapRendererBuild, publishReady, readBootstrap, settleSurface } from "./readiness";
import { propsHashBrowser } from "./propsHash";

interface LoadedComponent {
  id: string;
  name: string;
  version: ComponentVersion;
  props: Record<string, unknown>;
  dsMetaVersion: number | null;
  theme: ThemeContent | null;
}

type PropsSelection =
  | { kind: "empty" }
  | { kind: "legacy" }
  | { kind: "named"; name: string }
  | { kind: "error"; message: string };

function propsSelection(search: URLSearchParams): PropsSelection {
  const examples = search.getAll("example");
  const props = search.getAll("props");
  if (examples.length > 1 || props.length > 1) return { kind: "error", message: "Duplicate props selector" };
  if (props.length === 1 && props[0] !== "example") return { kind: "error", message: "Invalid props selector" };
  if (examples.length === 1) return { kind: "named", name: examples[0] };
  if (props.length === 1) return { kind: "legacy" };
  return { kind: "empty" };
}

function selectedProps(versionDto: ComponentVersion, selection: PropsSelection): Record<string, unknown> {
  const bootstrap = readBootstrap();
  if (bootstrap?.kind === "component" && bootstrap.props) return bootstrap.props;
  if (selection.kind === "error") throw new Error(selection.message);
  if (selection.kind === "legacy") {
    if (!versionDto.example) throw new Error("Example props are not available");
    return versionDto.example;
  }
  if (selection.kind === "named") {
    const examples = versionDto.examples ?? Object.create(null) as Record<string, Record<string, unknown>>;
    if (!Object.hasOwn(examples, selection.name)) throw new Error(`Unknown example: ${selection.name}`);
    return examples[selection.name];
  }
  return {};
}

async function loadComponent(id: string, version: number, selection: PropsSelection, signal: AbortSignal): Promise<LoadedComponent> {
  const [meta, versionDto] = await Promise.all([getComponentMeta(id, signal), getComponentVersion(id, version, signal)]);
  const props = selectedProps(versionDto, selection);
  // Components are not theme-pinned: use the latest theme of the component's design system.
  let dsMetaVersion: number | null = null; let theme: ThemeContent | null = null;
  try { const ds = await getDesignSystemById(versionDto.designSystem, signal); dsMetaVersion = ds.latestMetaVersion ?? null; theme = { tokens: ds.tokens ?? {}, fonts: ds.fonts ?? [], icons: ds.icons ?? [] }; } catch { /* theme is best-effort */ }
  return { id, name: meta.name, version: versionDto, props, dsMetaVersion, theme };
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
          bundleHash: version.bundleHash, propsHash, dsMetaVersion: loaded.dsMetaVersion, rendererBuild: bootstrapRendererBuild(),
        });
      } catch (error) {
        if (!cancelled) publishReady({ status: "error", error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <SurfaceSpacingScope systemId={version.designSystem} themeTokens={loaded.theme?.tokens}>
    <div ref={ref} id="eui-capture-surface" className="bg-background text-foreground inline-block">
      <ThemeStyle content={loaded.theme} />
      <CaptureSurface designSystem={version.designSystem} custom={custom} tree={tree} initialState={{}} screenIds={new Set()} />
    </div>
  </SurfaceSpacingScope>;
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
  const selection = useMemo(() => propsSelection(search), [search]);

  const state = useApi((signal) => loadComponent(id ?? "", versionNumber ?? 0, selection, signal), [id, versionNumber, selection]);
  usePublishError(state.status === "error" ? errorMessage(state.error) : versionNumber === undefined ? "Invalid version" : null);

  return <>
    <CaptureStyle />
    {versionNumber === undefined ? <div data-capture-error="version" />
      : state.status === "loading" ? <div id="eui-capture-loading" />
      : state.status === "error" ? <div data-capture-error="load" />
      : <WithComponent loaded={state.data} />}
  </>;
}
