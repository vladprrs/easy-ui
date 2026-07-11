import { useState, type Dispatch, type KeyboardEvent } from "react";
import { z } from "zod";
import { inputBase, kicker } from "../app/chrome";
import type { ComponentDefinition } from "../catalog/definitions";
import { jsonValueSchema, type JsonValue } from "../prototype/schema";
import { FORBIDDEN_STATE_KEYS, mergeScreenState, STATE_OVERRIDE_DEPTH_LIMIT } from "../prototype/stateOverrides";
import type { EditorAction, EditorState } from "./editorReducer";
import { ElementTree } from "./ElementTree";
import { PropsForm } from "./propsForm/PropsForm";

const inputClass = `${inputBase} mt-1 w-full bg-white`;
const overridesSchema = z.record(z.string(), jsonValueSchema);

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="border-b border-eui-ink/10 p-4 last:border-b-0"><h2 className={`${kicker} mb-3 font-eui-ui`}>{title}</h2>{children}</section>;
}

function BlurText({ label, value, multiline, onCommit }: { label: string; value: string; multiline?: boolean; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const enter = (event: KeyboardEvent<HTMLInputElement>) => { if (event.key === "Enter") { event.preventDefault(); onCommit(draft); event.currentTarget.blur(); } };
  return <label className="block font-eui-ui text-xs text-eui-slate-500">{label}{multiline ? <textarea className={`${inputClass} min-h-20 text-eui-ink`} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => onCommit(draft)} /> : <input className={`${inputClass} text-eui-ink`} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => onCommit(draft)} onKeyDown={enter} />}</label>;
}

function validateOverrideTree(value: JsonValue, depth = 0): string | null {
  if (Array.isArray(value)) {
    for (const item of value) { const error = validateOverrideTree(item, depth + 1); if (error) return error; }
  } else if (typeof value === "object" && value !== null) {
    if (depth > STATE_OVERRIDE_DEPTH_LIMIT) return `Глубина stateOverrides не должна превышать ${STATE_OVERRIDE_DEPTH_LIMIT}`;
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_STATE_KEYS.has(key)) return `Ключ «${key}» запрещён`;
      const error = validateOverrideTree(item, depth + 1); if (error) return error;
    }
  }
  return null;
}

function JsonEditor({ label, value, onCommit, objectOnly = false, validate }: { label: string; value: unknown; onCommit: (value: Record<string, JsonValue>) => void; objectOnly?: boolean; validate?: (value: JsonValue) => string | null }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState("");
  const commit = () => {
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { setError("Некорректный JSON"); return; }
    const parsed = (objectOnly ? overridesSchema : jsonValueSchema).safeParse(raw);
    if (!parsed.success || typeof parsed.data !== "object" || parsed.data === null || Array.isArray(parsed.data)) { setError("Ожидается JSON-объект"); return; }
    const treeError = validate?.(parsed.data);
    if (treeError) { setError(treeError); return; }
    setError(""); onCommit(parsed.data);
  };
  return <label className="block font-eui-ui text-xs text-eui-slate-500">{label}<textarea className={`${inputClass} min-h-28 font-mono text-eui-ink`} value={text} onChange={(event) => setText(event.target.value)} onBlur={commit} />{error ? <span role="alert" className="mt-1 block text-xs text-eui-magenta">{error}</span> : null}</label>;
}

function CanvasEditor({ canvas, onCommit }: { canvas?: { width: number; height: number }; onCommit: (canvas: { width: number; height: number } | undefined) => void }) {
  const [width, setWidth] = useState(canvas ? String(canvas.width) : "");
  const [height, setHeight] = useState(canvas ? String(canvas.height) : "");
  const [error, setError] = useState("");
  const commit = () => {
    if (!width && !height) { setError(""); onCommit(undefined); return; }
    const w = Number(width), h = Number(height);
    if (!width || !height || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) { setError("Укажите положительные ширину и высоту вместе"); return; }
    setError(""); onCommit({ width: w, height: h });
  };
  return <fieldset className="font-eui-ui"><legend className="text-xs text-eui-slate-500">Холст</legend><div className="mt-1 grid grid-cols-2 gap-2"><label className="text-xs text-eui-slate-500">Ширина<input aria-label="Ширина холста" type="number" className={`${inputClass} text-eui-ink`} value={width} onChange={(event) => setWidth(event.target.value)} onBlur={commit} /></label><label className="text-xs text-eui-slate-500">Высота<input aria-label="Высота холста" type="number" className={`${inputClass} text-eui-ink`} value={height} onChange={(event) => setHeight(event.target.value)} onBlur={commit} /></label></div>{error ? <p role="alert" className="mt-1 text-xs text-eui-magenta">{error}</p> : null}</fieldset>;
}

export function InspectorPanel({ state, definitions, dispatch }: { state: EditorState; definitions: Record<string, ComponentDefinition>; dispatch: Dispatch<EditorAction> }) {
  const screenIndex = state.doc.screens.findIndex((item) => item.id === state.selection.screenId);
  const screen = state.doc.screens[screenIndex];
  if (!screen) return <aside className="w-90 shrink-0 border-l border-eui-ink/10 bg-white p-4"><p className="font-eui-ui text-sm text-eui-slate-500">Экран не найден.</p></aside>;
  const elementKey = state.selection.elementKey;
  const element = elementKey ? screen.spec.elements[elementKey] : undefined;
  const definition = element ? definitions[element.type] : undefined;
  const effectiveState = mergeScreenState(state.doc.state, screen.stateOverrides);
  const elementPath = ["screens", screenIndex, "spec", "elements", elementKey ?? "", "props"];

  return <aside className="w-90 shrink-0 overflow-y-auto border-l border-eui-ink/10 bg-white" aria-label="Инспектор">
    <Section title="Элемент">
      <ElementTree spec={screen.spec} selectedKey={elementKey} onSelect={(key) => dispatch({ type: "select-element", elementKey: key })} />
      {element ? <div className="mt-4 border-t border-eui-ink/10 pt-4"><p className="mb-3 font-eui-ui text-sm"><span className="text-eui-slate-500">Тип:</span> <strong>{element.type}</strong></p>
        {definition ? <PropsForm definition={definition} values={element.props} effectiveState={effectiveState} path={elementPath} onCommit={(props) => dispatch({ type: "set-element-props", screenId: screen.id, elementKey: elementKey!, props })} />
          : <JsonEditor label="Props (JSON)" value={element.props} onCommit={(props) => dispatch({ type: "set-element-props", screenId: screen.id, elementKey: elementKey!, props })} />}
      </div> : <p className="mt-3 font-eui-ui text-sm text-eui-slate-500">Выберите элемент на холсте или в дереве.</p>}
    </Section>
    <Section title="Экран"><div className="space-y-3">
      <BlurText key={`name:${screen.id}:${screen.name}`} label="Название" value={screen.name} onCommit={(name) => dispatch({ type: "set-screen-meta", screenId: screen.id, patch: { name } })} />
      <BlurText key={`note:${screen.id}:${screen.note ?? ""}`} label="Заметка" multiline value={screen.note ?? ""} onCommit={(note) => dispatch({ type: "set-screen-meta", screenId: screen.id, patch: { note: note.trim() ? note : undefined } })} />
      <CanvasEditor key={`canvas:${screen.id}:${screen.canvas?.width ?? ""}:${screen.canvas?.height ?? ""}`} canvas={screen.canvas} onCommit={(canvas) => dispatch({ type: "set-screen-meta", screenId: screen.id, patch: { canvas } })} />
      <JsonEditor key={`overrides:${screen.id}:${JSON.stringify(screen.stateOverrides ?? {})}`} label="stateOverrides (JSON)" objectOnly value={screen.stateOverrides ?? {}} validate={validateOverrideTree} onCommit={(stateOverrides) => dispatch({ type: "set-screen-meta", screenId: screen.id, patch: { stateOverrides } })} />
    </div></Section>
    <Section title="Прототип"><div className="space-y-3">
      <BlurText key={`doc-name:${state.doc.name}`} label="Название" value={state.doc.name} onCommit={(name) => dispatch({ type: "set-doc-meta", patch: { name } })} />
      <BlurText key={`description:${state.doc.description ?? ""}`} label="Описание" multiline value={state.doc.description ?? ""} onCommit={(description) => dispatch({ type: "set-doc-meta", patch: { description } })} />
      <label className="block font-eui-ui text-xs text-eui-slate-500">Стартовый экран<select className={`${inputClass} text-eui-ink`} value={state.doc.startScreen} onChange={(event) => dispatch({ type: "set-doc-meta", patch: { startScreen: event.target.value } })}>{state.doc.screens.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="block font-eui-ui text-xs text-eui-slate-500">Устройство<select className={`${inputClass} text-eui-ink`} value={state.doc.device} onChange={(event) => dispatch({ type: "set-doc-meta", patch: { device: event.target.value as EditorState["doc"]["device"] } })}><option value="mobile">Телефон</option><option value="tablet">Планшет</option><option value="desktop">Компьютер</option></select></label>
    </div></Section>
  </aside>;
}
