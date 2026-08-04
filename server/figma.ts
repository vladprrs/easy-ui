import type { Database } from "bun:sqlite";
import { z } from "zod";
import { ApiError } from "./http";

// Figma provenance (plan §J). Immutable per-revision link back to the source Figma file:
// a strict, url-safe file key, 1..50 node ids, optional reference screenshot asset ids
// (validated against the asset registry), and an optional ISO sync timestamp. Stored as a
// JSON string in prototype_revisions.figma_json / component_revisions.figma_json.

const ASSET_ID = /^asset_[0-9a-f]{64}$/;

export const figmaSchema = z.strictObject({
  fileKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "fileKey must be url-safe"),
  nodeIds: z.array(z.string().min(1).max(64).regex(/^[A-Za-z0-9:._-]+$/, "nodeId must be safe")).min(1).max(50),
  referenceScreenshots: z.array(z.string().regex(ASSET_ID, "must be an asset id")).max(50).optional(),
  lastSyncedAt: z.string().min(1).max(40).refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO date").optional(),
});

export type FigmaProvenance = z.infer<typeof figmaSchema>;

// Validate an optional `figma` request field into a persist-ready JSON string (or null when the
// field is absent/null). referenceScreenshots must exist in the asset registry (422 asset_not_found).
export function parseFigmaInput(db: Database, value: unknown, pathRoot: string): string | null {
  if (value === undefined || value === null) return null;
  const parsed = figmaSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(422, "validation_failed", "Figma provenance is invalid", { issues: parsed.error.issues });
  for (const assetId of parsed.data.referenceScreenshots ?? []) {
    if (!db.query("SELECT 1 ok FROM assets WHERE id=?").get(assetId)) {
      throw new ApiError(422, "asset_not_found", "A referenced screenshot asset does not exist", { issues: [{ path: [pathRoot, "referenceScreenshots"], message: `unknown asset: ${assetId}` }] });
    }
  }
  return JSON.stringify(parsed.data);
}

// Parse a stored figma_json blob for read-back. Returns null for NULL/corrupt rows so read-back
// never fails on a legacy revision.
export function parseFigmaStored(json: string | null | undefined): FigmaProvenance | null {
  if (json === null || json === undefined) return null;
  try { return figmaSchema.parse(JSON.parse(json)); } catch { return null; }
}

/*
 * Provenance-слой компонентов (RFC candidate-acceptance §6, волна R3a).
 *
 * Provenance живёт в append-only `component_provenance(component_id, rev, seq, …)` и **резолвится
 * при чтении**, чтобы правка ссылки на Figma не требовала ни новой ревизии, ни новой версии.
 * Этот модуль — **единственный** легальный читатель `component_revisions.figma_json`
 * (см. `scripts/check-provenance-resolver.ts`): любой другой путь обязан ходить сюда.
 *
 * Резолв — cross-revision (триаж R3-B1): последняя запись по `(rev, seq)` среди ревизий
 * `rev' ≤ rev` того же компонента, иначе — сырая колонка самой ревизии. Tombstone (строка с
 * `figma_json IS NULL`) возвращает `null` и **не** проваливается обратно на колонку: иначе
 * очистку было бы не отличить от «записей нет».
 */

/** Служебный автор seq-строк, записанных backfill'ом миграции R3a. */
export const PROVENANCE_MIGRATION_AUTHOR = "migration:component_provenance";

type ProvenanceRow = { figma_json: string | null };

/**
 * Сырая форма резолвера (триаж раунд2-B4). Возвращает **строку**, а не разобранный объект:
 * `validateStoredFigma` обязан увидеть непарсящийся JSON и отчитаться 422, а no-op-детекция
 * компонентного PUT — сравнить байты.
 */
export function resolveProvenanceRaw(db: Database, componentId: string, rev: number): string | null {
  const row = db.query("SELECT figma_json FROM component_provenance WHERE component_id=? AND rev<=? ORDER BY rev DESC, seq DESC LIMIT 1")
    .get(componentId, rev) as ProvenanceRow | null;
  if (row) return row.figma_json;
  return (db.query("SELECT figma_json FROM component_revisions WHERE component_id=? AND rev=?")
    .get(componentId, rev) as ProvenanceRow | null)?.figma_json ?? null;
}

/** Типизированная обёртка для DTO-путей (`repo.meta|source|version`, чип Figma в Library). */
export function resolveProvenance(db: Database, componentId: string, rev: number): FigmaProvenance | null {
  return parseFigmaStored(resolveProvenanceRaw(db, componentId, rev));
}

/**
 * Правило B1 (§6): seq-строку пишет **любой** write-путь с переданным `figma` — POST create,
 * компонентный PUT, `repo.restore`, `PUT …/provenance` — этим единым хелпером и **внутри той же
 * транзакции**, что запись ревизии (триаж раунд3-m-2).
 *
 * `baselineRev` — ревизия, относительно которой считается дедуп (триаж раунд3-m-1): для только
 * что созданной ревизии это **предыдущая** (её собственная колонка ещё ничего не значит как
 * «предыдущая правда»), для provenance-PUT — она сама. Значение, совпадающее с резолвнутым
 * сырым, новой строки не создаёт: иначе каждый source-PUT драйвера с неизменным `figma` раздувал
 * бы историю и аудит показывал бы фантомные правки.
 *
 * Возвращает `seq` записанной строки либо `null`, если запись дедуплицирована.
 */
export function recordProvenance(
  db: Database,
  input: { componentId: string; rev: number; figmaJson: string | null; author?: string | null; baselineRev?: number },
): number | null {
  const baselineRev = input.baselineRev ?? input.rev;
  if (resolveProvenanceRaw(db, input.componentId, baselineRev) === input.figmaJson) return null;
  const seq = ((db.query("SELECT MAX(seq) m FROM component_provenance WHERE component_id=? AND rev=?")
    .get(input.componentId, input.rev) as { m: number | null }).m ?? 0) + 1;
  db.query("INSERT INTO component_provenance (component_id,rev,seq,figma_json,author,created_at) VALUES (?,?,?,?,?,?)")
    .run(input.componentId, input.rev, seq, input.figmaJson, input.author ?? null, new Date().toISOString());
  return seq;
}

/**
 * Использование ассета в append-only provenance (секция `provenance` отчёта `AssetUsage`,
 * RFC §6/триаж раунд2-m3): без неё эталонный скриншот, на который ссылается только seq-запись,
 * выглядел бы неиспользуемым.
 *
 * Кандидаты отбираются дешёвым `LIKE` по id ассета (он длинный и content-addressed, ложные
 * совпадения практически исключены), решает разбор в JS: `json_each` по сырой колонке уронил бы
 * ручку на битой записи, которую резолвер обязан отдавать как есть.
 */
export function provenanceAssetUsage(db: Database, assetId: string): { componentId: string; name: string; revs: number[] }[] {
  const rows = db.query(`SELECT cp.component_id componentId, c.name, cp.rev, cp.figma_json json
    FROM component_provenance cp JOIN components c ON c.id=cp.component_id
    WHERE cp.figma_json IS NOT NULL AND cp.figma_json LIKE ?
    ORDER BY cp.component_id, cp.rev, cp.seq`).all(`%${assetId}%`) as { componentId: string; name: string; rev: number; json: string }[];
  const usage: { componentId: string; name: string; revs: number[] }[] = [];
  for (const row of rows) {
    const figma = parseFigmaStored(row.json);
    if (!figma?.referenceScreenshots?.includes(assetId)) continue;
    const previous = usage.at(-1);
    if (previous?.componentId === row.componentId) { if (!previous.revs.includes(row.rev)) previous.revs.push(row.rev); }
    else usage.push({ componentId: row.componentId, name: row.name, revs: [row.rev] });
  }
  return usage;
}

/**
 * Set-based резолв provenance головных ревизий всех живых компонентов — горячий путь списочной
 * ручки Library (триаж раунд2-M5): наивный `resolveProvenance` на компонент дал бы N+1 под
 * перф-гейтом `npm run perf:library`.
 *
 * Окно `ROW_NUMBER()` по `(rev DESC, seq DESC)` повторяет порядок `resolveProvenanceRaw`; seq-строк
 * с `rev` больше головной не бывает (их пишут только для существующих ревизий), поэтому отсечка
 * `rev ≤ head_rev` в окне не нужна. Наличие строки — приоритетнее колонки, включая tombstone
 * (`COALESCE` здесь был бы ошибкой: он воскресил бы очищенную provenance из колонки).
 */
export function resolveHeadProvenanceByComponent(db: Database): Map<string, FigmaProvenance> {
  const rows = db.query(`SELECT c.id component_id,
      CASE WHEN p.component_id IS NULL THEN r.figma_json ELSE p.figma_json END figma_json
    FROM components c
    JOIN component_revisions r ON r.component_id=c.id AND r.rev=c.head_rev
    LEFT JOIN (
      SELECT component_id, figma_json,
             ROW_NUMBER() OVER (PARTITION BY component_id ORDER BY rev DESC, seq DESC) rn
      FROM component_provenance
    ) p ON p.component_id=c.id AND p.rn=1
    WHERE c.deleted_at IS NULL`).all() as { component_id: string; figma_json: string | null }[];
  const out = new Map<string, FigmaProvenance>();
  for (const row of rows) { const figma = parseFigmaStored(row.figma_json); if (figma) out.set(row.component_id, figma); }
  return out;
}
