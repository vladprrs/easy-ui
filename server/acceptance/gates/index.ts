/**
 * Реестр гейтов фазы 1 (план §5 W1a). Порядок значим: `determinism` сравнивает кадр, который
 * положил в мемо `render`, поэтому идёт после него. Гейты, объявленные политикой как
 * `not-implemented`, здесь просто отсутствуют — «объявлен, но не считается» и означает, что
 * реализации нет (в свёртке D10 такие гейты не участвуют).
 */
import type { GateName } from "../policies";
import { auditGate } from "./audit";
import { contractGate } from "./contract";
import { defaultsGate } from "./defaults";
import { determinismGate } from "./determinism";
import { geometryGate } from "./geometry";
import { geometry2Gate } from "./geometry2";
import { readinessGate } from "./readiness";
import { renderGate } from "./render";
import type { Gate } from "./types";

/**
 * Порядок исполнения гейтов внутри случая. `readiness` идёт сразу после `render`: он судит **тот
 * самый** кадр, который снял `render`, и его исход решает, имеют ли право считаться следующие
 * сравнивающие гейты (`geometry`/`determinism`/`visual` — инвариант D5, свод в `runner.ts`).
 */
export const GATE_ORDER: GateName[] = ["contract", "defaults", "audit", "render", "readiness", "geometry", "determinism"];

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
  determinism: determinismGate,
};

export { auditGate, contractGate, defaultsGate, determinismGate, geometryGate, geometry2Gate, readinessGate, renderGate };
export { readinessBlocksVisual, readinessOfCase } from "./readiness";
export { createGeometry2Gate, geometryTolerancesOf, paintShaKey } from "./geometry2";
export * from "./types";
export { captureCase, CaptureInfraError } from "./capture";
