import { createContext, useContext, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type KeyboardEvent } from "react";
import { chip, chipActive, inputBase } from "../../app/chrome";
import { editor } from "../../app/strings/editor";
import { getEditorAssetsSnapshot, subscribeEditorAssets, uploadAsset, type EditorAsset } from "../../api/client";
import type { ComponentDefinition } from "../../catalog/definitions";
import { jsonValueSchema } from "../../prototype/schema";
import { isDynamicValue, validateElementProps } from "../../prototype/validate";
import { describePropsSchema, type PropField, type SelectValue } from "../../catalog/zodIntrospect";

type PropsFormProps = {
  definition: ComponentDefinition;
  values: Record<string, unknown>;
  effectiveState: Record<string, unknown>;
  onCommit: (values: Record<string, unknown>) => void;
  path?: (string | number)[];
};

/**
 * Epoch authored-документа (W2-2): undo/redo (и restore/rebase через remount)
 * меняют номер — форма сбрасывает локальные черновики полей, чтобы после отката
 * не показывать устаревший текст, когда значение вернулось к baseline черновика.
 * Нативный text-undo внутри сфокусированного поля при этом остаётся живым:
 * обычные правки epoch не меняют.
 */
export const DocEpochContext = createContext(0);

const controlClass = `${inputBase} mt-1 w-full bg-white text-eui-ink`;
const pointerPart = (value: string) => value.replace(/~1/g, "/").replace(/~0/g, "~");

function optionKey(value: SelectValue): string {
  return JSON.stringify(value) ?? String(value);
}

function FieldLabel({ name, required, children }: { name: string; required: boolean; children: React.ReactNode }) {
  return <label className="block font-eui-ui text-xs text-eui-slate-500">{name}{required ? <span aria-hidden="true"> *</span> : null}{children}</label>;
}

function isAssetDirective(value: unknown): value is { $asset: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 1 && typeof (value as { $asset?: unknown }).$asset === "string";
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} КБ`;
  return `${Math.round(size / (1024 * 102.4)) / 10} МБ`;
}

function AssetField({ field, value, assets, commit }: { field: PropField; value: unknown; assets: EditorAsset[]; commit: (value: unknown) => boolean }) {
  const directive = isAssetDirective(value) ? value : null;
  const [mode, setMode] = useState<"url" | "asset">(directive ? "asset" : "url");
  const valueUrl = typeof value === "string" ? value : undefined;
  const [urlDraft, setUrlDraft] = useState({ baseline: valueUrl, text: valueUrl ?? "" });
  if (valueUrl !== undefined && valueUrl !== urlDraft.baseline) setUrlDraft({ baseline: valueUrl, text: valueUrl });
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const selected = directive ? assets.find((asset) => asset.id === directive.$asset) : undefined;
  const choices = directive && !selected ? [{ id: directive.$asset, sha256: directive.$asset.slice(6), mime: "", size: 0 }, ...assets] : assets;
  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setUploadError(""); setUploading(true);
    try { const asset = await uploadAsset(file); commit({ $asset: asset.id }); }
    catch (error) { setUploadError(error instanceof Error ? error.message : editor.assetUploadFailed); }
    finally { setUploading(false); }
  };
  return <div className="mt-1 space-y-2">
    <div className="flex gap-1" role="group" aria-label={field.name}>
      <button type="button" className={mode === "url" ? chipActive : chip} onClick={() => setMode("url")}>{editor.assetUrlMode}</button>
      <button type="button" className={mode === "asset" ? chipActive : chip} onClick={() => setMode("asset")}>{editor.assetMode}</button>
    </div>
    {mode === "url" ? <input aria-label={field.name} className={controlClass} value={urlDraft.text} onChange={(event) => setUrlDraft({ baseline: valueUrl, text: event.target.value })} onBlur={() => commit(urlDraft.text)} /> : <>
      <select aria-label={editor.assetSelect} className={`${controlClass} font-eui-ui`} value={directive?.$asset ?? ""} onChange={(event) => { if (event.target.value) commit({ $asset: event.target.value }); }}>
        <option value="" disabled>{choices.length ? editor.assetSelect : editor.assetEmpty}</option>
        {choices.map((asset) => <option key={asset.id} value={asset.id}>{asset.name ?? asset.id}{asset.mime ? ` — ${editor.assetMeta(asset.mime, formatBytes(asset.size))}` : ""}</option>)}
      </select>
      {directive ? <p className="break-all font-mono text-xs font-normal text-eui-slate-500">{selected?.name ?? directive.$asset}{selected ? <span className="mt-0.5 block font-eui-ui">{editor.assetMeta(selected.mime, formatBytes(selected.size))}</span> : null}</p> : null}
      <button type="button" className={chip} disabled={uploading} onClick={() => fileRef.current?.click()}>{uploading ? editor.assetUploading : editor.assetUpload}</button>
      <input ref={fileRef} type="file" aria-label={editor.assetUploadInput} className="sr-only" disabled={uploading} onChange={(event) => void onFile(event)} />
      {uploadError ? <p role="alert" className="text-xs font-normal text-eui-magenta">{uploadError}</p> : null}
    </>}
  </div>;
}

export function PropsForm({ definition, values, effectiveState, onCommit, path = ["props"] }: PropsFormProps) {
  const assets = useSyncExternalStore(subscribeEditorAssets, getEditorAssetsSnapshot, getEditorAssetsSnapshot);
  const described = useMemo(() => describePropsSchema(definition.props), [definition]);
  const fields = useMemo(() => {
    if (described === null) return null;
    const known = new Set(described.map((field) => field.name));
    return [...described, ...Object.keys(values).filter((name) => !known.has(name)).map((name): PropField => ({ name, required: false, nullable: true, control: { kind: "json" } }))];
  }, [described, values]);
  const docEpoch = useContext(DocEpochContext);
  const [drafts, setDrafts] = useState<Record<string, { baseline: unknown; text: string }>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [warnings, setWarnings] = useState<Record<string, string>>({});
  const [epochSeen, setEpochSeen] = useState(docEpoch);
  if (epochSeen !== docEpoch) { // reset-on-change во время рендера (React-паттерн), см. DocEpochContext
    setEpochSeen(docEpoch);
    setDrafts({});
    setErrors({});
    setWarnings({});
  }

  const commitCandidate = (name: string, candidate: Record<string, unknown>): boolean => {
    const result = validateElementProps({ definition, props: candidate, state: effectiveState, path });
    if (result.errors.length) {
      const byField: Record<string, string> = {};
      for (const error of result.errors) {
        const parts = error.path.split("/").slice(1).map(pointerPart);
        const field = String(parts[path.length] ?? name);
        byField[field] = byField[field] ? `${byField[field]}; ${error.message}` : error.message;
      }
      setErrors(byField);
      return false;
    }
    setErrors({});
    onCommit(candidate);
    return true;
  };

  const commit = (name: string, value: unknown) => commitCandidate(name, { ...values, [name]: value });

  /** Удаляет проп из spec (optional-поле очищено / выбрано «не задано»). */
  const commitRemove = (name: string) => {
    const candidate = { ...values };
    delete candidate[name];
    return commitCandidate(name, candidate);
  };

  const setFieldWarning = (name: string, message: string | null) => setWarnings((current) => {
    const next = { ...current };
    if (message === null) delete next[name];
    else next[name] = message;
    return next;
  });

  /**
   * Семантика числового поля (W2-3): пустой ввод — удаление optional-пропа либо
   * ошибка для required (0 не подставляется, `Number('') === 0`); нечисловой /
   * бесконечный ввод — ошибка без коммита.
   */
  const commitNumber = (field: PropField, text: string) => {
    const trimmed = text.trim();
    if (trimmed === "") {
      if (field.required) { setErrors((current) => ({ ...current, [field.name]: editor.propNumberRequired })); return; }
      commitRemove(field.name);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) { setErrors((current) => ({ ...current, [field.name]: editor.propNumberInvalid })); return; }
    commit(field.name, parsed);
  };

  /** Пустая required-строка коммитится, если схема позволяет, но с предупреждением (W2-3). */
  const commitText = (field: PropField, text: string) => {
    const committed = commit(field.name, text);
    setFieldWarning(field.name, committed && field.required && text === "" ? editor.propRequiredEmptyWarning : null);
  };

  const commitJson = (name: string, text: string) => {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { setErrors((current) => ({ ...current, [name]: "Некорректный JSON" })); return; }
    const json = jsonValueSchema.safeParse(parsed);
    if (!json.success) { setErrors((current) => ({ ...current, [name]: "Значение должно быть допустимым JSON" })); return; }
    commit(name, json.data);
  };

  if (fields === null) return <JsonWholeProps key={`${docEpoch}:${JSON.stringify(values)}`} definition={definition} values={values} effectiveState={effectiveState} path={path} onCommit={onCommit} />;

  return <div className="space-y-3">{fields.map((field) => {
    const value = values[field.name] ?? field.defaultValue;
    const assetField = field.name === "src" || isAssetDirective(value);
    const dynamic = !assetField && isDynamicValue(value);
    const kind = dynamic ? "json" : field.control.kind;
    const draft = drafts[field.name];
    const text = draft && Object.is(draft.baseline, value) ? draft.text : (kind === "json" ? JSON.stringify(value, null, 2) : String(value ?? ""));
    const setText = (next: string) => setDrafts((current) => ({ ...current, [field.name]: { baseline: value, text: next } }));
    const enter = (event: KeyboardEvent<HTMLInputElement>, next: () => void) => { if (event.key === "Enter") { event.preventDefault(); next(); event.currentTarget.blur(); } };
    return <div key={field.name}>
      {kind === "switch" ? <label className="flex items-center justify-between gap-3 font-eui-ui text-xs text-eui-slate-500"><span>{field.name}{field.required ? " *" : ""}</span><input type="checkbox" role="switch" checked={value === true} onChange={(event) => commit(field.name, event.target.checked)} /></label>
        : assetField ? <div className="font-eui-ui text-xs text-eui-slate-500"><span>{field.name}{field.required ? <span aria-hidden="true"> *</span> : null}</span><AssetField key={`${docEpoch}:${field.name}:${isAssetDirective(value) ? "asset" : "url"}`} field={field} value={value} assets={assets} commit={(next) => commit(field.name, next)} /></div>
        : <FieldLabel name={field.name} required={field.required}>
          {kind === "select" ? <select aria-label={field.name} className={`${value === undefined ? chip : chipActive} mt-1 font-eui-ui`} value={value === undefined && !field.required ? "" : optionKey(value as SelectValue)} onChange={(event) => {
            if (!field.required && event.target.value === "") { commitRemove(field.name); return; }
            const option = field.control.kind === "select" ? field.control.options.find((item) => optionKey(item) === event.target.value) : undefined;
            commit(field.name, option);
          }}>
            {field.required ? null : <option value="">{editor.propUnsetOption}</option>}
            {field.control.kind === "select" ? field.control.options.map((option) => <option key={optionKey(option)} value={optionKey(option)}>{String(option)}</option>) : null}
          </select> : null}
          {kind === "text" ? <input aria-label={field.name} className={controlClass} value={text} onChange={(event) => setText(event.target.value)} onBlur={() => commitText(field, text)} onKeyDown={(event) => enter(event, () => commitText(field, text))} /> : null}
          {kind === "number" ? <input aria-label={field.name} type="number" className={controlClass} value={text} onChange={(event) => setText(event.target.value)} onBlur={() => commitNumber(field, text)} onKeyDown={(event) => enter(event, () => commitNumber(field, text))} /> : null}
          {kind === "json" ? <><span className="mt-1 block text-xs font-normal text-eui-slate-500">{dynamic ? "динамическое значение" : "JSON"}</span><textarea aria-label={field.name} className={`${controlClass} min-h-24 font-mono`} value={text} onChange={(event) => setText(event.target.value)} onBlur={() => commitJson(field.name, text)} /></> : null}
        </FieldLabel>}
      {errors[field.name] ? <p role="alert" className="mt-1 text-xs text-eui-magenta">{errors[field.name]}</p> : null}
      {!errors[field.name] && warnings[field.name] ? <p role="status" className="mt-1 text-xs text-eui-orange">{warnings[field.name]}</p> : null}
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
