import { useState, type Dispatch, type KeyboardEvent } from "react";
import { z } from "zod";
import { inputBase, kicker, pillGhost } from "../app/chrome";
import { deviceNames } from "../app/strings/common";
import { editor } from "../app/strings/editor";
import type { ComponentDefinition } from "../catalog/definitions";
import { regionEligibility } from "../prototype/regionRules";
import { jsonValueSchema, REGION_KINDS, type JsonValue, type PrototypeDoc, type RegionKind } from "../prototype/schema";
import { FORBIDDEN_STATE_KEYS, mergeScreenState, STATE_OVERRIDE_DEPTH_LIMIT } from "../prototype/stateOverrides";
import type { EditorAction, EditorState } from "./editorReducer";
import { ElementTree, getElementPath } from "./ElementTree";
import { PropsForm } from "./propsForm/PropsForm";
import { suggestRegion } from "./regionSuggestion";

const inputClass = `${inputBase} mt-1 w-full bg-white`;
const overridesSchema = z.record(z.string(), jsonValueSchema);

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="border-b border-eui-ink/10 p-4 last:border-b-0"><h2 className={`${kicker} mb-3 font-eui-ui`}>{title}</h2>{children}</section>;
}

function formatParamValue(value: unknown) {
  if (typeof value === "string") return value;
  const json = JSON.stringify(value);
  const text = json ?? String(value);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

function formatAction(action: { action: string; params?: Record<string, unknown> }, screenNames: Map<string, string>) {
  const params = action.params ?? {};
  if (action.action === "navigate" && typeof params.screenId === "string") return `navigate(${screenNames.get(params.screenId) ?? params.screenId})`;
  if (action.action === "openUrl" && typeof params.url === "string") return `openUrl(${params.url})`;
  const summary = Object.entries(params).map(([key, value]) => `${key}: ${formatParamValue(value)}`).join(", ");
  return `${action.action}(${summary})`;
}

function ElementEvents({ on, screenNames }: { on: NonNullable<PrototypeDoc["screens"][number]["spec"]["elements"][string]["on"]>; screenNames: Map<string, string> }) {
  return <div className="mt-4 border-t border-eui-ink/10 pt-4">
    <h3 className={`${kicker} mb-3 font-eui-ui`}>{editor.sectionEvents}</h3>
    <ul className="space-y-2 break-words font-eui-ui text-xs text-eui-ink">
      {Object.entries(on).map(([eventName, handler]) => {
        const actions = Array.isArray(handler) ? handler : [handler];
        return <li key={eventName}>{`${eventName} → ${actions.map((action) => formatAction(action, screenNames)).join(", ")}`}</li>;
      })}
    </ul>
  </div>;
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
    if (depth > STATE_OVERRIDE_DEPTH_LIMIT) return editor.overridesDepthError(STATE_OVERRIDE_DEPTH_LIMIT);
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_STATE_KEYS.has(key)) return editor.forbiddenKeyError(key);
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
    try { raw = JSON.parse(text); } catch { setError(editor.invalidJson); return; }
    const parsed = (objectOnly ? overridesSchema : jsonValueSchema).safeParse(raw);
    if (!parsed.success || typeof parsed.data !== "object" || parsed.data === null || Array.isArray(parsed.data)) { setError(editor.expectObject); return; }
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
    if (!width || !height || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) { setError(editor.canvasSizeError); return; }
    setError(""); onCommit({ width: w, height: h });
  };
  return <fieldset className="font-eui-ui"><legend className="text-xs text-eui-slate-500">{editor.canvasLegend}</legend><div className="mt-1 grid grid-cols-2 gap-2"><label className="text-xs text-eui-slate-500">{editor.widthLabel}<input aria-label={editor.canvasWidthAria} type="number" className={`${inputClass} text-eui-ink`} value={width} onChange={(event) => setWidth(event.target.value)} onBlur={commit} /></label><label className="text-xs text-eui-slate-500">{editor.heightLabel}<input aria-label={editor.canvasHeightAria} type="number" className={`${inputClass} text-eui-ink`} value={height} onChange={(event) => setHeight(event.target.value)} onBlur={commit} /></label></div>{error ? <p role="alert" className="mt-1 text-xs text-eui-magenta">{error}</p> : null}</fieldset>;
}

export function InspectorPanel({ state, definitions, dispatch }: { state: EditorState; definitions: Record<string, ComponentDefinition>; dispatch: Dispatch<EditorAction> }) {
  const screenIndex = state.doc.screens.findIndex((item) => item.id === state.selection.screenId);
  const screen = state.doc.screens[screenIndex];
  if (!screen) return <aside className="w-90 shrink-0 border-l border-eui-ink/10 bg-white p-4"><p className="font-eui-ui text-sm text-eui-slate-500">{editor.screenMissing}</p></aside>;
  const elementKey = state.selection.elementKey;
  const element = elementKey ? screen.spec.elements[elementKey] : undefined;
  const definition = element ? definitions[element.type] : undefined;
  const effectiveState = mergeScreenState(state.doc.state, screen.stateOverrides);
  const elementPath = ["screens", screenIndex, "spec", "elements", elementKey ?? "", "props"];
  const breadcrumbKeys = elementKey ? getElementPath(screen.spec, elementKey) : [];
  const screenNames = new Map(state.doc.screens.map((item) => [item.id, item.name]));
  const directChild = elementKey !== null && (screen.spec.elements[screen.spec.root]?.children ?? []).includes(elementKey);
  const eligibility = regionEligibility(screen);
  const occupiedRegions = new Set(Object.entries(screen.spec.elements)
    .filter(([key]) => key !== elementKey)
    .map(([, candidate]) => candidate.region)
    .filter((region): region is RegionKind => region !== undefined));
  const suggestion = elementKey ? suggestRegion(screen, elementKey) : null;
  const commitCanvas = (canvas: { width: number; height: number } | undefined) => {
    if (canvas !== undefined
      && Object.values(screen.spec.elements).some((candidate) => candidate.region !== undefined)
      && !window.confirm(editor.canvasRegionsConfirm)) return;
    dispatch({ type: "set-screen-meta", screenId: screen.id, patch: { canvas } });
  };

  return <aside className="w-90 shrink-0 overflow-y-auto border-l border-eui-ink/10 bg-white" aria-label={editor.inspectorAria}>
    <Section title={editor.sectionElement}>
      <ElementTree key={screen.id} spec={screen.spec} selectedKey={elementKey} onSelect={(key) => dispatch({ type: "select-element", elementKey: key })} />
      {element ? <div className="mt-4 border-t border-eui-ink/10 pt-4">
        <nav aria-label={editor.elementBreadcrumbsAria} className="mb-3 flex flex-wrap items-center gap-1 font-eui-ui text-xs text-eui-slate-500">
          <button type="button" className="rounded px-1 py-0.5 hover:bg-eui-lilac-100 hover:text-eui-ink" onClick={() => dispatch({ type: "select-element", elementKey: null })}>{editor.screenBreadcrumb}</button>
          {breadcrumbKeys.map((key) => <span key={key} className="contents"><span aria-hidden="true">›</span>{key === elementKey
            ? <span aria-current="page" className="px-1 py-0.5 font-medium text-eui-ink">{screen.spec.elements[key]!.type}</span>
            : <button type="button" className="rounded px-1 py-0.5 hover:bg-eui-lilac-100 hover:text-eui-ink" onClick={() => dispatch({ type: "select-element", elementKey: key })}>{screen.spec.elements[key]!.type}</button>}</span>)}
        </nav>
        <p className="mb-3 font-eui-ui text-sm"><span className="text-eui-slate-500">{editor.typeLabel}</span> <strong>{element.type}</strong></p>
        {directChild ? <div className="mb-3">
          <label className="block font-eui-ui text-xs text-eui-slate-500">{editor.regionLabel}<select
            aria-label={editor.regionLabel}
            className={`${inputClass} text-eui-ink disabled:bg-eui-lav disabled:text-eui-slate-400`}
            value={element.region ?? ""}
            disabled={!eligibility.eligible}
            onChange={(event) => dispatch({
              type: "set-element-region",
              screenId: screen.id,
              elementKey: elementKey!,
              region: event.target.value ? event.target.value as RegionKind : undefined,
            })}
          >
            <option value="">{editor.regionUnsetOption}</option>
            {REGION_KINDS.map((region) => <option key={region} value={region} disabled={occupiedRegions.has(region)}>{editor.regionName[region]}</option>)}
          </select></label>
          {!eligibility.eligible ? <p className="mt-1 font-eui-ui text-xs text-eui-slate-500">{editor.regionUnavailable}</p> : null}
          {suggestion ? <div className="mt-2 flex items-center justify-between gap-2">
            <p className="font-eui-ui text-xs text-eui-slate-500">{editor.regionSuggestion(editor.regionName[suggestion])}</p>
            <button type="button" className={`${pillGhost} shrink-0 px-3 py-1 text-xs`} onClick={() => dispatch({ type: "set-element-region", screenId: screen.id, elementKey: elementKey!, region: suggestion })}>{editor.applyRegionSuggestion}</button>
          </div> : null}
        </div> : null}
        {definition ? <PropsForm definition={definition} values={element.props} effectiveState={effectiveState} path={elementPath} onCommit={(props) => dispatch({ type: "set-element-props", screenId: screen.id, elementKey: elementKey!, props })} />
          : <JsonEditor label="Props (JSON)" value={element.props} onCommit={(props) => dispatch({ type: "set-element-props", screenId: screen.id, elementKey: elementKey!, props })} />}
        {element.on && Object.keys(element.on).length ? <ElementEvents on={element.on} screenNames={screenNames} /> : null}
      </div> : <p className="mt-3 font-eui-ui text-sm text-eui-slate-500">{editor.selectElementHint}</p>}
    </Section>
    <Section title={editor.sectionScreen}><div className="space-y-3">
      <BlurText key={`name:${screen.id}:${screen.name}`} label={editor.nameLabel} value={screen.name} onCommit={(name) => dispatch({ type: "set-screen-meta", screenId: screen.id, patch: { name } })} />
      <BlurText key={`note:${screen.id}:${screen.note ?? ""}`} label={editor.noteLabel} multiline value={screen.note ?? ""} onCommit={(note) => dispatch({ type: "set-screen-meta", screenId: screen.id, patch: { note: note.trim() ? note : undefined } })} />
      <CanvasEditor key={`canvas:${screen.id}:${screen.canvas?.width ?? ""}:${screen.canvas?.height ?? ""}`} canvas={screen.canvas} onCommit={commitCanvas} />
      <JsonEditor key={`overrides:${screen.id}:${JSON.stringify(screen.stateOverrides ?? {})}`} label="stateOverrides (JSON)" objectOnly value={screen.stateOverrides ?? {}} validate={validateOverrideTree} onCommit={(stateOverrides) => dispatch({ type: "set-screen-meta", screenId: screen.id, patch: { stateOverrides } })} />
    </div></Section>
    <Section title={editor.sectionPrototype}><div className="space-y-3">
      <BlurText key={`doc-name:${state.doc.name}`} label={editor.nameLabel} value={state.doc.name} onCommit={(name) => dispatch({ type: "set-doc-meta", patch: { name } })} />
      <BlurText key={`description:${state.doc.description ?? ""}`} label={editor.descriptionLabel} multiline value={state.doc.description ?? ""} onCommit={(description) => dispatch({ type: "set-doc-meta", patch: { description } })} />
      <label className="block font-eui-ui text-xs text-eui-slate-500">{editor.startScreenLabel}<select className={`${inputClass} text-eui-ink`} value={state.doc.startScreen} onChange={(event) => dispatch({ type: "set-doc-meta", patch: { startScreen: event.target.value } })}>{state.doc.screens.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="block font-eui-ui text-xs text-eui-slate-500">{editor.deviceLabel}<select className={`${inputClass} text-eui-ink`} value={state.doc.device} onChange={(event) => dispatch({ type: "set-doc-meta", patch: { device: event.target.value as EditorState["doc"]["device"] } })}><option value="mobile">{deviceNames.mobile}</option><option value="tablet">{deviceNames.tablet}</option><option value="desktop">{deviceNames.desktop}</option></select></label>
    </div></Section>
  </aside>;
}
