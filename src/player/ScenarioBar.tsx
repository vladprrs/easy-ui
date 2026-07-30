import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import type { Flow, PrototypeDoc } from "../prototype/schema";
import { pillDeep, pillGhost, popover, popoverItem } from "../app/chrome";
import { player } from "../app/strings/player";
import { FlowTree } from "../cjm/FlowTree";
import { buildFlowTree, flowBreadcrumb } from "../prototype/flowGraph";
import { buildPrototypeRouteBase, usePlayerNavigation } from "./navigation";

/** Стрелка шага сценария — лавандовый круг 36px (макет 04). */
const stepCircle = "grid h-9 w-9 shrink-0 place-items-center rounded-full bg-pay-lavender text-eui-ink transition-colors duration-100 hover:brightness-95 disabled:opacity-40 disabled:hover:brightness-100";

interface ScenarioProgress {
  lastConfirmed: number | null;
  pendingTarget: number | null;
}

const emptyProgress: ScenarioProgress = { lastConfirmed: null, pendingTarget: null };

function parseStep(value: string | null, flow: Flow, currentScreen: string): number | null {
  if (value === null || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const index = Number(value);
  return flow.steps[index]?.screenId === currentScreen ? index : null;
}

function withScenarioQuery(search: string, flowId: string | null, step: number | null): string {
  const params = new URLSearchParams(search);
  if (flowId === null) params.delete("flow");
  else params.set("flow", flowId);
  if (step === null) params.delete("step");
  else params.set("step", String(step));
  const next = params.toString();
  return next === "" ? "" : `?${next}`;
}

/**
 * Выбор сценария в плеере (план 2026-07-29 §7 T2b). `<select>` заменён кнопкой с
 * именем текущего сценария и breadcrumb'ом предков: дерево иерархии в однострочную
 * полосу не помещается, поэтому оно живёт поповером. На плоском документе
 * breadcrumb пуст и поведение остаётся прежним.
 */
function ScenarioPicker({ flows, flow, routeBase, onSelect }: {
  flows: NonNullable<PrototypeDoc["flows"]>;
  flow: Flow | null;
  routeBase: string;
  onSelect: (flowId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const roots = useMemo(() => buildFlowTree(flows), [flows]);
  const ancestors = useMemo(
    () => flow === null ? [] : flowBreadcrumb(flows, flow.id).slice(0, -1),
    [flow, flows],
  );

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (buttonRef.current?.contains(target) === true || popoverRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const choose = (flowId: string | null) => {
    onSelect(flowId);
    setOpen(false);
    buttonRef.current?.focus();
  };

  return <div className="relative flex items-center gap-2">
    <span id="scenario-picker-label" className="text-eui-slate-500">{player.scenarioSelect}</span>
    <button
      ref={buttonRef}
      type="button"
      id="scenario-picker-button"
      data-testid="scenario-flow-button"
      // Имя кнопки — «Сценарий» + имя текущего сценария: без ссылки на подпись
      // скринридер прочитал бы только имя флоу, потеряв назначение контрола.
      aria-labelledby="scenario-picker-label scenario-picker-button"
      aria-haspopup="tree"
      aria-expanded={open}
      onClick={() => setOpen((current) => !current)}
      className={`${pillDeep} max-w-72 gap-1.5 px-4 py-1.5 text-left`}
    >
      {ancestors.length === 0 ? null : <span className="min-w-0 truncate text-xs text-white/60">{ancestors.map((item) => item.name).join(" / ")} /</span>}
      <span className="min-w-0 truncate">{flow?.name ?? player.scenarioNone}</span>
      <span aria-hidden="true" className="shrink-0 text-white/60">▾</span>
    </button>
    {open ? <div
      ref={popoverRef}
      data-testid="scenario-flow-popover"
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); buttonRef.current?.focus(); } }}
      className={`${popover} absolute left-0 top-full z-40 mt-2 max-h-80 w-72 overflow-auto`}
    >
      <button
        type="button"
        aria-current={flow === null ? "true" : undefined}
        onClick={() => choose(null)}
        className={`${popoverItem} ${flow === null ? "bg-pay-lavender font-medium" : ""}`}
      >{player.scenarioNone}</button>
      <FlowTree roots={roots} activeFlowId={flow?.id ?? null} onActivate={choose} label={player.scenarioTreeAria} />
      {/* Дерево в поповере — вырезка того же дерева, что на странице прототипа;
          ссылка ведёт к полному виду со всеми сценариями (макет 08). */}
      <Link to={`${routeBase}/cjm`} className="mt-1 block rounded-item px-3 py-2 text-[13px] font-medium text-pay-red">{player.scenarioAllLink}</Link>
    </div> : null}
  </div>;
}

export function ScenarioBar({ doc, currentScreen, runtimeKey }: {
  doc: PrototypeDoc;
  currentScreen: string;
  runtimeKey: string;
}) {
  const flows = doc.flows;
  const { version } = useParams();
  const routeBase = buildPrototypeRouteBase(doc.id, version === undefined ? undefined : Number(version));
  const navigation = usePlayerNavigation();
  const location = useLocation();
  const routerNavigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedFlowId = searchParams.get("flow");
  const flow = flows?.find((item) => item.id === requestedFlowId) ?? null;
  const stateKey = flow === null ? null : `${runtimeKey}:${flow.id}`;
  const [progressByKey, setProgressByKey] = useState<Record<string, ScenarioProgress>>({});
  const pendingOrigins = useRef<Record<string, string>>({});
  const progress = stateKey === null ? emptyProgress : (progressByKey[stateKey] ?? emptyProgress);

  const replaceQuery = useCallback((search: string) => {
    routerNavigate({ search }, { replace: true, state: location.state });
  }, [location.state, routerNavigate]);

  const matches = useMemo(() => {
    if (flow === null) return [];
    const result: number[] = [];
    flow.steps.forEach((step, index) => {
      if (step.screenId === currentScreen) result.push(index);
    });
    return result;
  }, [currentScreen, flow]);
  const validUrlStep = flow === null ? null : parseStep(searchParams.get("step"), flow, currentScreen);
  const pendingConfirmation = progress.pendingTarget !== null
    && flow?.steps[progress.pendingTarget]?.screenId === currentScreen
    ? progress.pendingTarget
    : null;
  const confirmedStep = pendingConfirmation ?? validUrlStep ?? (matches.length === 1 ? matches[0]! : null);

  useEffect(() => {
    if (flow === null || stateKey === null) return;
    if (progress.pendingTarget !== null
      && pendingConfirmation === null
      && pendingOrigins.current[stateKey] === currentScreen) {
      return;
    }
    const keepPendingUntilUrlIsCanonical = pendingConfirmation !== null && validUrlStep !== pendingConfirmation;
    const nextProgress: ScenarioProgress = confirmedStep === null
      ? { lastConfirmed: progress.lastConfirmed, pendingTarget: null }
      : { lastConfirmed: confirmedStep, pendingTarget: keepPendingUntilUrlIsCanonical ? progress.pendingTarget : null };
    if (progress.pendingTarget !== null && nextProgress.pendingTarget === null) delete pendingOrigins.current[stateKey];
    if (nextProgress.lastConfirmed !== progress.lastConfirmed || nextProgress.pendingTarget !== progress.pendingTarget) {
      // URL/screen navigation is the external source being reconciled into per-flow progress.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProgressByKey((current) => ({ ...current, [stateKey]: nextProgress }));
    }
    const nextSearch = withScenarioQuery(location.search, flow.id, confirmedStep);
    if (nextSearch !== location.search) replaceQuery(nextSearch);
  }, [
    confirmedStep,
    currentScreen,
    flow,
    location.search,
    progress.lastConfirmed,
    progress.pendingTarget,
    pendingConfirmation,
    replaceQuery,
    stateKey,
    validUrlStep,
  ]);

  if (flows === undefined) return null;

  const setPending = (target: number) => {
    if (flow === null || stateKey === null) return;
    setProgressByKey((current) => ({
      ...current,
      [stateKey]: { lastConfirmed: progress.lastConfirmed, pendingTarget: target },
    }));
    pendingOrigins.current[stateKey] = currentScreen;
    navigation.goToScreen(flow.steps[target]!.screenId);
  };

  const chooseOccurrence = (target: number) => {
    if (flow === null || stateKey === null) return;
    setProgressByKey((current) => ({
      ...current,
      [stateKey]: { lastConfirmed: target, pendingTarget: null },
    }));
    delete pendingOrigins.current[stateKey];
    replaceQuery(withScenarioQuery(location.search, flow.id, target));
  };

  const onFlowChange = (flowId: string | null) => {
    replaceQuery(withScenarioQuery(location.search, flowId, null));
  };

  const outside = flow !== null && matches.length === 0;
  const ambiguous = flow !== null && matches.length > 1 && confirmedStep === null;

  const currentStepScreen = confirmedStep === null ? undefined : doc.screens.find((item) => item.id === flow?.steps[confirmedStep]?.screenId);

  return <section
    aria-label={player.scenarioAria}
    data-testid="scenario-bar"
    className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-white px-5 py-2.5 text-sm text-eui-ink sm:px-6"
  >
    <ScenarioPicker flows={flows} flow={flow} routeBase={routeBase} onSelect={onFlowChange} />

    {flow === null ? null : <>
      {confirmedStep === null
        ? <span role="status" className="text-eui-slate-500">{outside ? player.scenarioOutside : player.scenarioAmbiguous}</span>
        : <span role="status" className="text-eui-slate-500">
          {player.scenarioStep(confirmedStep + 1, flow.steps.length)}
          {currentStepScreen ? <span className="text-eui-ink"> · {currentStepScreen.name}</span> : null}
        </span>}
      {/* Прогресс шага: точка 8px, активный шаг — красная «капсула» 22×8. */}
      <ol className="flex items-center gap-1.5" aria-hidden="true">
        {flow.steps.map((step, index) => <li
          key={`${step.screenId}:${index}`}
          className={`h-2 rounded-full ${index === confirmedStep ? "w-[22px] bg-pay-red" : "w-2 bg-pay-lavender-light"}`}
        />)}
      </ol>
      <button
        type="button"
        aria-label={player.scenarioPrevious}
        title={player.scenarioPrevious}
        disabled={confirmedStep === null || confirmedStep === 0}
        onClick={() => setPending(confirmedStep! - 1)}
        className={stepCircle}
      >
        <span aria-hidden="true">←</span>
      </button>
      <button
        type="button"
        aria-label={player.scenarioNext}
        title={player.scenarioNext}
        disabled={confirmedStep === null || confirmedStep === flow.steps.length - 1}
        onClick={() => setPending(confirmedStep! + 1)}
        className={stepCircle}
      >
        <span aria-hidden="true">→</span>
      </button>
      {outside
        ? <button type="button" onClick={() => setPending(0)} className={`${pillGhost} px-3 py-1.5 text-[13px]`}>{player.scenarioToFirst}</button>
        : null}
      {ambiguous ? <div className="flex flex-wrap items-center gap-2" role="group" aria-label={player.scenarioOccurrences}>
        {matches.map((index) => <button key={index} type="button" onClick={() => chooseOccurrence(index)} className={`${pillGhost} px-3 py-1.5 text-[13px]`}>
          {player.scenarioOccurrence(index + 1)}
        </button>)}
      </div> : null}
      <span className="text-xs text-eui-slate-500">{player.scenarioGuidedBrowse}</span>
    </>}
  </section>;
}
