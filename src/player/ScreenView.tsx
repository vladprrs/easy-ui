import { Renderer } from "@json-render/react";
import { Component, type ErrorInfo, type ReactNode, useMemo } from "react";
import { Link, useOutletContext, useParams } from "react-router";
import type { PlayerOutletContext } from "./PlayerShell";
import { DeviceFrame } from "./DeviceFrame";
import { ScreensSidebar } from "./ScreensSidebar";
import { usePlayerNavigation } from "./navigation";
import { toRuntimeSpec } from "../prototype/runtimeSpec";
import { splitCanvasSpec } from "./canvasSpec";
import { CanvasLayers } from "./CanvasLayers";

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
    return <section role="alert" className="rounded border border-destructive p-6">
      <h1 className="text-xl font-bold">This screen could not be rendered</h1>
      <p className="mt-2 font-mono text-sm">Prototype: {this.props.prototypeId} · Screen: {this.props.screenId}</p>
      <p className="mt-2 text-sm">{this.state.error.message}</p>
      <button type="button" className="mt-4 rounded border px-4 py-2" onClick={this.props.restart}>Restart</button>
    </section>;
  }
}

export function ScreenView() {
  const { doc, registry } = useOutletContext<PlayerOutletContext>();
  const { screenId } = useParams();
  const navigation = usePlayerNavigation();
  const screen = doc.screens.find((item) => item.id === screenId);
  const screenSpec = screen?.spec;
  const screenCanvas = screen?.canvas;
  const specs = useMemo(() => {
    if (!screenSpec) return null;
    const runtimeSpec = toRuntimeSpec(screenSpec);
    return screenCanvas ? splitCanvasSpec(runtimeSpec) : { content: runtimeSpec, hotspots: [] };
  }, [screenCanvas, screenSpec]);
  if (!screen) return <main className="mx-auto max-w-xl p-8"><h1 className="text-2xl font-bold">Screen not found</h1><p className="mt-2">This screen does not exist in “{doc.name}”.</p><Link className="mt-4 inline-block underline" to="/">Back to gallery</Link></main>;

  const rendered = screen.canvas
    ? <CanvasLayers canvas={screen.canvas} specs={specs!} registry={registry} />
    : <Renderer registry={registry} spec={specs!.content!} />;

  return <main className="flex min-h-screen gap-6 p-6">
    <ScreensSidebar doc={doc} currentScreen={screen.id} />
    <DeviceFrame defaultDevice={doc.device} canvas={screen.canvas}>
      <ScreenErrorBoundary key={screen.id} prototypeId={doc.id} screenId={screen.id} restart={navigation.restart}>{rendered}</ScreenErrorBoundary>
    </DeviceFrame>
  </main>;
}
