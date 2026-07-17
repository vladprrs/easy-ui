import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import type { Flow, PrototypeDoc } from "../prototype/schema";
import { player } from "../app/strings/player";
import { usePlayerNavigation } from "./navigation";

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

export function ScenarioBar({ doc, currentScreen, runtimeKey }: {
  doc: PrototypeDoc;
  currentScreen: string;
  runtimeKey: string;
}) {
  const flows = doc.flows;
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

  const onFlowChange = (flowId: string) => {
    replaceQuery(withScenarioQuery(location.search, flowId === "" ? null : flowId, null));
  };

  const outside = flow !== null && matches.length === 0;
  const ambiguous = flow !== null && matches.length > 1 && confirmedStep === null;

  return <section
    aria-label={player.scenarioAria}
    data-testid="scenario-bar"
    className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-eui-brand/20 bg-eui-lilac-50 px-4 py-2 font-eui-ui text-sm text-eui-ink sm:px-6"
  >
    <label className="flex items-center gap-2">
      <span>{player.scenarioSelect}</span>
      <select
        aria-label={player.scenarioSelect}
        className="max-w-64 rounded-full border border-eui-ink/15 bg-white px-3 py-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-eui-brand"
        value={flow?.id ?? ""}
        onChange={(event) => onFlowChange(event.target.value)}
      >
        <option value="">{player.scenarioNone}</option>
        {flows.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </label>

    {flow === null ? null : <>
      {confirmedStep === null
        ? <span role="status">{outside ? player.scenarioOutside : player.scenarioAmbiguous}</span>
        : <span role="status">{player.scenarioStep(confirmedStep + 1, flow.steps.length)}</span>}
      <button
        type="button"
        disabled={confirmedStep === null || confirmedStep === 0}
        onClick={() => setPending(confirmedStep! - 1)}
        className="rounded-full border border-eui-brand/25 px-3 py-1 font-semibold text-eui-brand disabled:opacity-40"
      >
        {player.scenarioPrevious}
      </button>
      <button
        type="button"
        disabled={confirmedStep === null || confirmedStep === flow.steps.length - 1}
        onClick={() => setPending(confirmedStep! + 1)}
        className="rounded-full border border-eui-brand/25 px-3 py-1 font-semibold text-eui-brand disabled:opacity-40"
      >
        {player.scenarioNext}
      </button>
      {outside
        ? <button type="button" onClick={() => setPending(0)} className="font-semibold text-eui-brand underline-offset-2 hover:underline">{player.scenarioToFirst}</button>
        : null}
      {ambiguous ? <div className="flex flex-wrap items-center gap-2" role="group" aria-label={player.scenarioOccurrences}>
        {matches.map((index) => <button key={index} type="button" onClick={() => chooseOccurrence(index)} className="rounded-full border border-eui-brand/25 px-3 py-1 text-eui-brand">
          {player.scenarioOccurrence(index + 1)}
        </button>)}
      </div> : null}
      <span className="text-xs text-eui-slate-500">{player.scenarioGuidedBrowse}</span>
    </>}
  </section>;
}
