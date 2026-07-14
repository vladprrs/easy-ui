import { Component, type ErrorInfo, type ReactNode, useMemo, useState } from "react";
import { Link, useOutletContext, useParams } from "react-router";
import type { PlayerOutletContext } from "./PlayerShell";
import { DeviceFrame, useStageZoom } from "./DeviceFrame";
import { ScreensSidebar } from "./ScreensSidebar";
import { buildPrototypeRouteBase, usePlayerNavigation } from "./navigation";
import { toRuntimeSpec } from "../prototype/runtimeSpec";
import { ScreenSurface } from "./ScreenSurface";
import { chip, chipActive, pillGhost, pillGhostOnDark } from "../app/chrome";
import { PrototypeChrome } from "../app/PrototypeChrome";
import { player, playerDocumentTitle } from "../app/strings/player";
import { common, deviceNames } from "../app/strings/common";
import { canonicalViewport } from "../designSystems/deviceMetrics";
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

const zoomChip = "inline-flex items-center rounded-full px-2.5 py-1 text-sm font-medium text-eui-ink transition-colors hover:bg-eui-lilac-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-eui-brand aria-pressed:bg-eui-brand aria-pressed:font-bold aria-pressed:text-white";

export function ScreenView() {
  const { doc, registry, runtime, customTypes, customDefinitions, onError } = useOutletContext<PlayerOutletContext>();
  const { screenId } = useParams();
  const { version } = useParams();
  const navigation = usePlayerNavigation();
  const [device, setDevice] = useState(doc.device);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const stageZoom = useStageZoom();
  const screen = doc.screens.find((item) => item.id === screenId);
  useDocumentTitle(screen
    ? playerDocumentTitle(doc.name, screen.name, version === undefined ? undefined : Number(version))
    : player.screenMissingTitle);
  const screenSpec = screen?.spec;
  const screenCanvas = screen?.canvas;
  const tree = useMemo(() => (screenSpec ? toRuntimeSpec(screenSpec, { customTypes }) : null), [screenSpec, customTypes]);
  const numericVersion = version === undefined ? undefined : Number(version);
  // Вход в презентацию с текущего экрана (W1-2); present-маршруты живут вне /p-хрома.
  const presentPath = `${buildPrototypeRouteBase(doc.id, numericVersion)}/present${screen ? `/s/${encodeURIComponent(screen.id)}` : ""}`;
  // Zoom-контролы осмысленны только для фиксированного viewport (canvas-экран или
  // mobile/tablet); desktop auto-height рендерится fluid-веткой без масштаба.
  const hasFixedViewport = screenCanvas !== undefined || canonicalViewport[device] !== null;
  const zoomValue = stageZoom.value;
  const isActualSize = zoomValue.mode === "manual" && zoomValue.zoom === 1;
  // Единый хром /p/* (WF-4): вью поставляет только слоты, тело вью — stage (W1-1).
  const chrome = <PrototypeChrome
    prototypeId={doc.id}
    prototypeName={doc.name}
    view="player"
    version={numericVersion}
    actions={<>
      {screen === undefined ? null : <>
        <div role="group" aria-label={player.deviceAria} className="flex items-center gap-1">
          {(["mobile", "tablet", "desktop"] as const).map((item) => (
            <button key={item} type="button" aria-pressed={device === item} onClick={() => { setDevice(item); stageZoom.fit(); }} className={device === item ? chipActive : chip}>
              {deviceNames[item]}
            </button>
          ))}
        </div>
        {hasFixedViewport && <div role="group" aria-label={player.zoomAria} className="flex items-center gap-0.5 rounded-full border border-eui-ink/15 px-1 py-0.5">
          <button type="button" aria-pressed={zoomValue.mode === "fit"} onClick={stageZoom.fit} className={zoomChip}>{player.zoomFit}</button>
          <button type="button" aria-pressed={isActualSize} onClick={stageZoom.actualSize} className={zoomChip}>{player.zoomActual}</button>
          <button type="button" aria-label={player.zoomOut} title={player.zoomOut} onClick={stageZoom.zoomOut} className={zoomChip}><span aria-hidden="true">−</span></button>
          <button type="button" aria-label={player.zoomIn} title={player.zoomIn} onClick={stageZoom.zoomIn} className={zoomChip}><span aria-hidden="true">+</span></button>
          <span className="px-1.5 text-xs tabular-nums text-eui-slate-500" aria-hidden="true">{player.zoomPercent(Math.round(stageZoom.effectiveScale * 100))}</span>
        </div>}
      </>}
      <Link className={pillGhost} to={presentPath}>{player.present}</Link>
      <button type="button" onClick={navigation.back} disabled={navigation.flowDepth === 0} className={`${pillGhost} disabled:opacity-50`}>{player.back}</button>
      <button type="button" onClick={navigation.restart} className={pillGhost}>{player.restart}</button>
    </>}
  />;
  if (!screen) return <main className="flex h-dvh min-h-0 flex-col">{chrome}<div className="flex min-h-0 flex-1 items-start justify-center bg-eui-graphite p-8 text-white"><section role="alert" className="w-full max-w-xl rounded-2xl bg-white/10 p-6 text-eui-orange"><h2 className="font-eui-display text-2xl font-bold">{player.screenMissingTitle}</h2><p className="mt-2 text-eui-ondark-2">{player.screenMissingBody(doc.name)}</p><Link className={`${pillGhostOnDark} mt-4 font-eui-ui`} to="/">{common.backToGallery}</Link></section></div></main>;

  const rendered = <ScreenSurface registry={registry} runtime={runtime} customDefinitions={customDefinitions} onError={onError} tree={tree!} canvas={screen.canvas} />;

  return <main className="flex h-dvh min-h-0 flex-col">
    {chrome}
    <div className="flex min-h-0 flex-1 bg-eui-graphite text-white">
      <ScreensSidebar doc={doc} currentScreen={screen.id} collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((prev) => !prev)} />
      <DeviceFrame device={device} canvas={screen.canvas} zoom={zoomValue} onEffectiveScale={stageZoom.onEffectiveScale}>
        <ScreenErrorBoundary key={screen.id} prototypeId={doc.id} screenId={screen.id} restart={navigation.restart}>{rendered}</ScreenErrorBoundary>
      </DeviceFrame>
    </div>
  </main>;
}
