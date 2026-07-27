/**
 * Обязательный dry-run readiness-отчёта (план 2026-07-27, волна 4).
 *
 * План запрещает включать любой publish-гейт раньше, чем измерено, что он делает с
 * реальными данными. Скрипт считает отчёт по каждому прототипу базы и печатает сводку:
 * распределение статусов по гейтам и список прототипов, которые были бы заблокированы
 * при гипотетическом «включено всё».
 *
 * Запуск (только через bun — нужен bun:sqlite и материализация TSX-модулей):
 *
 *   ~/.bun/bin/bun scripts/readiness-dryrun.ts --database <copy.db> [--data-dir data] [--json]
 *
 * Работать копией: скрипт открывает базу на запись только ради миграций схемы
 * (`openDatabase`), поэтому оригинальную прод-базу передавать нельзя.
 */

import { resolve } from "node:path";
import { openDatabase } from "../server/db";
import { computeReadiness, READINESS_GATE_IDS, type GateStatus, type ReadinessGateId } from "../server/readiness";

interface Args { database: string; dataDir: string; json: boolean }

function parseArgs(argv: string[]): Args {
  let database: string | undefined;
  let dataDir = "data";
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--database" || arg === "-d") { database = argv[index + 1]; index += 1; continue; }
    if (arg === "--data-dir") { dataDir = argv[index + 1] ?? dataDir; index += 1; continue; }
    if (arg === "--json") { json = true; continue; }
    if (!arg.startsWith("-") && database === undefined) { database = arg; continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!database) throw new Error("Usage: bun scripts/readiness-dryrun.ts --database <copy.db> [--data-dir data] [--json]");
  return { database: resolve(database), dataDir: resolve(dataDir), json };
}

const STATUSES: GateStatus[] = ["pass", "warn", "fail", "unknown"];
const pad = (value: string, width: number) => value.padEnd(width);
const padLeft = (value: string, width: number) => value.padStart(width);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // openDatabase прогоняет миграции: копия прод-базы может быть на более старой версии схемы.
  const db = openDatabase(args.database);
  try {
    const prototypes = db.query("SELECT id,name,head_rev,kind FROM prototypes ORDER BY id").all() as { id: string; name: string; head_rev: number; kind: string | null }[];
    const counts = new Map<ReadinessGateId, Record<GateStatus, number>>(
      READINESS_GATE_IDS.map((id) => [id, { pass: 0, warn: 0, fail: 0, unknown: 0 }]),
    );
    // «Включено всё» — гипотетический максимум: каждый гейт блокирует на fail.
    const allGates = Object.fromEntries(READINESS_GATE_IDS.map((id) => [id, "fail" as const]));
    const blockedRows: { id: string; name: string; blocking: string[] }[] = [];
    const failures: { id: string; error: string }[] = [];
    const perPrototype: unknown[] = [];

    for (const row of prototypes) {
      try {
        const report = await computeReadiness(db, row.id, { dataDir: args.dataDir, gates: allGates });
        for (const gate of report.gates) counts.get(gate.id)![gate.status] += 1;
        if (report.blocking.length) blockedRows.push({ id: row.id, name: row.name, blocking: report.blocking });
        perPrototype.push({ id: row.id, name: row.name, kind: row.kind, rev: report.rev, blocking: report.blocking, gates: report.gates.map((gate) => ({ id: gate.id, status: gate.status, summary: gate.summary })) });
      } catch (error) {
        failures.push({ id: row.id, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (args.json) {
      console.log(JSON.stringify({ database: args.database, prototypes: prototypes.length, counts: Object.fromEntries(counts), blocked: blockedRows, failures, perPrototype }, null, 2));
      return;
    }

    console.log(`База: ${args.database}`);
    console.log(`Прототипов: ${prototypes.length}${failures.length ? ` (отчёт не собрался у ${failures.length})` : ""}`);
    console.log("");
    const width = Math.max(...READINESS_GATE_IDS.map((id) => id.length), 5);
    console.log(`${pad("gate", width)} | ${STATUSES.map((status) => padLeft(status, 7)).join(" | ")}`);
    console.log(`${"-".repeat(width)}-+-${STATUSES.map(() => "-".repeat(7)).join("-+-")}`);
    for (const id of READINESS_GATE_IDS) {
      const row = counts.get(id)!;
      console.log(`${pad(id, width)} | ${STATUSES.map((status) => padLeft(String(row[status]), 7)).join(" | ")}`);
    }
    console.log("");
    console.log(`Заблокировано при «включено всё» (каждый гейт блокирует на fail): ${blockedRows.length}`);
    for (const row of blockedRows) console.log(`  - ${row.id} (${row.name}): ${row.blocking.join(", ")}`);
    if (failures.length) {
      console.log("");
      console.log("Отчёт не собрался:");
      for (const failure of failures) console.log(`  - ${failure.id}: ${failure.error}`);
    }
  } finally {
    db.close();
  }
}

await main();
