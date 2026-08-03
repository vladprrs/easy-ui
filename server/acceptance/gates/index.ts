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
import { renderGate } from "./render";
import type { Gate } from "./types";

/** Порядок исполнения гейтов внутри случая. */
export const GATE_ORDER: GateName[] = ["contract", "defaults", "audit", "render", "geometry", "determinism"];

export const IMPLEMENTED_GATES: Partial<Record<GateName, Gate>> = {
  contract: contractGate,
  defaults: defaultsGate,
  audit: auditGate,
  render: renderGate,
  geometry: geometryGate,
  determinism: determinismGate,
};

export { auditGate, contractGate, defaultsGate, determinismGate, geometryGate, renderGate };
export * from "./types";
export { captureCase, CaptureInfraError } from "./capture";
