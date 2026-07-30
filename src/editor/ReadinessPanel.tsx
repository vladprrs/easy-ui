import { useCallback } from "react";
import { getPrototypeReadiness, type ReadinessGate, type ReadinessGateStatus, type ReadinessLocation, type ReadinessReport } from "../api/client";
import { useApi } from "../api/hooks";
import { pillGhost } from "../app/chrome";
import { editor } from "../app/strings/editor";

/**
 * Панель «Готовность к публикации» (план 2026-07-27, волна 4).
 *
 * Отчёт read-only: сервер ничего не запускает, панель ничего не чинит. Одна строка на
 * гейт, статус + человекочитаемая сводка, а где деталь несёт JSON-pointer — ссылка на
 * экран/элемент (`onSelectLocation`). Без обработчика ссылки рисуются текстом, поэтому
 * панель одинаково работает и в редакторе, и в диалоге публикации галереи.
 */

const STATUS_CLASS: Record<ReadinessGateStatus, string> = {
  pass: "bg-eui-lilac-100 text-eui-slate-500",
  warn: "bg-eui-lilac-100 text-pay-red",
  fail: "bg-pay-red text-white",
  unknown: "bg-eui-lav text-eui-slate-400",
};

const LOCATION_LIMIT = 8;

/** Детали гейта разложены в сам объект; собираем из них все места с путями. */
export function gateLocations(gate: ReadinessGate): ReadinessLocation[] {
  const out: ReadinessLocation[] = [];
  for (const key of ["errors", "warnings", "issues", "missing", "unpinned"]) {
    const value = gate[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string") { out.push({ path: item, message: item }); continue; }
      if (item && typeof item === "object" && typeof (item as ReadinessLocation).message === "string") out.push(item as ReadinessLocation);
    }
  }
  return out;
}

function GateRow({ gate, onSelectLocation }: { gate: ReadinessGate; onSelectLocation?: (location: ReadinessLocation) => void }) {
  const locations = gateLocations(gate);
  const shown = locations.slice(0, LOCATION_LIMIT);
  const exempted = Array.isArray(gate.exempted) ? gate.exempted.length : 0;
  return <li className="flex flex-col gap-1 border-b border-eui-ink/10 py-2 last:border-b-0 max-sm:gap-1.5">
    <div className="flex flex-wrap items-center gap-2">
      <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[gate.status]}`}>
        {editor.readinessStatusNames[gate.status] ?? gate.status}
      </span>
      <span className="text-sm font-medium text-eui-ink">{editor.readinessGateNames[gate.id] ?? gate.id}</span>
      <span className="text-sm text-eui-slate-500">{editor.readinessSummaries[gate.summary] ?? gate.summary}</span>
      {exempted ? <span className="text-xs text-eui-slate-400">{editor.readinessExempted(exempted)}</span> : null}
    </div>
    {shown.length ? <ul className="pl-2 text-xs text-eui-slate-500">
      {shown.map((location, index) => {
        const label = location.screenId ? editor.readinessLocationLabel(location.screenId, location.elementKey) : location.path;
        return <li key={`${location.path}:${index}`} className="py-0.5">
          {onSelectLocation && location.screenId
            ? <button type="button" className="underline underline-offset-2 hover:text-pay-red" title={editor.readinessOpenLocation(label)} onClick={() => onSelectLocation(location)}>{label}</button>
            : <span className="font-medium">{label}</span>}
          <span> — {location.message}</span>
        </li>;
      })}
      {locations.length > shown.length ? <li className="py-0.5 text-eui-slate-400">{editor.readinessMore(locations.length - shown.length)}</li> : null}
    </ul> : null}
  </li>;
}

export interface ReadinessPanelProps {
  prototypeId: string;
  /** Меняется — отчёт перезапрашивается (сохранение, публикация, открытие диалога). */
  refreshKey?: number;
  onSelectLocation?: (location: ReadinessLocation) => void;
}

export function ReadinessPanel({ prototypeId, refreshKey = 0, onSelectLocation }: ReadinessPanelProps) {
  const load = useCallback((signal: AbortSignal) => getPrototypeReadiness(prototypeId, signal), [prototypeId]);
  const state = useApi<ReadinessReport>(load, [load, refreshKey]);
  const report = state.status === "ready" ? state.data : null;
  const blockedNames = report?.blocking.map((id) => editor.readinessGateNames[id] ?? id).join(", ") ?? "";

  return <section aria-label={editor.readinessPanelAria} className="border-b border-eui-ink/10 bg-white px-6 py-3 font-eui-ui max-sm:px-4">
    <div className="flex flex-wrap items-center gap-3">
      <h2 className="pay-display text-base text-eui-ink">{editor.readinessTitle}</h2>
      {report ? <span className="text-xs text-eui-slate-400">{editor.readinessRev(report.rev)}</span> : null}
      <button type="button" className={`${pillGhost} ml-auto max-sm:ml-0`} disabled={state.status === "loading"} onClick={state.reload}>{editor.readinessRefresh}</button>
    </div>
    {state.status === "loading" ? <p aria-live="polite" className="mt-2 text-sm text-eui-slate-500">{editor.readinessLoading}</p> : null}
    {state.status === "error" ? <p role="alert" className="mt-2 text-sm text-pay-red">{editor.readinessFailed}</p> : null}
    {report ? <>
      <p className={`mt-1 text-sm ${report.publishable ? "text-eui-slate-500" : "text-pay-red"}`}>
        {report.publishable ? editor.readinessPublishable : editor.readinessBlocked(blockedNames)}
      </p>
      {Object.keys(report.enabledGates).length === 0 ? <p className="text-xs text-eui-slate-400">{editor.readinessReportOnly}</p> : null}
      <ul className="mt-2 max-h-72 overflow-y-auto">
        {report.gates.map((gate) => <GateRow key={gate.id} gate={gate} onSelectLocation={onSelectLocation} />)}
      </ul>
    </> : null}
  </section>;
}
