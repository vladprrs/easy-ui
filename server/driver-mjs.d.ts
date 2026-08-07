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
      viewport?: DriverViewport;
      theme?: "light" | "dark";
      dsf?: number;
      figma?: string;
      [key: string]: unknown;
    };
  }
  export const flagSpecs: Readonly<Record<string, Readonly<Record<string, DriverFlagSpec>>>>;
  /**
   * Агентская квитанция `--json`-вывода (план 2026-08-07 §1.4, W6a): один вложенный ключ
   * `envelope` рядом с прежними ключами payload. `ok` равен `exitCode === EXIT.ok` верба;
   * `summary` в W6a пуст — per-verb контракты приезжают в W6b.
   */
  export interface DriverEnvelope {
    schemaVersion: number;
    command: string | null;
    ok: boolean;
    summary: Record<string, unknown>;
    items: unknown[];
    artifacts: unknown[];
    warnings: unknown[];
    nextActions: unknown[];
  }
  /** Вход `buildEnvelope`: `ok` обязателен, остальное — необязательные поля каркаса. */
  export interface DriverEnvelopeInput {
    command?: string | null;
    ok: boolean;
    summary?: Record<string, unknown>;
    items?: readonly unknown[];
    artifacts?: readonly unknown[];
    warnings?: readonly unknown[];
    nextActions?: readonly unknown[];
  }
  export const ENVELOPE_SCHEMA_VERSION: number;
  export function buildEnvelope(envelope: DriverEnvelopeInput): DriverEnvelope;
  export function parseArgs(argv: readonly string[]): DriverParsedArgs;
  export function rendererPreflightWarning(capabilities: unknown): string | null;
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
  export const MAX_ASSET_PIXELS: number;
  export function captureSurface(screen: Record<string, unknown>, device?: string): DriverViewport;
  export function assertCaptureSurfaceBudget(surface: DriverViewport, deviceScaleFactor?: number): DriverViewport;
  /** Поверхность документа (`doc.surfaces`, план multi-surface-flows D1). */
  export interface DriverSurfaceSpec {
    id: string;
    name?: string;
    device?: string;
    startScreen?: string;
    designSystem?: string;
  }
  export interface DriverDocLike {
    device?: string;
    designSystem?: string;
    surfaces?: readonly DriverSurfaceSpec[];
    screens?: readonly Record<string, unknown>[];
  }
  export function surfaceOfScreen(doc: DriverDocLike, screen: Record<string, unknown> | undefined): DriverSurfaceSpec | null;
  export function screenDevice(doc: DriverDocLike, screen: Record<string, unknown> | undefined): string;
  export function screenDesignSystem(doc: DriverDocLike, screen: Record<string, unknown> | undefined): string | undefined;
  export function buildSnapPlan(
    draft: { doc: DriverDocLike & { screens: readonly Record<string, unknown>[] } },
    flags?: { viewport?: DriverViewport | null; dsf?: number; theme?: string },
  ): { screenId: string; viewport: DriverViewport; deviceScaleFactor?: number; theme?: string }[];
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
  // --- expect: числовая приёмка геометрии (план agent-iteration DX, P4) ---
  export interface DriverGeometryRect {
    key: string; instance: number; parentKey?: string; parentInstance?: number;
    domIndex: number; x: number; y: number; width: number; height: number; hidden?: true;
    layoutContext: { display: string; flexDirection: string; flexWrap: string; rowGap: string; columnGap: string } | null;
  }
  export const DEFAULT_EXPECT_TOLERANCE: number;
  export function readGeometryRects(document: unknown): DriverGeometryRect[];
  export function directChildren(rects: readonly DriverGeometryRect[], rect: DriverGeometryRect): DriverGeometryRect[];
  export function resolveAxis(rect: DriverGeometryRect, children: readonly DriverGeometryRect[], override?: "row" | "column"): "row" | "column";
  export function observedGaps(children: readonly DriverGeometryRect[], axis: "row" | "column"): number[];
  export function observedPadding(
    rect: DriverGeometryRect,
    children: readonly DriverGeometryRect[],
  ): { top: number; right: number; bottom: number; left: number } | null;
  export interface DriverExpectations {
    tolerance: number;
    elements: {
      key: string; instance: number; axis?: "row" | "column"; tolerance?: number;
      size?: { width?: number; height?: number };
      gaps?: number[]; uniformGap: boolean;
      padding?: Partial<Record<"top" | "right" | "bottom" | "left", number>>;
    }[];
  }
  export function parseExpectations(document: unknown, cliTolerance?: number): DriverExpectations;
  export interface DriverExpectCheck {
    label: string; metric: string; expected?: number; actual?: number; ok: boolean; axis?: string; message: string;
  }
  export function evaluateExpectations(
    expectations: DriverExpectations,
    rects: readonly DriverGeometryRect[],
  ): { tolerance: number; checks: DriverExpectCheck[]; mismatches: DriverExpectCheck[] };
  export function expectLines(
    evaluation: { tolerance: number; checks: readonly DriverExpectCheck[]; mismatches: readonly DriverExpectCheck[] },
    expectedPath: string,
    actualPath: string,
  ): string[];
  export function expectExitCode(evaluation: { mismatches: readonly DriverExpectCheck[] }): 0 | 2;
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
  /** Типизированный код капчура (R3) в форме, которую печатает CLI. */
  export interface DriverCaptureCode { code: string; severity: string; detail: string }
  export interface DriverCaptureRenderer {
    rendererFingerprint: string | null;
    rendererVersion: string | null;
    source: string | null;
    browserVersion: string | null;
  }
  export interface DriverCaptureEvidence {
    receiptSha256: string | null;
    renderer: DriverCaptureRenderer | null;
    codes: DriverCaptureCode[];
  }
  export function captureCodes(
    state: Record<string, unknown> | null | undefined,
    receipt: Record<string, unknown> | null | undefined,
  ): DriverCaptureCode[];
  export function captureReceiptEvidence(
    state: Record<string, unknown> | null | undefined,
    receiptDocument: Record<string, unknown> | null | undefined,
  ): DriverCaptureEvidence;
  export function snapExitCode(rows: readonly { imageProduced: boolean; productErrors: readonly string[] }[]): 0 | 1 | 2;
  export const QUEUE_RETRY_DELAYS_MS: readonly number[];
  export function previewOutputPath(id: string, version: number, variant?: string): string;
  export function previewDraftOutputPath(id: string, rev: number, variant?: string): string;
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
  // --- audit --versions: KPI-срез публичных версий (RFC candidate-acceptance §9) ---
  export interface DriverVersionAuditRow {
    id: string;
    designSystem: string;
    versions: number;
    active: number;
    byStatus: Record<string, number>;
    /** Сколько версий компонента несут непустой `acceptanceRunId` (RFC §12.6(в), волна R3c). */
    acceptanceEvidence: number;
    /** Принята ли сама активная версия — тот же признак, что Library-`accepted`. */
    acceptedActive: boolean;
    latestVersion: number | null;
    firstPublishedAt: string | null;
    lastPublishedAt: string | null;
  }
  export interface DriverVersionAuditFindings {
    components: number;
    published: number;
    totalVersions: number;
    versionsPerComponent: number;
    firstVersionOnly: string[];
    noActiveVersion: string[];
    multipleActive: string[];
    unpublished: string[];
    versionsWithEvidence: number;
    acceptedComponents: string[];
    withoutEvidence: string[];
  }
  export function versionAuditRows(
    components: readonly { id: string; designSystem: string }[],
    versionsById: Record<string, readonly { version: number; status: string; publishedAt: string; acceptanceRunId?: string | null }[]>,
  ): DriverVersionAuditRow[];
  export function versionAuditFindings(rows: readonly DriverVersionAuditRow[]): DriverVersionAuditFindings;
  export function versionAuditExitCode(findings: { noActiveVersion: readonly string[] }): 0 | 2;
  export function versionAuditLines(
    scope: string,
    rows: readonly DriverVersionAuditRow[],
    findings: DriverVersionAuditFindings,
  ): string[];
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
  /** Происхождение вывода о существовании ресурса (план 2026-08-04 §W4). */
  export type DriverExistenceSource = "list-cache" | "direct-cache" | "direct-network";
  export interface DriverExistence { source: DriverExistenceSource; refreshed: boolean; status: number }
  export const EXISTENCE_SOURCES: readonly DriverExistenceSource[];
  export function existenceReport(): { existence?: DriverExistence };
  /** Лимиты case-set-манифеста, известные драйверу офлайн (план 2026-08-04 §W6). */
  export interface DriverCaseSetLimits {
    manifestVersion: number;
    maxCases: number;
    maxCasesPerRun: number;
    maxDimensions: number;
    maxDimensionValues: number;
    maxExpectedTuples: number;
    /** Слот-биндинги случая (план 2026-08-05 §A1) и их вложенность (2026-08-06 §W6). */
    maxSlotChildren: number;
    maxSlotsPerCase: number;
    maxSlotDepth: number;
    maxSlotNodes: number;
    /** Per-case допуски (план 2026-08-06 §W3): потолки `sizeDeltaPx` и сторон `overflowBudgetPx`. */
    maxCaseSizeDeltaPx: number;
    maxCaseOverflowBudgetPx: number;
  }
  export const CASE_SET_LIMITS: Readonly<DriverCaseSetLimits>;
  export function caseSetLimits(capabilities: unknown): DriverCaseSetLimits;
  export function caseSetManifestIssues(manifest: unknown, limits?: DriverCaseSetLimits): string[];
  /** Локальная проверка `policy`/`policy.perCase` манифеста (план 2026-08-06 §W3). */
  export function casePolicyIssues(policy: unknown, limits?: DriverCaseSetLimits): string[];
  export function caseSetIdOfManifest(manifest: unknown): string;
}
