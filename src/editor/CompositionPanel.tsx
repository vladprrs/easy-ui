import { useContext, useState, type Dispatch } from "react";
import { inputBase, kicker } from "../app/chrome";
import { editor } from "../app/strings/editor";
import type { CompositionDoc, CompositionParam } from "../prototype/composition";
import { jsonValueSchema, type JsonValue } from "../prototype/schema";
import type { EditorAction } from "./editorReducer";
import type { ScreenElement, Screen } from "./compositions";
import { AssetValueField, DocEpochContext } from "./propsForm/PropsForm";

/**
 * Панель ссылки на композицию (волна 5, план 2026-07-27 §5).
 *
 * Показывает пин композиции, форму её **параметров** (подставляют только props) и
 * раскладку детей ссылки по слотам. Внутренности композиции здесь не редактируются:
 * авторский документ владеет только самой ссылкой.
 */

const inputClass = `${inputBase} mt-1 w-full bg-white text-eui-ink`;
const DEFAULT_SLOT = "default";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ParamField({ name, declared, value, onCommit }: {
  name: string;
  declared: CompositionParam;
  value: JsonValue | undefined;
  onCommit: (value: JsonValue | undefined) => void;
}) {
  const docEpoch = useContext(DocEpochContext);
  const label = <span className="font-eui-ui text-xs text-eui-slate-500">
    {name}{declared.required ? <span className="ml-1 text-pay-red">*</span> : null}
    {declared.description ? <span className="ml-1 text-eui-slate-400">— {declared.description}</span> : null}
  </span>;

  if (declared.type === "boolean") {
    return <label className="flex items-center gap-2 py-1">
      <input type="checkbox" aria-label={name} checked={value === true} onChange={(event) => onCommit(event.target.checked)} />
      {label}
    </label>;
  }
  if (declared.type === "asset") {
    return <div className="py-1">{label}<AssetValueField name={name} value={value} onCommit={(next) => onCommit(next as JsonValue)} /></div>;
  }
  if (declared.type === "json") {
    return <JsonParamField key={`${docEpoch}:${name}`} name={name} value={value} onCommit={onCommit} label={label} />;
  }
  return <ScalarParamField
    key={`${docEpoch}:${name}:${String(value ?? "")}`}
    name={name}
    numeric={declared.type === "number"}
    value={value}
    onCommit={onCommit}
    label={label}
  />;
}

function ScalarParamField({ name, numeric, value, onCommit, label }: {
  name: string; numeric: boolean; value: JsonValue | undefined; onCommit: (value: JsonValue | undefined) => void; label: React.ReactNode;
}) {
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  const [error, setError] = useState("");
  const commit = () => {
    if (!draft.trim()) { setError(""); onCommit(undefined); return; }
    if (!numeric) { setError(""); onCommit(draft); return; }
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) { setError(editor.propNumberInvalid); return; }
    setError(""); onCommit(parsed);
  };
  return <label className="block py-1">{label}
    <input
      aria-label={name}
      type={numeric ? "number" : "text"}
      className={inputClass}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); event.currentTarget.blur(); } }}
    />
    {error ? <span role="alert" className="mt-1 block font-eui-ui text-xs text-pay-red">{error}</span> : null}
  </label>;
}

function JsonParamField({ name, value, onCommit, label }: {
  name: string; value: JsonValue | undefined; onCommit: (value: JsonValue | undefined) => void; label: React.ReactNode;
}) {
  const [text, setText] = useState(() => (value === undefined ? "" : JSON.stringify(value, null, 2)));
  const [error, setError] = useState("");
  const commit = () => {
    if (!text.trim()) { setError(""); onCommit(undefined); return; }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { setError(editor.invalidJson); return; }
    const parsed = jsonValueSchema.safeParse(raw);
    if (!parsed.success) { setError(editor.invalidJson); return; }
    setError(""); onCommit(parsed.data);
  };
  return <label className="block py-1">{label}
    <textarea aria-label={name} className={`${inputClass} min-h-20 font-mono`} value={text} onChange={(event) => setText(event.target.value)} onBlur={commit} />
    {error ? <span role="alert" className="mt-1 block font-eui-ui text-xs text-pay-red">{error}</span> : null}
  </label>;
}

export interface CompositionPanelProps {
  screen: Screen;
  elementKey: string;
  element: ScreenElement;
  compositionId: string;
  composition?: CompositionDoc;
  /** Версия закреплённой композиции (из пинов ревизии). */
  version?: number;
  dispatch: Dispatch<EditorAction>;
  onSelectElement: (key: string) => void;
}

export function CompositionPanel({ screen, elementKey, element, compositionId, composition, version, dispatch, onSelectElement }: CompositionPanelProps) {
  const provided = isObject(element.props.params) ? element.props.params as Record<string, JsonValue> : {};

  const commitParam = (name: string, value: JsonValue | undefined) => {
    const params = { ...provided };
    if (value === undefined) delete params[name]; else params[name] = value;
    const props = { ...element.props };
    if (Object.keys(params).length) props.params = params; else delete props.params;
    dispatch({ type: "set-element-props", screenId: screen.id, elementKey, props });
  };

  const children = (element.children ?? []).filter((key) => Object.hasOwn(screen.spec.elements, key));
  const slots = composition?.slots ?? [];
  const slotOf = (key: string) => screen.spec.elements[key]?.slot ?? DEFAULT_SLOT;

  return <section className="mt-4 border-t border-eui-ink/10 pt-4" aria-label={editor.sectionComposition}>
    <h3 className={`${kicker} mb-2 font-eui-ui`}>{editor.sectionComposition}</h3>
    <dl className="mb-3 space-y-0.5 font-eui-ui text-xs">
      <div className="flex gap-2"><dt className="text-eui-slate-500">{editor.compositionIdLabel}</dt><dd className="min-w-0 break-all text-eui-ink">{compositionId}</dd></div>
      {composition ? <div className="flex gap-2"><dt className="text-eui-slate-500">{editor.nameLabel}</dt><dd className="min-w-0 break-words text-eui-ink">{composition.name}</dd></div> : null}
      <div className="flex gap-2"><dt className="text-eui-slate-500">{editor.compositionVersionLabel}</dt><dd className="text-eui-ink">{version === undefined ? editor.compositionVersionUnpinned : editor.versionBadge(version)}</dd></div>
    </dl>
    {composition ? null : <p role="alert" className="mb-3 font-eui-ui text-xs text-pay-red">{editor.compositionUnknown(compositionId)}</p>}
    <p className="mb-3 font-eui-ui text-xs text-eui-slate-400">{editor.compositionInnerReadonly}</p>

    <h4 className="mb-1 font-eui-ui text-xs font-medium text-eui-ink">{editor.compositionParamsTitle}</h4>
    {composition && Object.keys(composition.params).length
      ? <div className="space-y-1">{Object.entries(composition.params).map(([name, declared]) => <ParamField
        key={name}
        name={name}
        declared={declared}
        value={Object.hasOwn(provided, name) ? provided[name] : undefined}
        onCommit={(value) => commitParam(name, value)}
      />)}</div>
      : <p className="font-eui-ui text-xs text-eui-slate-500">{editor.compositionNoParams}</p>}

    <h4 className="mt-4 mb-1 font-eui-ui text-xs font-medium text-eui-ink">{editor.compositionSlotsTitle}</h4>
    {slots.length
      ? <ul className="space-y-0.5 font-eui-ui text-xs">{slots.map((slot) => {
        const filled = children.filter((key) => slotOf(key) === slot);
        return <li key={slot} className="flex gap-2">
          <span className="shrink-0 font-mono text-eui-ink">{slot}</span>
          <span className="min-w-0 break-words text-eui-slate-500">{filled.length ? filled.join(", ") : editor.compositionSlotEmpty}</span>
        </li>;
      })}</ul>
      : <p className="font-eui-ui text-xs text-eui-slate-500">{editor.compositionNoSlots}</p>}

    <h4 className="mt-4 mb-1 font-eui-ui text-xs font-medium text-eui-ink">{editor.compositionChildrenTitle}</h4>
    {children.length
      ? <ul className="space-y-1">{children.map((key) => <li key={key} className="flex items-center gap-2">
        <button
          type="button"
          className="min-w-0 flex-1 truncate rounded-item px-2 py-1 text-left font-eui-ui text-xs text-eui-slate-500 hover:bg-eui-lilac-100"
          onClick={() => onSelectElement(key)}
        >{screen.spec.elements[key]!.type} · {key}</button>
        <select
          aria-label={editor.compositionSlotSelectAria(key)}
          className={`${inputBase} w-32 shrink-0 bg-white font-eui-ui text-xs text-eui-ink`}
          value={slotOf(key)}
          onChange={(event) => dispatch({
            type: "set-element-slot",
            screenId: screen.id,
            elementKey: key,
            slot: event.target.value === DEFAULT_SLOT ? undefined : event.target.value,
          })}
        >
          {(slots.includes(slotOf(key)) ? slots : [slotOf(key), ...slots]).map((slot) => <option key={slot} value={slot}>{slot}</option>)}
        </select>
      </li>)}</ul>
      : <p className="font-eui-ui text-xs text-eui-slate-500">{editor.compositionNoChildren}</p>}
  </section>;
}
