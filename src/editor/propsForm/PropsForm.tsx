import { useMemo, useState, type KeyboardEvent } from "react";
import { chip, chipActive, inputBase } from "../../app/chrome";
import type { ComponentDefinition } from "../../catalog/definitions";
import { jsonValueSchema } from "../../prototype/schema";
import { isDynamicValue, validateElementProps } from "../../prototype/validate";
import { describePropsSchema, type PropField, type SelectValue } from "./introspect";

type PropsFormProps = {
  definition: ComponentDefinition;
  values: Record<string, unknown>;
  effectiveState: Record<string, unknown>;
  onCommit: (values: Record<string, unknown>) => void;
  path?: (string | number)[];
};

const controlClass = `${inputBase} mt-1 w-full bg-white text-eui-ink`;
const pointerPart = (value: string) => value.replace(/~1/g, "/").replace(/~0/g, "~");

function optionKey(value: SelectValue): string {
  return JSON.stringify(value) ?? String(value);
}

function FieldLabel({ name, required, children }: { name: string; required: boolean; children: React.ReactNode }) {
  return <label className="block font-eui-ui text-xs text-eui-slate-500">{name}{required ? <span aria-hidden="true"> *</span> : null}{children}</label>;
}

export function PropsForm({ definition, values, effectiveState, onCommit, path = ["props"] }: PropsFormProps) {
  const described = useMemo(() => describePropsSchema(definition.props), [definition]);
  const fields = useMemo(() => {
    if (described === null) return null;
    const known = new Set(described.map((field) => field.name));
    return [...described, ...Object.keys(values).filter((name) => !known.has(name)).map((name): PropField => ({ name, required: false, nullable: true, control: { kind: "json" } }))];
  }, [described, values]);
  const [drafts, setDrafts] = useState<Record<string, { baseline: unknown; text: string }>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const commit = (name: string, value: unknown) => {
    const candidate = { ...values, [name]: value };
    const result = validateElementProps({ definition, props: candidate, state: effectiveState, path });
    if (result.errors.length) {
      const byField: Record<string, string> = {};
      for (const error of result.errors) {
        const parts = error.path.split("/").slice(1).map(pointerPart);
        const field = String(parts[path.length] ?? name);
        byField[field] = byField[field] ? `${byField[field]}; ${error.message}` : error.message;
      }
      setErrors(byField);
      return;
    }
    setErrors({});
    onCommit(candidate);
  };

  const commitJson = (name: string, text: string) => {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { setErrors((current) => ({ ...current, [name]: "Некорректный JSON" })); return; }
    const json = jsonValueSchema.safeParse(parsed);
    if (!json.success) { setErrors((current) => ({ ...current, [name]: "Значение должно быть допустимым JSON" })); return; }
    commit(name, json.data);
  };

  if (fields === null) return <JsonWholeProps key={JSON.stringify(values)} definition={definition} values={values} effectiveState={effectiveState} path={path} onCommit={onCommit} />;

  return <div className="space-y-3">{fields.map((field) => {
    const value = values[field.name] ?? field.defaultValue;
    const dynamic = isDynamicValue(value);
    const kind = dynamic ? "json" : field.control.kind;
    const draft = drafts[field.name];
    const text = draft && Object.is(draft.baseline, value) ? draft.text : (kind === "json" ? JSON.stringify(value, null, 2) : String(value ?? ""));
    const setText = (next: string) => setDrafts((current) => ({ ...current, [field.name]: { baseline: value, text: next } }));
    const enter = (event: KeyboardEvent<HTMLInputElement>, next: () => void) => { if (event.key === "Enter") { event.preventDefault(); next(); event.currentTarget.blur(); } };
    return <div key={field.name}>
      {kind === "switch" ? <label className="flex items-center justify-between gap-3 font-eui-ui text-xs text-eui-slate-500"><span>{field.name}{field.required ? " *" : ""}</span><input type="checkbox" role="switch" checked={value === true} onChange={(event) => commit(field.name, event.target.checked)} /></label>
        : <FieldLabel name={field.name} required={field.required}>
          {kind === "select" ? <select aria-label={field.name} className={`${value === undefined ? chip : chipActive} mt-1 font-eui-ui`} value={optionKey(value as SelectValue)} onChange={(event) => {
            const option = field.control.kind === "select" ? field.control.options.find((item) => optionKey(item) === event.target.value) : undefined;
            commit(field.name, option);
          }}>{field.control.kind === "select" ? field.control.options.map((option) => <option key={optionKey(option)} value={optionKey(option)}>{String(option)}</option>) : null}</select> : null}
          {kind === "text" ? <input aria-label={field.name} className={controlClass} value={text} onChange={(event) => setText(event.target.value)} onBlur={() => commit(field.name, text)} onKeyDown={(event) => enter(event, () => commit(field.name, text))} /> : null}
          {kind === "number" ? <input aria-label={field.name} type="number" className={controlClass} value={text} onChange={(event) => setText(event.target.value)} onBlur={() => commit(field.name, Number(text))} onKeyDown={(event) => enter(event, () => commit(field.name, Number(text)))} /> : null}
          {kind === "json" ? <><span className="mt-1 block text-xs font-normal text-eui-slate-500">{dynamic ? "динамическое значение" : "JSON"}</span><textarea aria-label={field.name} className={`${controlClass} min-h-24 font-mono`} value={text} onChange={(event) => setText(event.target.value)} onBlur={() => commitJson(field.name, text)} /></> : null}
        </FieldLabel>}
      {errors[field.name] ? <p role="alert" className="mt-1 text-xs text-eui-magenta">{errors[field.name]}</p> : null}
    </div>;
  })}</div>;
}

function JsonWholeProps({ definition, values, effectiveState, path, onCommit }: PropsFormProps) {
  const [text, setText] = useState(() => JSON.stringify(values, null, 2));
  const [error, setError] = useState("");
  const commit = () => {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { setError("Некорректный JSON"); return; }
    const json = jsonValueSchema.safeParse(parsed);
    if (!json.success || typeof json.data !== "object" || json.data === null || Array.isArray(json.data)) { setError("Props должны быть JSON-объектом"); return; }
    const result = validateElementProps({ definition, props: json.data, state: effectiveState, path: path ?? ["props"] });
    if (result.errors.length) { setError(result.errors.map((item) => item.message).join("; ")); return; }
    setError(""); onCommit(json.data);
  };
  return <label className="block font-eui-ui text-xs text-eui-slate-500">Props (JSON)<textarea aria-label="Props (JSON)" className={`${controlClass} min-h-36 font-mono`} value={text} onChange={(event) => setText(event.target.value)} onBlur={commit} />{error ? <span role="alert" className="mt-1 block text-xs text-eui-magenta">{error}</span> : null}</label>;
}
