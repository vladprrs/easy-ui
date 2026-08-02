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
  prototypeInstanceId: string;
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

/**
 * Draft variant of the component handshake (план 2026-08-02, P1b): the target
 * is a saved but unpublished head revision rendered from the ephemeral
 * validate candidate bundle. `rev` + `sourceHash` replace the published
 * `version`; the bundle itself is job-scoped by the content-addressed URL
 * the enqueue puts into the bootstrap target.
 */
export interface ComponentDraftExpected {
  kind: "component-draft";
  componentId: string;
  rev: number;
  sourceHash: string;
  bundleHash: string;
  propsHash: string;
  dsMetaVersion: number | null;
  rendererBuild: string | null;
}

export type CaptureExpected = PrototypeExpected | ComponentExpected | ComponentDraftExpected;

export interface PrototypeReady {
  status: "ready";
  kind: "prototype";
  prototypeInstanceId: string;
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

export interface ComponentDraftReady {
  status: "ready";
  kind: "component-draft";
  componentId: string;
  rev: number;
  sourceHash: string;
  bundleHash: string;
  propsHash: string;
  dsMetaVersion: number | null;
  rendererBuild: string | null;
}

export interface CaptureErrorReady {
  status: "error";
  error: string;
}

export type CaptureReady = PrototypeReady | ComponentReady | ComponentDraftReady | CaptureErrorReady;

/**
 * Prototype-target payload the enqueue freezes into `bootstrap.target` (план 2026-08-02, P2.3).
 * `components`/`componentManifestHash` присутствуют, когда постановка джобы уже разрешила пины:
 * поверхность рендерит именно их и публикует именно этот manifest-hash, поэтому публикация
 * новой версии компонента между enqueue и рендером не ломает exact-match handshake.
 */
export interface PrototypeBootstrapTarget {
  kind: "prototype";
  rev: number;
  componentManifestHash?: string;
  components?: { id: string; name: string; version: number; bundleUrl: string; bundleHash: string; status?: string }[];
}

/** Worker-injected bootstrap. Absent in browser (Library) preview mode. */
export interface CaptureBootstrap {
  kind: "prototype" | "component" | "component-draft";
  target: Record<string, unknown>;
  props?: Record<string, unknown>;
  /**
   * Draft captures only (P1b): props schema and named examples from the draft
   * extraction. A published capture reads them from the version DTO instead —
   * a draft has no published DTO, so the enqueue delivers them here, job-scoped
   * by construction.
   */
  propsJsonSchema?: unknown;
  examples?: Record<string, Record<string, unknown>>;
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
