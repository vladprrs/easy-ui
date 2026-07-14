import { Component, type ErrorInfo, type ReactNode, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useOutletContext, useParams } from "react-router";
import type { PlayerOutletContext } from "./PlayerShell";
import { DeviceFrame, isPlayerHelpHotkey, isPlayerHotkeyEvent, useStageZoom } from "./DeviceFrame";
import { ScreensSidebar } from "./ScreensSidebar";
import { buildPlayerPath, buildPrototypeRouteBase, documentLifetimeNonce, FlowResetBanner, type PlayerLocationState, usePlayerNavigation } from "./navigation";
import { toRuntimeSpec } from "../prototype/runtimeSpec";
import { ScreenSurface } from "./ScreenSurface";
import { chip, chipActive, pillGhost, pillGhostOnDark } from "../app/chrome";
import { PrototypeChrome } from "../app/PrototypeChrome";
import { formatPlayerDate, inspector as inspectorStrings, player, playerDocumentTitle, playerHotkeys } from "../app/strings/player";
import { common, deviceNames } from "../app/strings/common";
import { canonicalViewport } from "../designSystems/deviceMetrics";
import { useDocumentTitle } from "../app/useDocumentTitle";
import { InspectorPanel } from "./inspector/InspectorPanel";
import { getPrototypeVersion, type PrototypeDraft } from "../api/client";

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

const hotkeyRows = [
  ["←", playerHotkeys.previous],
  ["→", playerHotkeys.next],
  ["R", playerHotkeys.restart],
  ["F", playerHotkeys.zoom],
  ["?", playerHotkeys.help],
] as const;

export function PlayerHotkeysHelp({ onClose, present = false }: { onClose: () => void; present?: boolean }) {
  const rows = present
    ? [...hotkeyRows.filter(([key]) => key !== "F"), ["Esc", playerHotkeys.exitPresent] as const]
    : hotkeyRows;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-eui-graphite/70 p-4" role="presentation">
    <section role="dialog" aria-modal="true" aria-labelledby="player-hotkeys-title" className="w-full max-w-sm rounded-3xl bg-white p-6 text-eui-ink shadow-2xl">
      <div className="flex items-center justify-between gap-4">
        <h2 id="player-hotkeys-title" className="font-eui-display text-xl font-bold">{player.hotkeysTitle}</h2>
        <button type="button" aria-label={player.hotkeysClose} title={player.hotkeysClose} onClick={onClose} className="rounded-full px-2 py-1 text-xl leading-none hover:bg-eui-lilac-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-eui-brand">×</button>
      </div>
      <dl className="mt-5 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-3">
        {rows.map(([key, label]) => <div key={key} className="contents">
          <dt><kbd className="inline-flex min-w-10 justify-center rounded-lg border border-eui-ink/20 bg-eui-lilac-50 px-2 py-1 font-mono text-sm font-bold">{key}</kbd></dt>
          <dd className="text-sm text-eui-slate-700">{label}</dd>
        </div>)}
      </dl>
    </section>
  </div>;
}

export function ScreenView() {
  const { doc, registry, runtime, customTypes, customDefinitions, onError, inspector, versions } = useOutletContext<PlayerOutletContext>();
  const { screenId } = useParams();
  const { version } = useParams();
  const navigation = usePlayerNavigation();
  const routerNavigate = useNavigate();
  const [device, setDevice] = useState(doc.device);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [hotkeysVisible, setHotkeysVisible] = useState(false);
  const [noteVisible, setNoteVisible] = useState(false);
  const stageZoom = useStageZoom();
  const screen = doc.screens.find((item) => item.id === screenId);
  useEffect(() => setNoteVisible(false), [screenId]);
  useDocumentTitle(screen
    ? playerDocumentTitle(doc.name, screen.name, version === undefined ? undefined : Number(version))
    : player.screenMissingTitle);
  const screenSpec = screen?.spec;
  const screenCanvas = screen?.canvas;
  // customTypes — стабильный Set из контекста загрузчика; пересчёт дерева нужен только при его замене.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const tree = useMemo(() => (screenSpec ? toRuntimeSpec(screenSpec, { customTypes }) : null), [screenSpec, customTypes]);
  const numericVersion = version === undefined ? undefined : Number(version);
  // Вход в презентацию с текущего экрана (W1-2); present-маршруты живут вне /p-хрома.
  // Query string (в т.ч. ?debug=1) сохраняется переходом (W1-5).
  const location = useLocation();
  const presentPath = `${buildPrototypeRouteBase(doc.id, numericVersion)}/present${screen ? `/s/${encodeURIComponent(screen.id)}` : ""}${location.search}`;
  // Zoom-контролы осмысленны только для фиксированного viewport (canvas-экран или
  // mobile/tablet); desktop auto-height рендерится fluid-веткой без масштаба.
  const hasFixedViewport = screenCanvas !== undefined || canonicalViewport[device] !== null;

  const publishedVersions = versions?.published ?? [];
  const latestPublished = publishedVersions.reduce<typeof publishedVersions[number] | undefined>(
    (latest, item) => latest === undefined || item.version > latest.version ? item : latest,
    undefined,
  );
  const currentPublished = numericVersion === undefined ? undefined : publishedVersions.find((item) => item.version === numericVersion);
  const isNonLatest = numericVersion !== undefined && latestPublished !== undefined && numericVersion < latestPublished.version;
  const hasUnpublishedChanges = latestPublished !== undefined && versions !== null && versions.draft.rev > latestPublished.rev;
  const [loadedLatest, setLoadedLatest] = useState<{ version: number; doc: PrototypeDraft["doc"] } | null>(null);
  const latestDoc = loadedLatest !== null && latestPublished !== undefined && loadedLatest.version === latestPublished.version
    ? loadedLatest.doc
    : null;
  useEffect(() => {
    if (!isNonLatest || latestPublished === undefined) return;
    const controller = new AbortController();
    void getPrototypeVersion(doc.id, latestPublished.version, controller.signal).then(
      (loaded) => setLoadedLatest({ version: latestPublished.version, doc: loaded.doc }),
      () => undefined,
    );
    return () => controller.abort();
  }, [doc.id, isNonLatest, latestPublished]);

  const targetPath = (targetDoc: PrototypeDraft["doc"], targetVersion?: number) => {
    const targetScreen = screen && targetDoc.screens.some((item) => item.id === screen.id) ? screen.id : targetDoc.startScreen;
    return `${buildPlayerPath(buildPrototypeRouteBase(doc.id, targetVersion), targetScreen)}${location.search}`;
  };
  const browseState = {
    sessionNonce: navigation.sessionNonce,
    flowDepth: 0,
    entryReason: "browse",
    documentNonce: documentLifetimeNonce,
  } satisfies PlayerLocationState;
  const [switchingVersion, setSwitchingVersion] = useState(false);
  const switchVersion = async (value: string) => {
    if (value === (numericVersion === undefined ? "draft" : String(numericVersion))) return;
    setSwitchingVersion(true);
    try {
      if (value === "draft") {
        if (versions) routerNavigate(targetPath(versions.draft.doc), { state: browseState });
        return;
      }
      const targetVersion = Number(value);
      const target = latestPublished?.version === targetVersion && latestDoc
        ? { doc: latestDoc }
        : await getPrototypeVersion(doc.id, targetVersion);
      routerNavigate(targetPath(target.doc, targetVersion), { state: browseState });
    } catch {
      // Метаданные версий — вспомогательная навигация: основной плеер остаётся рабочим.
    } finally {
      setSwitchingVersion(false);
    }
  };
  const zoomValue = stageZoom.value;
  const toggleFitActual = stageZoom.toggleFitActual;
  const isActualSize = zoomValue.mode === "manual" && zoomValue.zoom === 1;
  const currentIndex = screen ? doc.screens.indexOf(screen) : -1;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPlayerHotkeyEvent(event)) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const offset = event.key === "ArrowLeft" ? -1 : 1;
        const target = doc.screens[currentIndex + offset];
        if (!target) return;
        event.preventDefault();
        navigation.browseToScreen(target.id);
      } else if (event.key.toLowerCase() === "r") {
        event.preventDefault();
        navigation.restart();
      } else if (event.key.toLowerCase() === "f" && hasFixedViewport) {
        event.preventDefault();
        toggleFitActual();
      } else if (isPlayerHelpHotkey(event)) {
        event.preventDefault();
        setHotkeysVisible((visible) => !visible);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [currentIndex, doc.screens, hasFixedViewport, navigation, toggleFitActual]);
  // Единый хром /p/* (WF-4): вью поставляет только слоты, тело вью — stage (W1-1).
  const chrome = <PrototypeChrome
    prototypeId={doc.id}
    prototypeName={doc.name}
    view="player"
    version={numericVersion}
    status={publishedVersions.length === 0 ? undefined : <>
      <label className="sr-only" htmlFor="player-version-select">{player.versionsAria}</label>
      <select
        id="player-version-select"
        aria-label={player.versionsAria}
        className="max-w-56 rounded-full border border-eui-ink/15 bg-white px-3 py-1 text-sm text-eui-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-eui-brand"
        value={numericVersion === undefined ? "draft" : String(numericVersion)}
        disabled={switchingVersion}
        onChange={(event) => { void switchVersion(event.target.value); }}
      >
        <option value="draft">{player.draftVersion}</option>
        {[...publishedVersions].sort((a, b) => b.version - a.version).map((item) => (
          <option key={item.version} value={item.version}>{player.publishedVersion(item.version, formatPlayerDate(item.publishedAt))}</option>
        ))}
      </select>
      {hasUnpublishedChanges ? <span className="text-xs text-eui-magenta">{player.unpublishedChanges}</span> : null}
    </>}
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
      {screen?.note ? <button type="button" aria-expanded={noteVisible} aria-controls="player-screen-note" onClick={() => setNoteVisible((visible) => !visible)} className={pillGhost}>{player.note}</button> : null}
      {inspector.enabled && <button type="button" aria-pressed={inspector.visible} onClick={inspector.toggle} className={pillGhost}>{inspectorStrings.title}</button>}
    </>}
  />;
  if (!screen) return <main className="flex h-dvh min-h-0 flex-col">{chrome}<div className="flex min-h-0 flex-1 items-start justify-center bg-eui-graphite p-8 text-white"><section role="alert" className="w-full max-w-xl rounded-2xl bg-white/10 p-6 text-eui-orange"><h2 className="font-eui-display text-2xl font-bold">{player.screenMissingTitle}</h2><p className="mt-2 text-eui-ondark-2">{player.screenMissingBody(doc.name)}</p><Link className={`${pillGhostOnDark} mt-4 font-eui-ui`} to="/">{common.backToGallery}</Link></section></div></main>;

  const rendered = <ScreenSurface registry={registry} runtime={runtime} customDefinitions={customDefinitions} onError={onError} tree={tree!} canvas={screen.canvas} />;

  return <main className="flex h-dvh min-h-0 flex-col">
    {hotkeysVisible && <PlayerHotkeysHelp onClose={() => setHotkeysVisible(false)} />}
    {chrome}
    {noteVisible && screen.note ? <section id="player-screen-note" aria-label={player.notePanelAria} className="border-b border-eui-brand/20 bg-eui-lilac-50 px-4 py-3 text-eui-ink sm:px-6">
      <p className="whitespace-pre-wrap font-eui-ui text-sm">{screen.note}</p>
    </section> : null}
    {isNonLatest && currentPublished && latestPublished ? <div role="status" data-testid="non-latest-version-banner" className="flex flex-wrap items-center gap-2 border-b border-eui-brand/20 bg-eui-lilac-100 px-4 py-2 font-eui-ui text-sm text-eui-ink sm:px-6">
      <span>{player.nonLatestVersion(numericVersion, formatPlayerDate(currentPublished.publishedAt))}</span>
      <span aria-hidden="true">·</span>
      {latestDoc
        ? <Link className="font-semibold text-eui-brand underline-offset-2 hover:underline" to={targetPath(latestDoc, latestPublished.version)} state={browseState}>{player.openLatestPublished}</Link>
        : <span className="font-semibold text-eui-slate-500">{player.openLatestPublished}</span>}
    </div> : null}
    <FlowResetBanner />
    <div className="flex min-h-0 flex-1 bg-eui-graphite text-white">
      <ScreensSidebar doc={doc} currentScreen={screen.id} collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((prev) => !prev)} />
      <DeviceFrame device={device} canvas={screen.canvas} zoom={zoomValue} onEffectiveScale={stageZoom.onEffectiveScale}>
        <ScreenErrorBoundary key={screen.id} prototypeId={doc.id} screenId={screen.id} restart={navigation.restart}>{rendered}</ScreenErrorBoundary>
      </DeviceFrame>
      {inspector.enabled && inspector.visible ? <InspectorPanel log={inspector.log} /> : null}
    </div>
  </main>;
}
