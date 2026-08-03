/**
 * Плагинный контракт гейтов приёмки (RFC §4.2, план §5 W1a).
 *
 * Каждый гейт — чистая функция над узким контекстом: БД, dataDir, капчур-сервис, кандидат,
 * случай и политика. Узость контекста — не эстетика: она позволяет тестам подсунуть заглушку
 * капчура (`AcceptanceCaptureService` структурно совместим со `ScreenshotService`) и не тащить
 * в гейты ни роуты, ни сессии, ни оркестратор.
 */
import type { Database } from "bun:sqlite";
import type { CandidateEntry } from "../../components/candidates";
import type { ReadinessPolicy } from "../../../src/capture/readinessPolicy";
import type { CaptureProbe, JobOutcome, JobStatus } from "../../screenshot/service";
import type { RunInkBbox } from "../inkBbox";
import type { RunNormalizedDiff } from "../../visual/diff-runner";
import type { AcceptancePolicy, GateName } from "../policies";
import type { CaseSurface } from "../ids";
import type { AcceptanceCase } from "../cases";

/**
 * `indeterminate` — не «ошибка гейта», а «вердикт не выдан»: он блокирует `pass` обязательного
 * гейта (D10, N2), но несёт диагностику, а не обвинение компонента. `not-implemented` в свёртке
 * не участвует вовсе.
 */
export type GateStatus = "pass" | "fail" | "skipped" | "not-implemented" | "indeterminate";

export interface GateArtifactRef { name: string; sha256: string; bytes: number }

export interface GateResult {
  gate: GateName;
  status: GateStatus;
  metrics?: Record<string, unknown>;
  artifacts?: GateArtifactRef[];
  exceptions?: string[];
  warnings?: string[];
  /** Человекочитаемая причина `fail`/`indeterminate` — попадает в run-репорт и evidence. */
  detail?: string;
}

/** Кандидат как субъект приёмки: durable-идентичность + уже собранный candidate-кэш. */
export interface CandidateSubject {
  candidateId: string;
  componentId: string;
  designSystem: string;
  rev: number;
  sourceHash: string;
  bundleHash: string;
  hostAbiVersion: number;
  themeVersion: number | null;
  entry: CandidateEntry;
  /** A10/N1: снимаемый билд разошёлся с head — advisory-метка в evidence, не отказ. */
  headDiverged?: boolean;
}

/**
 * Ровно та часть `ScreenshotService`, которая нужна приёмке. `enqueueComponentCandidate`
 * возвращает `FrozenEnqueue` (шире, чем `{jobId}`) — структурная совместимость сохраняется.
 */
export interface AcceptanceCaptureService {
  enqueueComponentCandidate(
    id: string,
    candidate: { rev: number; sourceHash: string },
    opts: {
      props?: Record<string, unknown>; exampleName?: string; viewport: unknown; deviceScaleFactor?: unknown;
      theme?: string; waitForFonts?: boolean; probe?: CaptureProbe; deliver?: "asset" | "bytes"; background?: boolean;
      /** W3 (`probe:"paint"`): поле вокруг компонента и ключи детальных измерений. */
      paintMargin?: number; geometryDetailKeys?: string[];
      /** W4: политика readiness, которую обязана исполнить поверхность. */
      readinessPolicy?: ReadinessPolicy;
    },
  ): Promise<{ jobId: string }>;
  get(jobId: string): JobStatus;
  outcome(jobId: string): JobOutcome | undefined;
  hasBackgroundCapacity(): boolean;
}

export interface GateContext {
  db: Database;
  dataDir: string;
  service: AcceptanceCaptureService;
  policy: AcceptancePolicy;
  runId: string;
  candidate: CandidateSubject;
  case: AcceptanceCase;
  surface: CaseSurface;
  /** Попал ли случай в выборку `determinismSampleSize` (плюс все fail-случаи — план §4.2). */
  determinismSampled: boolean;
  /** Мемо на ран: сюда гейты кладут разделяемые результаты (аудит каталога, sha свежего кадра). */
  shared: Map<string, unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /**
   * Измеритель ink-bbox (W3). По умолчанию — node-подпроцесс `scripts/ink-bbox-worker.mjs`;
   * шов существует, чтобы гейт `geometry` v2 тестировался без pngjs-подпроцесса и без chromium.
   */
  inkBbox?: RunInkBbox;
  /**
   * Нормализующий visual-diff (W5a). По умолчанию — node-подпроцесс `scripts/visual-diff-worker.mjs`
   * в режиме `normalize`; шов тот же, что у `inkBbox`: гейт `visual` проверяется без pngjs-подпроцесса.
   */
  runDiff?: RunNormalizedDiff;
}

export interface Gate {
  name: GateName;
  run(ctx: GateContext): Promise<GateResult>;
}
