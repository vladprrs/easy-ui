// Ambient types for the untyped authoring-skill driver, so server tests can
// import its pure planner helpers (the CLI itself runs as a standalone .mjs).
declare module "*/author/driver.mjs" {
  export interface DriverViewport { width: number; height: number }
  export interface DriverSurface {
    screenId: string;
    viewport: DriverViewport;
    deviceScaleFactor: number;
    theme: string;
  }
  export function resolveViewport(
    screen: Record<string, unknown>,
    override: DriverViewport | null | undefined,
    device?: string,
  ): DriverViewport;
  export function assertViewportPixelBudget(viewport: DriverViewport, deviceScaleFactor?: number): DriverViewport;
  export function buildBaselinePlan(
    draft: Record<string, unknown> & { rev: number; prototypeInstanceId: string },
    options?: { viewport?: DriverViewport | null; dsf?: number; theme?: string },
  ): { rev: number; prototypeInstanceId: string; surfaces: DriverSurface[] };
  export function buildBaselineMembers(
    surfaces: readonly DriverSurface[],
    captures: readonly { screenId: string; assetId: string }[],
  ): (DriverSurface & { assetId: string })[];
  export function parseDiffArguments(
    revisionArgs: readonly (string | number)[],
    headRev: number,
  ): { toRev: number; againstRev: number };
  export function analyzeGeometryGaps(
    screen: {spec:{elements:Record<string,{type:string;props?:Record<string,unknown>;children?:string[];slot?:string;region?:"statusBar"|"header"|"footer";repeat?:unknown}>}},
    definitions: Record<string,{layout?:{flow?:unknown}}>,
    geometry: {rects:Array<{key:string;instance:number;parentKey?:string;parentInstance?:number;domIndex:number;x:number;y:number;width:number;height:number;layoutContext:{display:string;flexDirection:string;flexWrap:string;rowGap:string;columnGap:string}|null}>},
  ): Array<{key:string;instance:number;reason:string|null;cssGap:{rowGap:string;columnGap:string}|null;observed:number[]|null}>;
  export const EXIT: { readonly ok: 0; readonly failed: 1; readonly productErrors: 2 };
  export const SNAP_ATTEMPTS: number;
  export const RETRY_BACKOFF_MS: number[];
  export interface DriverCaptureSummary {
    imageProduced: boolean;
    captureClean: boolean;
    productErrors: string[];
    infraNoise: string[];
    runtimeWarnings: string[];
  }
  export function summarizeCapture(result: Record<string, unknown> | null | undefined): DriverCaptureSummary;
  export function snapExitCode(rows: readonly { imageProduced: boolean; productErrors: readonly string[] }[]): 0 | 1 | 2;
}
