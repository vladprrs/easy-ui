#!/usr/bin/env node
/* global process, setTimeout */
/**
 * Массовая пересъёмка визуальных эталонов под текущий рендерер
 * (план `docs/plans/2026-08-03-renderer-contract-2.md` §5 **R6**, N11, §7).
 *
 * Зачем инструмент существует. Включение детерминизм-флагов (`EASYUI_RENDERER_FLAGS=1`) меняет
 * растр: все эталоны, снятые до него, становятся неприменимыми. Guard R6 честно отвечает на это
 * `stale_renderer` вместо ложного процента, но продукту нужен способ **вернуть зелёный** —
 * переснять эталоны на новом рендерере. Без такого инструмента component-scope эталоны (их
 * пишет только generic `PUT /api/visual-references`) остались бы stale навсегда (V-N3).
 *
 * Что делает:
 * 1. **Инвентаризация** обоих scope (`--dry-run` печатает числа и ничего не меняет) — это
 *    предпосылка прод-включения флагов по §7: сколько эталонов, у скольких известен рендерер,
 *    сколько из них уже текущей эпохи.
 * 2. **Пересъёмка** `prototype-screen` через существующий baseline-путь
 *    (`POST /prototypes/:id/screens/:screenId/screenshot` → `PUT /visual-baselines/prototypes/:id`)
 *    — набор эталонов прототипа атомарен и живёт поколениями, поэтому переснимать его поштучно
 *    нельзя;
 * 3. **Пересъёмка** `component` через generic `PUT /api/visual-references` с тем же отпечатком.
 *
 * Три инварианта реализации:
 * - **V-N8 (ревизия при приёмке R6)**: `receiptSha256` берётся прямо из `JobStatus.result` и
 *   передаётся в PUT (`receiptSha256` / `receipts`), но факты рендерера резолвит СЕРВЕР в момент
 *   PUT — инлайн-приём renderer-блока от клиента отвергнут (spoofing provenance эталона).
 *   Устойчивость к вытеснению receipt'ов до commit'а обеспечивают пин живых джоб + троттлинг GC
 *   стора и **пост-PUT верификация здесь**: NULL `renderer_json` → одна свежая пересъёмка
 *   (component-scope) и ненулевой exit с WARNING при остатке — молчаливого stale_renderer нет.
 * - **Rate limit**: капчуры идут строго последовательно, с паузой между ними (`--delay-ms`).
 *   Конкуренция capture на сервере равна 1, а очередь делится с фоновой приёмкой
 *   (`BACKGROUND_QUEUE_RESERVE`): распараллеленная пересъёмка просто получала бы `queue_full` и
 *   вытесняла бы чужие раны.
 * - **Идемпотентность по поколениям**: `baseGeneration` читается непосредственно перед PUT;
 *   409 не ретраится (кто-то коммитил параллельно) — прототип помечается `conflict` и работа
 *   продолжается со следующим. Повторный запуск скрипта доснимет пропущенное.
 *
 * Запуск:
 *   node scripts/rebaseline-all.mjs --api https://easy-ui.pay-offline.ru/api --dry-run
 *   node scripts/rebaseline-all.mjs --api http://127.0.0.1:8787/api [--scope prototype|component]
 *                                   [--prototype <id>] [--component <id>] [--delay-ms 250]
 *                                   [--limit N] [--json]
 *
 * Аутентификация — канон `scripts/easyui-auth.mjs` (env `EASYUI_USERNAME`/`EASYUI_PASSWORD`,
 * опционально `EASYUI_BASIC_AUTH`). Мутации требуют заголовка `Origin` — его ставит клиент.
 */
import { createEasyUiClient } from "./easyui-auth.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const has = (name) => args.includes(`--${name}`);

const API = flag("api", process.env.EASYUI_API ?? "http://127.0.0.1:8787/api").replace(/\/$/, "");
const DRY_RUN = has("dry-run");
const JSON_MODE = has("json");
const SCOPE = flag("scope", "both");
const ONLY_PROTOTYPE = flag("prototype", null);
const ONLY_COMPONENT = flag("component", null);
const DELAY_MS = Number(flag("delay-ms", "250"));
const LIMIT = Number(flag("limit", "0"));
const JOB_DEADLINE_MS = 180_000;

const client = createEasyUiClient({ apiBase: API });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => { if (!JSON_MODE) console.error(message); };

async function api(method, path, body) {
  const response = await client.request(path, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* не-JSON ответ остаётся null */ }
  return { status: response.status, json, text };
}

const ok = (label, response, allowed = [200]) => {
  if (!allowed.includes(response.status)) {
    throw new Error(`${label}: HTTP ${response.status} ${response.text.slice(0, 500)}`);
  }
  return response.json;
};

/** Ждёт терминального состояния джобы; `queue_full` на постановке — уважение чужой очереди. */
async function pollJob(jobId) {
  const deadline = Date.now() + JOB_DEADLINE_MS;
  for (;;) {
    const state = ok("screenshot-job", await api("GET", `/screenshot-jobs/${encodeURIComponent(jobId)}`));
    if (state.status === "done" || state.status === "error") return state;
    if (Date.now() > deadline) throw new Error(`screenshot job ${jobId} did not settle in ${JOB_DEADLINE_MS} ms`);
    await sleep(500);
  }
}

async function capture(path, body) {
  for (let attempt = 0; ; attempt += 1) {
    const queued = await api("POST", path, body);
    if (queued.status === 429 && attempt < 5) {
      // Очередь занята фоном приёмки: ждём, а не давим — конкуренция capture на сервере равна 1.
      await sleep(2_000 * (attempt + 1));
      continue;
    }
    const job = ok(`capture ${path}`, queued, [202]);
    const state = await pollJob(job.jobId);
    if (state.status !== "done" || !state.result?.assetId) {
      throw new Error(`capture ${path}: ${state.status} ${JSON.stringify(state.failure ?? state.error ?? {})}`);
    }
    return { assetId: state.result.assetId, receiptSha256: state.result.receiptSha256 ?? null };
  }
}

/** Инвентаризация: сколько эталонов, у скольких известен рендерер и сколько уже текущей эпохи. */
function inventory(references, epoch) {
  const summary = { total: references.length, withRenderer: 0, currentEpoch: 0, unknown: 0 };
  for (const reference of references) {
    if (reference.renderer?.fingerprint) {
      summary.withRenderer += 1;
      if (epoch !== null && reference.renderer.epoch === epoch) summary.currentEpoch += 1;
    } else summary.unknown += 1;
  }
  return summary;
}

async function rebaselinePrototype(prototypeId) {
  const current = await api("GET", `/visual-baselines/prototypes/${encodeURIComponent(prototypeId)}`);
  if (current.status === 404) return { prototypeId, status: "skipped", reason: "baseline_not_found", members: 0 };
  const set = ok("baseline read", current);
  const captures = new Map();
  const receipts = {};
  for (const member of set.members) {
    const shot = await capture(`/prototypes/${encodeURIComponent(prototypeId)}/screens/${encodeURIComponent(member.screenId)}/screenshot`, {
      rev: set.rev, viewport: member.viewport, deviceScaleFactor: member.deviceScaleFactor, theme: member.theme,
    });
    captures.set(member.screenId, shot.assetId);
    if (shot.receiptSha256) receipts[shot.assetId] = shot.receiptSha256;
    await sleep(DELAY_MS);
  }
  // Поколение перечитывается перед самым PUT: между началом пересъёмки и коммитом могли
  // закоммитить эталоны руками, и затирать чужое поколение молча нельзя.
  const before = ok("baseline read", await api("GET", `/visual-baselines/prototypes/${encodeURIComponent(prototypeId)}`));
  const response = await api("PUT", `/visual-baselines/prototypes/${encodeURIComponent(prototypeId)}`, {
    rev: before.rev,
    prototypeInstanceId: before.prototypeInstanceId,
    baseGeneration: before.generation,
    members: before.members.map((member) => ({
      screenId: member.screenId, viewport: member.viewport, deviceScaleFactor: member.deviceScaleFactor,
      theme: member.theme, assetId: captures.get(member.screenId),
    })),
    receipts,
  });
  if (response.status === 409) return { prototypeId, status: "conflict", reason: response.json?.error?.code ?? "generation_conflict", members: 0 };
  const committed = ok("baseline commit", response);
  // V-N8: renderer-блок резолвится сервером в момент PUT (авторитет — сервер, инлайн-приём
  // renderer-блока от клиента отвергнут: это spoofing provenance эталона). Значит единственный
  // честный контроль — пост-PUT верификация: если receipt успел вытесниться и renderer_json
  // остался NULL, это видно немедленно, а не после включения флагов как stale_renderer.
  const after = ok("references re-read", await api("GET", "/visual-references")).references;
  const mine = after.filter((item) => item.fingerprint?.scope === "prototype-screen" && item.fingerprint?.prototypeId === prototypeId);
  const nullRenderer = mine.filter((item) => item.renderer === null).length;
  return { prototypeId, status: "rebaselined", generation: committed.generation, members: committed.members.length, nullRenderer };
}

async function rebaselineComponentReference(reference, attempt = 1) {
  const fp = reference.fingerprint;
  const shot = await capture(`/components/${encodeURIComponent(fp.componentId)}/versions/${fp.refVersion}/screenshot`, {
    viewport: fp.viewport, deviceScaleFactor: fp.deviceScaleFactor, theme: fp.theme,
  });
  const response = await api("PUT", "/visual-references", {
    fingerprint: fp,
    assetId: shot.assetId,
    ...(reference.note === null ? {} : { note: reference.note }),
    ...(shot.receiptSha256 === null ? {} : { receiptSha256: shot.receiptSha256 }),
  });
  if (response.status === 409) return { referenceId: reference.id, status: "skipped", reason: response.json?.error?.code ?? "baseline_managed" };
  const row = ok("reference upsert", response);
  // V-N8 пост-PUT контроль: сервер не смог резолвнуть receipt (вытеснен между капчуром и PUT) —
  // одна свежая пересъёмка, свежий receipt точно жив (пин живых джоб + троттлинг GC).
  if (row.renderer === null && attempt === 1) {
    await sleep(DELAY_MS);
    return rebaselineComponentReference(reference, 2);
  }
  return { referenceId: row.id, status: "rebaselined", rendererKnown: row.renderer !== null };
}

async function main() {
  const capabilities = await api("GET", "/capabilities");
  const renderer = capabilities.json?.renderer ?? null;
  const epoch = process.env.EASYUI_RENDERER_EPOCH || renderer?.rendererVersion || null;

  const references = ok("references", await api("GET", "/visual-references")).references;
  const prototypeRefs = references.filter((item) => item.fingerprint?.scope === "prototype-screen");
  const componentRefs = references.filter((item) => item.fingerprint?.scope === "component");
  const report = {
    api: API,
    epoch,
    rendererFingerprint: renderer?.fingerprint ?? null,
    inventory: {
      "prototype-screen": inventory(prototypeRefs, epoch),
      component: inventory(componentRefs, epoch),
    },
    dryRun: DRY_RUN,
    prototypes: [],
    components: [],
    errors: [],
  };

  if (DRY_RUN) {
    if (!JSON_MODE) {
      console.log(`renderer epoch: ${epoch ?? "unknown"} (fingerprint ${report.rendererFingerprint ?? "unknown"})`);
      for (const [scope, stats] of Object.entries(report.inventory)) {
        console.log(`${scope}: total=${stats.total} withRenderer=${stats.withRenderer} currentEpoch=${stats.currentEpoch} unknown=${stats.unknown}`);
      }
    } else console.log(JSON.stringify(report));
    return 0;
  }

  if (SCOPE !== "component") {
    const ids = [...new Set(prototypeRefs.map((item) => item.fingerprint.prototypeId))]
      .filter((id) => ONLY_PROTOTYPE === null || id === ONLY_PROTOTYPE);
    for (const [index, prototypeId] of ids.entries()) {
      if (LIMIT > 0 && index >= LIMIT) break;
      log(`prototype ${prototypeId} (${index + 1}/${ids.length})`);
      try { report.prototypes.push(await rebaselinePrototype(prototypeId)); }
      catch (error) { report.errors.push({ prototypeId, message: String(error?.message ?? error) }); }
      await sleep(DELAY_MS);
    }
  }

  if (SCOPE !== "prototype") {
    const targets = componentRefs.filter((item) => ONLY_COMPONENT === null || item.fingerprint.componentId === ONLY_COMPONENT);
    for (const [index, reference] of targets.entries()) {
      if (LIMIT > 0 && index >= LIMIT) break;
      log(`component reference ${reference.id} (${index + 1}/${targets.length})`);
      try { report.components.push(await rebaselineComponentReference(reference)); }
      catch (error) { report.errors.push({ referenceId: reference.id, message: String(error?.message ?? error) }); }
      await sleep(DELAY_MS);
    }
  }

  // V-N8: эталон без renderer_json после пересъёмки — это будущий stale_renderer при включённых
  // флагах; молча заканчиваться успехом здесь нельзя.
  const nullRenderer = report.prototypes.reduce((sum, item) => sum + (item.nullRenderer ?? 0), 0)
    + report.components.filter((item) => item.status === "rebaselined" && item.rendererKnown === false).length;
  report.nullRenderer = nullRenderer;
  if (JSON_MODE) console.log(JSON.stringify(report));
  else {
    console.log(`prototypes rebaselined: ${report.prototypes.filter((item) => item.status === "rebaselined").length}/${report.prototypes.length}`);
    console.log(`component references rebaselined: ${report.components.filter((item) => item.status === "rebaselined").length}/${report.components.length}`);
    if (nullRenderer > 0) console.log(`WARNING: ${nullRenderer} reference(s) committed WITHOUT renderer_json — will read as stale_renderer once flags are on; re-run for the affected targets`);
    for (const error of report.errors) console.log(`error: ${JSON.stringify(error)}`);
  }
  return report.errors.length === 0 && nullRenderer === 0 ? 0 : 2;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exit(1);
});
