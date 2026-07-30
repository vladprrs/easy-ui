import { useMemo, type ReactNode } from "react";
import { panel } from "../app/chrome";
import { cjm } from "../app/strings/cjm";
import { verifyEdge, type NavigationGraph } from "../prototype/navigationGraph";
import type { PrototypeDoc } from "../prototype/schema";
import { ConnectivityMarker } from "./ConnectivityLegend";

/**
 * Ряд счётчиков режима «Сценарии» (макет 02): белые панели над простынёй.
 *
 * Акцент бренда — ровно один на экран, поэтому курсивом и красным набрано только
 * число сценариев; остальные числа нейтральны, и «не готов» кодируется приглушённым
 * пурпуром, а не вторым красным (план 2026-07-31, S2).
 *
 * Связность считается по тем же рёбрам, что и метки шагов, — отдельного источника
 * истины у неё нет. Единица счёта — смежная пара шагов внутри одного флоу
 * (`verifyEdge(previous, current)`), поэтому сумма трёх чисел = число переходов,
 * а не число экранов.
 */

interface Connectivity {
  /** `static`: у экрана-источника есть authored navigate ровно в этот экран. */
  confirmed: number;
  /** `dynamic`: цель вычисляется (`$event`) — валидная конструкция, не дефект. */
  dynamic: number;
  /** `missing`: перехода нет ни статического, ни динамического — разрыв. */
  missing: number;
}

export function CjmCounters({ doc, graph }: { doc: PrototypeDoc; graph: NavigationGraph }) {
  const flows = doc.flows ?? [];
  const connectivity = useMemo<Connectivity>(() => {
    const counts: Connectivity = { confirmed: 0, dynamic: 0, missing: 0 };
    for (const flow of doc.flows ?? []) {
      flow.steps.forEach((step, index) => {
        const previous = flow.steps[index - 1];
        if (previous === undefined) return;
        const verified = verifyEdge(graph, previous.screenId, step.screenId);
        if (verified === "static") counts.confirmed += 1;
        else if (verified === "dynamic") counts.dynamic += 1;
        else counts.missing += 1;
      });
    }
    return counts;
  }, [doc.flows, graph]);

  const hasFlows = flows.length > 0;
  return <dl className="mx-auto grid max-w-[1600px] gap-5 sm:grid-cols-2 lg:grid-cols-4" aria-label={cjm.countersAria}>
    <Counter value={String(doc.screens.length)} label={cjm.counterScreens} />
    <Counter value={String(flows.length)} label={cjm.counterFlows} accent={hasFlows} />
    {hasFlows ? <>
      <div className={`${panel} p-6`}>
        <dt className="text-[15px] text-eui-slate-500">{cjm.counterConnectivity}</dt>
        <dd className="mt-2 flex flex-col gap-1.5 text-[13px] text-eui-ink">
          <ConnectivityRow kind="static">{cjm.connectivityConfirmed(connectivity.confirmed)}</ConnectivityRow>
          <ConnectivityRow kind="dynamic">{cjm.connectivityDynamic(connectivity.dynamic)}</ConnectivityRow>
          <ConnectivityRow kind="missing">{cjm.connectivityMissing(connectivity.missing)}</ConnectivityRow>
        </dd>
      </div>
      <div className={`${panel} flex items-center gap-3 p-6`}>
        {/* Не готов — приглушённый пурпур: второй красный на экране запрещён (S2). */}
        <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${connectivity.missing === 0 ? "bg-pay-valid" : "bg-pay-deep/25"}`} />
        <div>
          <dt className="sr-only">{cjm.countersAria}</dt>
          <dd className="text-[15px] text-eui-slate-500">{connectivity.missing === 0 ? cjm.readinessReady : cjm.readinessGaps(connectivity.missing)}</dd>
        </div>
      </div>
    </> : <div className={`${panel} p-6 sm:col-span-2`}>
      {/* Без флоу обе ячейки связности были ложью: «12 проверок» = 0 и
          «Готов к публикации» — похвала пустоте. Вместо них одна подпись. */}
      <dt className="text-[15px] font-medium text-eui-ink">{cjm.countersLinearTitle}</dt>
      <dd className="mt-2 text-[13px] text-eui-slate-500">{cjm.countersLinearBody}</dd>
    </div>}
  </dl>;
}

function ConnectivityRow({ kind, children }: { kind: "static" | "dynamic" | "missing"; children: ReactNode }) {
  return <span className="flex items-center gap-2">
    <ConnectivityMarker kind={kind} />
    {children}
  </span>;
}

function Counter({ value, label, accent = false }: { value: string; label: string; accent?: boolean }) {
  return <div className={`${panel} p-6`}>
    <dd className={`pay-display text-[44px] leading-none ${accent ? "pay-accent" : ""}`}>{value}</dd>
    <dt className="mt-2 text-[15px] text-eui-slate-500">{label}</dt>
  </div>;
}
