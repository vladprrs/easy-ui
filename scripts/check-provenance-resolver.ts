/**
 * `npm run verify:provenance` — регресс-гард provenance-резолвера
 * (RFC candidate-acceptance-pipeline §6, волна R3a; форма гейта — триаж раунд2-m3, по прецеденту
 * `check-openapi-drift.ts`/`check-renderer-pin.ts`).
 *
 * Инвариант: **колонку `component_revisions.figma_json` и таблицу `component_provenance` читает и
 * пишет только резолвер** (`server/figma.ts`). Любой новый путь, дотянувшийся до сырой колонки,
 * молча вернулся бы к per-revision-семантике: чтение показывало бы устаревший снапшот, запись не
 * оставляла бы seq-строки (правило B1), и правка через `PUT …/provenance` до него не доезжала бы.
 *
 * Allowlist **закрыт**: файла нет в нём — гейт падает. Для компонентных путей число упоминаний
 * ещё и пинуется, чтобы новый читатель внутри уже легального файла не проехал незамеченным.
 * Provenance прототипов выведена из скоупа R3 (триаж R3-B4) и остаётся per-revision — её файлы
 * перечислены без пина количества.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Файл → сколько упоминаний `figma_json` в нём легально (для компонентных путей), и почему. */
const ALLOWLIST: Record<string, { count?: number; why: string }> = {
  "server/figma.ts": { count: 17, why: "сам резолвер: resolveProvenanceRaw/recordProvenance/resolveHeadProvenanceByComponent/provenanceAssetUsage (+доккоменты, включая обратную совместимость multi-source, план 2026-08-06 §W1)" },
  "server/migrations.ts": { count: 10, why: "DDL v27 (component_provenance), backfill head-ревизий, ADD COLUMN v9 и прототипные перестройки" },
  "server/repos/components.ts": { count: 2, why: "write-пути правила B1: INSERT ревизии в create и save (колонка остаётся фолбэком резолвера)" },
  "server/migrationRunner.ts": { count: 7, why: "срезы таблиц в currentDataFingerprint и прототипная перезапись ревизий — снапшоты, не read-path" },
  "server/components/validate.ts": { count: 1, why: "текст сообщения 422, не запрос" },
  "server/repos/prototypes.ts": { why: "provenance прототипов — per-revision, выведена из скоупа R3 (триаж R3-B4)" },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) { walk(full, out); continue; }
    if (/\.(ts|mts|mjs)$/.test(entry) && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function main(): void {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  for (const file of walk(path.join(repoRoot, "server"))) {
    const rel = path.relative(repoRoot, file).split(path.sep).join("/");
    const hits = readFileSync(file, "utf8").split("\n")
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => line.includes("figma_json"));
    if (!hits.length) continue;
    seen.set(rel, hits.length);
    const allowed = ALLOWLIST[rel];
    if (!allowed) {
      problems.push(`${rel}: ${hits.length} прямых упоминания figma_json (строки ${hits.map((hit) => hit.number).join(", ")}) — ходите через резолвер server/figma.ts или внесите файл в allowlist осознанной правкой скрипта`);
      continue;
    }
    if (allowed.count !== undefined && hits.length !== allowed.count) {
      problems.push(`${rel}: упоминаний figma_json стало ${hits.length}, в allowlist зафиксировано ${allowed.count} (${allowed.why}) — сверьте новый путь с правилом B1 (RFC §6) и обновите скрипт`);
    }
  }
  for (const [rel, allowed] of Object.entries(ALLOWLIST)) {
    if (!seen.has(rel)) problems.push(`${rel}: упоминаний figma_json нет вовсе, а allowlist их ждёт (${allowed.why}) — запись устарела, удалите её`);
  }

  if (problems.length) {
    console.error("provenance resolver gate failed:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`provenance resolver gate: ok (${Object.keys(ALLOWLIST).length} allowlisted readers/writers)`);
}

main();
