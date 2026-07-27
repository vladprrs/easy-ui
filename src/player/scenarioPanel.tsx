import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { scenarios as strings } from "../app/strings/player";
import { pillGhost } from "../app/chrome";
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

const box = "rounded border border-white/20 bg-transparent px-2 py-1 text-xs text-white placeholder:text-white/40";
const button = "rounded border border-white/20 px-2 py-0.5 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50";

const statusClass: Record<ScenarioStepResult["status"], string> = {
  pass: "text-eui-mint",
  fail: "text-eui-orange",
  stale: "text-white/50",
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
  if (!steps.length) return <p className="px-3 py-2 text-white/50">{strings.stepsEmpty}</p>;
  return <ol aria-label={strings.stepsAria} className="min-h-0 flex-1 overflow-y-auto px-3 py-2" data-testid="scenario-steps">
    {steps.map((step, index) => {
      const result = results[index];
      return <li
        key={index}
        data-testid={`scenario-step-${index}`}
        aria-current={current === index ? "step" : undefined}
        className={`flex items-start gap-2 border-b border-white/10 py-1 last:border-b-0 ${current === index ? "bg-white/10" : ""}`}
      >
        <span className="w-4 shrink-0 text-white/40">{index + 1}</span>
        <span className="min-w-0 flex-1 break-all">{describeStep(step)}</span>
        {result ? <span className={`shrink-0 ${statusClass[result.status]}`} data-testid={`scenario-step-status-${index}`}>{strings.statusLabel[result.status]}</span> : null}
        {onRemove ? <button type="button" aria-label={strings.stepRemove} title={strings.stepRemove} onClick={() => onRemove(index)} className="shrink-0 px-1 text-white/50 hover:text-white">×</button> : null}
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

  return <aside aria-label={strings.panelAria} className="flex h-full w-80 shrink-0 flex-col overflow-hidden border-l border-white/20 bg-eui-graphite font-mono text-xs text-white">
    <header className="flex items-center gap-2 border-b border-white/15 px-3 py-2">
      <span className="font-semibold">{strings.title}</span>
      <button
        type="button"
        className={`${button} ml-auto ${draft.recording ? "border-eui-orange text-eui-orange" : ""}`}
        aria-pressed={draft.recording}
        data-testid="scenario-record"
        onClick={() => setDraft((value) => value.recording
          ? { ...value, recording: false }
          : { recording: true, steps: startRecording(screenId), name: value.name, scenarioId: value.scenarioId })}
      >{draft.recording ? strings.stop : strings.record}</button>
      <button type="button" className={button} aria-label={strings.close} title={strings.close} onClick={controller.toggle}>×</button>
    </header>

    {draft.recording ? <p className="border-b border-white/15 px-3 py-1 text-eui-orange" role="status">{strings.recordHint}</p> : null}
    {error ? <p className="border-b border-white/15 px-3 py-1 text-eui-orange" role="alert">{error}</p> : null}

    <div className="flex min-h-0 flex-1 flex-col">
      <StepList
        steps={draft.steps}
        results={results}
        current={current}
        onRemove={(index) => setDraft((value) => ({ ...value, steps: removeStep(value.steps, index) }))}
      />
      {summary ? <p className={`px-3 py-1 ${summary.failed ? "text-eui-orange" : "text-eui-mint"}`} role="status" data-testid="scenario-run-summary">
        {summary.text} · {summary.failed ? strings.runFailed : strings.runPassed}
      </p> : null}

      <div className="border-t border-white/15 px-3 py-2">
        {adding === null
          ? <div className="flex flex-wrap items-center gap-1">
            <select aria-label={strings.expectationType} className={box} value="" onChange={(event) => { setAdding(event.target.value as ScenarioStepType); setFields({ text: "", pointer: "", value: "" }); }}>
              <option value="" className="bg-eui-graphite">{strings.addExpectation}</option>
              {EXPECTATION_TYPES.map((type) => <option key={type} value={type} className="bg-eui-graphite">{strings.stepTypeLabel[type]}</option>)}
            </select>
          </div>
          : <div className="flex flex-col gap-1">
            <span className="text-white/60">{strings.stepTypeLabel[adding]}</span>
            {adding === "setState" || adding === "expectState"
              ? <>
                <input aria-label={strings.pointerLabel} placeholder="/path" className={box} value={fields.pointer} onChange={(event) => setFields((value) => ({ ...value, pointer: event.target.value }))} />
                <input aria-label={strings.valueLabel} placeholder='"value"' className={box} value={fields.value} onChange={(event) => setFields((value) => ({ ...value, value: event.target.value }))} />
              </>
              : <input aria-label={strings.expectationValue} className={box} value={fields.text} onChange={(event) => setFields((value) => ({ ...value, text: event.target.value }))} />}
            <div className="flex gap-1">
              <button type="button" className={button} onClick={addExpectation}>{strings.add}</button>
              <button type="button" className={button} onClick={() => { setAdding(null); setError(null); }}>{strings.cancel}</button>
            </div>
          </div>}
      </div>

      <div className="flex flex-col gap-1 border-t border-white/15 px-3 py-2">
        <input
          aria-label={strings.nameLabel}
          placeholder={strings.namePlaceholder}
          className={box}
          value={draft.name}
          onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))}
        />
        <div className="flex flex-wrap gap-1">
          <button type="button" className={button} data-testid="scenario-replay" disabled={!draft.steps.length || running} onClick={() => { void replay(draft.steps); }}>
            {running ? strings.replaying : strings.replay}
          </button>
          <button type="button" className={button} data-testid="scenario-save" disabled={!draft.steps.length || saving} onClick={() => { void save(); }}>
            {saving ? strings.saving : strings.save}
          </button>
          <button type="button" className={button} onClick={() => { setDraft(emptyScenarioDraft); setResults([]); setCurrent(null); }}>{strings.discard}</button>
        </div>
      </div>

      {/* pb-16: нижний правый угол панели перекрывает пузырь json-render devtools в dev-режиме. */}
      <section className="max-h-48 shrink-0 overflow-y-auto border-t border-white/15 px-3 pt-2 pb-16">
        {list.status === "loading" ? <p className="text-white/50">{strings.loading}</p> : null}
        {list.status === "error" ? <p className="text-eui-orange">{strings.loadError}</p> : null}
        {list.status === "ready" && list.data.length === 0 ? <p className="text-white/50">{strings.empty}</p> : null}
        {list.status === "ready" && list.data.length > 0 ? <ul aria-label={strings.listAria}>
          {list.data.map((scenario) => <li key={scenario.id} className="flex items-center gap-2 border-b border-white/10 py-1 last:border-b-0">
            <span className="min-w-0 flex-1 break-all">{scenario.name}</span>
            <button type="button" className={button} onClick={() => open(scenario)}>{strings.edit}</button>
            <button type="button" className={button} disabled={running} onClick={() => { open(scenario); void replay(scenario.steps); }}>{strings.replay}</button>
            <button type="button" className={button} onClick={() => { void remove(scenario); }}>{strings.delete}</button>
          </li>)}
        </ul> : null}
      </section>
    </div>
    <HighlightLayer rects={rects} testId="scenario-highlights" className="rounded-md border-2 border-eui-brand bg-eui-brand/20" />
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
