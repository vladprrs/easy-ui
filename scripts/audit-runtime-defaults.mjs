#!/usr/bin/env bun
/* global process */
/**
 * Разовый аудит дрейфа runtime-дефолтов (план `docs/plans/2026-08-07-migration-feedback-wave.md`
 * §1.6, §W9): **сколько компонентов каталога объявляют в схеме дефолты, которых хост не применял**.
 *
 * Зачем отдельный скрипт, если то же предупреждение теперь эмитит извлечение
 * (`server/components/extract-subprocess.ts#runtimeDefaultDrift`). Извлечение видит **одну**
 * ревизию в момент, когда её кто-то сохраняет; вопрос волны — про весь корпус и **до** её начала:
 * стоит ли перевод вообще того. Ответ нужен числом, а не по мере того, как компоненты будут
 * пересохраняться.
 *
 * Почему без исполнения исходников. `definition_meta.propsJsonSchema` — это
 * `z.toJSONSchema(props, {io:"input"})`, посчитанный тем же publish'ем, и `.default(x)` попадает
 * в него ключом `"default"`. То есть ответ уже лежит в БД: ни собирать бандлы, ни импортировать
 * TSX не нужно, и прод-копию можно аудировать без единого subprocess'а.
 *
 * Честные границы (их видно в выводе):
 * - учитываются дефолты **верхнего уровня** props — ровно те, что применил бы хост-адаптер;
 *   дефолт внутри вложенного объекта посчитан не будет;
 * - `.catch()`/`.prefault()` в JSON Schema дефолтом не выражаются — такой компонент честно
 *   попадёт в «нет дрейфа», хотя рантайм-значение у него есть;
 * - публикации до появления `propsJsonSchema` в meta считаются `unknown`, а не «чисто».
 *
 * ```
 * bun scripts/audit-runtime-defaults.mjs [--db <path>] [--ds <designSystem>] [--json]
 * ```
 * По умолчанию БД — `$DATA_DIR/easy-ui.sqlite` (или `.data/easy-ui.sqlite`).
 */
import { Database } from "bun:sqlite";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};
const asJson = argv.includes("--json");
const dbPath = resolve(flag("--db") ?? resolve(process.env.DATA_DIR ?? ".data", "easy-ui.sqlite"));
const onlyDesignSystem = flag("--ds") ?? null;

const db = new Database(dbPath, { readonly: true });

/**
 * Активные публикации: по **последней** активной версии на компонент. Аудит про то, что каталог
 * поставляет сейчас, а не про историю версий.
 */
const rows = db.query(`
  SELECT c.name AS name, r.design_system AS ds, p.component_id AS id, p.version AS version, p.definition_meta AS meta
  FROM component_publishes p
  JOIN components c ON c.id = p.component_id
  JOIN component_revisions r ON r.component_id = p.component_id AND r.rev = p.rev
  WHERE p.status = 'active' AND c.deleted_at IS NULL
    AND p.version = (SELECT MAX(q.version) FROM component_publishes q
                     WHERE q.component_id = p.component_id AND q.status = 'active')
  ORDER BY r.design_system, c.name
`).all();

const report = [];
for (const row of rows) {
  if (onlyDesignSystem !== null && row.ds !== onlyDesignSystem) continue;
  let meta;
  try { meta = JSON.parse(row.meta); } catch { meta = null; }
  const schema = meta?.propsJsonSchema;
  const declared = meta?.capabilities?.runtimeSchemaDefaults === true;
  if (schema === undefined || schema === null || typeof schema !== "object") {
    report.push({ ...pick(row), declared, state: "unknown", defaults: [] });
    continue;
  }
  const properties = schema.properties;
  const defaults = properties && typeof properties === "object"
    ? Object.entries(properties)
      .filter(([, value]) => value !== null && typeof value === "object" && "default" in value)
      .map(([name]) => name)
    : [];
  report.push({
    ...pick(row),
    declared,
    state: defaults.length === 0 ? "clean" : declared ? "declared" : "drifting",
    defaults,
  });
}

function pick(row) {
  return { designSystem: row.ds, name: row.name, componentId: row.id, version: row.version };
}

const counts = report.reduce((acc, item) => ({ ...acc, [item.state]: (acc[item.state] ?? 0) + 1 }), {});
const drifting = report.filter((item) => item.state === "drifting");

if (asJson) {
  console.log(JSON.stringify({ db: dbPath, total: report.length, counts, components: report }, null, 2));
} else {
  console.log(`db: ${dbPath}`);
  console.log(`active components: ${report.length}`);
  console.log(`  drifting (schema declares defaults, capability not declared): ${counts.drifting ?? 0}`);
  console.log(`  declared (capabilities.runtimeSchemaDefaults):                ${counts.declared ?? 0}`);
  console.log(`  clean    (no top-level defaults in props):                    ${counts.clean ?? 0}`);
  console.log(`  unknown  (publish predates propsJsonSchema in meta):          ${counts.unknown ?? 0}`);
  if (drifting.length > 0) {
    console.log("");
    console.log("drifting components (design system / name / defaulted props):");
    for (const item of drifting) {
      console.log(`  ${item.designSystem}  ${item.name} v${item.version}  ${item.defaults.join(", ")}`);
    }
  }
}

db.close();
