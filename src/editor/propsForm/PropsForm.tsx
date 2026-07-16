import { createContext, useContext, useRef, useState, useSyncExternalStore, type ChangeEvent } from "react";
import { chip, chipActive, inputBase } from "../../app/chrome";
import { editor } from "../../app/strings/editor";
import { propsForm as sharedStrings } from "../../app/strings/propsForm";
import { getEditorAssetsSnapshot, subscribeEditorAssets, uploadAsset, type EditorAsset } from "../../api/client";
import type { ComponentDefinition } from "../../catalog/definitions";
import { isDynamicValue, validateElementProps } from "../../prototype/validate";
import { PropsForm as CorePropsForm, type PropField, type PropsValidation } from "../../propsForm/PropsForm";

type PropsFormProps = {
  definition: ComponentDefinition;
  values: Record<string, unknown>;
  effectiveState: Record<string, unknown>;
  onCommit: (values: Record<string, unknown>) => void;
  path?: (string | number)[];
};

/** Epoch authored-документа; undo/redo сбрасывает локальные черновики формы. */
export const DocEpochContext = createContext(0);

const controlClass = `${inputBase} mt-1 w-full bg-white text-eui-ink`;
const pointerPart = (value: string) => value.replace(/~1/g, "/").replace(/~0/g, "~");
const strings = {
  ...sharedStrings,
  numberRequired: editor.propNumberRequired,
  numberInvalid: editor.propNumberInvalid,
  unsetOption: editor.propUnsetOption,
  requiredEmptyWarning: editor.propRequiredEmptyWarning,
};

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
  const docEpoch = useContext(DocEpochContext);
  const validate = (candidate: Record<string, unknown>): PropsValidation => {
    const result = validateElementProps({ definition, props: candidate, state: effectiveState, path });
    if (!result.errors.length) return { ok: true };
    const fields: Record<string, string> = {};
    const form: string[] = [];
    for (const error of result.errors) {
      const parts = error.path.split("/").slice(1).map(pointerPart);
      const relative = parts.slice(path.length);
      if (!relative.length) form.push(error.message);
      else {
        const field = String(relative[0]);
        fields[field] = fields[field] ? `${fields[field]}; ${error.message}` : error.message;
      }
    }
    return { ok: false, fields, ...(form.length ? { form: form.join("; ") } : {}) };
  };

  return <CorePropsForm
    schema={definition.props}
    values={values}
    validate={validate}
    onCandidate={(candidate, validation) => { if (validation.ok) onCommit(candidate); }}
    epoch={docEpoch}
    strings={strings}
    isDynamicValue={isDynamicValue}
    isAssetField={(field, value) => field.name === "src" || isAssetDirective(value)}
    renderAssetField={({ field, value, commit }) => <AssetField key={`${docEpoch}:${field.name}:${isAssetDirective(value) ? "asset" : "url"}`} field={field} value={value} assets={assets} commit={commit} />}
  />;
}

export { describePropsSchema, type PropControl, type PropField, type SelectValue } from "../../propsForm/introspect";
