import type { Database } from "bun:sqlite";

/**
 * Кэш шинглов исходника компонента (миграция v20, план 2026-07-31 §3.6).
 *
 * **Это кэш, а не источник истины.** Ключ content-addressed —
 * `(component_id, rev, source_sha256)`, поэтому запись невозможно «протухнуть»: изменившийся
 * исходник даёт другой ключ, промах пересчитывается на лету и пишется write-through. Отсюда
 * следует, что restore (сохранение ревизии мимо `checkSource`), импортёр бандла и прямые
 * скрипты самозалечиваются — им не нужно ничего инвалидировать.
 *
 * Props/io/структурные подписи и описание здесь **не хранятся**: их источник —
 * `definition_meta` активной публикации. Двух источников истины по построению нет.
 *
 * Обе операции синхронные: их вызывает `matchAndDecide()` изнутри `db.transaction(() => …)`,
 * где любой `await` молча коммитит транзакцию bun:sqlite.
 */

export type SourceShingles = string[];

export type FingerprintKey = {
  componentId: string;
  rev: number;
  /** sha256 исходника ревизии — часть ключа, а не поле записи. */
  sourceSha256: string;
};

export const sourceSha256 = (source: string): string =>
  new Bun.CryptoHasher("sha256").update(source).digest("hex");

export class ComponentFingerprintRepo {
  constructor(private db: Database) {}

  /**
   * Промах — не ошибка: `undefined` на пустой таблице, на другом исходнике и на повреждённой
   * записи одинаково означает «посчитай сам». Именно поэтому корпус на холодном кэше обязан
   * совпадать с корпусом после прогрева.
   */
  get(componentId: string, rev: number, sha256: string): SourceShingles | undefined {
    const row = this.db.query("SELECT shingles_json FROM component_fingerprints WHERE component_id=? AND rev=? AND source_sha256=?")
      .get(componentId, rev, sha256) as { shingles_json: string } | null;
    if (!row) return undefined;
    try {
      const parsed: unknown = JSON.parse(row.shingles_json);
      if (!Array.isArray(parsed) || parsed.some(item => typeof item !== "string")) return undefined;
      return parsed as SourceShingles;
    } catch { return undefined; }
  }

  /** Write-through. Идемпотентен по ключу: повторный put обновляет только `updated_at`. */
  put(componentId: string, rev: number, sha256: string, shingles: SourceShingles): void {
    this.db.query(`INSERT INTO component_fingerprints (component_id,rev,source_sha256,shingles_json,updated_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT (component_id,rev,source_sha256) DO UPDATE SET
        shingles_json=excluded.shingles_json, updated_at=excluded.updated_at`)
      .run(componentId, rev, sha256, JSON.stringify(shingles), new Date().toISOString());
  }

  /** Кэш-с-подстраховкой: одно место, где живёт «попал → верни, промахнулся → посчитай и запиши». */
  getOrCompute(componentId: string, rev: number, sha256: string, compute: () => SourceShingles): SourceShingles {
    const hit = this.get(componentId, rev, sha256);
    if (hit) return hit;
    const computed = compute();
    this.put(componentId, rev, sha256, computed);
    return computed;
  }

  /**
   * Обслуживание: строки кэша дешевы и самозалечиваются, но копятся по ревизиям. Удаление
   * кэша безопасно в любой момент — это ровно то, что делает тест «холодный кэш == прогретый».
   */
  deleteForComponent(componentId: string): number {
    return this.db.query("DELETE FROM component_fingerprints WHERE component_id=?").run(componentId).changes;
  }

  count(): number {
    return (this.db.query("SELECT COUNT(*) count FROM component_fingerprints").get() as { count: number }).count;
  }
}
