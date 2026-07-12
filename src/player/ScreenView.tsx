import { Renderer } from "@json-render/react";
import { Component, type ErrorInfo, type ReactNode, useEffect, useMemo } from "react";
import { Link, useOutletContext, useParams } from "react-router";
import type { PlayerOutletContext } from "./PlayerShell";
import { DeviceFrame } from "./DeviceFrame";
import { ScreensSidebar } from "./ScreensSidebar";
import { usePlayerNavigation } from "./navigation";
import { splitCanvas, toRuntimeSpec } from "../prototype/runtimeSpec";
import { CanvasLayers } from "./CanvasLayers";
import { EasyUiRuntimeProvider } from "./easyUiRuntime";
import { pillGhostOnDark } from "../app/chrome";

export class ScreenErrorBoundary extends Component<{
  prototypeId: string;
  screenId: string;
  restart: () => void;
  children: ReactNode;
}, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) console.error(`[player] ${this.props.prototypeId}/${this.props.screenId}`, error, info);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return <section role="alert" className="rounded-2xl bg-white/10 p-6 text-eui-orange">
      <h1 className="font-eui-display text-xl font-bold">This screen could not be rendered</h1>
      <p className="mt-2 font-mono text-sm text-eui-ondark-2">Prototype: {this.props.prototypeId} · Screen: {this.props.screenId}</p>
      <p className="mt-2 text-sm">{this.state.error.message}</p>
      <button type="button" className={`${pillGhostOnDark} mt-4 font-eui-ui`} onClick={this.props.restart}>Restart</button>
    </section>;
  }
}

export function ScreenView() {
  const { doc, registry, runtime, customTypes, customDefinitions, onError } = useOutletContext<PlayerOutletContext>();
  const { screenId } = useParams();
  const { version } = useParams();
  const navigation = usePlayerNavigation();
  const screen = doc.screens.find((item) => item.id === screenId);
  const screenSpec = screen?.spec;
  const screenCanvas = screen?.canvas;
  const tree = useMemo(() => (screenSpec ? toRuntimeSpec(screenSpec, { customTypes }) : null), [screenSpec, customTypes]);
  const specs = useMemo(() => {
    if (!tree) return null;
    if (screenCanvas) { const { content, hotspots } = splitCanvas(tree); return { content: content?.spec ?? null, hotspots: hotspots.map((h) => h.spec) }; }
    return { content: tree.spec, hotspots: [] };
  }, [screenCanvas, tree]);
  useEffect(() => { runtime.setScreenSpec(specs?.content ?? null); return () => runtime.setScreenSpec(null); }, [runtime, specs]);
  if (!screen) return <main className="flex h-full items-start justify-center bg-eui-graphite p-8 text-white"><section className="w-full max-w-xl rounded-2xl bg-white/10 p-6 text-eui-orange"><h1 className="font-eui-display text-2xl font-bold">Screen not found</h1><p className="mt-2 text-eui-ondark-2">This screen does not exist in “{doc.name}”.</p><Link className={`${pillGhostOnDark} mt-4 font-eui-ui`} to="/">Back to gallery</Link></section></main>;

  const rendered = <EasyUiRuntimeProvider value={{ metadata: tree!.metadata, runtime, definitions: customDefinitions, onError }}>
    {screen.canvas
      ? <CanvasLayers canvas={screen.canvas} specs={specs!} registry={registry} />
      : <Renderer registry={registry} spec={specs!.content!} />}
  </EasyUiRuntimeProvider>;

  return <main className="flex h-full min-h-0 flex-col bg-eui-graphite text-white">
    <header className="flex items-center gap-4 border-b border-white/15 px-6 py-3 font-eui-ui">
      <Link className="text-sm text-eui-ondark-2 hover:text-white" to="/">← Галерея</Link>
      <h1 className="font-eui-display font-medium text-white">{doc.name}</h1>
      {version === undefined ? null : <span className="rounded-full bg-white/10 px-3 py-1 text-xs text-white">v{version}</span>}
      <div className="ml-auto flex gap-2">
        <button type="button" onClick={navigation.back} disabled={navigation.flowDepth === 0} className={`${pillGhostOnDark} disabled:opacity-50`}>Back</button>
        <button type="button" onClick={navigation.restart} className={pillGhostOnDark}>Restart</button>
        <Link className={pillGhostOnDark} to={`${version === undefined ? `/p/${doc.id}` : `/p/${doc.id}/v/${version}`}/cjm`}>CJM</Link>
      </div>
    </header>
    <div className="flex min-h-0 flex-1">
      <ScreensSidebar doc={doc} currentScreen={screen.id} />
      <DeviceFrame defaultDevice={doc.device} canvas={screen.canvas}>
        <ScreenErrorBoundary key={screen.id} prototypeId={doc.id} screenId={screen.id} restart={navigation.restart}>{rendered}</ScreenErrorBoundary>
      </DeviceFrame>
    </div>
  </main>;
}
