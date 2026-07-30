import type { ReactElement } from "react";
import { cjm } from "../app/strings/cjm";
import type { EdgeVerification } from "../prototype/navigationGraph";

/**
 * Легенда связности шагов — общий язык обоих режимов разбора (план 2026-07-31, S3).
 *
 * Раньше три состояния перехода кодировались трижды и по-разному: в дорожках —
 * цветом линии, штрихом и глифом «!», в простыне — цветным кружком с «✓»/«–», а в
 * счётчиках вообще не кодировались. Здесь один код одного факта: цвет + форма.
 * Форма нужна, потому что «динамический» и «подтверждён» — оба зелёные (динамика
 * не дефект, а авторская конструкция через `$event`), а различать их обязаны и
 * дальтоники: залитый круг против полого.
 *
 * Красного здесь нет намеренно (S2): единственный акцент экрана — число сценариев,
 * поэтому «не найден» набран приглушённым пурпуром `bg-pay-deep/25` (= rgba(45,8,58,.25)).
 *
 * W3 подключает этот же экспорт в дорожках вместо `.cjm-edge-legend`.
 */

const order = ["static", "dynamic", "missing"] as const;

const legendLabel: Record<EdgeVerification, string> = {
  static: cjm.verifiedStatic,
  dynamic: cjm.verifiedDynamic,
  missing: cjm.verifiedMissing,
};

/**
 * Маркер одного состояния. `data-verified` намеренно не ставится: этот атрибут —
 * счётный признак шага/ребра, и лишние узлы с ним сбили бы счёт в e2e.
 */
export function ConnectivityMarker({ kind }: { kind: EdgeVerification }): ReactElement {
  // Полый круг — единственная разрешённая брендом «граница»: outline, не border.
  const shape = kind === "static"
    ? "bg-pay-valid"
    : kind === "dynamic"
      ? "outline-2 -outline-offset-2 outline-pay-valid"
      : "bg-pay-deep/25";
  return <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${shape}`} />;
}

export function ConnectivityLegend({ className }: { className?: string }): ReactElement {
  return <div
    className={`cjm-connectivity-legend flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-eui-slate-500 ${className ?? ""}`}
    aria-label={cjm.connectivityLegendAria}
  >
    {order.map((kind) => <span key={kind} className="inline-flex items-center gap-1.5">
      <ConnectivityMarker kind={kind} />
      {legendLabel[kind]}
    </span>)}
  </div>;
}
