import { createContext, useContext, type ReactNode, type RefObject } from "react";

export interface HostStageSurfaceContract {
  /** StageViewport node in the same native-coordinate transform chain as screen content. */
  stageHostRef: RefObject<HTMLElement | null>;
}

const HostStageSurfaceContext = createContext<HostStageSurfaceContract | null>(null);

export function HostStageSurface({ stageHostRef, children }: HostStageSurfaceContract & { children: ReactNode }) {
  return <HostStageSurfaceContext.Provider value={{ stageHostRef }}>{children}</HostStageSurfaceContext.Provider>;
}

export function useHostStageSurface(): HostStageSurfaceContract | null {
  return useContext(HostStageSurfaceContext);
}
