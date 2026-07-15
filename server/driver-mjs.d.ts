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
}
