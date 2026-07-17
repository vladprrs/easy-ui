import { createContext, useContext, type ReactNode } from "react";
import type { RegionKind } from "../prototype/schema";
import type { RegionPolicy } from "../prototype/runtimeSpec";

export type ScreenRegionTargets = Partial<Record<RegionKind, HTMLElement | null>>;

export interface ScreenRegionsContract {
  disposition: RegionPolicy;
  targets: ScreenRegionTargets;
}

const ScreenRegionsContext = createContext<ScreenRegionsContract | null>(null);

export function ScreenRegionsProvider({ disposition, targets, children }: ScreenRegionsContract & { children: ReactNode }) {
  return <ScreenRegionsContext.Provider value={{ disposition, targets }}>{children}</ScreenRegionsContext.Provider>;
}

export function useScreenRegions(): ScreenRegionsContract | null {
  return useContext(ScreenRegionsContext);
}
