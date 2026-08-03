import { Component, type ErrorInfo, type ReactNode, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useOutletContext, useParams } from "react-router";
import type { PlayerOutletContext } from "./PlayerShell";
import { DeviceFrame, isPlayerHelpHotkey, isPlayerHotkeyEvent, useStageZoom } from "./DeviceFrame";
import { ScreensSidebar } from "./ScreensSidebar";
import { buildPlayerPath, buildPrototypeRouteBase, documentLifetimeNonce, FlowResetBanner, type PlayerLocationState, usePlayerNavigation } from "./navigation";
import { toRuntimeSpec } from "../prototype/runtimeSpec";
import { hasSurfaces, screensOfSurface, surfaceOf } from "../prototype/surfaces";
import { DuoStage } from "./DuoStage";
import { ScreenSurface } from "./ScreenSurface";
import { useStatusBarPreference } from "./statusBarPreference";
import { chip, chipActive, pillDeep, pillGhost } from "../app/chrome";
import { Menu, MenuItem, menuItemClass } from "../app/Menu";
import { SelectPill } from "../app/SelectPill";
import { EmptyState, ErrorState } from "../app/states";
import { PrototypeChrome } from "../app/PrototypeChrome";
import { formatPlayerDate, inspector as inspectorStrings, player, playerDocumentTitle, playerHotkeys, share as shareStrings } from "../app/strings/player";
import { common, deviceNames } from "../app/strings/common";
import { canonicalViewport } from "../designSystems/deviceMetrics";
import { useDocumentTitle } from "../app/useDocumentTitle";
import { InspectorPanel } from "./inspector/InspectorPanel";
import { getPrototypeVersion, type PrototypeDraft } from "../api/client";
import { ShareDialog } from "./ShareDialog";
import { ScenarioBar } from "./ScenarioBar";
import { ScenarioPanel, ScenarioToggle } from "./scenarioPanel";

export function stripScenarioSearch(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("flow");
  params.delete("step");
  const next = params.toString();
  return next === "" ? "" : `?${next}`;
}

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
    // Ошибка рендера — белая панель на лавандовой канве (W4-12): тёмная плашка с
    // оранжевым текстом была единственным местом плеера со старой палитрой.
    return <ErrorState
      title={player.screenErrorTitle}
      description={<>
        {player.screenErrorContext(this.props.prototypeId, this.props.screenId)}
        <span className="mt-2 block text-eui-ink">{this.state.error.message}</span>
      </>}
      retryLabel={player.restart}
      onRetry={this.props.restart}
    />;
  }
}

const zoomChip = "inline-flex items-center rounded-full px-2.5 py-1 text-sm font-medium text-eui-ink transition-colors duration-100 hover:bg-pay-lavender aria-pressed:bg-pay-deep aria-pressed:text-white";

const hotkeyRows = [
  ["←", playerHotkeys.previous],
  ["→", playerHotkeys.next],
  ["Shift+←", playerHotkeys.stepPrevious],
  ["Shift+→", playerHotkeys.stepNext],
  ["R", playerHotkeys.restart],
  ["F", playerHotkeys.zoom],
  ["?", playerHotkeys.help],
] as const;

/** Клавиши, которых нет в презентации: зум и шаги сценария (полосы там нет). */
const presentHiddenHotkeys = new Set(["F", "Shift+←", "Shift+→"]);

export function PlayerHotkeysHelp({ onClose, present = false, canExitPresent = present }: { onClose: () => void; present?: boolean; canExitPresent?: boolean }) {
  const rows = present
    ? [...hotkeyRows.filter(([key]) => !presentHiddenHotkeys.has(key)), ...(canExitPresent ? [["Esc", playerHotkeys.exitPresent] as const] : [])]
    : hotkeyRows;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-pay-deep/55 p-4" role="presentation">
    <section role="dialog" aria-modal="true" aria-labelledby="player-hotkeys-title" className="w-full max-w-sm rounded-panel bg-white p-7 text-eui-ink">
      <div className="flex items-center justify-between gap-4">
        <h2 id="player-hotkeys-title" className="pay-display text-[32px] leading-[0.9]">{player.hotkeysTitle}</h2>
        <button type="button" aria-label={player.hotkeysClose} title={player.hotkeysClose} onClick={onClose} className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-pay-lavender text-lg leading-none transition-colors duration-100 hover:brightness-95"><span aria-hidden="true">✕</span></button>
      </div>
      <dl className="mt-5 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-3">
        {rows.map(([key, label]) => <div key={key} className="contents">
          <dt><kbd className="inline-flex min-w-10 justify-center rounded-item bg-pay-lavender px-2 py-1 font-mono text-sm font-medium">{key}</kbd></dt>
          <dd className="text-sm text-eui-slate-700">{label}</dd>
        </div>)}
      </dl>
    </section>
  </div>;
}

export function ScreenView() {
  const { doc, runtimeKey, registry, registries, themePins, runtime, customTypes, customDefinitions, onError, themeContent, inspector, versions, scenarios, pins } = useOutletContext<PlayerOutletContext>();
  const { screenId } = useParams();
  const { version } = useParams();
  const navigation = usePlayerNavigation();
  const routerNavigate = useNavigate();
  const [device, setDevice] = useState(doc.device);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [hotkeysVisible, setHotkeysVisible] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [statusBarHidden, setStatusBarHidden] = useStatusBarPreference();
  const [zonesVisible, setZonesVisible] = useState(false);
  // Заметка привязана к экрану, для которого её открыли: смена экрана закрывает
  // её без эффекта (react-hooks/set-state-in-effect).
  const [noteScreenId, setNoteScreenId] = useState<string | null>(null);
  const stageZoom = useStageZoom();
  // Дуо-док (план multi-surface, D10–D12): сцена — пара панелей, переключатель девайса
  // прячется (устройство задаёт поверхность), хром считается от сфокусированной поверхности.
  const duo = hasSurfaces(doc);
  const screen = doc.screens.find((item) => item.id === screenId);
  useDocumentTitle(screen
    ? playerDocumentTitle(doc.name, screen.name, version === undefined ? undefined : Number(version))
    : player.screenMissingTitle);
  const screenSpec = screen?.spec;
  const screenCanvas = screen?.canvas;
  const hasStatusBar = screen !== undefined && Object.values(screen.spec.elements).some((element) => element.region === "statusBar");
  const hasOverlay = screen === undefined ? false : Object.values(screen.spec.elements).some((element) => element.type === "Overlay");
  const blocksDesktopPreview = hasOverlay && screenCanvas === undefined;
  const [deviceContext, setDeviceContext] = useState({ doc, screen });
  if (deviceContext.doc !== doc || deviceContext.screen !== screen) {
    setDeviceContext({ doc, screen });
    if (device === "desktop" && blocksDesktopPreview && doc.device !== "desktop") setDevice(doc.device);
  }
  // customTypes — стабильный Set из контекста загрузчика; пересчёт дерева нужен только при его замене.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const tree = useMemo(() => (screenSpec ? toRuntimeSpec(screenSpec, { customTypes }) : null), [screenSpec, customTypes]);
  const numericVersion = version === undefined ? undefined : Number(version);
  // Вход в презентацию с текущего экрана (W1-2); present-маршруты живут вне /p-хрома.
  // Present не поддерживает guided browse: flow/step срезаются, прочий query сохраняется.
  const location = useLocation();
  const presentPath = `${buildPrototypeRouteBase(doc.id, numericVersion)}/present${screen ? `/s/${encodeURIComponent(screen.id)}` : ""}${stripScenarioSearch(location.search)}`;
  // Подпись кнопки говорит о срезе сценарного контекста ровно тогда, когда он
  // есть (W4-11): на документе без флоу «· без сценария» было бы шумом.
  const hasScenarioContext = stripScenarioSearch(location.search) !== location.search;
  // Zoom-контролы осмысленны только для фиксированного viewport (canvas-экран или
  // mobile/tablet); desktop auto-height рендерится fluid-веткой без масштаба.
  // На дуо-доке устройство берётся у поверхности экрана, а desktop-поверхность обязана
  // нести canvas (D2a) — фиксированный вьюпорт есть у каждой панели.
  const screenSurface = screen ? surfaceOf(doc, screen.id) : undefined;
  const hasFixedViewport = duo
    ? true
    : screenCanvas !== undefined || canonicalViewport[device] !== null;
  // Оверлей интерактивных зон (T3): подписи целей строятся по документу, а зоны —
  // по сырым `on`-биндингам рантайм-метаданных внутри ScreenSurface.
  const currentFlowId = new URLSearchParams(location.search).get("flow");
  const interactiveZones = useMemo(() => {
    if (!zonesVisible) return undefined;
    const screenNames = new Map(doc.screens.map((item) => [item.id, item.name]));
    const flows = doc.flows;
    if (flows === undefined) return { screenNames };
    const currentFlow = flows.find((item) => item.id === currentFlowId);
    // Подпись зоны — «→ {Экран} · шаг N» (W4-5). Номер ставится только когда он
    // однозначен: экран может входить в сценарий несколько раз, и тогда любая
    // конкретная цифра была бы враньём — остаётся «→ {Экран}».
    const flowNote = (screenId: string) => {
      if (currentFlow === undefined) return undefined;
      const occurrences = currentFlow.steps.flatMap((step, index) => step.screenId === screenId ? [index] : []);
      return occurrences.length === 1 ? player.zoneStep(occurrences[0]! + 1) : undefined;
    };
    return { screenNames, flowNote };
  }, [currentFlowId, doc.flows, doc.screens, zonesVisible]);

  const publishedVersions = versions?.published ?? [];
  const latestPublished = publishedVersions.reduce<typeof publishedVersions[number] | undefined>(
    (latest, item) => latest === undefined || item.version > latest.version ? item : latest,
    undefined,
  );
  const currentPublished = numericVersion === undefined ? undefined : publishedVersions.find((item) => item.version === numericVersion);
  const isNonLatest = numericVersion !== undefined && latestPublished !== undefined && numericVersion < latestPublished.version;
  const hasUnpublishedChanges = latestPublished !== undefined && versions !== null && versions.draft.rev > latestPublished.rev;
  const versionOptions = [
    { value: "draft", label: player.draftVersion },
    ...[...publishedVersions]
      .sort((a, b) => b.version - a.version)
      .map((item) => ({ value: String(item.version), label: player.publishedVersion(item.version, formatPlayerDate(item.publishedAt)) })),
  ];
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
  // Стрелки ходят в пределах сфокусированной поверхности (D12): на одно-поверхностном
  // документе это весь `doc.screens` в прежнем порядке.
  const browseScreens = useMemo(
    () => duo ? screensOfSurface(doc, navigation.focusedSurfaceId) : doc.screens.map((item) => item.id),
    [doc, duo, navigation.focusedSurfaceId],
  );
  const currentIndex = screen ? browseScreens.indexOf(screen.id) : -1;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPlayerHotkeyEvent(event)) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        // Shift+←/→ принадлежат шагам сценария (ScenarioBar, W4-6).
        if (event.shiftKey) return;
        const offset = event.key === "ArrowLeft" ? -1 : 1;
        const target = currentIndex < 0 ? undefined : browseScreens[currentIndex + offset];
        if (!target) return;
        event.preventDefault();
        navigation.browseToScreen(target);
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
  }, [browseScreens, currentIndex, hasFixedViewport, navigation, toggleFitActual]);
  // Единый хром /p/* (WF-4): вью поставляет только слоты, тело вью — stage (W1-1).
  const chrome = <PrototypeChrome
    prototypeId={doc.id}
    prototypeName={doc.name}
    view="player"
    version={numericVersion}
    status={publishedVersions.length === 0 ? undefined : <>
      {/* Версии (W4-4): от `sm:` — брендовая пилюля с поповером, ниже — нативный
          `<select>` в оболочке `SelectPill`. Системный список на телефоне
          выбирается одним пальцем, и менять его на поповер значило бы чинить
          внешний вид ценой мобильной доступности (ревью m6). */}
      <span className="sm:hidden">
        <SelectPill
          id="player-version-select"
          label={player.versionsAria}
          value={numericVersion === undefined ? "draft" : String(numericVersion)}
          disabled={switchingVersion}
          options={versionOptions}
          onChange={(value) => { void switchVersion(value); }}
        />
      </span>
      <span className="max-sm:hidden">
        <Menu
          // Смена версии закрывает поповер пересозданием: примитив не отдаёт
          // наружу императивного `close()`, а висеть над новой версией меню не должно.
          key={numericVersion ?? "draft"}
          label={player.versionsAria}
          triggerClassName={`${pillGhost} gap-1.5`}
          panelClassName="w-72"
          trigger={<>
            <span>{numericVersion === undefined ? player.draftVersion : player.versionShort(numericVersion)}</span>
            <span aria-hidden="true" className="text-pay-red">▾</span>
          </>}
        >
          {versionOptions.map((option) => <MenuItem
            key={option.value}
            disabled={switchingVersion}
            onSelect={() => { void switchVersion(option.value); }}
          >{option.label}</MenuItem>)}
        </Menu>
      </span>
      {hasUnpublishedChanges ? <span className="text-xs text-eui-slate-500">{player.unpublishedChanges}</span> : null}
    </>}
    actions={<>
      {screen === undefined ? null : <>
        {/* Тумблер зон — включён тёмной пилюлей, выключен лавандовой (макет 04);
            подпись несёт состояние, потому что цвет его не сообщает (W4-9). */}
        <button type="button" aria-pressed={zonesVisible} onClick={() => setZonesVisible((visible) => !visible)} className={zonesVisible ? pillDeep : pillGhost}>{player.zonesToggle(zonesVisible)}</button>
        {/* Переключатель девайса на surfaces-доке скрыт (D10): устройство панели
            задаёт её поверхность, а не выбор зрителя. */}
        {duo ? null : <div role="group" aria-label={player.deviceAria} className="flex items-center gap-1">
          {(["mobile", "tablet", "desktop"] as const).map((item) => (
            <button key={item} type="button" aria-pressed={device === item} disabled={item === "desktop" && blocksDesktopPreview} title={item === "desktop" && blocksDesktopPreview ? player.desktopOverlayUnavailable : undefined} onClick={() => { setDevice(item); stageZoom.fit(); }} className={`${device === item ? chipActive : chip} disabled:cursor-not-allowed disabled:opacity-50`}>
              {deviceNames[item]}
            </button>
          ))}
        </div>}
        {hasFixedViewport && <div role="group" aria-label={player.zoomAria} className="flex items-center gap-0.5 rounded-full bg-pay-lavender/50 px-1 py-0.5">
          <button type="button" aria-pressed={zoomValue.mode === "fit"} onClick={stageZoom.fit} className={zoomChip}>{player.zoomFit}</button>
          <button type="button" aria-pressed={isActualSize} onClick={stageZoom.actualSize} className={zoomChip}>{player.zoomActual}</button>
          <button type="button" aria-label={player.zoomOut} title={player.zoomOut} onClick={stageZoom.zoomOut} className={zoomChip}><span aria-hidden="true">−</span></button>
          <button type="button" aria-label={player.zoomIn} title={player.zoomIn} onClick={stageZoom.zoomIn} className={zoomChip}><span aria-hidden="true">+</span></button>
          <span className="px-1.5 text-xs tabular-nums text-eui-slate-500" aria-hidden="true">{player.zoomPercent(Math.round(stageZoom.effectiveScale * 100))}</span>
        </div>}
      </>}
      <button type="button" onClick={() => setShareOpen(true)} disabled={publishedVersions.length === 0} title={publishedVersions.length === 0 ? shareStrings.noPublishedVersions : undefined} className={`${pillGhost} disabled:cursor-not-allowed disabled:opacity-50`}>{shareStrings.action}</button>
      <Link className={pillGhost} to={presentPath}>{hasScenarioContext ? player.presentWithoutScenario : player.present}</Link>
      <button type="button" onClick={navigation.restart} className={pillGhost}>{player.restart}</button>
      {screen?.note ? <button type="button" aria-expanded={noteScreenId === screenId} aria-controls="player-screen-note" onClick={() => setNoteScreenId((open) => open === screenId ? null : screenId ?? null)} className={pillGhost}>{player.note}</button> : null}
      <ScenarioToggle controller={scenarios} />
      {/* В «···» уезжают только редкие контролы (W4-3, триаж M4-C): «Проверки» —
          единственный вход в рекордер прогонов, «Начать сначала» — самое частое
          действие показа, поэтому оба остаются в ряду. Условный рендер сохранён:
          серых пунктов «недоступно, потому что…» здесь не будет. */}
      <Menu label={player.moreActions}>
        <button
          type="button"
          role="menuitem"
          disabled={navigation.flowDepth === 0}
          onClick={navigation.back}
          className={`${menuItemClass} disabled:opacity-50`}
        >{player.back}</button>
        {hasStatusBar && <button
          type="button"
          role="menuitem"
          aria-pressed={statusBarHidden}
          onClick={() => setStatusBarHidden(!statusBarHidden)}
          className={menuItemClass}
        >{player.statusBarToggle}</button>}
        {inspector.enabled && <button
          type="button"
          role="menuitem"
          aria-pressed={inspector.visible}
          onClick={inspector.toggle}
          className={menuItemClass}
        >{inspectorStrings.title}</button>}
      </Menu>
    </>}
  />;
  // Плееру список версий уже известен: он приходит вместе с документом, поэтому
  // состояние загрузки диалогу передавать неоткуда — сразу «готово» (W6 §2).
  const shareDialog = shareOpen ? <ShareDialog prototypeId={doc.id} versions={{ status: "ready", versions: publishedVersions }} currentVersion={numericVersion} onClose={() => setShareOpen(false)} /> : null;
  // Экран не найден — белая панель на лавандовой канве (W4-12).
  if (!screen) return <main className="flex h-dvh min-h-0 flex-col">
    {shareDialog}
    {chrome}
    <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto bg-pay-lavender p-8">
      <div className="w-full max-w-xl">
        <EmptyState
          title={player.screenMissingTitle}
          description={player.screenMissingBody(doc.name)}
          primary={<Link className={pillGhost} to="/">{common.backToGallery}</Link>}
        />
      </div>
    </div>
  </main>;

  // D10: на дуо-доке разрешение примитивов хоста считается от поверхности экрана,
  // на обычном — от выбранного в плеере превью-устройства (прежнее поведение).
  const rendered = <ScreenSurface registry={registry} runtime={runtime} customDefinitions={customDefinitions} onError={onError} tree={tree!} surfaceId={screenSurface?.id} canvas={screen.canvas} misclickHighlights hostPrimitivesAllowed={(duo ? screenSurface!.device : device) !== "desktop" || screen.canvas !== undefined} interactiveZones={interactiveZones} />;

  return <main className="flex h-dvh min-h-0 flex-col">
    {shareDialog}
    {hotkeysVisible && <PlayerHotkeysHelp onClose={() => setHotkeysVisible(false)} />}
    {chrome}
    {noteScreenId === screenId && screen.note ? <section id="player-screen-note" aria-label={player.notePanelAria} className="bg-white px-5 py-3 text-eui-ink sm:px-6">
      <p className="whitespace-pre-wrap text-sm">{screen.note}</p>
    </section> : null}
    {isNonLatest && currentPublished && latestPublished ? <div role="status" data-testid="non-latest-version-banner" className="flex flex-wrap items-center gap-2 bg-pay-lavender px-5 py-2.5 text-sm text-eui-ink sm:px-6">
      <span>{player.nonLatestVersion(numericVersion, formatPlayerDate(currentPublished.publishedAt))}</span>
      <span aria-hidden="true">·</span>
      {latestDoc
        ? <Link className="font-medium text-pay-red underline-offset-2 hover:underline" to={targetPath(latestDoc, latestPublished.version)} state={browseState}>{player.openLatestPublished}</Link>
        : <span className="font-semibold text-eui-slate-500">{player.openLatestPublished}</span>}
    </div> : null}
    <FlowResetBanner />
    <ScenarioBar doc={doc} currentScreen={screen.id} runtimeKey={runtimeKey} />
    {/* Стейдж плеера — лавандовая канва бренда (макет 04); тёмными остаются только
        инструментальные панели инспектора и сценариев. */}
    <div className="relative flex min-h-0 flex-1 bg-pay-lavender text-eui-ink">
      <ScreensSidebar doc={doc} currentScreen={screen.id} collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((prev) => !prev)} />
      {duo
        ? <DuoStage
            doc={doc}
            screenBySurface={navigation.screenBySurface}
            focusedSurfaceId={navigation.focusedSurfaceId}
            onFocusSurface={navigation.focusSurface}
            registry={registry}
            registries={registries}
            themePins={themePins}
            runtime={runtime}
            customDefinitions={customDefinitions}
            customTypes={customTypes}
            onError={onError}
            designSystem={doc.designSystem}
            themeTokens={themeContent?.tokens}
            statusBarHidden={statusBarHidden}
            restart={navigation.restart}
            zoom={zoomValue}
            onEffectiveScale={stageZoom.onEffectiveScale}
            misclickHighlights
            interactiveZones={interactiveZones}
          />
        : <DeviceFrame device={device} canvas={screen.canvas} zoom={zoomValue} onEffectiveScale={stageZoom.onEffectiveScale} designSystem={doc.designSystem} themeTokens={themeContent?.tokens} statusBarHidden={statusBarHidden} scrollResetKey={screen.id}>
            <ScreenErrorBoundary key={screen.id} prototypeId={doc.id} screenId={screen.id} restart={navigation.restart}>{rendered}</ScreenErrorBoundary>
          </DeviceFrame>}
      {scenarios.open ? <ScenarioPanel doc={doc} screenId={screen.id} controller={scenarios} /> : null}
      {inspector.enabled && inspector.visible ? <InspectorPanel log={inspector.log} spec={screen.spec} definitions={customDefinitions} pins={pins} /> : null}
      {/* Подсказка про misclick-подсветку (макет 04): белая пилюля в левом нижнем
          углу стейджа, не перехватывает указатель. Она объясняет, как найти
          кликабельное **без** оверлея зон, поэтому при включённом тумблере не
          нужна (W4-8); на узком экране она нужна тем более и не прячется. */}
      {zonesVisible ? null : <p className="pointer-events-none absolute bottom-5 left-5 z-10 rounded-full bg-white px-4 py-2 text-[13px] text-eui-slate-500">{player.zonesMisclickHint}</p>}
    </div>
  </main>;
}
