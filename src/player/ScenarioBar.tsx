import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import type { Flow, PrototypeDoc } from "../prototype/schema";
import { menuItemClass, Menu } from "../app/Menu";
import { SelectPill } from "../app/SelectPill";
import { pillDeep } from "../app/chrome";
import { player } from "../app/strings/player";
import { FlowTree } from "../cjm/FlowTree";
import { buildFlowTree, flowBreadcrumb } from "../prototype/flowGraph";
import { isPlayerHotkeyEvent, setPlayerPopoverOpen } from "./DeviceFrame";
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
 * Выбор сценария в плеере (план 2026-07-29 §7 T2b, редизайн W4-1/W4-2).
 *
 * Пилюля одна и тёмная: назначение контрола («Сценарий:») живёт внутри неё, а
 * breadcrumb предков вынесен наружу приглушённым текстом — внутри тёмной пилюли
 * он конкурировал с именем сценария и обрезался вместе с ним.
 *
 * Поповер — общий примитив {@link Menu} (W0): фокус уходит внутрь по ↓, Esc
 * возвращает его на триггер. Само дерево остаётся `role="tree"` со своей
 * клавиатурой; меню владеет оболочкой, а не навигацией по узлам.
 */
function ScenarioPicker({ flows, flow, routeBase, onSelect, onOpenChange }: {
  flows: NonNullable<PrototypeDoc["flows"]>;
  flow: Flow | null;
  routeBase: string;
  onSelect: (flowId: string | null) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const roots = useMemo(() => buildFlowTree(flows), [flows]);
  const ancestors = useMemo(
    () => flow === null ? [] : flowBreadcrumb(flows, flow.id).slice(0, -1),
    [flow, flows],
  );
  // `Menu` владеет собственным состоянием раскрытия и не умеет закрываться
  // снаружи — выбор сценария закрывает его пересозданием по ключу. Фокус после
  // этого возвращается на триггер вручную: узел, на котором он стоял, исчезает.
  const [pickerKey, setPickerKey] = useState(0);
  const returnFocus = useRef(false);
  useLayoutEffect(() => {
    if (!returnFocus.current) return;
    returnFocus.current = false;
    rootRef.current?.querySelector("button")?.focus();
  }, [pickerKey]);

  const choose = (flowId: string | null) => {
    onSelect(flowId);
    onOpenChange(false);
    returnFocus.current = true;
    setPickerKey((current) => current + 1);
  };

  const title = player.scenarioPill(flow?.name ?? player.scenarioNone);
  return <div ref={rootRef} data-testid="scenario-flow-button" className="flex min-w-0 items-center gap-2">
    <Menu
      key={pickerKey}
      label={title}
      onOpenChange={onOpenChange}
      panelLabel={player.scenarioTreeAria}
      // Пилюля прижата к левому краю полосы: панель обязана раскрываться вправо,
      // иначе на узком экране она уезжает за границу вьюпорта. `left-0` вместе с
      // фиксированной шириной переопределяет `right-0` примитива без `!`:
      // over-constrained абсолютное позиционирование в LTR игнорирует `right`.
      panelClassName="left-0 max-h-80 w-72 overflow-auto"
      triggerClassName={`${pillDeep} max-w-72 gap-1.5 px-4 py-1.5 text-left`}
      trigger={<>
        <span className="min-w-0 truncate">{title}</span>
        <span aria-hidden="true" className="shrink-0 text-white/60">▾</span>
      </>}
    >
      <button
        type="button"
        role="menuitem"
        aria-current={flow === null ? "true" : undefined}
        onClick={() => choose(null)}
        // Радиус и паддинг — как у пунктов дерева (14 / 9-12): рядом стоящие
        // пункты одного списка не должны отличаться геометрией.
        className={`${menuItemClass} rounded-field py-[9px] ${flow === null ? "bg-pay-lavender font-medium" : ""}`}
      >{player.scenarioNone}</button>
      <FlowTree roots={roots} activeFlowId={flow?.id ?? null} onActivate={choose} label={player.scenarioTreeAria} />
      {/* Дерево в поповере — вырезка того же дерева, что на странице прототипа;
          ссылка ведёт к полному виду со всеми сценариями (макет 08). Красным
          она быть не должна: единственный акцент полосы — активный шаг. */}
      <Link role="menuitem" to={`${routeBase}/cjm`} className={`${menuItemClass} rounded-field text-[13px] font-medium`}>
        {player.scenarioAllLink} <span aria-hidden="true">→</span>
      </Link>
    </Menu>
    {ancestors.length === 0 ? null : <span className="min-w-0 truncate text-[13px] text-pay-deep/60">
      {ancestors.map((item) => item.name).join(" / ")} /
    </span>}
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
  const [pickerOpen, setPickerOpen] = useState(false);

  // Пока поповер открыт, глобальные хоткеи плеера (в т.ч. ← →) выключены.
  // Флаг снимается и при размонтировании полосы, иначе он завис бы включённым.
  useEffect(() => {
    if (!pickerOpen) return;
    setPlayerPopoverOpen(true);
    return () => setPlayerPopoverOpen(false);
  }, [pickerOpen]);

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

  const setPending = useCallback((target: number) => {
    if (flow === null || stateKey === null) return;
    setProgressByKey((current) => ({
      ...current,
      [stateKey]: { lastConfirmed: current[stateKey]?.lastConfirmed ?? null, pendingTarget: target },
    }));
    pendingOrigins.current[stateKey] = currentScreen;
    navigation.goToScreen(flow.steps[target]!.screenId);
  }, [currentScreen, flow, navigation, stateKey]);

  // Шаги сценария на Shift+←/→ (W4-6): без Shift те же клавиши остаются за
  // экранами документа, потому что сценарий есть далеко не у каждого прототипа.
  useEffect(() => {
    if (flow === null || confirmedStep === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.shiftKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
      if (!isPlayerHotkeyEvent(event)) return;
      const target = confirmedStep + (event.key === "ArrowLeft" ? -1 : 1);
      if (target < 0 || target >= flow.steps.length) return;
      event.preventDefault();
      setPending(target);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmedStep, flow, setPending]);

  if (flows === undefined) return null;

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
  const screenNames = new Map(doc.screens.map((item) => [item.id, item.name]));
  const currentStepScreen = confirmedStep === null || flow === null
    ? undefined
    : screenNames.get(flow.steps[confirmedStep]!.screenId);

  // Один контрол вместо россыпи кнопок «К шагу 1» / «Шаг 2» / «Шаг 5» (W4-7):
  // и «экран вне сценария», и «шаг не определён» — это один и тот же вопрос
  // «на каком шаге мы находимся», поэтому и ответ у них один — выбор шага.
  const resolveOptions = flow === null || confirmedStep !== null ? [] : (outside
    ? flow.steps.map((step, index) => ({
      value: String(index),
      label: player.scenarioStepOption(index + 1, screenNames.get(step.screenId) ?? step.screenId),
    }))
    : matches.map((index) => ({ value: String(index), label: player.scenarioOccurrence(index + 1) })));

  return <section
    aria-label={player.scenarioAria}
    data-testid="scenario-bar"
    className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-white px-5 py-2.5 text-sm text-eui-ink sm:px-6"
  >
    <ScenarioPicker flows={flows} flow={flow} routeBase={routeBase} onSelect={onFlowChange} onOpenChange={setPickerOpen} />

    {flow === null ? null : <>
      {/* Полоса всегда сообщает «Шаг N из M»: без счётчика неопределённое
          состояние читалось как поломка, а не как вопрос к пользователю. */}
      <span role="status" className="text-eui-slate-500">
        {confirmedStep === null ? player.scenarioStepUnknown(flow.steps.length) : player.scenarioStep(confirmedStep + 1, flow.steps.length)}
        {confirmedStep === null
          ? <> · {outside ? player.scenarioOutside : player.scenarioAmbiguous}</>
          : currentStepScreen === undefined ? null : <span className="text-eui-ink"> · {currentStepScreen}</span>}
      </span>
      {/* Прогресс шага: точка 8px, активный шаг — красная «капсула» 22×8. */}
      <ol className="flex items-center gap-1.5" aria-hidden="true">
        {flow.steps.map((step, index) => <li
          key={`${step.screenId}:${index}`}
          className={`h-2 rounded-full ${index === confirmedStep ? "w-[22px] bg-pay-red" : "w-2 bg-pay-lavender-light"}`}
        />)}
      </ol>
      <div
        role="group"
        aria-label={player.scenarioStepsAria}
        aria-describedby="scenario-guided-browse"
        title={player.scenarioGuidedBrowse}
        className="flex items-center gap-2"
      >
        <button
          type="button"
          aria-label={player.scenarioPreviousHotkey}
          title={player.scenarioPreviousHotkey}
          disabled={confirmedStep === null || confirmedStep === 0}
          onClick={() => setPending(confirmedStep! - 1)}
          className={stepCircle}
        >
          <span aria-hidden="true">←</span>
        </button>
        <button
          type="button"
          aria-label={player.scenarioNextHotkey}
          title={player.scenarioNextHotkey}
          disabled={confirmedStep === null || confirmedStep === flow.steps.length - 1}
          onClick={() => setPending(confirmedStep! + 1)}
          className={stepCircle}
        >
          <span aria-hidden="true">→</span>
        </button>
      </div>
      {/* Пояснение про guided browse больше не абзац документации в тулбаре
          (W4-10): оно висит подсказкой ровно на тех кнопках, к которым относится. */}
      <p id="scenario-guided-browse" className="sr-only">{player.scenarioGuidedBrowse}</p>
      {resolveOptions.length === 0 ? null : <SelectPill
        label={player.scenarioResolveAria}
        value=""
        options={[
          { value: "", label: ambiguous ? player.scenarioResolveAmbiguous : player.scenarioResolveOutside },
          ...resolveOptions,
        ]}
        onChange={(value) => {
          if (value === "") return;
          const index = Number(value);
          if (outside) setPending(index);
          else chooseOccurrence(index);
        }}
      />}
    </>}
  </section>;
}
