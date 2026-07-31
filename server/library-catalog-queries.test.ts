import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "./db";
import { libraryCatalog } from "./routes/libraryCatalog";

// Гейт «статусы считаются set-based» (план §3.1): число SQL-запросов read-model ограничено
// константой и **не растёт** с размером каталога. Счётчик — обёртка над `db.query` инстанса
// (свойство перезаписываемо в bun 1.3.14). `db.run`/`db.prepare` она не перехватывает,
// поэтому read-model обязан ходить только через `db.query` — этот тест и есть его гарантия.

const BOUNDED_QUERY_LIMIT = 12;
const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();

function seedCatalog(db: Database, count: number): void {
  for (const id of ["qc-a", "qc-b", "qc-c"]) {
    db.query("INSERT INTO design_systems (id,name,description,builtin_provider,created_at,updated_at,retired) VALUES (?,?,?,NULL,?,?,0)")
      .run(id, `System ${id}`, "query counter", at(0), at(0));
  }
  const meta = JSON.stringify({ description: "Counter component", events: [], slots: [], example: { value: 1 } });
  for (let index = 0; index < count; index += 1) {
    const id = `qc-${index}`, designSystem = ["qc-a", "qc-b", "qc-c"][index % 3]!;
    db.query("INSERT INTO components (id,name,head_rev,design_system,deleted_at,created_at,updated_at) VALUES (?,?,1,?,NULL,?,?)").run(id, `Qc${index}`, designSystem, at(0), at(0));
    db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,figma_json,message,created_at) VALUES (?,1,?,?,NULL,NULL,?)").run(id, "export const definition = {};", designSystem, at(0));
    db.query("INSERT INTO component_publishes (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,message,published_at) VALUES (?,1,1,'active',?,?,?,?,4,NULL,?)")
      .run(id, "export default () => null;", meta, `sh-${id}`, `bh-${id}`, at(0));
  }
}

/** Считает вызовы `db.query`, не меняя их поведения. */
function countQueries(db: Database, run: () => void): number {
  const original = db.query.bind(db);
  let calls = 0;
  (db as { query: Database["query"] }).query = ((sql: string) => { calls += 1; return original(sql); }) as Database["query"];
  try { run(); } finally { (db as { query: Database["query"] }).query = original; }
  return calls;
}

function measure(count: number): { queries: number; entries: number } {
  const db = openDatabase(":memory:");
  try {
    seedCatalog(db, count);
    let entries = 0;
    const queries = countQueries(db, () => { entries = libraryCatalog(db).components.length; });
    return { queries, entries };
  } finally { db.close(); }
}

describe("library read model query budget", () => {
  test("число запросов ограничено константой и не растёт с размером каталога", () => {
    // Отдельные БД на каждый замер: кэш usage-графа живёт в WeakMap по инстансу, и общая БД
    // сделала бы второй замер дешевле по причине, не связанной с размером каталога.
    const small = measure(10), large = measure(100);
    expect(small.entries).toBe(10);
    expect(large.entries).toBe(100);
    expect(small.queries).toBeLessThanOrEqual(BOUNDED_QUERY_LIMIT);
    expect(large.queries).toBe(small.queries);
  });

  test("фильтр по системе не добавляет запросов на компонент", () => {
    const db = openDatabase(":memory:");
    try {
      seedCatalog(db, 60);
      const filtered = countQueries(db, () => { libraryCatalog(db, "qc-b"); });
      expect(filtered).toBeLessThanOrEqual(BOUNDED_QUERY_LIMIT);
    } finally { db.close(); }
  });
});
