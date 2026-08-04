import type { Database } from "bun:sqlite";
import { AssetRepo, type AssetPublic } from "../repos/assets";
import { fingerprintId, fingerprintJson, type Fingerprint } from "./fingerprint";
import { ApiError } from "../http";
import { getAssetReceipt, readReceipt } from "../capture/receiptStore";
import type { CaptureReceipt } from "../../src/capture/receipt";
import type { EdgeResidual } from "./diff-runner";
import type { VisualCause } from "./causes";

export interface VisualReferenceRow {
  id: string;
  fingerprint_json: string;
  asset_id: string;
  note: string | null;
  created_at: string;
  deleted_at: string | null;
  /** R6: см. миграцию v28 — аддитивные атрибуты происхождения кадра, не часть identity (N6). */
  renderer_fingerprint: string | null;
  renderer_json: string | null;
  font_manifest_hash: string | null;
  receipt_sha256: string | null;
  renderer_recorded_at: string | null;
}

/**
 * Рендерер, которым нарисован кадр эталона (R6). Записывается **инлайном**: receipt-стор живёт по
 * TTL/LRU, а эталон обязан оставаться судимым и через год, поэтому `receipt_sha256` — только
 * evidence-ссылка, а авторитет — этот объект.
 *
 * `null` в поле — «доказательство этого не принесло», а не «совпало»: guard читает такой эталон
 * как `unknown`, а не как совпавший.
 */
export interface ReferenceRendererRecord {
  fingerprint: string;
  fontManifestHash: string | null;
  readinessPolicyHash: string | null;
  /** Эпоха рендерера кадра (N11) — `rendererVersion` объявления, снявшего эталон. */
  epoch: string | null;
  browserVersion: string | null;
  launchedExecutable: string | null;
  browserExecutableSha256: string | null;
  source: "manifest" | "fallback" | null;
  receiptSha256: string | null;
  recordedAt: string;
}

/**
 * Резолвит рендерер эталона по кадру (T-B2). Порядок источников не случаен:
 *
 * 1. **индекс `assetId → receiptSha`** (R5) — авторитетная серверная связь: этот PNG снял этот
 *    процесс, и вот его receipt. Baseline-эталоны рождены серверным капчуром (`driver.mjs
 *    runBaseline` кладёт `state.result.assetId`), поэтому именно эта ветка делает `matched`
 *    достижимым, а весь guard — не мёртвым кодом;
 * 2. **явно указанный `receiptSha256`** — фолбэк для массовой пересъёмки (`rebaseline-all.mjs`,
 *    V-N8): скрипт берёт sha прямо из `JobStatus.result`, не полагаясь на свежесть индекса.
 *    Содержимое всё равно читается из стора — клиент указывает **адрес**, а не факты;
 * 3. `null` — PNG залит извне или индекс истёк. Это честный `unknown`, а не выдуманное совпадение.
 */
export async function resolveReferenceRenderer(dataDir: string, assetId: string, receiptSha256?: string | null): Promise<ReferenceRendererRecord | null> {
  const linked = await getAssetReceipt(dataDir, assetId);
  const sha = linked?.receiptSha256 ?? (typeof receiptSha256 === "string" ? receiptSha256 : null);
  if (sha === null) return null;
  return rendererRecordFromReceipt(await readReceipt(dataDir, sha), sha);
}

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/**
 * Проекция receipt'а в запись эталона. Берётся ровно то, что нужно guard'у, а не весь документ:
 * receipt живёт по TTL, а эта запись — вечно рядом с эталоном, и раздувать её дампом страницы
 * (console, timings, faces) значило бы копить мусор в БД.
 */
export function rendererRecordFromReceipt(receipt: CaptureReceipt | null, sha: string | null): ReferenceRendererRecord | null {
  if (receipt === null || typeof receipt.renderer?.fingerprint !== "string") return null;
  return {
    fingerprint: receipt.renderer.fingerprint,
    fontManifestHash: text(receipt.resources?.fontManifestHash),
    readinessPolicyHash: text(receipt.verdict?.readinessPolicyHash),
    epoch: text(receipt.renderer.rendererVersion),
    browserVersion: text(receipt.renderer.browserVersion),
    launchedExecutable: text(receipt.renderer.launchedExecutable),
    browserExecutableSha256: text(receipt.renderer.browserExecutableSha256),
    source: receipt.renderer.source === "manifest" || receipt.renderer.source === "fallback" ? receipt.renderer.source : null,
    receiptSha256: sha,
    recordedAt: new Date().toISOString(),
  };
}

/** Разбор `renderer_guard` строки рана. Битая/старая (до v28) запись — `null`. */
export function parseGuardRecord(value: string | null | undefined): RendererGuardRecord | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object") return null;
    const state = (parsed as RendererGuardRecord).state;
    return state === "matched" || state === "mismatch" || state === "unknown" || state === "disabled" ? parsed as RendererGuardRecord : null;
  } catch { return null; }
}

/** Разбор `renderer_json` строки эталона. Битая запись — `null` (честный `unknown`). */
export function parseReferenceRenderer(row: Pick<VisualReferenceRow, "renderer_json">): ReferenceRendererRecord | null {
  if (!row.renderer_json) return null;
  try {
    const parsed: unknown = JSON.parse(row.renderer_json);
    return parsed !== null && typeof parsed === "object" && typeof (parsed as ReferenceRendererRecord).fingerprint === "string"
      ? parsed as ReferenceRendererRecord : null;
  } catch { return null; }
}

export type RunStatus = "pass" | "fail" | "error" | "reference_missing";

export interface VisualRunRow {
  id: string;
  reference_id: string;
  reference_asset_id: string | null;
  candidate_asset_id: string | null;
  diff_asset_id: string | null;
  metric: string | null;
  metric_options_json: string | null;
  diff_pixels: number | null;
  total_pixels: number | null;
  diff_percent: number | null;
  status: RunStatus;
  candidate_meta_json: string | null;
  created_at: string;
  /** R6 (v28): исход cross-renderer guard'а. `status` новых значений не получает (N7). */
  renderer_guard: string | null;
  outcome_code: RunOutcomeCode | null;
  candidate_receipt_sha256: string | null;
  reference_receipt_sha256: string | null;
}

/**
 * Типизированный исход рана поверх `status` (N7). `renderer_mismatch` — эталон и кандидат
 * нарисованы разными рендерерами; `stale_renderer` — эталон снят до текущей эпохи рендерера
 * (или его происхождение неизвестно) при включённых детерминизм-флагах. В обоих случаях процента
 * нет вовсе: сравнивать эти кадры нельзя, и «0,3 %» было бы враньём.
 */
export type RunOutcomeCode = "renderer_mismatch" | "stale_renderer" | "dimensions_irreconcilable";

/**
 * Класс визуального рана (R7a, E6) — ответ на вопрос «что это было», которого у одного процента
 * не было: `identical` (кадры совпали побайтно), `renderer_residual` (остаток лежит на контурах
 * эталона — рисовал другой растеризатор, а не другой продукт), `regression` (остаток вне контуров
 * либо бюджет перцептивной метрики превышен), `indeterminate` (кадры несводимы, метрик нет вовсе).
 *
 * `class` **не заменяет** `status`: статус остаётся тем же множеством значений (N7), класс лишь
 * объясняет его. `null` — ран судился доволновой семантикой (флаг `EASYUI_VISUAL_SIGNALS_V2` выключен).
 */
export type RunClass = "identical" | "renderer_residual" | "regression" | "indeterminate";

/**
 * Четыре сигнала рана (E6). Каждый отвечает за своё, и ни один не подменяет остальные:
 * `dims` — сводимость кадров, `exact` — «отличается ли хоть байт», `perceptual` — историческая
 * метрика бюджета, `edgeResidual` — **где** лежит остаток.
 */
export interface RunSignals {
  dims: "equal" | "normalized" | "irreconcilable";
  exact: MetricResult | null;
  perceptual: MetricResult | null;
  edgeResidual: EdgeResidual | null;
  thresholds: { passPct: number; edgeInsidePct: number };
  /** Причина `indeterminate`: почему кадры не сведены. */
  reason?: string;
  /** Причины провала (`regression`) — та же таксономия, что у приёмки (`causes.ts`). */
  causes?: VisualCause[];
}

/** Состояние guard'а на ране. `disabled` — аварийный `EASYUI_RENDERER_GUARD_DISABLED=1`. */
export type RendererGuardState = "matched" | "mismatch" | "unknown" | "disabled";

/** Публичная запись guard'а (едет в `renderer_guard` и в отчёт рана). */
export interface RendererGuardRecord {
  state: RendererGuardState;
  /** Поля, по которым эталон и кандидат разошлись: `[]` для `matched`/`unknown`. */
  differing: string[];
  reference: { fingerprint: string | null; fontManifestHash: string | null; readinessPolicyHash: string | null; epoch: string | null };
  candidate: { fingerprint: string | null; fontManifestHash: string | null; readinessPolicyHash: string | null; epoch: string | null };
  /** Снапшот флагов, взятый на `beginCheck` (N11): ран доигрывается по семантике своего старта. */
  flags: { rendererFlags: boolean; epoch: string | null };
}

export interface MetricResult { diffPixels: number; totalPixels: number; diffPercent: number }
export interface CandidateMeta {
  rev?: number;
  version?: number;
  pins?: { id: string; version: number; bundleHash: string }[];
  bundleHash?: string;
  rendererBuild?: string | null;
  browserVersion?: string;
  kind?: "prototype" | "component";
  outcome?: "captured" | "capture_failed";
  requestedTarget?: { rev?: number; version?: number };
  resolvedTarget?: { rev?: number; version?: number };
  expected?: unknown;
  browser?: { browserVersion: string; rendererBuild: string | null; consoleErrors: string[]; pageErrors: string[] } | null;
  error?: string;
}

export interface RunReport {
  runId: string;
  referenceId: string;
  status: RunStatus | "reference_unknown";
  createdAt: string;
  metric: string | null;
  metricOptions: Record<string, unknown> | null;
  diffPixels: number | null;
  totalPixels: number | null;
  diffPercent: number | null;
  metrics: { "exact-rgba"?: MetricResult; "pixelmatch-v1"?: MetricResult };
  referenceStatus: "known" | "unknown";
  reference: EvidenceAsset | null;
  candidate: EvidenceAsset | null;
  diff: { assetId: string; url: string } | null;
  candidateMeta: CandidateMeta | null;
  /** R6: типизированный исход поверх `status` — `null` у ранов, судимых обычными метриками. */
  outcomeCode: RunOutcomeCode | null;
  rendererGuard: RendererGuardRecord | null;
  candidateReceiptSha256: string | null;
  referenceReceiptSha256: string | null;
  /**
   * R7a: класс рана и четыре сигнала, из которых он получен. `null` у ранов, судимых доволновой
   * семантикой (флаг выключен), — отсутствие сигналов видимо, а не замаскировано нулями.
   */
  class: RunClass | null;
  signals: RunSignals | null;
  /**
   * Advisory-предупреждения рана. Сегодня единственное — `renderer_unknown`: происхождение
   * эталона неизвестно, вердикт всё равно вынесен по метрикам (нулевой регресс до включения
   * флагов, §5 R6).
   */
  warnings: string[];
}

export interface EvidenceAsset { assetId: string; url: string; sha256: string; width: number | null; height: number | null; mime: string }

export interface VisualReferencePublic {
  id: string;
  fingerprint: unknown;
  note: string | null;
  createdAt: string;
  asset: (AssetPublic & { url: string }) | null;
  lastRun: RunReport | null;
  /**
   * Происхождение кадра эталона (R6). `null` — PNG залит извне или снят до этой волны: такой
   * эталон guard читает как `unknown`. Отдаётся наружу, потому что инвентаризация перед массовой
   * пересъёмкой (`scripts/rebaseline-all.mjs`) обязана отличать эти два состояния по API.
   */
  renderer: ReferenceRendererRecord | null;
}

/**
 * DB access for visual references + runs. Kept out of `server/repos` so the T7
 * feature owns its own persistence surface; reads reuse {@link AssetRepo} for
 * content-addressed asset evidence (sha256, dimensions).
 */
export class VisualRepo {
  private readonly assets: AssetRepo;
  constructor(private readonly db: Database, dataDir: string) {
    this.assets = new AssetRepo(db, dataDir);
  }

  assetRepo(): AssetRepo { return this.assets; }

  /**
   * Internal privileged mutation used by the atomic baseline-set transaction.
   *
   * **Общая точка обоих путей записи эталона** (V-N3): и `visual_baselines`-коммит, и generic
   * `PUT /api/visual-references` проходят здесь, поэтому рендерер пишется ровно в одном месте.
   *
   * `renderer` резолвится **вызывающим** (async, до транзакции): чтение receipt'а — файловый
   * ввод-вывод, а метод синхронный и живёт внутри `BEGIN IMMEDIATE`.
   *
   * Апдейт существующей строки с `renderer === null` **обнуляет** пять колонок намеренно: кадр
   * сменился, и прежнее происхождение его больше не описывает — оставить старое значило бы
   * приписать новому PNG чужой рендерер.
   */
  upsertReferencePrivileged(fingerprint: Fingerprint, assetId: string, note: string | null, renderer: ReferenceRendererRecord | null = null): VisualReferenceRow {
    const json = fingerprintJson(fingerprint);
    const id = fingerprintId(json);
    const existing = this.getReference(id, true);
    const parts = [renderer?.fingerprint ?? null, renderer ? JSON.stringify(renderer) : null, renderer?.fontManifestHash ?? null, renderer?.receiptSha256 ?? null, renderer?.recordedAt ?? null] as const;
    if (existing) {
      this.db.query(`UPDATE visual_references SET asset_id=?, note=?, deleted_at=NULL,
        renderer_fingerprint=?, renderer_json=?, font_manifest_hash=?, receipt_sha256=?, renderer_recorded_at=? WHERE id=?`)
        .run(assetId, note, ...parts, id);
    } else {
      this.db.query(`INSERT INTO visual_references
        (id,fingerprint_json,asset_id,note,created_at,renderer_fingerprint,renderer_json,font_manifest_hash,receipt_sha256,renderer_recorded_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(id, json, assetId, note, new Date().toISOString(), ...parts);
    }
    return this.getReference(id)!;
  }

  private latestManagedIds(): Set<string> {
    const latestByPrototype = this.db.query(`SELECT s.members_json FROM visual_baseline_sets s
      WHERE s.generation=(SELECT MAX(x.generation) FROM visual_baseline_sets x WHERE x.prototype_id=s.prototype_id)`).all() as {members_json:string}[];
    return new Set(latestByPrototype.flatMap((set) => (JSON.parse(set.members_json) as {referenceId:string}[]).map((member) => member.referenceId)));
  }

  private assertNotManaged(id: string): void {
    if (this.latestManagedIds().has(id)) throw new ApiError(409, "baseline_managed", "Visual reference is managed by a committed baseline set");
  }

  upsertReferenceGeneric(fingerprint: Fingerprint, assetId: string, note: string | null, renderer: ReferenceRendererRecord | null = null): VisualReferenceRow {
    let began=false;
    try {
      this.db.run("BEGIN IMMEDIATE"); began=true;
      this.assertNotManaged(fingerprintId(fingerprintJson(fingerprint)));
      const row=this.upsertReferencePrivileged(fingerprint,assetId,note,renderer);
      this.db.run("COMMIT"); began=false;
      return row;
    } catch(error) {
      if(began) this.db.run("ROLLBACK");
      throw error;
    }
  }

  getReference(id: string, includeDeleted = false): VisualReferenceRow | null {
    return this.db.query(`SELECT * FROM visual_references WHERE id=?${includeDeleted ? "" : " AND deleted_at IS NULL"}`).get(id) as VisualReferenceRow | null;
  }

  listReferences(filter: { scope?: string; prototypeId?: string; componentId?: string }): VisualReferenceRow[] {
    const rows = this.db.query("SELECT * FROM visual_references WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC").all() as VisualReferenceRow[];
    return rows.filter((row) => {
      if (!filter.scope && !filter.prototypeId && !filter.componentId) return true;
      let fp: Record<string, unknown>;
      try { fp = JSON.parse(row.fingerprint_json) as Record<string, unknown>; } catch { return false; }
      if (filter.scope && fp.scope !== filter.scope) return false;
      if (filter.prototypeId && fp.prototypeId !== filter.prototypeId) return false;
      if (filter.componentId && fp.componentId !== filter.componentId) return false;
      return true;
    });
  }

  deleteReference(id: string): boolean {
    const result = this.db.query("UPDATE visual_references SET deleted_at=? WHERE id=? AND deleted_at IS NULL").run(new Date().toISOString(), id);
    return result.changes === 1;
  }

  deleteReferenceGeneric(id:string):boolean {
    let began=false;
    try {
      this.db.run("BEGIN IMMEDIATE"); began=true;
      this.assertNotManaged(id);
      const deleted=this.deleteReference(id);
      this.db.run("COMMIT"); began=false;
      return deleted;
    } catch(error) {
      if(began) this.db.run("ROLLBACK");
      throw error;
    }
  }

  insertRun(row: VisualRunRow): void {
    this.db.query(`INSERT INTO visual_runs
      (id,reference_id,reference_asset_id,candidate_asset_id,diff_asset_id,metric,metric_options_json,diff_pixels,total_pixels,diff_percent,status,candidate_meta_json,created_at,
       renderer_guard,outcome_code,candidate_receipt_sha256,reference_receipt_sha256)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id, row.reference_id, row.reference_asset_id, row.candidate_asset_id, row.diff_asset_id, row.metric, row.metric_options_json,
        row.diff_pixels, row.total_pixels, row.diff_percent, row.status, row.candidate_meta_json, row.created_at,
        row.renderer_guard, row.outcome_code, row.candidate_receipt_sha256, row.reference_receipt_sha256);
  }

  getRun(id: string): VisualRunRow | null {
    return this.db.query("SELECT * FROM visual_runs WHERE id=?").get(id) as VisualRunRow | null;
  }

  listRuns(referenceId: string): VisualRunRow[] {
    return this.db.query("SELECT * FROM visual_runs WHERE reference_id=? ORDER BY created_at DESC, id DESC").all(referenceId) as VisualRunRow[];
  }

  private evidenceAsset(assetId: string | null): EvidenceAsset | null {
    if (!assetId) return null;
    const row = this.assets.get(assetId);
    if (!row) return null;
    return { assetId: row.id, url: `/api/assets/${row.id}`, sha256: row.sha256, width: row.width, height: row.height, mime: row.mime };
  }

  /** Assemble the honest evidence report for a run row (evidence guard §E.6). */
  runReport(row: VisualRunRow): RunReport {
    const referenceKnown = row.reference_asset_id !== null;
    const meta: (Record<string, unknown> & { exactRgba?: MetricResult; signalsV2?: { class: RunClass; signals: RunSignals } }) | null = row.candidate_meta_json ? JSON.parse(row.candidate_meta_json) : null;
    const options = row.metric_options_json ? JSON.parse(row.metric_options_json) as Record<string, unknown> : null;
    const metrics: RunReport["metrics"] = {};
    if (referenceKnown && meta?.exactRgba) metrics["exact-rgba"] = meta.exactRgba;
    if (referenceKnown && row.metric === "pixelmatch-v1" && row.diff_pixels !== null && row.total_pixels !== null && row.diff_percent !== null) {
      metrics["pixelmatch-v1"] = { diffPixels: row.diff_pixels, totalPixels: row.total_pixels, diffPercent: row.diff_percent };
    }
    const candidateMeta: CandidateMeta | null = meta ? { ...meta } as CandidateMeta : null;
    if (candidateMeta) {
      // `exactRgba` и `signalsV2` едут в той же колонке (миграции у волны нет — единственная
      // миграция пакета была в R6), но наружу отдаются собственными полями отчёта, а не
      // подмешиваются в `candidateMeta`: его форма строго описана контрактом.
      delete (candidateMeta as { exactRgba?: unknown }).exactRgba;
      delete (candidateMeta as { signalsV2?: unknown }).signalsV2;
    }
    const signalsV2 = referenceKnown ? meta?.signalsV2 ?? null : null;
    const guard = parseGuardRecord(row.renderer_guard);
    return {
      runId: row.id,
      referenceId: row.reference_id,
      status: referenceKnown ? row.status : "reference_unknown",
      createdAt: row.created_at,
      metric: referenceKnown ? row.metric : null,
      metricOptions: referenceKnown ? options : null,
      diffPixels: referenceKnown ? row.diff_pixels : null,
      totalPixels: referenceKnown ? row.total_pixels : null,
      diffPercent: referenceKnown ? row.diff_percent : null,
      metrics,
      referenceStatus: referenceKnown ? "known" : "unknown",
      reference: this.evidenceAsset(row.reference_asset_id),
      candidate: this.evidenceAsset(row.candidate_asset_id),
      diff: referenceKnown && row.diff_asset_id ? { assetId: row.diff_asset_id, url: `/api/assets/${row.diff_asset_id}` } : null,
      candidateMeta,
      outcomeCode: row.outcome_code ?? null,
      rendererGuard: guard,
      candidateReceiptSha256: row.candidate_receipt_sha256 ?? null,
      referenceReceiptSha256: row.reference_receipt_sha256 ?? null,
      class: signalsV2?.class ?? null,
      signals: signalsV2?.signals ?? null,
      warnings: guard?.state === "unknown" && row.outcome_code === null ? ["renderer_unknown"] : [],
    };
  }

  referencePublic(row: VisualReferenceRow): VisualReferencePublic {
    const asset = this.assets.publicById(row.asset_id);
    const runs = this.listRuns(row.id);
    // A pass/fail against an older baseline must not verify the newly-upserted active baseline.
    const matchingRun = runs.find((run) => run.reference_asset_id === row.asset_id);
    const lastRun = matchingRun ? this.runReport(matchingRun) : null;
    return {
      id: row.id,
      fingerprint: JSON.parse(row.fingerprint_json),
      note: row.note,
      createdAt: row.created_at,
      asset: asset ? { ...asset, url: `/api/assets/${asset.id}` } : null,
      lastRun,
      renderer: parseReferenceRenderer(row),
    };
  }
}
