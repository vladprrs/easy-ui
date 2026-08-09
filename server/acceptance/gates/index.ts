/**
 * Реестр гейтов фазы 1 (план §5 W1a). Порядок значим: `determinism` сравнивает кадр, который
 * положил в мемо `render`, поэтому идёт после него. Гейты, объявленные политикой как
 * `not-implemented`, здесь просто отсутствуют — «объявлен, но не считается» и означает, что
 * реализации нет (в свёртке D10 такие гейты не участвуют).
 */
import type { GateName } from "../policies";
import type { RunPhase } from "./capture";
import { auditGate } from "./audit";
import { contractGate } from "./contract";
import { defaultsGate } from "./defaults";
import { determinismGate } from "./determinism";
import { geometryGate } from "./geometry";
import { geometry2Gate } from "./geometry2";
import { readinessGate } from "./readiness";
import { renderGate } from "./render";
import { visualGate } from "./visual";
import type { Gate } from "./types";

/**
 * Порядок исполнения гейтов внутри случая. `readiness` идёт сразу после `render`: он судит **тот
 * самый** кадр, который снял `render`, и его исход решает, имеют ли право считаться следующие
 * сравнивающие гейты (`geometry`/`determinism`/`visual` — инвариант D5, свод в `runner.ts`).
 *
 * `visual` идёт **после** `geometry`: кандидатом сравнения служит `paint.png`, который снял и
 * положил в мемо рана именно гейт геометрии. Своей съёмки у визуала нет — иначе `layoutBounds`
 * и пиксельный вердикт относились бы к разным кадрам (R1-M3).
 */
export const GATE_ORDER: GateName[] = ["contract", "defaults", "audit", "render", "readiness", "geometry", "visual", "determinism"];

export const IMPLEMENTED_GATES: Partial<Record<GateName, Gate>> = {
  contract: contractGate,
  defaults: defaultsGate,
  audit: auditGate,
  render: renderGate,
  // W3: боевой гейт геометрии (`probe:"paint"`, layout/paint/overflow). Advisory-v1
  // (`gates/geometry.ts`) выключен — он остаётся в дереве только как исторический источник
  // v1-метрик и в реестр больше не входит.
  geometry: geometry2Gate,
  // W4: readiness — обязательный гейт; кадр, снятый до готовности, теряет право на визуальный
  // и геометрический вердикт (D5).
  readiness: readinessGate,
  // W5a: минимальный визуальный гейт (A5). В реестре он есть всегда — обязательность решает
  // политика рана (`advisory` в `default-v1`, `required` в `pixel-strict-v1` и при
  // `requireVisual` case-set-манифеста), а не наличие реализации.
  visual: visualGate,
  determinism: determinismGate,
};

export { auditGate, contractGate, defaultsGate, determinismGate, geometryGate, geometry2Gate, readinessGate, renderGate, visualGate };
export { readinessBlocksVisual, readinessOfCase } from "./readiness";
export { createGeometry2Gate, geometryTolerancesOf, paintShaKey } from "./geometry2";
export { createVisualGate, maxRawDiffPctOf, visualIsRequired, visualSeverityClass } from "./visual";
export * from "./types";
export { captureCase, CaptureInfraError, RUN_PHASES, phaseRank, type RunPhase } from "./capture";

/**
 * Фаза рана, которой принадлежит гейт (BR-06). Три структурных гейта живут в одной публичной
 * фазе `validate` — они не трогают кадр и исполняются до аллокации рендерера; `render` — это и
 * есть фаза `capture` (аллокация отделена от неё швом в screenshot-сервисе, и её отказ приезжает
 * своей фазой из `CaptureInfraError`); остальные гейты дают одноимённые фазы.
 */
export const GATE_PHASE: Partial<Record<GateName, RunPhase>> = {
  contract: "validate", defaults: "validate", audit: "validate",
  render: "capture", readiness: "readiness", geometry: "geometry", visual: "visual", determinism: "determinism",
};

/**
 * Фаза гейта; объявленный, но не реализованный гейт (`regression`/`interactions`) фазы не
 * занимает и читается как `verdict` — он не может оставить ран «недошедшим» до себя.
 */
export const phaseOfGate = (gate: GateName): RunPhase => GATE_PHASE[gate] ?? "verdict";

/** Гейты фазы `validate`: единственные, чей завершённый результат имеет право переехать в resume. */
export const RESUMABLE_GATES: readonly GateName[] = ["contract", "defaults", "audit"] as const;
