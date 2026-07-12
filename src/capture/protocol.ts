/**
 * Shared capture-shell protocol: the `__EUI_CAPTURE_BOOTSTRAP__` object the
 * worker injects before navigation and the `__EUI_CAPTURE_READY__` object the
 * shell publishes once the screen surface has settled. Both discriminated
 * unions keep the prototype and component captures strictly separate so the
 * worker can canonically compare the shell's readiness with the enqueue
 * snapshot (`expected`).
 */

export interface PrototypeExpected {
  kind: "prototype";
  rev: number;
  componentManifestHash: string;
  builtinCatalogHash: string;
  dsMetaVersion: number | null;
  rendererBuild: string | null;
}

export interface ComponentExpected {
  kind: "component";
  componentId: string;
  version: number;
  bundleHash: string;
  propsHash: string;
  dsMetaVersion: number | null;
  rendererBuild: string | null;
}

export type CaptureExpected = PrototypeExpected | ComponentExpected;

export interface PrototypeReady {
  status: "ready";
  kind: "prototype";
  revision: number;
  componentManifestHash: string;
  builtinCatalogHash: string;
  dsMetaVersion: number | null;
  rendererBuild: string | null;
}

export interface ComponentReady {
  status: "ready";
  kind: "component";
  componentId: string;
  version: number;
  bundleHash: string;
  propsHash: string;
  dsMetaVersion: number | null;
  rendererBuild: string | null;
}

export interface CaptureErrorReady {
  status: "error";
  error: string;
}

export type CaptureReady = PrototypeReady | ComponentReady | CaptureErrorReady;

/** Worker-injected bootstrap. Absent in browser (Library) preview mode. */
export interface CaptureBootstrap {
  kind: "prototype" | "component";
  target: Record<string, unknown>;
  props?: Record<string, unknown>;
  expected: CaptureExpected;
}

export const CAPTURE_READY_KEY = "__EUI_CAPTURE_READY__";
export const CAPTURE_BOOTSTRAP_KEY = "__EUI_CAPTURE_BOOTSTRAP__";

declare global {
  interface Window {
    __EUI_CAPTURE_READY__?: CaptureReady;
    __EUI_CAPTURE_BOOTSTRAP__?: CaptureBootstrap;
  }
}
