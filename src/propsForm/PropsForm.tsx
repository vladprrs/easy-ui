import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import type { z } from "zod";
import { inputBase, chip, chipActive } from "../app/chrome";
import { propsForm as defaultStrings, type PropsFormStrings } from "../app/strings/propsForm";
import { describePropsSchema, type PropField, type SelectValue } from "./introspect";

export type PropsValidation =
  | { ok: true }
  | { ok: false; fields: Record<string, string>; form?: string };

export type AssetFieldRenderArgs = {
  field: PropField;
  value: unknown;
  commit: (value: unknown) => boolean;
};

export type CorePropsFormProps = {
  schema: z.ZodType;
  values: Record<string, unknown>;
  validate: (candidate: Record<string, unknown>) => PropsValidation;
  onCandidate: (candidate: Record<string, unknown>, validation: PropsValidation) => void;
  epoch?: number;
  strings?: PropsFormStrings;
  renderAssetField?: (args: AssetFieldRenderArgs) => ReactNode;
  isAssetField?: (field: PropField, value: unknown) => boolean;
  isDynamicValue?: (value: unknown) => boolean;
};

const controlClass = `${inputBase} mt-1 w-full bg-white text-eui-ink`;

function caughtValidation(strings: PropsFormStrings): PropsValidation {
  return { ok: false, fields: {}, form: strings.validationException };
}

function runValidation(validate: CorePropsFormProps["validate"], candidate: Record<string, unknown>, strings: PropsFormStrings): PropsValidation {
  try { return validate(candidate); }
  catch { return caughtValidation(strings); }
}

export function validateZodCandidate(schema: z.ZodType, candidate: Record<string, unknown>, exceptionMessage = defaultStrings.validationException): PropsValidation {
  try {
    const parsed = schema.safeParse(candidate);
    if (parsed.success) return { ok: true };
    const fields: Record<string, string> = {};
    const form: string[] = [];
    for (const issue of parsed.error.issues) {
      const name = issue.path[0];
      if (typeof name !== "string" && typeof name !== "number") form.push(issue.message);
      else {
        const key = String(name);
        fields[key] = fields[key] ? `${fields[key]}; ${issue.message}` : issue.message;
      }
    }
    return { ok: false, fields, ...(form.length ? { form: form.join("; ") } : {}) };
  } catch {
    return { ok: false, fields: {}, form: exceptionMessage };
  }
}

function optionKey(value: SelectValue): string {
  return JSON.stringify(value) ?? String(value);
}

function FieldLabel({ field, children }: { field: PropField; children: ReactNode }) {
  return <label className="block font-eui-ui text-xs text-eui-slate-500">{field.name}{field.required ? <span aria-hidden="true"> *</span> : null}{children}</label>;
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && Object.values(value).every(isJsonValue);
}

export function PropsForm({ schema, values, validate, onCandidate, epoch = 0, strings = defaultStrings, renderAssetField, isAssetField, isDynamicValue }: CorePropsFormProps) {
  const introspection = useMemo(() => {
    try { return { fields: describePropsSchema(schema), error: undefined }; }
    catch { return { fields: null, error: strings.validationException }; }
  }, [schema, strings]);
  const [state, setState] = useState(() => ({ external: values, epoch, candidate: values }));
  const current = state.external === values && state.epoch === epoch ? state : { external: values, epoch, candidate: values };
  if (current !== state) setState(current);
  const [errors, setErrors] = useState<PropsValidation>(() => runValidation(validate, values, strings));
  const [drafts, setDrafts] = useState<Record<string, { baseline: unknown; present: boolean; text: string }>>({});
  const [warnings, setWarnings] = useState<Record<string, string>>({});
  const [draftEpoch, setDraftEpoch] = useState(epoch);
  if (draftEpoch !== epoch) {
    setDraftEpoch(epoch);
    setDrafts({});
    setWarnings({});
    setErrors(runValidation(validate, values, strings));
  }

  const described = introspection.fields;
  const fields = useMemo(() => {
    if (described === null) return null;
    const known = new Set(described.map((field) => field.name));
    return [...described, ...Object.keys(current.candidate).filter((name) => !known.has(name)).map((name): PropField => ({ name, required: false, nullable: true, control: { kind: "json" } }))];
  }, [described, current.candidate]);

  const report = (candidate: Record<string, unknown>): boolean => {
    const validation = runValidation(validate, candidate, strings);
    setState({ external: values, epoch, candidate });
    setErrors(validation);
    onCandidate(candidate, validation);
    return validation.ok;
  };
  const commit = (name: string, value: unknown) => report({ ...current.candidate, [name]: value });
  const remove = (name: string) => {
    const candidate = { ...current.candidate };
    delete candidate[name];
    return report(candidate);
  };
  const setWarning = (name: string, message: string | null) => setWarnings((old) => {
    const next = { ...old };
    if (message === null) delete next[name]; else next[name] = message;
    return next;
  });
  const setSyntaxError = (name: string, message: string) => setErrors({ ok: false, fields: { ...(errors.ok ? {} : errors.fields), [name]: message } });

  const commitNumber = (field: PropField, text: string) => {
    const trimmed = text.trim();
    if (trimmed === "") {
      if (field.required) { setSyntaxError(field.name, strings.numberRequired); return; }
      remove(field.name); return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) { setSyntaxError(field.name, strings.numberInvalid); return; }
    commit(field.name, parsed);
  };
  const commitText = (field: PropField, text: string) => {
    const committed = commit(field.name, text);
    setWarning(field.name, committed && field.required && text === "" ? strings.requiredEmptyWarning : null);
  };
  const commitJson = (name: string, text: string) => {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { setSyntaxError(name, strings.invalidJson); return; }
    if (!isJsonValue(parsed)) { setSyntaxError(name, strings.invalidJsonValue); return; }
    commit(name, parsed);
  };

  if (fields === null) return <JsonWholeProps key={`${epoch}:${JSON.stringify(values)}`} values={current.candidate} validate={introspection.error ? () => caughtValidation(strings) : validate} onCandidate={(candidate, validation) => {
    setState({ external: values, epoch, candidate });
    setErrors(validation);
    onCandidate(candidate, validation);
  }} strings={strings} initialError={introspection.error} />;

  const fieldErrors = errors.ok ? {} : errors.fields;
  const formError = introspection.error ?? (errors.ok ? undefined : errors.form);
  return <div className="space-y-3">
    {formError ? <p role="alert" className="text-xs text-eui-magenta">{formError}</p> : null}
    {fields.map((field) => {
      const present = Object.hasOwn(current.candidate, field.name);
      const value = present ? current.candidate[field.name] : undefined;
      const asset = isAssetField?.(field, value) ?? false;
      const dynamic = !asset && (isDynamicValue?.(value) ?? false);
      const kind = dynamic ? "json" : field.control.kind;
      const draft = drafts[field.name];
      const text = draft && draft.present === present && Object.is(draft.baseline, value) ? draft.text : (kind === "json" ? (present ? JSON.stringify(value, null, 2) : "") : (present && value !== null ? String(value) : ""));
      const setText = (next: string) => setDrafts((old) => ({ ...old, [field.name]: { baseline: value, present, text: next } }));
      const enter = (event: KeyboardEvent<HTMLInputElement>, next: () => void) => { if (event.key === "Enter") { event.preventDefault(); next(); event.currentTarget.blur(); } };
      const hint = Object.hasOwn(field, "defaultValue") ? strings.defaultHint(field.defaultValue) : undefined;
      const canUnset = !field.required;
      const actions = <>{canUnset && present ? <button type="button" className={chip} onClick={() => remove(field.name)}>{strings.reset}</button> : null}{field.nullable && value !== null ? <button type="button" className={chip} onClick={() => commit(field.name, null)}>{strings.setNull}</button> : null}</>;
      return <div key={field.name}>
        {asset && renderAssetField ? <div className="font-eui-ui text-xs text-eui-slate-500"><span>{field.name}{field.required ? <span aria-hidden="true"> *</span> : null}</span>{renderAssetField({ field, value, commit: (next) => commit(field.name, next) })}</div>
          : <FieldLabel field={field}>
            {kind === "switch" ? <span className="mt-1 flex items-center justify-between gap-3"><span>{!present ? strings.unsetOption : value === null ? strings.nullOption : String(value)}</span><input aria-label={field.name} type="checkbox" role="switch" checked={value === true} onChange={(event) => commit(field.name, event.target.checked)} /></span> : null}
            {kind === "select" ? <select aria-label={field.name} className={`${present ? chipActive : chip} mt-1 font-eui-ui`} value={!present ? "" : optionKey(value as SelectValue)} onChange={(event) => {
              if (event.target.value === "") { remove(field.name); return; }
              if (event.target.value === "null") { commit(field.name, null); return; }
              const option = field.control.kind === "select" ? field.control.options.find((item) => optionKey(item) === event.target.value) : undefined;
              commit(field.name, option);
            }}>{canUnset ? <option value="">{strings.unsetOption}</option> : !present ? <option value="" disabled hidden /> : null}{field.control.kind === "select" ? field.control.options.map((option) => <option key={optionKey(option)} value={optionKey(option)}>{String(option)}</option>) : null}{field.nullable && field.control.kind === "select" && !field.control.options.includes(null) ? <option value="null">{strings.nullOption}</option> : null}</select> : null}
            {kind === "text" ? <input aria-label={field.name} className={controlClass} placeholder={hint} value={text} onChange={(event) => setText(event.target.value)} onBlur={() => commitText(field, text)} onKeyDown={(event) => enter(event, () => commitText(field, text))} /> : null}
            {kind === "number" ? <input aria-label={field.name} type="number" className={controlClass} placeholder={hint} value={text} onChange={(event) => setText(event.target.value)} onBlur={() => commitNumber(field, text)} onKeyDown={(event) => enter(event, () => commitNumber(field, text))} /> : null}
            {kind === "json" ? <><span className="mt-1 block text-xs font-normal text-eui-slate-500">{dynamic ? strings.dynamicValueLabel : strings.jsonLabel}</span><textarea aria-label={field.name} className={`${controlClass} min-h-24 font-mono`} value={text} onChange={(event) => setText(event.target.value)} onBlur={() => commitJson(field.name, text)} /></> : null}
            {hint ? <span className="mt-1 block text-xs font-normal text-eui-slate-500">{hint}</span> : null}
          </FieldLabel>}
        <div className="mt-1 flex gap-1">{!asset ? actions : null}</div>
        {fieldErrors[field.name] ? <p role="alert" className="mt-1 text-xs text-eui-magenta">{fieldErrors[field.name]}</p> : null}
        {!fieldErrors[field.name] && warnings[field.name] ? <p role="status" className="mt-1 text-xs text-eui-orange">{warnings[field.name]}</p> : null}
      </div>;
    })}
  </div>;
}

function JsonWholeProps({ values, validate, onCandidate, strings, initialError }: Pick<CorePropsFormProps, "values" | "validate" | "onCandidate"> & { strings: PropsFormStrings; initialError?: string }) {
  const [text, setText] = useState(() => JSON.stringify(values, null, 2));
  const [error, setError] = useState(initialError ?? "");
  const commit = () => {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { setError(strings.invalidJson); return; }
    if (!isJsonValue(parsed) || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) { setError(strings.propsObjectRequired); return; }
    const candidate = parsed as Record<string, unknown>;
    const validation = runValidation(validate, candidate, strings);
    setError(validation.ok ? "" : validation.form ?? Object.values(validation.fields).join("; "));
    onCandidate(candidate, validation);
  };
  return <label className="block font-eui-ui text-xs text-eui-slate-500">{strings.propsJsonLabel}<textarea aria-label={strings.propsJsonLabel} className={`${controlClass} min-h-36 font-mono`} value={text} onChange={(event) => setText(event.target.value)} onBlur={commit} />{error ? <span role="alert" className="mt-1 block text-xs text-eui-magenta">{error}</span> : null}</label>;
}

export { describePropsSchema, type PropControl, type PropField, type SelectValue } from "./introspect";
