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
import type { CaptureCode } from "../../../src/capture/failureCodes";
import type { Gate, GateContext, GateResult } from "./types";

/**
 * **Валидация против злоупотребления `cases[].geometryOwnership`** (BR-05, план 2026-08-08 §5).
 *
 * Декларация «этот узел — декорация» законна ровно для узла **вне потока**: он не держит габариты,
 * и объяснить его краску — значит объяснить факт. Наложить ту же метку на **in-flow контейнер с
 * layout-детьми** — не объяснение, а сокрытие раскладки: такой узел формирует контур, и выкинуть
 * его из union'а значит объявить компонент меньше, чем он есть. Отказ — `geometry_ownership_invalid`.
 *
 * Проверка ведётся **по фактам замера** (`detail.ownershipViolations`, снимает браузер: только там
 * известны и поток, и дети), а не по манифесту: «этот селектор указывает на контейнер» — суждение о
 * снятом кадре, а не о форме поля.
 *
 * **Почему функция живёт здесь, а зовёт её гейт геометрии** (осознанное отклонение, зафиксировано
 * планом-исполнением): `audit` принадлежит фазе `validate` и по `GATE_ORDER` исполняется **до**
 * `render`/`geometry`, то есть до единственного измерения случая — фактов на момент его запуска не
 * существует. Гейт, который «отклоняет декларацию», не имея факта, отклонял бы её по догадке.
 * Поэтому здесь — правило и его код, а точка применения — там, где факт уже есть.
 */
export interface GeometryOwnershipViolation {
  elementKey?: string;
  elementPath?: string;
  reason?: string;
  layoutChildren?: number;
}

export function geometryOwnershipViolationCodes(
  violations: readonly GeometryOwnershipViolation[] | undefined,
): CaptureCode[] {
  if (!violations || violations.length === 0) return [];
  return violations.map((violation) => ({
    code: "geometry_ownership_invalid" as const,
    severity: "error" as const,
    detail: `cases[].geometryOwnership declares ${violation.elementPath ?? violation.elementKey ?? "a node"}`
      + ` as decoration, but it is an in-flow container with ${violation.layoutChildren ?? 0} layout child(ren):`
      + " excluding it would understate the component's own bounds",
    ...(violation.elementPath || violation.elementKey ? { ref: violation.elementPath || violation.elementKey! } : {}),
  }));
}

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
