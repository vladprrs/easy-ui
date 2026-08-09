/**
 * Evidence приёмки: content-addressed store + per-run манифест (амендмент A4 плана
 * `docs/plans/2026-08-03-family-acceptance-and-composition-v3.md`, RFC §3.3).
 *
 * Раскладка:
 * ```
 * <dataDir>/.acceptance/cas/<sha[0:2]>/<sha>      — артефакты (PNG, geometry JSON, метрики)
 * <dataDir>/.acceptance/<runId>/manifest.json     — манифест рана (ссылки на CAS)
 * <dataDir>/.acceptance/<runId>/SHA256SUMS        — "<sha256>  <имя>" построчно
 * ```
 *
 * Границы, которые здесь держатся вместо вызывающих:
 * - **Путь run-каталога выводится только из валидированного `runId`** (D4): `isRunId` — regex
 *   `acc_<uuid>`, поэтому в имя каталога не попадает ни `..`, ни абсолютный путь.
 * - **Имена записей санитизируются** charset'ом W2 (`^[A-Za-z0-9._-]{1,64}$`) — они уезжают в
 *   SHA256SUMS и в zip-экспорт; отказ, а не «почистим молча».
 * - **Артефакты не в asset-store** (A4): у asset-store нет GC, а приёмка снимает десятки кадров
 *   на ран. Байты приходят из `deliver:"bytes"`-джобы и кладутся сюда.
 * - **GC консервативен**: артефакт удаляется только если на него не ссылается ни одна строка
 *   `acceptance_case_results` и ни одна `acceptance_cases`, и он старше grace-периода (молодой
 *   артефакт может быть записан прямо сейчас — строка результата ещё не закоммичена).
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalStringify } from "../../src/capture/canonicalJson";
import { ApiError } from "../http";
import type { ResolvedSlotBinding, RunOverlayNode } from "./cases";
import { isRunId, type VerdictPolicySnapshot } from "./ids";
import { evidenceMaxBytes as DEFAULT_EVIDENCE_MAX_BYTES, acceptanceCaseTtlHours } from "./policies";
import type { AcceptanceRepo } from "./repo";

export const ACCEPTANCE_DIR_NAME = ".acceptance";
/** Молодые артефакты не вытесняются: строка результата могла ещё не появиться (прецедент `gcCandidates`). */
export const EVIDENCE_GC_GRACE_MS = 30 * 60_000;

const SHA_PATTERN = /^[0-9a-f]{64}$/;
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const sha256Of = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export const acceptanceRoot = (dataDir: string): string => resolve(dataDir, ACCEPTANCE_DIR_NAME);
export const casRoot = (dataDir: string): string => resolve(acceptanceRoot(dataDir), "cas");

/** Путь артефакта в CAS. `sha` обязан быть 64-hex — иначе это не адрес, а произвольный путь. */
export function casPath(dataDir: string, sha: string): string {
  if (!SHA_PATTERN.test(sha)) throw new ApiError(422, "invalid_artifact", "Artifact sha256 must be 64 lowercase hex chars");
  return resolve(casRoot(dataDir), sha.slice(0, 2), sha);
}

/** Каталог рана. Имя — только из `runId`, прошедшего regex-валидацию (D4). */
export function runEvidenceDir(dataDir: string, runId: string): string {
  if (!isRunId(runId)) throw new ApiError(404, "not_found", "Acceptance run not found");
  return resolve(acceptanceRoot(dataDir), runId);
}

/** Имя записи манифеста/архива. Отказ, а не тихая замена символов. */
export function sanitizeEvidenceName(name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new ApiError(422, "invalid_evidence_name", `Evidence entry name must match ${NAME_PATTERN.source}: ${JSON.stringify(name)}`);
  }
  return name;
}

export interface EvidenceArtifact { sha256: string; path: string; bytes: number }

const writeAtomic = async (path: string, data: Uint8Array | string): Promise<void> => {
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
};

/**
 * Кладёт артефакт в CAS. Повторная запись того же содержимого — no-op по содержимому (тот же
 * адрес), поэтому дедуп между ранами получается бесплатно. JSON канонизуется: одинаковые метрики
 * с разным порядком ключей обязаны давать один адрес.
 */
export async function putArtifact(dataDir: string, data: Uint8Array | string | Record<string, unknown> | unknown[]): Promise<EvidenceArtifact> {
  const bytes = data instanceof Uint8Array
    ? data
    : new TextEncoder().encode(typeof data === "string" ? data : canonicalStringify(data));
  const sha = sha256Of(bytes);
  const path = casPath(dataDir, sha);
  await mkdir(resolve(path, ".."), { recursive: true });
  try {
    const existing = await stat(path);
    if (existing.size === bytes.byteLength) return { sha256: sha, path, bytes: bytes.byteLength };
  } catch { /* нет записи — пишем */ }
  await writeAtomic(path, bytes);
  return { sha256: sha, path, bytes: bytes.byteLength };
}

/** Физическое существование артефакта — предусловие reuse (A4: иначе пересъёмка). */
export async function artifactPresent(dataDir: string, sha: string): Promise<boolean> {
  if (!SHA_PATTERN.test(sha)) return false;
  try { return (await stat(casPath(dataDir, sha))).size > 0; }
  catch { return false; }
}

export async function readArtifact(dataDir: string, sha: string): Promise<Uint8Array | null> {
  try { return new Uint8Array(await readFile(casPath(dataDir, sha))); }
  catch { return null; }
}

/**
 * Запись CAS в манифесте случая: `paint.png`, `geometry.json`, `diff.png`,
 * `normalized-candidate.png`, `visual.json`, `receipt.json` и — с волны W5 —
 * `normalized-reference.png`.
 *
 * Последняя появляется только там, где эталон **строил сервер** (`referenceSurface:"content-hug"`):
 * иммутабельный источник остаётся в реестре ассетов и адресуется из `visual.json` парой
 * `referenceSource {assetId, sha256}`, а в CAS едет ровно то, чего в реестре нет, — построенная
 * канва вместе с её lineage (`referenceNormalization`). Без деривата «сравнение прошло» было бы
 * неотличимо от «сравнили не то»: канву не восстановить по одному лишь id исходного ассета.
 */
export interface EvidenceEntry { name: string; sha256: string; bytes: number }

/**
 * Ребёнок слота в манифесте (план 2026-08-05 §A7): **разрешённый** пин, а не то, что было написано
 * в манифесте набора. `bundleHash` и `propsHash` здесь потому, что именно они входят в кадровый
 * слой отпечатка: без них читатель evidence видит «в слоте был PayChild v1», но не может отличить
 * снятый билд ребёнка от любого другого с тем же номером версии.
 */
export interface EvidenceSlotChild {
  componentId: string;
  /** Имя компонента — то, чем ребёнок пинуется в манифесте набора. */
  name: string;
  /** Отсутствует у overlay-ребёнка (волна 2026-08-07 §W3): кандидат не опубликован. */
  version?: number;
  /** Кандидат, из которого взят overlay-ребёнок (§W3); у пиннутого ребёнка отсутствует. */
  candidateId?: string;
  bundleHash: string;
  props: Record<string, unknown>;
  propsHash: string;
}
/** Слот случая: ключ (`default` — неявный слот `children`, §A2a) и дети **в порядке рендера**. */
export interface EvidenceSlotBinding { slot: string; children: EvidenceSlotChild[] }

export interface EvidenceCaseEntry {
  caseId: string;
  caseKey: string;
  verdict: string | null;
  status: string;
  reused: boolean;
  /** Почему случай снят заново вопреки кэшу (`refresh:all|failed|cases`), если это было форсом. */
  refreshReason?: string;
  /**
   * Почему случай **не** снимался (W6): `impact:<basis>` — вердикт перенесён с baseline-рана,
   * `case_fingerprint` — обычный reuse, `alias_of:<caseId>` — наследование цели. Читатель
   * evidence обязан видеть основание пропуска съёмки, иначе «дешёвый ран» неотличим от неполного.
   */
  reuseReason?: string;
  aliasOfCaseId: string | null;
  /**
   * Квитанция reuse случая (W8, P2-10): `{reuse:{candidate,frame,readiness,geometry,visualMetrics,
   * verdict}, fingerprints:{frame,comparison,verdictPolicy,case}}`. В манифесте она обязательна не
   * меньше, чем в API: доказательство приёмки без ответа «что здесь вообще считали заново»
   * неотличимо от доказательства, собранного целиком из кэша.
   */
  reuseReceipt?: Record<string, unknown>;
  /**
   * **Эффективная вердиктная политика случая** (критерий P0-3): снимок по значениям + его хэш.
   * Хэш один ничего не доказывает читателю evidence — по нему нельзя увидеть, каким порогом мерили;
   * снимок один не проверяем — по нему нельзя сверить строку кэша, из которой вердикт переносился.
   * Поэтому пара, и ровно та же пара, что персистит `acceptance_case_results.verdict_policy_json`.
   */
  verdictPolicy?: { hash: string; snapshot: VerdictPolicySnapshot };
  /**
   * **Разрешённое дерево слотов случая** (§A7): что именно рендерилось внутри кандидата. Кадр
   * слот-случая зависит от детей не меньше, чем от props родителя, поэтому без дерева манифест не
   * отвечает «что мы приняли»: два случая с одинаковыми props и разным содержимым слотов
   * неразличимы. Поля опциональны и пишутся условным спредом — у slot-free случая их нет вовсе
   * (инвариант «отсутствует, а не пусто»), и его запись остаётся побайтово прежней.
   */
  slotBindings?: EvidenceSlotBinding[];
  /**
   * Тот же `slots_hash`, что персистирован в `acceptance_cases` и вошёл в рукопожатие капчура —
   * одним значением сверяются строка случая, кадр и evidence.
   */
  slotsHash?: string;
  /**
   * **Квитанция сравнения случая** (BR-07, перечень E1 плана): чем и над чем получен визуальный
   * вердикт — matte и плоскостность эталона после него, цветовое пространство, отпечаток
   * рендерера и шрифтового стека, версия политики сравнения. Условный ключ: случай без визуального
   * измерения (нет эталона, `indeterminate` до диффа) его не несёт, и запись остаётся прежней.
   */
  comparisonReceipt?: Record<string, unknown>;
  /**
   * **Сводка атрибуции** (BR-07) и **два вердикта** (BR-08). В манифест едет именно сводка, а не
   * весь список владельцев: полный набор лежит в `visual.json` случая, а доказательству нужен
   * ответ «сколько пикселей нашли владельца и сколько осталось ничьими» — по нему читается, можно
   * ли вообще верить кластерам. Оба ключа условные.
   */
  attribution?: Record<string, unknown>;
  ownership?: Record<string, unknown>;
  artifacts: EvidenceEntry[];
}

/**
 * Визуальные квитанции случая для манифеста (BR-07/BR-08). Возвращает **пустой объект**, когда
 * гейт не считал ни атрибуции, ни квитанции: спред пустого объекта не добавляет ключей, и запись
 * доволнового случая остаётся побайтово прежней.
 */
export function evidenceVisualReceiptOf(
  gates: readonly { gate: string; metrics?: Record<string, unknown> }[],
): { comparisonReceipt?: Record<string, unknown>; attribution?: Record<string, unknown>; ownership?: Record<string, unknown> } {
  const metrics = gates.find((gate) => gate.gate === "visual")?.metrics;
  if (metrics === undefined) return {};
  const receipt = metrics.comparisonReceipt;
  const attribution = metrics.attribution as Record<string, unknown> | undefined;
  const ownership = metrics.ownership as Record<string, unknown> | undefined;
  return {
    ...(receipt === undefined ? {} : { comparisonReceipt: receipt as Record<string, unknown> }),
    ...(attribution === undefined ? {} : {
      attribution: {
        attributedPixels: attribution.attributedPixels,
        unknownPixels: attribution.unknownPixels,
        totalMismatchedPixels: attribution.totalMismatchedPixels,
        coveragePct: attribution.coveragePct,
        truncated: attribution.truncated,
      },
    }),
    ...(ownership === undefined ? {} : { ownership }),
  };
}

/**
 * Слот-поля записи манифеста из случая рана. Плоский `ResolvedSlotBinding[]` группируется по
 * слотам — читателю evidence нужен слепок дерева, а не кортежи отпечатка; порядок слотов и детей
 * внутри слота сохраняется как есть (он же порядок рендера и пре-образ `slotsHash`).
 *
 * Возвращает **пустой объект**, если у случая нет слотов: спред пустого объекта не добавляет ключей,
 * и slot-free запись не отличается от досhlot-овой ни одним байтом.
 */
export function evidenceSlotsOf(
  item: { slotBindings?: ResolvedSlotBinding[]; slotsHash?: string } | undefined,
): { slotBindings?: EvidenceSlotBinding[]; slotsHash?: string } {
  if (!item || item.slotBindings === undefined || item.slotBindings.length === 0) return {};
  const bySlot = new Map<string, EvidenceSlotChild[]>();
  for (const binding of item.slotBindings) {
    const children = bySlot.get(binding.slot) ?? [];
    if (children.length === 0) bySlot.set(binding.slot, children);
    children.push({
      componentId: binding.componentId,
      name: binding.name,
      // §W3: условные ключи — запись пиннутого ребёнка остаётся побайтово прежней (golden §A7).
      ...(binding.version === undefined ? {} : { version: binding.version }),
      ...(binding.candidate === undefined ? {} : { candidateId: binding.candidate.candidateId }),
      bundleHash: binding.bundleHash,
      props: binding.props,
      propsHash: binding.propsHash,
    });
  }
  return {
    slotBindings: [...bySlot].map(([slot, children]) => ({ slot, children })),
    ...(item.slotsHash === undefined ? {} : { slotsHash: item.slotsHash }),
  };
}
export interface RunManifest {
  version: 1;
  runId: string;
  candidateId: string;
  componentId: string;
  policyProfileId: string;
  policyProfileHash: string;
  verdict: string;
  createdAt: string;
  finishedAt: string;
  /** A10/N1: расхождение снимаемого билда с head — advisory-метка, а не отказ. */
  headDiverged?: boolean;
  /**
   * Резолвнутый граф неопубликованных зависимостей рана (волна 2026-08-07 §W3) и его хэш —
   * ровно то, что персистировано в `acceptance_runs.overlay_manifest_json`/`overlay_hash`.
   * Условные ключи: манифест overlay-free рана остаётся байт-в-байт прежним.
   */
  candidateOverlay?: RunOverlayNode[];
  overlayHash?: string;
  cases: EvidenceCaseEntry[];
}

/** Хэш манифеста целиком — он же `acceptance_runs.evidence_manifest_hash`. */
export function evidenceManifestHash(manifest: RunManifest): string {
  return new Bun.CryptoHasher("sha256").update(canonicalStringify(manifest)).digest("hex");
}

/** `"<sha256>  <caseId>/<name>"` построчно — формат `sha256sum`, читаемый и проверяемый снаружи. */
export function sha256Sums(manifest: RunManifest): string {
  const lines: string[] = [];
  for (const item of manifest.cases) {
    const caseId = sanitizeEvidenceName(item.caseId);
    for (const artifact of item.artifacts) lines.push(`${artifact.sha256}  ${caseId}/${sanitizeEvidenceName(artifact.name)}`);
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * Пишет манифест рана и SHA256SUMS. Возвращает хэш манифеста — вызывающий кладёт его в
 * терминализацию рана одной транзакцией (D2).
 */
export async function writeRunManifest(dataDir: string, runId: string, manifest: RunManifest): Promise<{ manifestHash: string; dir: string }> {
  const dir = runEvidenceDir(dataDir, runId);
  // Санитизация имён — до записи: частично записанный манифест хуже отказа.
  const sums = sha256Sums(manifest);
  await mkdir(dir, { recursive: true });
  await writeAtomic(resolve(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeAtomic(resolve(dir, "SHA256SUMS"), sums);
  return { manifestHash: evidenceManifestHash(manifest), dir };
}

export async function readRunManifest(dataDir: string, runId: string): Promise<RunManifest | null> {
  try { return JSON.parse(await readFile(resolve(runEvidenceDir(dataDir, runId), "manifest.json"), "utf8")) as RunManifest; }
  catch { return null; }
}

/** Глубокий обход JSON в поисках sha-адресов: артефакты лежат и в результатах, и в gates случаев. */
export function collectShas(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") { if (SHA_PATTERN.test(value)) into.add(value); return into; }
  if (Array.isArray(value)) { for (const item of value) collectShas(item, into); return into; }
  if (value !== null && typeof value === "object") { for (const item of Object.values(value)) collectShas(item, into); return into; }
  return into;
}

const parseJson = (raw: string | null): unknown => {
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

/**
 * Адреса, на которые ссылаются доказательства приёмки (case-результаты и гейты случаев).
 *
 * Используется дважды: внутри `gcEvidence` как «живое множество» CAS и — с волны R5 — как
 * **пин-множество свипера receipt-стора**. Второе не косметика: гейт `render` кладёт в CAS ровно
 * те байты, что лежат в `.receipts`, поэтому у receipt'а и его CAS-копии один адрес, и вытеснение
 * из receipt-стора того, на что ссылается живой per-run манифест, оставило бы доказательство
 * читаемым только в одном из двух контуров. Пин делает оба согласованными, не связывая GC.
 */
export function referencedArtifactShas(repo: AcceptanceRepo): Set<string> {
  const live = new Set<string>();
  for (const row of repo.allCaseResults()) collectShas(parseJson(row.artifacts_json), live);
  for (const row of repo.allCaseGates()) {
    collectShas(parseJson(row.gates_json), live);
    collectShas(parseJson(row.capture_quality_json), live);
  }
  return live;
}

export interface EvidenceGcOptions {
  graceMs?: number;
  maxBytes?: number;
  /** TTL строк `acceptance_case_results` (кэш reuse). */
  ttlHours?: number;
  now?: number;
}
export interface EvidenceGcReport {
  removedArtifacts: number;
  removedResults: number;
  freedBytes: number;
  totalBytes: number;
}

/**
 * GC evidence (A4). Порядок шагов важен:
 *
 * 1. Протухшие строки `acceptance_case_results`, на которые не ссылается ни один `acceptance_cases`,
 *    удаляются **вместе со своими артефактами** — иначе кэш reuse ссылался бы в пустоту.
 * 2. Живое множество sha пересчитывается по объединению `acceptance_case_results` ∪ `acceptance_cases`
 *    (union-refcount, триаж R1-B5).
 * 3. CAS-файлы вне живого множества и старше grace-периода удаляются.
 * 4. Если CAS всё ещё тяжелее `evidenceMaxBytes` — вытесняются самые давно использованные строки
 *    результатов **терминальных fail/error ранов** (их пересъёмка дешевле, чем потеря доказательств
 *    прошедшей приёмки). Метаданные ранов (`manifest.json`/`SHA256SUMS`) не трогаются никогда:
 *    манифест — это и есть свидетельство, его размер пренебрежим.
 */
export async function gcEvidence(dataDir: string, repo: AcceptanceRepo, options: EvidenceGcOptions = {}): Promise<EvidenceGcReport> {
  const now = options.now ?? Date.now();
  const graceMs = options.graceMs ?? EVIDENCE_GC_GRACE_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_EVIDENCE_MAX_BYTES;
  const ttlHours = options.ttlHours ?? acceptanceCaseTtlHours;
  const report: EvidenceGcReport = { removedArtifacts: 0, removedResults: 0, freedBytes: 0, totalBytes: 0 };

  // 1. Протухшие и нессылаемые результаты.
  const staleIso = new Date(now - ttlHours * 3600_000).toISOString();
  for (const row of repo.unreferencedCaseResults(staleIso)) {
    repo.deleteCaseResult(row.case_fingerprint);
    report.removedResults += 1;
  }

  // 2. Живое множество адресов.
  const live = referencedArtifactShas(repo);

  // 3. Обход CAS.
  const files: { sha: string; path: string; bytes: number; mtimeMs: number }[] = [];
  let shards: string[];
  try { shards = await readdir(casRoot(dataDir)); } catch { return report; }
  for (const shard of shards) {
    let names: string[];
    try { names = await readdir(resolve(casRoot(dataDir), shard)); } catch { continue; }
    for (const name of names) {
      if (!SHA_PATTERN.test(name)) continue;
      const path = resolve(casRoot(dataDir), shard, name);
      try {
        const info = await stat(path);
        files.push({ sha: name, path, bytes: info.size, mtimeMs: info.mtimeMs });
      } catch { /* гонка с параллельной записью */ }
    }
  }
  for (const file of files) {
    if (live.has(file.sha) || now - file.mtimeMs < graceMs) continue;
    try { await rm(file.path, { force: true }); report.removedArtifacts += 1; report.freedBytes += file.bytes; }
    catch { /* best effort */ }
  }

  // 4. Потолок байт.
  let total = files.filter((file) => live.has(file.sha) || now - file.mtimeMs < graceMs).reduce((sum, file) => sum + file.bytes, 0);
  if (total > maxBytes) {
    const byPath = new Map(files.map((file) => [file.sha, file]));
    for (const row of repo.evictableCaseResults()) {
      if (total <= maxBytes) break;
      const shas = collectShas(parseJson(row.artifacts_json));
      repo.deleteCaseResult(row.case_fingerprint);
      report.removedResults += 1;
      for (const sha of shas) {
        // Артефакт мог остаться живым по ссылке из другой строки — пересчёт по union.
        if (repo.artifactStillReferenced(sha)) continue;
        const file = byPath.get(sha);
        try { await rm(casPath(dataDir, sha), { force: true }); } catch { continue; }
        report.removedArtifacts += 1;
        if (file) { total -= file.bytes; report.freedBytes += file.bytes; }
      }
    }
  }
  report.totalBytes = Math.max(total, 0);
  return report;
}
