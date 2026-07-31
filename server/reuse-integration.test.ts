import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { createTestHandler } from "./test-auth";
import { BOOTSTRAP_ADMIN_ID, ensureBootstrapAdmin } from "./users";
import { capabilities, routeMeta } from "./routes/meta";
import { libraryCatalog } from "./routes/libraryCatalog";
import { searchComponents } from "../src/library/libraryModel";

/**
 * Интеграционные сценарии reuse-гейта — план 2026-07-31 §4 «Волна 4 → T9», спека §10
 * («Integration») и отступление **D8**.
 *
 * Отличие от соседних файлов волны намеренное и определяет, что здесь уместно:
 *
 * - `server/reuse-gate.test.ts` проверяет **решения** гейта на одном роуте;
 * - `server/catalog-candidates.test.ts` — **корпус** и discovery-роут;
 * - `server/driver-cli.test.ts` — **форму вывода** CLI;
 * - здесь проверяется, что из этих частей складывается рабочий цикл агента: найти → переиспользовать,
 *   и что обе двери в каталог (сырой HTTP и `driver.mjs`) заперты **одинаково**.
 *
 * Поэтому сервер поднимается настоящий (`Bun.serve`): CLI обязан ходить по сети, а «сырой HTTP»
 * должен быть именно HTTP, а не вызовом хендлера в процессе.
 */

const driver = resolve(".claude/skills/author/driver.mjs");

const servers: Bun.Server<unknown>[] = [];
const databases: Database[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function setup(): Promise<{ db: Database; directory: string; api: string }> {
  const directory = await mkdtemp(resolve(process.cwd(), ".reuse-integration-test-"));
  directories.push(directory);
  const db = openDatabase(":memory:");
  databases.push(db);
  await ensureBootstrapAdmin(db, { name: "Reuse Admin", password: "reuse-test-password" });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createTestHandler(db, { dataDir: directory }) });
  servers.push(server);
  return { db, directory, api: `http://127.0.0.1:${server.port}/api` };
}

/**
 * Соседи по каталогу сидятся прямо в БД: настоящая публикация — subprocess-извлечение плюс
 * typecheck и сборка на каждый компонент, а гейт зависит только от строк
 * `components`/`component_revisions`/`component_publishes`. Создаваемый артефакт, наоборот,
 * всегда идёт настоящим путём — проверяется именно он.
 */
interface SeedOptions {
  source: string;
  description: string;
  designSystem?: string;
  atomicLevel?: string;
  events?: string[];
  canonicalFor?: string[];
}
function seedComponent(db: Database, id: string, name: string, options: SeedOptions): void {
  const designSystem = options.designSystem ?? "yandex-pay";
  db.query("INSERT INTO components (id,name,head_rev,design_system,deleted_at,owner_id,created_at,updated_at) VALUES (?,?,1,?,NULL,?,'now','now')")
    .run(id, name, designSystem, BOOTSTRAP_ADMIN_ID);
  db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES (?,1,?,?,'now')")
    .run(id, options.source, designSystem);
  const meta = {
    description: options.description,
    events: options.events ?? [],
    slots: [],
    propsJsonSchema: { type: "object", properties: { label: { type: "string" } } },
    canonicalFor: options.canonicalFor ?? [],
    ...(options.atomicLevel === undefined ? {} : { atomicLevel: options.atomicLevel }),
  };
  db.query(`INSERT INTO component_publishes (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,published_at)
    VALUES (?,1,1,'active','export default () => null;',?,?,?,4,'now')`)
    .run(id, JSON.stringify(meta), `sh-${id}`, `bh-${id}`);
}

/** Валидный TSX: путь create проходит настоящий `checkSource`, а не мок. */
async function writeComponentSource(directory: string, name: string, description: string, marker: string): Promise<string> {
  const path = resolve(directory, `${name}-${marker}.tsx`);
  await Bun.write(path, `import { z } from "zod";
export const definition = { props: z.strictObject({ label: z.string().optional() }), description: ${JSON.stringify(description)}, atomicLevel: "atom" as const, events: ["press"], slots: [] };
export default function ${name}({ props }: any) { return <button data-marker=${JSON.stringify(marker)}>{props.label ?? ${JSON.stringify(marker)}}</button>; }
`);
  return path;
}

async function runDriver(api: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn({
    cmd: ["node", driver, ...args],
    cwd: process.cwd(),
    env: { ...process.env, EASYUI_API: api, EASYUI_LEGACY_BASIC_AUTH: "", EASYUI_USERNAME: "Reuse Admin", EASYUI_PASSWORD: "reuse-test-password" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode, stdout, stderr };
}

const postJson = (api: string, path: string, body: unknown) =>
  fetch(`${api}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

interface DecisionRow { id: string; decision: string; actor_id: string | null; artifact_id: string; reason: string | null; gate_mode: string; intent: string | null; policy_version: number }
const decisionsFor = (db: Database, artifactId: string): DecisionRow[] =>
  db.query("SELECT id,decision,actor_id,artifact_id,reason,gate_mode,intent,policy_version FROM catalog_reuse_decisions WHERE artifact_id=? ORDER BY created_at").all(artifactId) as DecisionRow[];

// ───────────────────────────── capabilities ─────────────────────────────

describe("GET /api/capabilities: фаза гейта", () => {
  /**
   * Фаза обязана быть читаемой **до** create: в `shadow` запрос без `intent` проходит с
   * предупреждением, в `enforce` тот же запрос — `400 invalid_request`. Без этого поля
   * единственный способ узнать фазу — сломать собственное создание компонента (ровно так
   * фаза и выяснялась в прод-инциденте 2026-07-31).
   */
  test("режим и intentRequired приезжают параметром, а не из env", async () => {
    const { db } = await setup();

    expect(capabilities(db, "enforce")).toMatchObject({ reuseGate: { mode: "enforce", intentRequired: true, policyVersion: 1 } });
    expect(capabilities(db, "shadow")).toMatchObject({ reuseGate: { mode: "shadow", intentRequired: false, policyVersion: 1 } });
    // Гейт как факт существования — там же, где остальные фичи discovery.
    expect((capabilities(db, "shadow") as { features: Record<string, boolean> }).features.componentReuseGate).toBe(true);

    // Дефолт кода — `enforce` (`DEFAULT_REUSE_GATE_MODE`): безопасное состояние прод-деплоя
    // задаётся переменной `REUSE_GATE`, а не отсутствием параметра.
    expect(capabilities(db)).toMatchObject({ reuseGate: { mode: "enforce", intentRequired: true } });
  });

  /**
   * Роут читает режим из аргумента и никогда из `process.env`: иначе discovery и сам гейт стали
   * бы двумя источниками истины, а тесты в общем процессе `bun test` мутировали бы друг другу
   * глобальный env (план §3.5).
   *
   * Проброс `HandlerOptions → routeMeta` вносит терминальная T4′, поэтому режим здесь подаётся
   * прямым вызовом роута — тот же приём, что в `server/reuse-gate.test.ts` для `routeComponents`.
   */
  test("routeMeta отдаёт переданный режим и не ходит в process.env", async () => {
    const { db } = await setup();
    const request = new Request("http://test/api/capabilities");
    const previous = process.env.REUSE_GATE;
    process.env.REUSE_GATE = "shadow";
    try {
      const body = await routeMeta(request, db, ["capabilities"], "enforce")!.json() as { reuseGate: { mode: string; intentRequired: boolean; policyVersion: number } };
      expect(body.reuseGate).toEqual({ mode: "enforce", intentRequired: true, policyVersion: 1 });
    } finally {
      if (previous === undefined) delete process.env.REUSE_GATE; else process.env.REUSE_GATE = previous;
    }
  });

  test("живой GET /api/capabilities несёт reuseGate целиком", async () => {
    const { api } = await setup();
    const body = await (await fetch(`${api}/capabilities`)).json() as { reuseGate: { mode: string; intentRequired: boolean; policyVersion: number }; features: Record<string, boolean> };
    expect(Object.keys(body.reuseGate).sort()).toEqual(["intentRequired", "mode", "policyVersion"]);
    expect(["shadow", "enforce"]).toContain(body.reuseGate.mode);
    expect(body.reuseGate.intentRequired).toBe(body.reuseGate.mode === "enforce");
    expect(body.features.componentReuseGate).toBe(true);
  });
});

// ───────────────────────────── сценарий 1: переиспользование ─────────────────────────────

describe("агентский цикл: найти и переиспользовать", () => {
  /**
   * Спека §10: «an agent-style test searches, reuses a candidate, and publishes a prototype
   * without creating a component». Ценность сценария — в отрицательном утверждении: пройдя
   * discovery до конца, агент **не создаёт** ни компонента, ни единой записи аудита, потому что
   * гейт стоит только на create.
   */
  test("поиск по intent → чтение версии → прототип на существующем компоненте, без create", async () => {
    const { db, api, directory } = await setup();
    const source = await Bun.file(await writeComponentSource(directory, "IntPayButton", "Кнопка оплаты заказа с индикатором загрузки", "reuse")).text();
    seedComponent(db, "int-pay-button", "IntPayButton", { source, description: "Кнопка оплаты заказа с индикатором загрузки", atomicLevel: "atom", events: ["press"] });

    // 1. Агент ищет по продуктовой задаче, а не по имени файла.
    const search = await fetch(`${api}/catalog/candidates?designSystem=yandex-pay&intent=${encodeURIComponent("оплата заказа кнопкой в карточке")}&limit=5`);
    expect(search.status).toBe(200);
    const found = await search.json() as { catalogRevision: string; candidates: { id: string; name: string }[] };
    expect(found.candidates[0]).toMatchObject({ id: "int-pay-button", name: "IntPayButton" });

    // 2. Читает точное определение выбранного кандидата — компактный ответ поиска схем не несёт.
    const version = await (await fetch(`${api}/components/int-pay-button/versions/1`)).json() as { propsJsonSchema?: unknown; events: string[] };
    expect(version.propsJsonSchema).toBeDefined();
    expect(version.events).toEqual(["press"]);

    // 3. Собирает прототип на найденном компоненте и публикует его.
    const doc = {
      version: 1, id: "int-reuse-flow", name: "Reuse flow", designSystem: "yandex-pay", device: "mobile", startScreen: "home", state: {},
      screens: [{ id: "home", name: "Home", spec: { root: "cta", elements: { cta: { type: "IntPayButton", props: { label: "Оплатить" } } } } }],
    };
    const created = await postJson(api, "/prototypes", { doc, message: "reuse existing component" });
    expect(created.status).toBe(201);
    const published = await postJson(api, "/prototypes/int-reuse-flow/publish", { baseRev: 1, message: "v1" });
    expect(published.status).toBe(201);
    expect(await published.json()).toMatchObject({ version: 1 });

    // Итог сценария: компонент переиспользован — пин есть, нового компонента нет.
    expect(db.query("SELECT component_id id, component_version version FROM prototype_revision_components WHERE prototype_id='int-reuse-flow'").all())
      .toEqual([{ id: "int-pay-button", version: 1 }]);
    expect((db.query("SELECT COUNT(*) count FROM components").get() as { count: number }).count).toBe(1);
    // Гейт стоит на create: путь переиспользования не пишет в append-only аудит вообще ничего.
    expect((db.query("SELECT COUNT(*) count FROM catalog_reuse_decisions").get() as { count: number }).count).toBe(0);
  });
});

// ───────────────────────────── сценарий 2: обе двери заперты ─────────────────────────────

describe("дубликат блокируется обеими дверьми", () => {
  /**
   * Спека §10: «an agent-style duplicate attempt is blocked through both driver and raw API».
   * Смысл — не в двух зелёных проверках, а в том, что решение принимает **сервер**: CLI не
   * добавляет к нему ни собственного правила, ни собственной лазейки. Поэтому обе попытки
   * сверяются между собой (один и тот же код, один и тот же blocking-кандидат), а не только с
   * ожиданием по отдельности.
   */
  test("сырой HTTP и driver.mjs получают один и тот же терминальный отказ", async () => {
    const { db, api, directory } = await setup();
    const sourcePath = await writeComponentSource(directory, "IntCheckoutCard", "Карточка оплаты заказа в чекауте", "duplicate");
    const source = await Bun.file(sourcePath).text();
    seedComponent(db, "int-existing-card", "IntExistingCard", { source, description: "Карточка оплаты заказа в чекауте", atomicLevel: "atom", events: ["press"] });
    const intent = "показать карточку оплаты заказа в чекауте";

    // Дверь 1 — сырой HTTP, в обход discovery. Пропуск поиска ничего не даёт: сервер выполняет
    // тот же матчинг сам, внутри транзакции создания.
    const raw = await postJson(api, "/components", { designSystem: "yandex-pay", id: "int-raw-duplicate", name: "IntRawDuplicate", source, intent });
    expect(raw.status).toBe(409);
    const rawError = (await raw.json() as { error: { code: string; retryable: boolean; decisionId: string; candidates: { id: string; blocking: boolean }[] } }).error;
    expect(rawError).toMatchObject({ code: "component_reuse_required", retryable: false });
    expect(rawError.candidates.filter((candidate) => candidate.blocking).map((candidate) => candidate.id)).toEqual(["int-existing-card"]);

    // Дверь 2 — задокументированный путь агента. Отказ обязан быть терминальным: exit 2,
    // `stop: true`, без авто-ретрая.
    const cli = await runDriver(api, ["component", "int-cli-duplicate", "IntCliDuplicate", sourcePath, "--design-system", "yandex-pay", "--intent", intent, "--json"]);
    expect(cli.exitCode).toBe(2);
    const cliPayload = JSON.parse(cli.stdout) as { created: boolean; stop: boolean; code: string; decisionId: string | null; candidates: { id: string }[] };
    expect(cliPayload).toMatchObject({ created: false, stop: true, code: rawError.code });
    expect(cliPayload.candidates.map((candidate) => candidate.id)).toContain("int-existing-card");

    // Ни одна из дверей не оставила артефакта…
    expect((db.query("SELECT COUNT(*) count FROM components").get() as { count: number }).count).toBe(1);
    for (const id of ["int-raw-duplicate", "int-cli-duplicate"]) {
      expect((await fetch(`${api}/components/${id}`)).status).toBe(404);
      // …и обе наблюдаемы одинаково: по одной атрибутируемой `blocked`-записи на попытку.
      const rows = decisionsFor(db, id);
      expect(rows.map((row) => row.decision)).toEqual(["blocked"]);
      expect(rows[0]).toMatchObject({ actor_id: BOOTSTRAP_ADMIN_ID, gate_mode: "enforce", intent, reason: "component_reuse_required" });
    }
    // `decisionId` из CLI ссылается на ту самую строку аудита: эскалация к админу должна вести
    // к конкретному решению, а не к «где-то была блокировка».
    expect(cliPayload.decisionId).toBe(decisionsFor(db, "int-cli-duplicate")[0]!.id);
    expect(rawError.decisionId).toBe(decisionsFor(db, "int-raw-duplicate")[0]!.id);
  }, 60_000);
});

// ───────────────────────────── сценарий 3: force-new ─────────────────────────────

describe("админский force-new", () => {
  /**
   * Спека §10: «an admin force-new creates one attributable audit record». Проверяется именно
   * **ровно одна** запись: двухфазность (кандидаты → override) не должна оставлять следа за
   * фазу чтения, а причина обязана сохраниться дословно — иначе выборка «кто и почему обошёл
   * гейт» (T10) читает домыслы.
   */
  test("двухфазный override даёт ровно одну запись force_new с человеческой причиной", async () => {
    const { db, api, directory } = await setup();
    const sourcePath = await writeComponentSource(directory, "IntForcedCard", "Карточка оплаты заказа для эксперимента", "forced");
    const source = await Bun.file(sourcePath).text();
    seedComponent(db, "int-forced-existing", "IntForcedExisting", { source, description: "Карточка оплаты заказа для эксперимента", atomicLevel: "atom", events: ["press"] });
    const intent = "карточка оплаты заказа для эксперимента с новой анимацией";

    // Фаза 1 — чтение: source-backed поиск отдаёт авторитетный набор ключей и ревизию каталога.
    const discovery = await (await postJson(api, "/catalog/candidates", {
      designSystem: "yandex-pay", intent,
      proposed: { kind: "component", id: "int-forced-new", name: "IntForcedNew", source },
    })).json() as { catalogRevision: string; overrideTemplate?: { catalogRevision: string; candidateKeys: string[] } };
    expect(discovery.overrideTemplate?.candidateKeys).toEqual(["component:yandex-pay:int-forced-existing"]);
    // Фаза чтения ничего не решает и потому ничего не пишет: иначе `repeatedAttempts` врал бы.
    expect((db.query("SELECT COUNT(*) count FROM catalog_reuse_decisions").get() as { count: number }).count).toBe(0);

    // Фаза 2 — решение человека, переданное сервером как override.
    const reason = "Продукт согласовал отдельный экспериментальный вариант карточки оплаты";
    const forced = await postJson(api, "/components", {
      designSystem: "yandex-pay", id: "int-forced-new", name: "IntForcedNew", source, intent,
      reuseOverride: { catalogRevision: discovery.overrideTemplate!.catalogRevision, candidateKeys: discovery.overrideTemplate!.candidateKeys, reason },
    });
    expect(forced.status).toBe(201);

    const rows = decisionsFor(db, "int-forced-new");
    expect(rows.map((row) => row.decision)).toEqual(["force_new"]);
    expect(rows[0]).toMatchObject({ actor_id: BOOTSTRAP_ADMIN_ID, gate_mode: "enforce", intent, reason, policy_version: 1 });
    // Ровно одна запись **на весь каталог**: обход гейта нельзя размазать по нескольким строкам.
    expect((db.query("SELECT COUNT(*) count FROM catalog_reuse_decisions").get() as { count: number }).count).toBe(1);
  }, 60_000);
});

// ───────────────────────────── инвариант D8 ─────────────────────────────

describe("инвариант D8 (обратный)", () => {
  /**
   * Отступление **D8**: прямое включение из спеки («search results match Library results»)
   * ложно — `searchComponents` (`src/library/libraryModel.ts`) отбрасывает всё с `score === 0`
   * по токенам имени/описания, поэтому структурный дубликат с другим именем в выдаче библиотеки
   * отсутствует, и матчер обязан быть **шире** библиотеки, а не равен ей.
   *
   * Проверяется обратное включение: топ-N библиотеки для того же intent ⊆ кандидаты матчера при
   * `limit = N + k`. Оно и важно агенту: поиск не теряет ничего из того, что видит человек.
   */
  test("топ-N библиотеки для intent ⊆ кандидаты матчера при limit = N + k", async () => {
    const { db, api } = await setup();
    const rows: [id: string, name: string, description: string][] = [
      ["int-pay-button", "IntPayButton", "Кнопка оплаты заказа: запускает платёж и показывает спиннер"],
      ["int-pay-sheet", "IntPaySheet", "Шторка оплаты заказа со списком карт"],
      ["int-pay-status", "IntPayStatus", "Экран статуса оплаты заказа после платежа"],
      ["int-avatar", "IntAvatar", "Аватар пользователя с инициалами"],
      ["int-separator", "IntSeparator", "Горизонтальный разделитель между блоками списка"],
      ["int-map", "IntMap", "Карта с пином точки самовывоза"],
      ["int-toast", "IntToast", "Всплывающее уведомление в нижней части экрана"],
      ["int-stepper", "IntStepper", "Счётчик количества товара с плюсом и минусом"],
    ];
    for (const [id, name, description] of rows) {
      seedComponent(db, id, name, { description, source: `export const definition = { description: "${description}" };\nexport default function ${name}() { return <div className="${id}" />; }\n` });
    }

    // Запрос в словоформе описаний: и библиотека, и матчер сравнивают токены как подстроки,
    // без стемминга (`src/library/text.ts`) — «оплата» не является подстрокой «оплаты».
    const intent = "оплаты заказа";
    const N = 3;
    const k = 3;

    // Человек в библиотеке: тот же каталог, тот же запрос.
    const library = libraryCatalog(db, "yandex-pay").components;
    const libraryTop = searchComponents(library, intent).slice(0, N).map((entry) => entry.id);
    expect(libraryTop).toHaveLength(N);

    // Агент через матчер: та же задача, только limit шире на k.
    const candidates = await (await fetch(`${api}/catalog/candidates?designSystem=yandex-pay&intent=${encodeURIComponent(intent)}&limit=${N + k}`)).json() as { candidates: { id: string }[] };
    const candidateIds = candidates.candidates.map((candidate) => candidate.id);
    expect(candidateIds.length).toBeLessThanOrEqual(N + k);
    expect(candidateIds).toEqual(expect.arrayContaining(libraryTop));

    // И причина, по которой инвариант развёрнут: обратное включение неверно — матчер шире.
    // Компонент, которого нет в выдаче библиотеки для этого запроса, у матчера присутствует.
    const missingInLibrary = candidateIds.filter((id) => !searchComponents(library, intent).map((entry) => entry.id).includes(id));
    expect(missingInLibrary.length).toBeGreaterThan(0);
  });
});
