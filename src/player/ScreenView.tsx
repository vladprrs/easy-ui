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
import { pillGhost, pillGhostOnDark } from "../app/chrome";
import { PrototypeChrome } from "../app/PrototypeChrome";
import { player, playerDocumentTitle } from "../app/strings/player";
import { common } from "../app/strings/common";
import { useDocumentTitle } from "../app/useDocumentTitle";

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
      <h1 className="font-eui-display text-xl font-bold">{player.screenErrorTitle}</h1>
      <p className="mt-2 font-mono text-sm text-eui-ondark-2">{player.screenErrorContext(this.props.prototypeId, this.props.screenId)}</p>
      <p className="mt-2 text-sm">{this.state.error.message}</p>
      <button type="button" className={`${pillGhostOnDark} mt-4 font-eui-ui`} onClick={this.props.restart}>{player.restart}</button>
    </section>;
  }
}

export function ScreenView() {
  const { doc, registry, runtime, customTypes, customDefinitions, onError } = useOutletContext<PlayerOutletContext>();
  const { screenId } = useParams();
  const { version } = useParams();
  const navigation = usePlayerNavigation();
  const screen = doc.screens.find((item) => item.id === screenId);
  useDocumentTitle(screen
    ? playerDocumentTitle(doc.name, screen.name, version === undefined ? undefined : Number(version))
    : player.screenMissingTitle);
  const screenSpec = screen?.spec;
  const screenCanvas = screen?.canvas;
  const tree = useMemo(() => (screenSpec ? toRuntimeSpec(screenSpec, { customTypes }) : null), [screenSpec, customTypes]);
  const specs = useMemo(() => {
    if (!tree) return null;
    if (screenCanvas) { const { content, hotspots } = splitCanvas(tree); return { content: content?.spec ?? null, hotspots: hotspots.map((h) => h.spec) }; }
    return { content: tree.spec, hotspots: [] };
  }, [screenCanvas, tree]);
  useEffect(() => { runtime.setScreenSpec(specs?.content ?? null); return () => runtime.setScreenSpec(null); }, [runtime, specs]);
  const numericVersion = version === undefined ? undefined : Number(version);
  // Единый хром /p/* (WF-4): вью поставляет только слоты, тело вью — stage.
  const chrome = <PrototypeChrome
    prototypeId={doc.id}
    prototypeName={doc.name}
    view="player"
    version={numericVersion}
    actions={<>
      <button type="button" onClick={navigation.back} disabled={navigation.flowDepth === 0} className={`${pillGhost} disabled:opacity-50`}>{player.back}</button>
      <button type="button" onClick={navigation.restart} className={pillGhost}>{player.restart}</button>
    </>}
  />;
  if (!screen) return <main className="flex h-full min-h-0 flex-col">{chrome}<div className="flex min-h-0 flex-1 items-start justify-center bg-eui-graphite p-8 text-white"><section role="alert" className="w-full max-w-xl rounded-2xl bg-white/10 p-6 text-eui-orange"><h2 className="font-eui-display text-2xl font-bold">{player.screenMissingTitle}</h2><p className="mt-2 text-eui-ondark-2">{player.screenMissingBody(doc.name)}</p><Link className={`${pillGhostOnDark} mt-4 font-eui-ui`} to="/">{common.backToGallery}</Link></section></div></main>;

  const rendered = <EasyUiRuntimeProvider value={{ metadata: tree!.metadata, runtime, definitions: customDefinitions, onError }}>
    {screen.canvas
      ? <CanvasLayers canvas={screen.canvas} specs={specs!} registry={registry} />
      : <Renderer registry={registry} spec={specs!.content!} />}
  </EasyUiRuntimeProvider>;

  return <main className="flex h-full min-h-0 flex-col">
    {chrome}
    <div className="flex min-h-0 flex-1 bg-eui-graphite text-white">
      <ScreensSidebar doc={doc} currentScreen={screen.id} />
      <DeviceFrame defaultDevice={doc.device} canvas={screen.canvas}>
        <ScreenErrorBoundary key={screen.id} prototypeId={doc.id} screenId={screen.id} restart={navigation.restart}>{rendered}</ScreenErrorBoundary>
      </DeviceFrame>
    </div>
  </main>;
}
