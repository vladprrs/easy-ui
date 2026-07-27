import { useEffect, useState } from "react";
import { ApiError, createComposition, getComposition, listCompositions, publishComposition, type CompositionSummary } from "../api/client";
import { inputBase, pillGhost, pillPrimary } from "../app/chrome";
import { formatApiError } from "../app/strings/common";
import { editor } from "../app/strings/editor";
import type { CompositionDoc } from "../prototype/composition";
import { slugSchema } from "../prototype/schema";
import { buildCompositionFromSubtree, type Screen } from "./compositions";

/**
 * Диалоги композиций в редакторе (волна 5, план 2026-07-27 §5):
 * вставка ссылки на опубликованную композицию и извлечение композиции из поддерева экрана.
 */

const inputClass = `${inputBase} mt-1 w-full bg-white text-eui-ink`;
const dialogShell = "fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 font-eui-ui";

function apiMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return formatApiError(error.code, { message: error.message, status: error.status });
  return error instanceof Error ? error.message : fallback;
}

export function InsertCompositionDialog({ designSystem, parentKey, onCancel, onPick }: {
  designSystem: string;
  parentKey: string;
  onCancel: () => void;
  onPick: (id: string, doc: CompositionDoc) => void;
}) {
  const [items, setItems] = useState<CompositionSummary[] | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void listCompositions(controller.signal)
      .then((all) => setItems(all.filter((item) => item.designSystem === designSystem && !item.deleted)))
      .catch((cause) => { if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(editor.compositionListFailed); });
    return () => controller.abort();
  }, [designSystem]);

  const pick = async (id: string) => {
    setError(""); setBusyId(id);
    try {
      const meta = await getComposition(id);
      onPick(id, meta.doc);
    } catch (cause) { setError(apiMessage(cause, editor.compositionLoadFailed)); }
    finally { setBusyId(null); }
  };

  return <div role="dialog" aria-modal="true" aria-label={editor.compositionInsertDialogAria} className={dialogShell}>
    <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
      <h2 className="font-eui-display text-lg font-medium">{editor.compositionInsertTitle}</h2>
      <p className="mt-1 text-sm text-eui-slate-500">{editor.compositionInsertHint(designSystem, parentKey)}</p>
      {error ? <p role="alert" className="mt-2 text-sm text-eui-magenta">{error}</p> : null}
      {items === null
        ? <p className="mt-3 text-sm text-eui-slate-500">{editor.compositionListLoading}</p>
        : items.length
          ? <ul className="mt-3 max-h-72 space-y-1 overflow-y-auto">{items.map((item) => <li key={item.id}>
            <button
              type="button"
              disabled={busyId !== null}
              onClick={() => void pick(item.id)}
              className="w-full rounded-xl px-3 py-2 text-left hover:bg-eui-lilac-100 disabled:opacity-50"
            >
              <span className="block text-sm font-medium text-eui-ink">{item.name}</span>
              <span className="block text-xs text-eui-slate-500">{item.id} · {editor.compositionSummaryMeta(item.params.length, item.slots.length)}</span>
            </button>
          </li>)}</ul>
          : <p className="mt-3 text-sm text-eui-slate-500">{editor.compositionListEmpty}</p>}
      <div className="mt-4 flex justify-end"><button type="button" className={pillGhost} onClick={onCancel}>{editor.compositionExtractCancel}</button></div>
    </div>
  </div>;
}

export function ExtractCompositionDialog({ screen, rootKey, designSystem, onCancel, onExtracted }: {
  screen: Screen;
  rootKey: string;
  designSystem: string;
  onCancel: () => void;
  onExtracted: (id: string, doc: CompositionDoc, keptChildren: string[]) => void;
}) {
  const element = screen.spec.elements[rootKey];
  const [id, setId] = useState(() => `${screen.id}-${rootKey}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
  const [name, setName] = useState(() => element?.type ?? rootKey);
  const [description, setDescription] = useState("");
  const [keepChildren, setKeepChildren] = useState(false);
  const [slotName, setSlotName] = useState("default");
  const [errors, setErrors] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  const submit = async () => {
    setErrors([]);
    if (!slugSchema.safeParse(id).success) { setErrors([editor.compositionExtractIdError]); return; }
    const built = buildCompositionFromSubtree(screen, rootKey, {
      name, description, keepChildren, slotName, source: `${screen.id}/${rootKey}`,
    });
    if (!built.ok) { setErrors(built.errors); return; }
    setRunning(true);
    try {
      const created = await createComposition(id, built.doc, designSystem);
      await publishComposition(id, created.rev);
      onExtracted(id, built.doc, built.keptChildren);
    } catch (cause) { setErrors([apiMessage(cause, editor.compositionExtractFailed)]); }
    finally { setRunning(false); }
  };

  return <div role="dialog" aria-modal="true" aria-label={editor.compositionExtractDialogAria} className={dialogShell}>
    <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
      <h2 className="font-eui-display text-lg font-medium">{editor.compositionExtractTitle(rootKey)}</h2>
      <p className="mt-1 text-sm text-eui-slate-500">{editor.compositionExtractBody}</p>
      <label className="mt-3 block text-xs text-eui-slate-500">{editor.compositionExtractIdLabel}
        <input className={inputClass} value={id} onChange={(event) => setId(event.target.value)} />
      </label>
      <label className="mt-2 block text-xs text-eui-slate-500">{editor.compositionExtractNameLabel}
        <input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="mt-2 block text-xs text-eui-slate-500">{editor.compositionExtractDescriptionLabel}
        <textarea className={`${inputClass} min-h-16`} value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>
      <label className="mt-3 flex items-center gap-2 text-xs text-eui-slate-500">
        <input type="checkbox" checked={keepChildren} onChange={(event) => setKeepChildren(event.target.checked)} />
        {editor.compositionExtractKeepChildren}
      </label>
      {keepChildren ? <label className="mt-2 block text-xs text-eui-slate-500">{editor.compositionExtractSlotLabel}
        <input className={inputClass} value={slotName} onChange={(event) => setSlotName(event.target.value)} />
      </label> : null}
      {errors.length ? <div role="alert" className="mt-3 rounded-2xl bg-eui-lilac-100 p-3 text-sm text-eui-magenta">
        <p className="font-medium">{editor.compositionExtractErrorsTitle}</p>
        <ul className="mt-1 list-disc pl-5">{errors.map((message, index) => <li key={index}>{message}</li>)}</ul>
      </div> : null}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={pillGhost} onClick={onCancel}>{editor.compositionExtractCancel}</button>
        <button type="button" disabled={running} className={`${pillPrimary} disabled:opacity-50`} onClick={() => void submit()}>
          {running ? editor.compositionExtractRunning : editor.compositionExtractSubmit}
        </button>
      </div>
    </div>
  </div>;
}
