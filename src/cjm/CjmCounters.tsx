import { useMemo } from "react";
import { panel } from "../app/chrome";
import { cjm } from "../app/strings/cjm";
import { verifyEdge, type NavigationGraph } from "../prototype/navigationGraph";
import type { PrototypeDoc } from "../prototype/schema";

/**
 * Ряд счётчиков режима «Сценарии» (макет 02): четыре белые панели над простынёй.
 *
 * Акцент бренда — ровно один на экран, поэтому курсивом и красным набрано только
 * число сценариев; остальные числа нейтральны. Готовность считается по тем же
 * рёбрам, что и метки шагов, — отдельного источника истины у неё нет.
 */
export function CjmCounters({ doc, graph }: { doc: PrototypeDoc; graph: NavigationGraph }) {
  const { checks, gaps } = useMemo(() => {
    let checks = 0;
    let gaps = 0;
    for (const flow of doc.flows ?? []) {
      flow.steps.forEach((step, index) => {
        const previous = flow.steps[index - 1];
        if (previous === undefined) return;
        if (verifyEdge(graph, previous.screenId, step.screenId) === "static") checks += 1;
        else gaps += 1;
      });
    }
    return { checks, gaps };
  }, [doc.flows, graph]);

  return <dl className="mx-auto grid max-w-[1600px] gap-5 sm:grid-cols-2 lg:grid-cols-4" aria-label={cjm.countersAria}>
    <Counter value={String(doc.screens.length)} label={cjm.counterScreens} />
    <Counter value={String(doc.flows?.length ?? 0)} label={cjm.counterFlows} accent />
    <Counter value={String(checks)} label={cjm.counterChecks} />
    <div className={`${panel} flex items-center gap-3 p-6`}>
      <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${gaps === 0 ? "bg-pay-valid" : "bg-pay-invalid"}`} />
      <div>
        <dt className="sr-only">{cjm.countersAria}</dt>
        <dd className="text-[15px] text-eui-slate-500">{gaps === 0 ? cjm.readinessReady : cjm.readinessGaps(gaps)}</dd>
      </div>
    </div>
  </dl>;
}

function Counter({ value, label, accent = false }: { value: string; label: string; accent?: boolean }) {
  return <div className={`${panel} p-6`}>
    <dd className={`pay-display text-[44px] leading-none ${accent ? "pay-accent" : ""}`}>{value}</dd>
    <dt className="mt-2 text-[15px] text-eui-slate-500">{label}</dt>
  </div>;
}
