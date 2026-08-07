#!/usr/bin/env bun
/* global process, setTimeout */
/**
 * Инвентаризация case-set'ов, которых касается смена семантики измерения `layoutBounds`
 * (план `docs/plans/2026-08-06-feedback-3-platform-capabilities.md` §W2-audit, находки S7/F8).
 *
 * **Зачем.** Волна W2 меняет `GEOMETRY_CONTRACT_VERSION` 1 → 2: в `layoutBounds` теперь входят
 * живые текстовые узлы, а клипнутое поддерево режется окном клипа. Кадры честно инвалидируются
 * (поле едет в `frameFingerprint`), но **манифесты не мигрируются**: `cset_` — контентный адрес,
 * переписать манифест на месте нельзя by design. Значит, до деплоя W2+W3 нужен список семейств,
 * где новая семантика сдвинет вердикт, чтобы координатор перевыпустил их осознанно.
 *
 * **Кого касается.**
 * - `expectedGeometry` — объявленный контур случая. Он сверяется с измеренным `layoutBounds`;
 *   если измерение сдвинулось (текст под контуром, клипнутая лента), кейс начнёт падать
 *   `size-mismatch`, пока манифест не перевыпустят с новыми числами или `sizeDeltaPx` (W3).
 * - `referenceSurface: "content-hug"` **без** `expectedGeometry` — канва сравнения выводится из
 *   измеренного `layoutBounds` прямо в ране (`server/acceptance/gates/visual.ts#referenceCanvasOf`).
 *   Числа в манифесте не поменяются, а канва — да, поэтому эталон подлежит перепроверке.
 *
 * **Волна 2026-08-07 (W1a/W1b), класс `legacy-branch-order-sensitive`.** Вердикт получил вторую
 * ветку (per-surface), а легаси-вход обязан исполнять прежний код байт-в-байт. Наблюдаемая разница
 * между ветками возможна ровно там, где значим **порядок решений**: `expectedGeometry` вместе с
 * `allowPaintOverflow`/`expectedClip`. Прогон на восстановленной копии прод-тома — доказательство
 * того, что таких семей ноль (либо поимённый список, который координатор переводит осознанно).
 * Прогон с `--server-url` дополнительно печатает новые факты кадра (`rootBounds`,
 * `referenceExportDims`) — они меряются безусловно и в доволновых манифестах.
 *
 * **Режимы.**
 *   bun scripts/audit-geometry-contract.mjs                       # инвентаризация data/easy-ui.db
 *   bun scripts/audit-geometry-contract.mjs --db .backups/prod.db # то же по копии прод-базы
 *   bun scripts/audit-geometry-contract.mjs --json                # машинный отчёт
 *   bun scripts/audit-geometry-contract.mjs --server-url http://127.0.0.1:8787 [--component id]
 *       # dry-run: поднять кандидата и прогнать затронутые наборы на **новой** семантике,
 *       # напечатав дельту «объявлено в манифесте → измерено сейчас».
 *
 * Дельта «старая семантика → новая» напрямую не считается: старое измерение живёт только в
 * коде до W2. Сравнение идёт с объявленным `expectedGeometry` — это ровно тот вход, по которому
 * гейт выносит вердикт, и потому единственный, который координатору предстоит править.
 *
 * Запускается под Bun (`bun:sqlite` — тот же драйвер, что у сервера; npm-зависимости не нужны).
 *
 * Прогон только читает: ни манифесты, ни строки базы скрипт не меняет.
 */
import { Database } from "bun:sqlite";
import { createEasyUiClient, easyUiCredentials } from "./easyui-auth.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const has = (name) => args.includes(`--${name}`);

const dbPath = flag("db", "data/easy-ui.db");
const serverUrl = flag("server-url", null);
const onlyComponent = flag("component", null);
const asJson = has("json");

/**
 * Классификация случая: почему смена контракта измерения (W2) либо новая ветка вердикта
 * (волна 2026-08-07, W1a/W1b) его касается. Классов у случая может быть несколько — они отвечают
 * на разные вопросы, и схлопывать их в один значило бы потерять ровно тот, ради которого запущен
 * прогон.
 *
 * - `expected-geometry-declared` / `canvas-from-measurement` / `paint-policy-declared` — исходные
 *   классы W2 (смена семантики `layoutBounds`).
 * - `legacy-branch-order-sensitive` (**W1b**) — `expectedGeometry` **вместе с**
 *   `allowPaintOverflow`/`expectedClip`. Это единственная комбинация, где наблюдаем **порядок
 *   решений** легаси-ветки: ранний `return layout-overflow` выносится до проверки краски, поэтому
 *   paint-намерения на таком случае сегодня не применяются вовсе. Ожидание аудита — ноль
 *   расхождений (легаси-ветка байт-идентична), и перечень существует как **доказательство** этого,
 *   а не как список к правке.
 * - `surfaces-declared` — случай уже переведён на новый путь (`expectedSurfaces`/
 *   `comparisonSurface`/`clipExpectation`): его вердикт считается новой веткой по построению.
 */
export function risksOf(entry, manifest) {
  const policy = manifest.policy?.perCase?.[entry.id] ?? {};
  const paintPolicy = Boolean(policy.allowPaintOverflow || policy.expectedClip);
  const risks = [];
  if (entry.expectedGeometry) risks.push("expected-geometry-declared");
  else if ((entry.referenceSurface ?? null) === "content-hug") risks.push("canvas-from-measurement");
  // Кейс без объявленного контура и без content-hug эталона: вердикт геометрии смотрит только на
  // paint-overflow, а он от смены layoutBounds тоже зависит — но лишь когда краска выходит наружу.
  if (paintPolicy) risks.push("paint-policy-declared");
  if (entry.expectedGeometry && paintPolicy) risks.push("legacy-branch-order-sensitive");
  if (entry.expectedSurfaces || entry.comparisonSurface || entry.clipExpectation) risks.push("surfaces-declared");
  return risks;
}

function inventory() {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.query(
    `SELECT case_set_id, component_id, design_system, manifest_json, case_count, created_at
       FROM component_case_sets ORDER BY component_id, created_at`,
  ).all();
  const report = [];
  for (const row of rows) {
    let manifest;
    try { manifest = JSON.parse(row.manifest_json); }
    catch { report.push({ caseSetId: row.case_set_id, componentId: row.component_id, error: "manifest_unparsable" }); continue; }
    if (onlyComponent && row.component_id !== onlyComponent) continue;
    const cases = [];
    for (const entry of manifest.cases ?? []) {
      const risks = risksOf(entry, manifest);
      if (!risks.length) continue;
      cases.push({
        caseId: entry.id,
        // `risk` — ведущий класс (совместимость с прежним отчётом), `risks` — полный набор.
        risk: risks[0],
        risks,
        expectedSurfaces: entry.expectedSurfaces ?? null,
        clipExpectation: entry.clipExpectation ?? null,
        comparisonSurface: entry.comparisonSurface ?? null,
        allowPaintOverflow: manifest.policy?.perCase?.[entry.id]?.allowPaintOverflow ?? null,
        expectedClip: manifest.policy?.perCase?.[entry.id]?.expectedClip ?? null,
        expectedGeometry: entry.expectedGeometry ?? null,
        referenceSurface: entry.referenceSurface ?? null,
        referencePlacement: entry.referencePlacement ?? null,
        referenceAssetId: entry.referenceAssetId ?? null,
      });
    }
    if (!cases.length) continue;
    report.push({
      caseSetId: row.case_set_id,
      componentId: row.component_id,
      designSystem: row.design_system,
      createdAt: row.created_at,
      caseCount: row.case_count,
      cases,
    });
  }
  db.close();
  return report;
}

/** Живое измерение на новой семантике: кандидат + ран по конкретному набору. */
async function measure(report) {
  const client = createEasyUiClient({
    apiBase: `${serverUrl.replace(/\/$/, "")}/api`,
    credentials: easyUiCredentials(),
  });
  const call = async (path, init) => {
    const response = await client.request(path, init);
    const text = await response.text();
    try { return { status: response.status, body: JSON.parse(text) }; }
    catch { return { status: response.status, body: text }; }
  };
  const post = (path, data) => call(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data),
  });

  const candidates = new Map();
  for (const set of report) {
    if (set.error) continue;
    if (!candidates.has(set.componentId)) {
      const created = await post(`/components/${set.componentId}/candidates`, {});
      candidates.set(set.componentId, created.status === 200 ? created.body.candidateId : null);
      if (created.status !== 200) set.measureError = `candidate ${created.status}`;
    }
    const candidateId = candidates.get(set.componentId);
    if (!candidateId) { set.measureError ??= "candidate unavailable"; continue; }
    const started = await post("/acceptance-runs", { candidateId, caseSetId: set.caseSetId, refresh: "all" });
    if (started.status !== 202) { set.measureError = `run ${started.status}`; continue; }
    let view = null;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      view = await call(`/acceptance-runs/${started.body.runId}`);
      if (!["queued", "running"].includes(view.body?.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const cases = await call(`/acceptance-runs/${started.body.runId}/cases`);
    for (const item of cases.body?.cases ?? []) {
      const target = set.cases.find((entry) => entry.caseId === item.caseId);
      if (!target) continue;
      const gate = (item.gates ?? []).find((candidate) => candidate.gate === "geometry");
      const measured = gate?.metrics?.layoutBounds ?? null;
      target.measured = measured ? { width: measured.width, height: measured.height } : null;
      // W1b: безусловные замеры кадра — их и предстоит объявлять поверхностями.
      const root = gate?.metrics?.rootBounds ?? null;
      target.measuredRoot = root ? { width: root.width, height: root.height } : null;
      target.measuredReferenceExport = gate?.metrics?.referenceExportDims ?? null;
      target.rootClip = gate?.metrics?.rootClip ?? null;
      target.geometryStatus = gate?.status ?? null;
      target.delta = measured && target.expectedGeometry
        ? { width: measured.width - target.expectedGeometry.width, height: measured.height - target.expectedGeometry.height }
        : null;
    }
  }
}

const report = inventory();
if (serverUrl) await measure(report);

if (asJson) {
  console.log(JSON.stringify({ db: dbPath, measured: Boolean(serverUrl), caseSets: report }, null, 2));
} else {
  const affectedCases = report.reduce((total, set) => total + (set.cases?.length ?? 0), 0);
  const byClass = new Map();
  for (const set of report) for (const entry of set.cases ?? []) {
    for (const risk of entry.risks ?? [entry.risk]) byClass.set(risk, (byClass.get(risk) ?? 0) + 1);
  }
  console.log(`db: ${dbPath}`);
  console.log(`затронутых case-set'ов: ${report.length}, случаев: ${affectedCases}`);
  for (const [risk, count] of [...byClass].sort()) console.log(`  ${risk}: ${count}`);
  for (const set of report) {
    if (set.error) { console.log(`- ${set.caseSetId} (${set.componentId}): ${set.error}`); continue; }
    console.log(`\n- ${set.caseSetId}  component=${set.componentId}  ds=${set.designSystem}  created=${set.createdAt}`);
    if (set.measureError) console.log(`  измерение недоступно: ${set.measureError}`);
    for (const entry of set.cases) {
      const declared = entry.expectedGeometry ? `${entry.expectedGeometry.width}×${entry.expectedGeometry.height}` : "—";
      const measured = entry.measured ? `${entry.measured.width}×${entry.measured.height}` : "—";
      const delta = entry.delta ? ` Δ=${entry.delta.width >= 0 ? "+" : ""}${entry.delta.width}×${entry.delta.height >= 0 ? "+" : ""}${entry.delta.height}` : "";
      const gate = entry.geometryStatus ? ` geometry=${entry.geometryStatus}` : "";
      console.log(`    ${entry.caseId}: ${(entry.risks ?? [entry.risk]).join("+")}  expected=${declared}  measured=${measured}${delta}${gate}`
        + (entry.referenceSurface ? `  referenceSurface=${entry.referenceSurface}` : "")
        + (entry.expectedSurfaces ? `  expectedSurfaces=${Object.keys(entry.expectedSurfaces).join(",")}` : "")
        + (entry.clipExpectation ? `  clipExpectation=${entry.clipExpectation}` : ""));
      if (entry.measuredRoot || entry.measuredReferenceExport) {
        const root = entry.measuredRoot ? `${entry.measuredRoot.width}×${entry.measuredRoot.height}` : "—";
        const exported = entry.measuredReferenceExport ? `${entry.measuredReferenceExport.width}×${entry.measuredReferenceExport.height}` : "—";
        console.log(`        root=${root}  referenceExport=${exported}${entry.rootClip ? `  rootClip=${entry.rootClip.property}` : ""}`);
      }
    }
  }
  if (!serverUrl) console.log("\n(измерение не запускалось: передайте --server-url для dry-run на новой семантике)");
}
