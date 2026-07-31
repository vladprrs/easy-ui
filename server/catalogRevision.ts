import { canonicalStringify } from "../src/capture/canonicalJson";

/**
 * Ревизия каталога — sha256 канонического JSON собранных строк read-model.
 * `kind` в сигнатуре с самого начала: проект 2 добавит композиции в тот же набор,
 * и порядок сортировки не должен поменяться задним числом.
 * Считать её можно только от **нефильтрованного** каталога: иначе два клиента с разными
 * `?designSystem=` получили бы разные «ревизии каталога» на одном состоянии БД.
 */
export interface CatalogRevisionRow { kind:string; designSystem:string; id:string }

export function catalogRevision(rows:readonly CatalogRevisionRow[]):string {
  const sorted=[...rows].sort((a,b)=>a.kind.localeCompare(b.kind)||a.designSystem.localeCompare(b.designSystem)||a.id.localeCompare(b.id));
  return new Bun.CryptoHasher("sha256").update(canonicalStringify(sorted)).digest("hex");
}
