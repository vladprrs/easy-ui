import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { scenarios as strings } from "../app/strings/player";
import { inputBase, pillDeep, pillGhost } from "../app/chrome";
import { SelectPill } from "../app/SelectPill";
import type { PrototypeDoc } from "../prototype/schema";
import {
  SCENARIO_STEPS_LIMIT, scenarioStepSchema,
  type PrototypeScenario, type ScenarioStep, type ScenarioStepType,
} from "../prototype/scenario";
import {
  createPrototypeScenario, deletePrototypeScenario, listPrototypeScenarios, savePrototypeScenario,
} from "../api/client";
import { useApi } from "../api/hooks";
import {
  appendClickStep, appendScreenStep, elementKeyFromPath, removeStep, scenarioIdFromName, startRecording,
} from "./scenarioRecording";
import { runScenario, type ScenarioStepResult } from "./scenarioRunner";
import { HighlightLayer, measureMarkerRects, type HighlightRect } from "./ScreenSurface";

/**
 * Панель сценариев плеера (волна 6, план 2026-07-27 §«Волна 6»).
 *
 * Рекордер: пока включена запись, capture-слушатель на документе фиксирует клики по
 * `[data-eui-key]` и переходы между экранами. Слушатель никогда не гасит событие и
 * живёт ровно столько, сколько включена запись, — вне режима записи взаимодействие с
 * прототипом ничем не отличается от обычного (тот же приём, что у вкладки «Дерево»).
 *
 * Прогон: `runScenario` работает в отдельной сессии рантайма и не трогает открытый
 * экран — живое состояние плеера остаётся тем, каким его оставил автор. Подсвечивается
 * текущий шаг в списке и, если элемент шага есть на открытом экране, его DOM-узел.
 */

export interface ScenarioDraft {
  recording: boolean;
  steps: ScenarioStep[];
  name: string;
  /** Идентификатор редактируемого сценария; null — новый. */
  scenarioId: string | null;
}

export const emptyScenarioDraft: ScenarioDraft = { recording: false, steps: [], name: "", scenarioId: null };

export interface ScenarioPanelController {
  enabled: boolean;
  open: boolean;
  toggle: () => void;
  draft: ScenarioDraft;
  setDraft: Dispatch<SetStateAction<ScenarioDraft>>;
}

/**
 * Панель в бренде Пэй (W4-13): белая поверхность, YS Text, пилюли. Бордеров и
 * теней в бренде нет — единственная разрешённая линия — 1px лаванда, ею и
 * разделяются секции панели. `font-mono` осталась только там, где показывается
 * машинный текст (JSON-значения шага), — в остальном панель читается как UI.
 */
const box = `${inputBase} w-full`;
const button = `${pillGhost} px-3 py-1.5 text-[13px] disabled:cursor-not-allowed disabled:opacity-50`;
const sectionDivider = "border-t border-pay-lavender";

// Три состояния шага кодируются словом (`statusLabel`) и цветом; зелёного в
// бренде нет, поэтому «ок» — обычный чернильный, а красный остаётся за провалом.
const statusClass: Record<ScenarioStepResult["status"], string> = {
  pass: "font-medium text-eui-ink",
  fail: "font-medium text-pay-red",
  stale: "text-eui-slate-500",
};

export function describeStep(step: ScenarioStep): string {
  switch (step.type) {
    case "click": return `${strings.stepTypeLabel.click}: ${step.label ?? step.elementKey}`;
    case "expectScreen": return `${strings.stepTypeLabel.expectScreen}: ${step.screenId}`;
    case "expectText": return `${strings.stepTypeLabel.expectText}: «${step.text}»`;
    case "setState": return `${strings.stepTypeLabel.setState}: ${step.pointer} = ${JSON.stringify(step.value)}`;
    case "expectState": return `${strings.stepTypeLabel.expectState}: ${step.pointer} = ${JSON.stringify(step.value)}`;
    case "expectDisabled": return `${strings.stepTypeLabel.expectDisabled}: ${step.elementKey}`;
  }
}

const EXPECTATION_TYPES: ScenarioStepType[] = ["expectScreen", "expectText", "expectDisabled", "setState", "expectState"];

/** Собирает шаг из полей формы; `null` — форма заполнена неверно (сообщение показывает панель). */
export function buildStep(type: ScenarioStepType, fields: { text: string; pointer: string; value: string }): ScenarioStep | null {
  const candidate = (() => {
    switch (type) {
      case "expectScreen": return { type, screenId: fields.text.trim() };
      case "expectText": return { type, text: fields.text.trim() };
      case "expectDisabled": return { type, elementKey: fields.text.trim() };
      case "click": return { type, elementKey: fields.text.trim() };
      case "setState":
      case "expectState": {
        try { return { type, pointer: fields.pointer.trim(), value: JSON.parse(fields.value) as never }; }
        catch { return null; }
      }
    }
  })();
  if (candidate === null) return null;
  const parsed = scenarioStepSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function StepList({ steps, results, current, onRemove }: {
  steps: readonly ScenarioStep[];
  results: readonly ScenarioStepResult[];
  current: number | null;
  onRemove?: (index: number) => void;
}) {
  if (!steps.length) return <p className="px-4 py-3 text-eui-slate-500">{strings.stepsEmpty}</p>;
  return <ol aria-label={strings.stepsAria} className="min-h-0 flex-1 overflow-y-auto px-3 py-2" data-testid="scenario-steps">
    {steps.map((step, index) => {
      const result = results[index];
      return <li
        key={index}
        data-testid={`scenario-step-${index}`}
        aria-current={current === index ? "step" : undefined}
        className={`flex flex-wrap items-start gap-x-2 gap-y-1 rounded-item px-1.5 py-1.5 ${current === index ? "bg-pay-lavender" : ""}`}
      >
        <span className="w-4 shrink-0 tabular-nums text-eui-slate-500">{index + 1}</span>
        <span className="min-w-0 flex-1 break-words">{describeStep(step)}</span>
        {result ? <span className={`shrink-0 ${statusClass[result.status]}`} data-testid={`scenario-step-status-${index}`}>{strings.statusLabel[result.status]}</span> : null}
        {onRemove ? <button type="button" aria-label={strings.stepRemove} title={strings.stepRemove} onClick={() => onRemove(index)} className="shrink-0 px-1 text-eui-slate-500 transition-colors duration-100 hover:text-pay-red"><span aria-hidden="true">✕</span></button> : null}
      </li>;
    })}
  </ol>;
}

export function ScenarioPanel({ doc, screenId, controller }: {
  doc: PrototypeDoc;
  screenId: string;
  controller: ScenarioPanelController;
}) {
  const { draft, setDraft } = controller;
  const list = useApi((signal) => listPrototypeScenarios(doc.id, signal), [doc.id]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState<ScenarioStepResult[]>([]);
  const [current, setCurrent] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [adding, setAdding] = useState<ScenarioStepType | null>(null);
  const [fields, setFields] = useState({ text: "", pointer: "", value: "" });
  // Подтверждение удаления вторым кликом: окно 2 с — меньше нельзя (S6 требует
  // ≥1.5 с), больше — и «Удалить?» останется висеть на кнопке, о которой забыли.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  useEffect(() => {
    if (pendingDelete === null) return;
    const timer = setTimeout(() => setPendingDelete(null), 2_000);
    return () => clearTimeout(timer);
  }, [pendingDelete]);

  // Клики рекордера: capture-фаза, без preventDefault — обычное взаимодействие не меняется.
  useEffect(() => {
    if (!draft.recording) return;
    const onClick = (event: MouseEvent) => {
      const hit = elementKeyFromPath(event.composedPath());
      if (!hit) return;
      setDraft((value) => value.recording ? { ...value, steps: appendClickStep(value.steps, hit) } : value);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [draft.recording, setDraft]);

  // Переход между экранами фиксируется как ожидание экрана.
  useEffect(() => {
    if (!draft.recording) return;
    setDraft((value) => value.recording ? { ...value, steps: appendScreenStep(value.steps, screenId) } : value);
  }, [draft.recording, screenId, setDraft]);

  const replay = useCallback(async (steps: readonly ScenarioStep[]) => {
    setRunning(true);
    setResults([]);
    setCurrent(null);
    try {
      const run = await runScenario(steps, doc, {
        onStep: (result, all) => { setResults([...all]); setCurrent(result.index); },
      });
      setResults(run.steps);
      setCurrent(null);
      return run;
    } finally { setRunning(false); }
  }, [doc]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const name = draft.name.trim() || strings.title;
      if (draft.scenarioId) await savePrototypeScenario(doc.id, draft.scenarioId, { name, steps: draft.steps });
      else {
        const created = await createPrototypeScenario(doc.id, { id: scenarioIdFromName(name), name, steps: draft.steps });
        setDraft((value) => ({ ...value, scenarioId: created.id, name: created.name }));
      }
      list.reload();
    } catch { setError(strings.saveError); }
    finally { setSaving(false); }
  };

  const remove = async (scenario: PrototypeScenario) => {
    setError(null);
    try {
      await deletePrototypeScenario(doc.id, scenario.id);
      if (draft.scenarioId === scenario.id) setDraft(emptyScenarioDraft);
      list.reload();
    } catch { setError(strings.deleteError); }
  };

  const open = (scenario: PrototypeScenario) => {
    setResults([]);
    setCurrent(null);
    setDraft({ recording: false, steps: scenario.steps, name: scenario.name, scenarioId: scenario.id });
  };

  const addExpectation = () => {
    if (adding === null) return;
    const step = buildStep(adding, fields);
    if (!step) { setError(strings.invalidStep); return; }
    setError(null);
    setDraft((value) => ({ ...value, steps: value.steps.length >= SCENARIO_STEPS_LIMIT ? value.steps : [...value.steps, step] }));
    setAdding(null);
    setFields({ text: "", pointer: "", value: "" });
  };

  // Подсветка DOM для текущего шага прогона, если его элемент есть на открытом экране.
  const currentStep = current === null ? undefined : draft.steps[current];
  const highlightKey = currentStep && (currentStep.type === "click" || currentStep.type === "expectDisabled") ? currentStep.elementKey : null;
  const rects = useMarkerRects(highlightKey);

  const summary = useMemo(() => {
    if (!results.length) return null;
    const passed = results.filter((item) => item.status === "pass").length;
    const stale = results.filter((item) => item.status === "stale").length;
    return { text: strings.runSummary(passed, results.length, stale), failed: results.some((item) => item.status === "fail") };
  }, [results]);

  return <aside aria-label={strings.panelAria} className="flex h-full w-80 shrink-0 flex-col overflow-hidden bg-white text-[13px] text-eui-ink">
    <header className="flex items-center gap-2 px-4 py-3">
      <span className="text-base font-medium">{strings.title}</span>
      <button
        type="button"
        className={`ml-auto ${draft.recording ? `${pillDeep} px-3 py-1.5 text-[13px]` : button}`}
        aria-pressed={draft.recording}
        data-testid="scenario-record"
        onClick={() => setDraft((value) => value.recording
          ? { ...value, recording: false }
          : { recording: true, steps: startRecording(screenId), name: value.name, scenarioId: value.scenarioId })}
      >{draft.recording ? strings.stop : strings.record}</button>
      <button type="button" className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-pay-lavender transition-colors duration-100 hover:brightness-95" aria-label={strings.close} title={strings.close} onClick={controller.toggle}><span aria-hidden="true">✕</span></button>
    </header>

    {draft.recording ? <p className="px-4 pb-2 text-eui-slate-500" role="status">{strings.recordHint}</p> : null}
    {error ? <p className="px-4 pb-2 font-medium text-pay-red" role="alert">{error}</p> : null}

    {/* overflow-y-auto здесь обязателен: без него автоматический min-height флекс-элемента
        равен высоте нескрываемых блоков (форма ожидания + имя + кнопки), и список
        сохранённых проверок ниже выдавливается за overflow-hidden панели. */}
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <StepList
        steps={draft.steps}
        results={results}
        current={current}
        onRemove={(index) => setDraft((value) => ({ ...value, steps: removeStep(value.steps, index) }))}
      />
      {summary ? <p className={`px-4 py-1.5 ${summary.failed ? "font-medium text-pay-red" : "text-eui-slate-500"}`} role="status" data-testid="scenario-run-summary">
        {summary.text} · {summary.failed ? strings.runFailed : strings.runPassed}
      </p> : null}

      <div className={`${sectionDivider} px-4 py-3`}>
        {adding === null
          ? <SelectPill
            label={strings.expectationType}
            value=""
            options={[
              { value: "", label: strings.addExpectation },
              ...EXPECTATION_TYPES.map((type) => ({ value: type, label: strings.stepTypeLabel[type] })),
            ]}
            onChange={(value) => { if (value === "") return; setAdding(value as ScenarioStepType); setFields({ text: "", pointer: "", value: "" }); }}
          />
          : <div className="flex flex-col gap-2">
            <span className="text-eui-slate-500">{strings.stepTypeLabel[adding]}</span>
            {adding === "setState" || adding === "expectState"
              ? <>
                <input aria-label={strings.pointerLabel} placeholder="/path" className={box} value={fields.pointer} onChange={(event) => setFields((value) => ({ ...value, pointer: event.target.value }))} />
                <input aria-label={strings.valueLabel} placeholder='"value"' className={box} value={fields.value} onChange={(event) => setFields((value) => ({ ...value, value: event.target.value }))} />
              </>
              : <input aria-label={strings.expectationValue} className={box} value={fields.text} onChange={(event) => setFields((value) => ({ ...value, text: event.target.value }))} />}
            <div className="flex gap-2">
              <button type="button" className={button} onClick={addExpectation}>{strings.add}</button>
              <button type="button" className={button} onClick={() => { setAdding(null); setError(null); }}>{strings.cancel}</button>
            </div>
          </div>}
      </div>

      <div className={`flex flex-col gap-2 ${sectionDivider} px-4 py-3`}>
        <input
          aria-label={strings.nameLabel}
          placeholder={strings.namePlaceholder}
          className={box}
          value={draft.name}
          onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))}
        />
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} data-testid="scenario-replay" disabled={!draft.steps.length || running} onClick={() => { void replay(draft.steps); }}>
            {running ? strings.replaying : strings.replay}
          </button>
          <button type="button" className={button} data-testid="scenario-save" disabled={!draft.steps.length || saving} onClick={() => { void save(); }}>
            {saving ? strings.saving : strings.save}
          </button>
          <button type="button" className={button} onClick={() => { setDraft(emptyScenarioDraft); setResults([]); setCurrent(null); }}>{strings.discard}</button>
        </div>
      </div>
    </div>

    {/* Список сохранённых проверок — сосед скроллящегося черновика, а не его часть:
        вложенным он клипался в ноль, как только черновик набирал шагов.
        pb-16: нижний правый угол панели перекрывает пузырь json-render devtools в dev-режиме. */}
    <section className={`max-h-48 shrink-0 overflow-y-auto ${sectionDivider} px-4 pt-3 pb-16`}>
        {list.status === "loading" ? <p className="text-eui-slate-500">{strings.loading}</p> : null}
        {list.status === "error" ? <p className="font-medium text-pay-red">{strings.loadError}</p> : null}
        {list.status === "ready" && list.data.length === 0 ? <p className="text-eui-slate-500">{strings.empty}</p> : null}
        {list.status === "ready" && list.data.length > 0 ? <ul aria-label={strings.listAria} className="flex flex-col gap-1.5">
          {/* Имя занимает всю строку, кнопки — следующую: в панели шириной 320
              три пилюли не оставляли имени ни пикселя, и оно схлопывалось в ноль. */}
          {list.data.map((scenario) => <li key={scenario.id} className="flex flex-wrap items-center gap-2">
            <span className="w-full break-words font-medium">{scenario.name}</span>
            <button type="button" className={button} onClick={() => open(scenario)}>{strings.edit}</button>
            <button type="button" className={button} disabled={running} onClick={() => { open(scenario); void replay(scenario.steps); }}>{strings.replay}</button>
            {/* Удаление проверки локально обратимо (её можно записать заново),
                поэтому подтверждение — второй клик с окном 2 с и сменой подписи,
                а не модалка (S6). */}
            <button
              type="button"
              className={pendingDelete === scenario.id ? `${pillDeep} px-3 py-1.5 text-[13px]` : button}
              onClick={() => {
                if (pendingDelete === scenario.id) { setPendingDelete(null); void remove(scenario); return; }
                setPendingDelete(scenario.id);
              }}
            >{pendingDelete === scenario.id ? strings.deleteConfirm : strings.delete}</button>
          </li>)}
      </ul> : null}
    </section>
    <HighlightLayer rects={rects} testId="scenario-highlights" className="rounded-item bg-pay-red/10 outline-2 outline-offset-[6px] outline-pay-red" />
  </aside>;
}

/** Прямоугольники маркера текущего шага; пустой список, когда элемента нет на экране. */
function useMarkerRects(key: string | null): HighlightRect[] {
  const [rects, setRects] = useState<HighlightRect[]>([]);
  useEffect(() => {
    // Замер — чтение layout, поэтому и сброс, и измерение делаются в кадре после коммита.
    const frame = requestAnimationFrame(() => setRects(key === null ? [] : measureMarkerRects(document, new Set([key]))));
    return () => cancelAnimationFrame(frame);
  }, [key]);
  return rects;
}

/** Кнопка в хроме плеера — тем же паттерном, что тумблер инспектора. */
export function ScenarioToggle({ controller }: { controller: ScenarioPanelController }) {
  return <button type="button" aria-pressed={controller.open} onClick={controller.toggle} className={pillGhost} data-testid="scenario-toggle">{strings.action}</button>;
}
