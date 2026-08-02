/**
 * Аудит spacing-резолвера по всем версиям тем всех дизайн-систем (план 2026-08-02, P6.3 / W4).
 *
 * Отвечает на вопрос, который нельзя закрыть рассуждением: где legacy-резолвер (`1`) реально
 * даёт другую шкалу, чем фикшеный (`2`) — то есть где включение фикса задним числом сдвинуло бы
 * геометрию. Для каждой версии темы печатается `(ds, version, fallbackTriggered, baseDropped)`.
 *
 * Запуск (bun — из-за bun:sqlite; база открывается только на чтение):
 *   ~/.bun/bin/bun scripts/audit-spacing-resolver.ts --db data/easy-ui.db
 *   ~/.bun/bin/bun scripts/audit-spacing-resolver.ts --json .backups/<snapshot>/design-systems.json
 *   ... --format json
 *
 * `--db` — полная история версий тем. `--json` — логический экспорт `GET /api/design-systems`
 * (в нём есть только **последняя** версия каждой системы: исторические версии в снапшот не
 * попадают, и это в отчёте отмечается явно).
 */
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { spacingResolverDiagnostics } from "../src/designSystems/spacingScale";

type Row = {
  designSystem: string;
  version: number | null;
  storedResolver: number | null;
  spaceTokensPresent: boolean;
  fallbackTriggered: boolean;
  baseDropped: boolean;
  differs: boolean;
};

type Args = { db?: string; json?: string; format: "table" | "json" };

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { format: "table" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--db") args.db = argv[++index];
    else if (arg === "--json") args.json = argv[++index];
    else if (arg === "--format") args.format = (argv[++index] === "json" ? "json" : "table");
    else if (arg === "--help" || arg === "-h") { printUsage(); process.exit(0); }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.db && !args.json) args.db = "data/easy-ui.db";
  return args;
}

function printUsage(): void {
  console.log("Usage: bun scripts/audit-spacing-resolver.ts [--db <sqlite>] [--json <design-systems.json>] [--format table|json]");
}

/** Диагностика одной версии темы. Чистая функция — источник (БД или JSON) её не касается. */
export function auditThemeVersion(designSystem: string, version: number | null, tokens: Record<string, string | number>, storedResolver: number | null): Row {
  const diagnostics = spacingResolverDiagnostics(designSystem, tokens);
  return {
    designSystem, version, storedResolver,
    spaceTokensPresent: diagnostics.spaceTokensPresent,
    fallbackTriggered: diagnostics.fallbackTriggered,
    baseDropped: diagnostics.baseDropped,
    differs: diagnostics.differs,
  };
}

function fromDatabase(path: string): Row[] {
  const db = new Database(path, { readonly: true });
  try {
    const columns = (db.query("PRAGMA table_info(design_system_versions)").all() as { name: string }[]).map((column) => column.name);
    // Базы старше v7 таблицы версий тем не имеют — это не ошибка аудита, а пустая история.
    if (!columns.length) return [];
    const hasResolver = columns.includes("spacing_resolver");
    const rows = db.query(`SELECT system_id, version, tokens_json${hasResolver ? ", spacing_resolver" : ""}
      FROM design_system_versions ORDER BY system_id, version`).all() as { system_id: string; version: number; tokens_json: string; spacing_resolver?: number }[];
    return rows.map((row) => auditThemeVersion(row.system_id, row.version, JSON.parse(row.tokens_json) as Record<string, string | number>, row.spacing_resolver ?? 1));
  } finally {
    db.close();
  }
}

function fromJsonExport(path: string): Row[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    designSystems?: { id: string; latestMetaVersion?: number | null; tokens?: Record<string, string | number> }[];
  };
  const systems = parsed.designSystems ?? [];
  // Логический экспорт несёт только последнюю версию: резолвер в нём не сериализован, поэтому
  // «записанный резолвер» неизвестен (null) — сравнение резолверов от этого не страдает.
  return systems.map((system) => auditThemeVersion(system.id, system.latestMetaVersion ?? null, system.tokens ?? {}, null));
}

export function renderTable(rows: Row[]): string {
  const header = ["design system", "version", "stored", "space.*", "fallbackTriggered", "baseDropped", "differs"];
  const body = rows.map((row) => [
    row.designSystem, row.version === null ? "—" : String(row.version), row.storedResolver === null ? "?" : String(row.storedResolver),
    row.spaceTokensPresent ? "yes" : "no", String(row.fallbackTriggered), String(row.baseDropped), String(row.differs),
  ]);
  const widths = header.map((_, column) => Math.max(header[column]!.length, ...body.map((cells) => cells[column]!.length)));
  const line = (cells: string[]) => cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ");
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...body.map(line)].join("\n");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const rows = args.json ? fromJsonExport(args.json) : fromDatabase(args.db!);
  if (args.format === "json") { console.log(JSON.stringify({ source: args.json ?? args.db, rows }, null, 2)); return; }
  console.log(`source: ${args.json ?? args.db}${args.json ? " (logical export — latest theme version per system only)" : ""}`);
  console.log(rows.length ? renderTable(rows) : "(no theme versions)");
  const affected = rows.filter((row) => row.differs);
  console.log(`\nversions: ${rows.length}; fallbackTriggered: ${rows.filter((row) => row.fallbackTriggered).length}; baseDropped: ${rows.filter((row) => row.baseDropped).length}; resolver 1 vs 2 differs: ${affected.length}`);
  for (const row of affected) console.log(`  ! ${row.designSystem} v${row.version ?? "?"} — enabling resolver 2 on this version would change the resolved scale`);
}

if (import.meta.main) main();
