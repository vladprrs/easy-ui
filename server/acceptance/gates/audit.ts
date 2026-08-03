/**
 * Гейт `audit` (RFC §4.2): существующий usage/catalog-аудит компонента, предупреждения — в
 * evidence, `fail` — только на блокирующих находках.
 *
 * Что считается: `componentUsages` (`server/usageGraph.ts`) — тот же отчёт, что показывает
 * `GET /api/components/:id/usages`. Он дешёвый и считается **один раз на ран** (мемо в
 * `ctx.shared`), а не на случай: зависимостей от случая у него нет.
 *
 * Что **не** считается: полный `auditCatalog` (`server/catalog/audit.ts`). Он прогоняет матчер
 * по всему каталогу — на 1-CPU проде это минуты поверх капчур-матрицы, а кандидат в его корпус
 * всё равно не входит (корпус собирается из опубликованных артефактов). Дубли ловит reuse-гейт
 * publish-пути, а не приёмка.
 *
 * Блокирующая находка фазы 1: строки компонента в каталоге нет (удалён/переименован между
 * созданием кандидата и раном) — снимать кандидата для несуществующего компонента бессмысленно.
 */
import { ApiError } from "../../http";
import { componentUsages, type ComponentUsageReport } from "../../usageGraph";
import type { Gate, GateContext, GateResult } from "./types";

const AUDIT_KEY = "audit.usages";

export const auditGate: Gate = {
  name: "audit",
  run(ctx: GateContext): Promise<GateResult> {
    const cached = ctx.shared.get(AUDIT_KEY) as { report?: ComponentUsageReport; error?: ApiError } | undefined;
    let entry = cached;
    if (entry === undefined) {
      try { entry = { report: componentUsages(ctx.db, ctx.candidate.componentId) }; }
      catch (error) { entry = error instanceof ApiError ? { error } : (() => { throw error; })(); }
      ctx.shared.set(AUDIT_KEY, entry);
    }
    if (entry.error) {
      return Promise.resolve({
        gate: "audit",
        status: "fail",
        detail: `Component is not in the catalog: ${entry.error.message}`,
        metrics: { code: entry.error.code },
      });
    }
    const report = entry.report!;
    const warnings: string[] = [];
    if (report.immutableUsages.length > 0) {
      warnings.push(`${report.immutableUsages.length} published prototype version(s) pin earlier versions of this component`);
    }
    return Promise.resolve({
      gate: "audit",
      status: "pass",
      metrics: {
        headUsages: report.currentHeadUsages.length,
        immutableUsages: report.immutableUsages.length,
        versionsInUse: report.versionsInUse,
        safeToRemove: report.safeToRemove,
      },
      warnings,
    });
  },
};
