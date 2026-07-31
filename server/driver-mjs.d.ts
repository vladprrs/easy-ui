// Ambient types for the untyped authoring-skill driver, so server tests can
// import its pure planner helpers (the CLI itself runs as a standalone .mjs).
declare module "*/author/driver.mjs" {
  export interface DriverFlagSpec {
    value: boolean;
    key?: string;
    enum?: readonly string[];
    parse?: (value: string) => unknown;
  }
  export interface DriverParsedArgs {
    cmd: string;
    args: string[];
    flags: {
      json?: boolean;
      designSystem?: string;
      intent?: string;
      limit?: number;
      full?: boolean;
      forceNew?: boolean;
      reason?: string;
      actor?: string;
      since?: string;
      minAttempts?: number;
      [key: string]: unknown;
    };
  }
  export const flagSpecs: Readonly<Record<string, Readonly<Record<string, DriverFlagSpec>>>>;
  export function parseArgs(argv: readonly string[]): DriverParsedArgs;
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
  export interface DriverReadinessGate { id: string; status: "pass" | "warn" | "fail" | "unknown"; summary: string }
  export interface DriverReadinessReport {
    prototypeId: string;
    rev: number;
    gates: DriverReadinessGate[];
    blocking: string[];
    publishable: boolean;
  }
  export function failingGates(report: Partial<DriverReadinessReport> | null | undefined): DriverReadinessGate[];
  export function readinessExitCode(report: Partial<DriverReadinessReport> | null | undefined): 0 | 1 | 2;
  export function readinessLines(report: DriverReadinessReport): string[];
  export interface DriverAuditRow {
    id: string;
    name: string;
    version: number;
    status: "active" | "deprecated";
    deprecated: boolean;
    scope: string | null;
    canonicalFor: string[] | null;
    replacement: string | null;
    headUsageCount: number;
    prototypes: string[];
  }
  export function auditRows(
    manifest: { components?: readonly Record<string, unknown>[] },
    usages: { components?: readonly { componentId: string; headUsageCount: number; prototypes?: readonly { prototypeId: string }[] }[] },
  ): DriverAuditRow[];
  export function auditFindings(rows: readonly DriverAuditRow[]): { deprecatedInUse: string[]; unused: string[] };
  export function auditExitCode(findings: { deprecatedInUse: readonly string[] }): 0 | 2;
  export interface DriverReuseDecision {
    id: string;
    actorId: string;
    artifactKind: string;
    artifactId: string;
    designSystem: string;
    decision: string;
    gateMode: string;
    intent: string | null;
    reason: string | null;
    candidates: { id: string; score: number; blocking: boolean; reasons: string[] }[];
    createdAt: string;
  }
  export interface DriverReuseAuditReport {
    generatedAt: string;
    gateActiveSince: string | null;
    filter?: { since?: string; designSystem?: string; actorId?: string; limit?: number; minAttempts?: number };
    totals?: { decisions: number; actors: number; byDecision: Record<string, number>; byGateMode: Record<string, number> };
    forceNew?: DriverReuseDecision[];
    repeatedBlocked?: {
      actorId: string; artifactKind: string; artifactId: string; designSystem: string;
      attempts: number; blocked: number; wouldBlock: number; firstAt: string; lastAt: string;
      lastDecisionId: string | null; lastReason: string | null; candidateIds: string[];
    }[];
    canonicalRoleConflicts?: (DriverReuseDecision & { roles: string[] })[];
    wouldBlock?: { total: number; actors: number; byActor: { actorId: string; count: number }[]; decisions: DriverReuseDecision[] };
    unreviewed?: { total: number; artifacts: { kind: string; id: string; name: string; designSystem: string; createdAt: string; createdBeforeGate: boolean }[] };
  }
  export function reuseAuditLines(report: DriverReuseAuditReport): string[];
}
