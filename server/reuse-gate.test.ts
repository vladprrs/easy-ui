import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { createHandler } from "./main";
import { createTestHandler } from "./test-auth";
import { BOOTSTRAP_ADMIN_ID, UserRepo } from "./users";
import { collectCorpus } from "./catalog/corpus";
import { candidateKey, matchAndDecide, recordBlockedAttempt, ReuseGateRejection, resolveReuseGateMode, synthesizeIntent } from "./catalog/gate";
import { ComponentFingerprintRepo } from "./repos/componentFingerprints";
import { ReuseDecisionRepo } from "./repos/reuseDecisions";
import { routeComponents } from "./routes/components";
import { stagingRoot } from "./components/pipeline";
import type { Principal } from "./auth";

/**
 * Гейт переиспользования на `POST /api/components` — план 2026-07-31 §3.5, спека §4/§9/§10
 * («API/security»).
 *
 * Соседние компоненты корпуса сидятся прямо в БД: настоящая публикация — subprocess-извлечение
 * плюс typecheck и сборка на каждый компонент, а гейт зависит только от строк
 * `components`/`component_revisions`/`component_publishes`. Создаваемый компонент, наоборот,
 * всегда идёт через настоящий HTTP-путь: проверяется именно он.
 *
 * **Фикстуры структурно разные намеренно.** Политика калибрована (`policyVersion 1`, вес
 * исходника 0.75, порог 0.70), поэтому два похожих исходника в одной БД блокируют друг друга.
 */

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();

const RATING_SOURCE = await Bun.file("server/fixtures/rating-stars.tsx").text();
/**
 * Копипаста с переименованным компонентом и переформулированным описанием — ровно тот класс,
 * ради которого гейт и стоит (замер T0: под весами спеки он давал 0.685 и не ловился).
 * `sourceShingles` нормализует локальные идентификаторы, поэтому сигнал исходника здесь 1.0.
 */
const RATING_COPY = RATING_SOURCE
  .replaceAll("RatingStars", "StarRating")
  .replace("An interactive five-star rating", "Пятизвёздочный рейтинг товара в карточке");

/** Структурно другой компонент: другие props, ни одного события, другое тело. */
const badgeSource = (name: string, description: string, extra = "") => `import { z } from "zod";
import type { BaseComponentProps } from "@json-render/react";

export const definition = {
  props: z.strictObject({ label: z.string(), tone: z.enum(["info", "warn"]) }),
  slots: [],
  description: ${JSON.stringify(description)},
  example: { label: "ok", tone: "info" as const },${extra}
};

type Props = z.output<typeof definition.props>;

export default function ${name}({ props }: BaseComponentProps<Props>) {
  return <span data-tone={props.tone} className="badge">{props.label.toUpperCase()}</span>;
}
`;

interface SeedOptions { designSystem: string; source: string; description?: string; meta?: Record<string, unknown>; publish?: boolean }
function seedComponent(db: Database, id: string, name: string, options: SeedOptions): void {
  const { designSystem, source, publish = true } = options;
  db.query("INSERT INTO components (id,name,head_rev,design_system,deleted_at,created_at,updated_at,owner_id) VALUES (?,?,1,?,NULL,?,?,?)")
    .run(id, name, designSystem, at(0), at(0), BOOTSTRAP_ADMIN_ID);
  db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,figma_json,message,created_at) VALUES (?,1,?,?,NULL,NULL,?)")
    .run(id, source, designSystem, at(1));
  if (!publish) return;
  const meta = { description: options.description ?? "", events: [], slots: [], propsJsonSchema: { type: "object", properties: {} }, ...options.meta };
  db.query("INSERT INTO component_publishes (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,message,published_at) VALUES (?,1,1,'active',?,?,?,?,4,NULL,?)")
    .run(id, "export default () => null;", JSON.stringify(meta), `sh-${id}`, `bh-${id}`, at(1));
}

const dbs: Database[] = [];
const dirs: string[] = [];
afterEach(async () => {
  // Гарантия §3.5.7: staging удаляется во **всех** ветках — успех, 409, 422, исключение матчера.
  for (const dir of dirs) {
    const entries = await readdir(stagingRoot(dir)).catch(() => [] as string[]);
    expect({ dir, entries }).toEqual({ dir, entries: [] });
  }
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(): Promise<{ db: Database; dir: string; handler: (request: Request) => Promise<Response> }> {
  const dir = await mkdtemp(resolve(process.cwd(), ".reuse-gate-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  dbs.push(db);
  const handler = createTestHandler(db, { dataDir: dir }) as (request: Request) => Promise<Response>;
  db.query("INSERT INTO design_systems (id,name,description,builtin_provider,retired,created_at,updated_at,owner_id) VALUES ('gate-ds','Gate DS','Gate test system',NULL,0,?,?,?)")
    .run(at(0), at(0), BOOTSTRAP_ADMIN_ID);
  return { db, dir, handler };
}

const create = (handler: (r: Request) => Promise<Response>, body: unknown) =>
  handler(new Request("http://test/api/components", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

const ADMIN: Principal = { kind: "user", userId: BOOTSTRAP_ADMIN_ID, name: "Test Admin", isAdmin: true };
/** Прямой вызов роута: режим `shadow` ещё не пробрасывается через `HandlerOptions` (дельта T4). */
const createWithMode = (db: Database, dir: string, body: unknown, mode: "shadow" | "enforce", principal: Principal = ADMIN) =>
  routeComponents(new Request("http://test/api/components", { method: "POST", headers: { "content-type": "application/json", "user-agent": "gate-test-agent/1.0" }, body: JSON.stringify(body) }), db, ["components"], principal, dir, mode);

interface ErrorBody { error: { code: string; message: string; catalogRevision?: string; decisionId?: string | null; repeatedAttempts?: number | null; retryable?: boolean; resolution?: string; nextSteps?: string[]; conflictingRoles?: string[]; overrideTemplate?: { catalogRevision: string; candidateKeys: string[] }; candidates?: { id: string; key: string; blocking: boolean; score: number; reasons: string[] }[] } }
const errorOf = async (response: Response): Promise<ErrorBody["error"]> => ((await response.json()) as ErrorBody).error;

const componentRows = (db: Database, id: string) => ({
  components: (db.query("SELECT COUNT(*) c FROM components WHERE id=?").get(id) as { c: number }).c,
  revisions: (db.query("SELECT COUNT(*) c FROM component_revisions WHERE component_id=?").get(id) as { c: number }).c,
});

const INTENT = "рейтинг товара звёздами в карточке каталога";

describe("create gate (POST /api/components)", () => {
  /**
   * Спека §10: «a duplicate direct POST is blocked even when the caller skipped the
   * candidate-search endpoint». Матчинг делает сервер, поэтому пропуск discovery ничего не даёт.
   */
  test("дубликат прямым POST блокируется, компонента и ревизии не остаётся", async () => {
    const { db, handler } = await setup();
    seedComponent(db, "gate-rating", "GateRating", { designSystem: "gate-ds", source: RATING_SOURCE, description: "Интерактивный рейтинг пятью звёздами" });

    const response = await create(handler, { designSystem: "gate-ds", id: "gate-star-rating", name: "GateStarRating", source: RATING_COPY, intent: INTENT });
    expect(response.status).toBe(409);
    const error = await errorOf(response);
    expect(error.code).toBe("component_reuse_required");
    expect(error.retryable).toBe(false);
    expect(error.catalogRevision).toBe(collectCorpus(db, "gate-ds").catalogRevision);
    expect(error.candidates!.some((candidate) => candidate.id === "gate-rating" && candidate.blocking)).toBe(true);
    expect(error.overrideTemplate).toEqual({ catalogRevision: error.catalogRevision!, candidateKeys: [candidateKey({ designSystem: "gate-ds", id: "gate-rating" })] });
    expect(error.nextSteps!.length).toBeGreaterThan(0);
    expect(["reuse", "escalate"]).toContain(error.resolution!);
    // Аудит доступен → счётчик считает и текущую попытку, а `decisionId` ссылается на строку.
    expect(error.repeatedAttempts).toBe(1);
    expect(new ReuseDecisionRepo(db).get(error.decisionId!)).toMatchObject({ decision: "blocked", gateMode: "enforce", artifactId: "gate-star-rating" });

    // Ни строки компонента: 409 бросается изнутри транзакции, поэтому откат гарантирован.
    expect(componentRows(db, "gate-star-rating")).toEqual({ components: 0, revisions: 0 });
    expect((await handler(new Request("http://test/api/components/gate-star-rating"))).status).toBe(404);

    // Повторная попытка того же актора наблюдаема — ради неё аудит и пишется best-effort.
    expect((await errorOf(await create(handler, { designSystem: "gate-ds", id: "gate-star-rating", name: "GateStarRating", source: RATING_COPY, intent: INTENT }))).repeatedAttempts).toBe(2);
  });

  test("настоящий новый компонент создаётся: сервер выполнил тот же матчинг внутри", async () => {
    const { db, handler } = await setup();
    seedComponent(db, "gate-rating", "GateRating", { designSystem: "gate-ds", source: RATING_SOURCE, description: "Интерактивный рейтинг пятью звёздами" });

    const response = await create(handler, { designSystem: "gate-ds", id: "gate-badge", name: "GateBadge", source: badgeSource("GateBadge", "Статусный бейдж заказа с тоном оформления"), intent: "бейдж статуса заказа в списке покупок" });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ id: "gate-badge", rev: 1 });

    const decisions = new ReuseDecisionRepo(db).list();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ decision: "accepted_no_match", gateMode: "enforce", artifactId: "gate-badge", policyVersion: 1, intent: "бейдж статуса заказа в списке покупок" });
    // Кэш шинглов заполняется на create: свежий драфт участвует в корпусе с первой проверки.
    expect(new ComponentFingerprintRepo(db).get("gate-badge", 1, decisions[0]!.sourceOrDocHash)).not.toBeUndefined();
  });

  test("в аудит-JSON нет исходника — ни в кандидатах, ни в самой записи", async () => {
    const { db, handler } = await setup();
    seedComponent(db, "gate-rating", "GateRating", { designSystem: "gate-ds", source: RATING_SOURCE, description: "Интерактивный рейтинг пятью звёздами" });
    await create(handler, { designSystem: "gate-ds", id: "gate-star-rating", name: "GateStarRating", source: RATING_COPY, intent: INTENT });

    const raw = JSON.stringify(db.query("SELECT * FROM catalog_reuse_decisions").all());
    for (const secret of ["useState", "z.strictObject", "★", "export default", "BaseComponentProps"]) expect(raw).not.toContain(secret);
    // Имена пропов в `propsDelta` разрешены явно (§3.6) — значения и схемы нет.
    expect(raw).toContain("propsDelta");
  });

  test("прямой POST не может подделать score, кандидатов или решение", async () => {
    const { db, handler } = await setup();
    seedComponent(db, "gate-rating", "GateRating", { designSystem: "gate-ds", source: RATING_SOURCE, description: "Интерактивный рейтинг пятью звёздами" });
    const base = { designSystem: "gate-ds", id: "gate-star-rating", name: "GateStarRating", source: RATING_COPY, intent: INTENT };

    // Аллоу-лист полей: подсунуть кандидатов/score/решение просто некуда.
    for (const forged of [{ candidates: [] }, { score: 0 }, { decision: "accepted_no_match" }, { blocking: false }, { catalogRevision: "deadbeef" }]) {
      const response = await create(handler, { ...base, ...forged });
      expect({ forged, status: response.status, code: (await errorOf(response)).code }).toEqual({ forged, status: 400, code: "invalid_request" });
    }
    // Присланные ключи override не становятся истиной: сервер пересчитывает blocking-набор.
    const bogus = await create(handler, { ...base, reuseOverride: { catalogRevision: collectCorpus(db, "gate-ds").catalogRevision, candidateKeys: ["component:gate-ds:not-a-real-candidate"], reason: "не хочу переиспользовать существующий компонент" } });
    expect(bogus.status).toBe(409);
    expect((await errorOf(bogus)).code).toBe("component_reuse_required");
    expect(componentRows(db, "gate-star-rating")).toEqual({ components: 0, revisions: 0 });
  });

  test("не-админ не может воспользоваться override", async () => {
    const { db, dir } = await setup();
    seedComponent(db, "gate-rating", "GateRating", { designSystem: "gate-ds", source: RATING_SOURCE, description: "Интерактивный рейтинг пятью звёздами" });
    const user = await new UserRepo(db).create({ name: "Gate Author", password: "gate author password", actorId: BOOTSTRAP_ADMIN_ID });
    // Система принадлежит автору: иначе он получил бы 403 forbidden на владении, а проверить
    // нужно именно админский барьер override.
    db.query("UPDATE design_systems SET owner_id=? WHERE id='gate-ds'").run(user.id);
    const session = new UserRepo(db).createSession(user.id);
    const handler = createHandler(db, { dataDir: dir });
    const response = await handler(new Request("http://test/api/components", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://test", cookie: `easyui_session=${session.token}` },
      body: JSON.stringify({ designSystem: "gate-ds", id: "gate-star-rating", name: "GateStarRating", source: RATING_COPY, intent: INTENT, reuseOverride: { catalogRevision: collectCorpus(db, "gate-ds").catalogRevision, candidateKeys: [candidateKey({ designSystem: "gate-ds", id: "gate-rating" })], reason: "у меня свои причины создавать копию" } }),
    }));
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe("admin_required");
    expect(componentRows(db, "gate-star-rating")).toEqual({ components: 0, revisions: 0 });
  });

  test("админский override требует reason, все текущие ключи и совпадающую ревизию", async () => {
    const { db, handler } = await setup();
    seedComponent(db, "gate-rating", "GateRating", { designSystem: "gate-ds", source: RATING_SOURCE, description: "Интерактивный рейтинг пятью звёздами" });
    const base = { designSystem: "gate-ds", id: "gate-star-rating", name: "GateStarRating", source: RATING_COPY, intent: INTENT };
    const revision = collectCorpus(db, "gate-ds").catalogRevision;
    const keys = [candidateKey({ designSystem: "gate-ds", id: "gate-rating" })];

    const short = await create(handler, { ...base, reuseOverride: { catalogRevision: revision, candidateKeys: keys, reason: "надо" } });
    expect({ status: short.status, code: (await errorOf(short)).code }).toEqual({ status: 422, code: "validation_failed" });

    const accepted = await create(handler, { ...base, reuseOverride: { catalogRevision: revision, candidateKeys: keys, reason: "новый компонент нужен для эксперимента с другой анимацией" } });
    expect(accepted.status).toBe(201);
    const decisions = new ReuseDecisionRepo(db).list();
    // Ровно одна атрибутируемая запись force-new (спека §10, интеграционный инвариант).
    expect(decisions.filter((decision) => decision.decision === "force_new")).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ decision: "force_new", actorId: BOOTSTRAP_ADMIN_ID, reason: "новый компонент нужен для эксперимента с другой анимацией" });
    expect(componentRows(db, "gate-star-rating")).toEqual({ components: 1, revisions: 1 });
  });

  test("гонка каталога: устаревшая ревизия в override даёт catalog_changed со свежими кандидатами", async () => {
    const { db, handler } = await setup();
    seedComponent(db, "gate-rating", "GateRating", { designSystem: "gate-ds", source: RATING_SOURCE, description: "Интерактивный рейтинг пятью звёздами" });
    const stale = collectCorpus(db, "gate-ds").catalogRevision;

    // Каталог сдвинулся между подготовкой override и его применением.
    seedComponent(db, "gate-other", "GateOther", { designSystem: "gate-ds", source: badgeSource("GateOther", "Посторонний компонент каталога"), description: "Посторонний компонент каталога" });
    const fresh = collectCorpus(db, "gate-ds").catalogRevision;
    expect(fresh).not.toBe(stale);

    const response = await create(handler, {
      designSystem: "gate-ds", id: "gate-star-rating", name: "GateStarRating", source: RATING_COPY, intent: INTENT,
      reuseOverride: { catalogRevision: stale, candidateKeys: [candidateKey({ designSystem: "gate-ds", id: "gate-rating" })], reason: "готовил override до публикации соседнего компонента" },
    });
    expect(response.status).toBe(409);
    const error = await errorOf(response);
    expect(error.code).toBe("catalog_changed");
    expect(error.catalogRevision).toBe(fresh);
    expect(error.overrideTemplate!.catalogRevision).toBe(fresh);
    expect(componentRows(db, "gate-star-rating")).toEqual({ components: 0, revisions: 0 });
  });

  test("сохранённый драфт участвует в корпусе и блокирует дубликат", async () => {
    const { db, handler } = await setup();
    // Драфт, созданный обычным путём: сначала посторонний исходник, затем PUT с рейтингом.
    expect((await create(handler, { designSystem: "gate-ds", id: "gate-draft", name: "GateDraft", source: badgeSource("GateDraft", "Черновик статусного бейджа заказа"), intent: "черновик бейджа статуса заказа" })).status).toBe(201);
    const saved = await handler(new Request("http://test/api/components/gate-draft", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRev: 1, source: RATING_SOURCE }) }));
    expect(saved.status).toBe(200);
    expect(new ComponentFingerprintRepo(db).count()).toBeGreaterThan(0);

    const corpus = collectCorpus(db, "gate-ds").candidates;
    expect(corpus.map((candidate) => candidate.id)).toEqual(["gate-draft"]);
    expect(corpus[0]).toMatchObject({ draft: true, version: 0 });

    const blocked = await create(handler, { designSystem: "gate-ds", id: "gate-star-rating", name: "GateStarRating", source: RATING_COPY, intent: INTENT });
    expect(blocked.status).toBe(409);
    expect((await errorOf(blocked)).candidates!.some((candidate) => candidate.id === "gate-draft" && candidate.blocking)).toBe(true);
  });

  test("ошибка извлечения остаётся 422 и матчинг не запускает", async () => {
    const { db, handler } = await setup();
    seedComponent(db, "gate-rating", "GateRating", { designSystem: "gate-ds", source: RATING_SOURCE, description: "Интерактивный рейтинг пятью звёздами" });
    const broken = await create(handler, { designSystem: "gate-ds", id: "gate-broken", name: "GateBroken", source: await Bun.file("server/fixtures/no-definition.tsx").text(), intent: "компонент без экспортированного definition" });
    expect(broken.status).toBe(422);
    // Ни одной аудит-записи: матчинг на частичной мете не запускается вовсе (спека §9).
    expect(new ReuseDecisionRepo(db).list()).toEqual([]);
    expect(componentRows(db, "gate-broken")).toEqual({ components: 0, revisions: 0 });
  });

  /** Спека §9: «candidate search failure prevents create; the system never fails open». */
  test("исключение матчера даёт 5xx, компонента не появляется", async () => {
    const { db, dir } = await setup();
    seedComponent(db, "gate-rating", "GateRating", { designSystem: "gate-ds", source: RATING_SOURCE, description: "Интерактивный рейтинг пятью звёздами" });
    // Повреждённая мета активной публикации роняет сборку корпуса изнутри транзакции.
    db.query("UPDATE component_publishes SET definition_meta='{not json' WHERE component_id='gate-rating'").run();
    const handler = createTestHandler(db, { dataDir: dir }) as (request: Request) => Promise<Response>;

    const response = await create(handler, { designSystem: "gate-ds", id: "gate-badge", name: "GateBadge", source: badgeSource("GateBadge", "Статусный бейдж заказа с тоном оформления"), intent: "бейдж статуса заказа в списке покупок" });
    expect(response.status).toBe(500);
    expect(componentRows(db, "gate-badge")).toEqual({ components: 0, revisions: 0 });
    expect(new ReuseDecisionRepo(db).list()).toEqual([]);
  });
});

describe("shadow mode", () => {
  test("не блокирует, но пишет would_block и intent_missing с идентификацией вызывателя", async () => {
    const { db, dir } = await setup();
    seedComponent(db, "gate-rating", "GateRating", { designSystem: "gate-ds", source: RATING_SOURCE, description: "Интерактивный рейтинг пятью звёздами" });

    // intent не прислан: в shadow это допустимо и синтезируется из имени.
    const response = await createWithMode(db, dir, { designSystem: "gate-ds", id: "gate-star-rating", name: "GateStarRating", source: RATING_COPY }, "shadow");
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string; warnings: string[] };
    expect(created.id).toBe("gate-star-rating");
    expect(created.warnings.some((warning) => warning.includes("shadow"))).toBe(true);
    expect(created.warnings.some((warning) => warning.includes("intent"))).toBe(true);
    expect(componentRows(db, "gate-star-rating")).toEqual({ components: 1, revisions: 1 });

    const decisions = new ReuseDecisionRepo(db).list();
    expect(decisions.map((decision) => decision.decision).sort()).toEqual(["intent_missing", "would_block"]);
    for (const decision of decisions) expect(decision).toMatchObject({ gateMode: "shadow", artifactId: "gate-star-rating", intent: null });
    // «Кого чинить» обязано быть в записи: актор плюс user-agent.
    const missing = decisions.find((decision) => decision.decision === "intent_missing")!;
    expect(missing.reason).toContain(BOOTSTRAP_ADMIN_ID);
    expect(missing.reason).toContain("gate-test-agent/1.0");
  });

  test("в enforce тот же запрос без intent отвергается до извлечения", async () => {
    const { db, dir } = await setup();
    // Прямой вызов роута отдаёт ApiError вызывающему (в конверт его заворачивает `createHandler`).
    await expect(createWithMode(db, dir, { designSystem: "gate-ds", id: "gate-badge", name: "GateBadge", source: badgeSource("GateBadge", "Статусный бейдж заказа с тоном оформления") }, "enforce"))
      .rejects.toMatchObject({ status: 400, code: "invalid_request" });
    expect(new ReuseDecisionRepo(db).list()).toEqual([]);
  });

  test("режим гейта читается из строки один раз, дефолт — enforce", () => {
    expect(resolveReuseGateMode(undefined)).toBe("enforce");
    expect(resolveReuseGateMode("")).toBe("enforce");
    expect(resolveReuseGateMode(" Shadow ")).toBe("shadow");
    expect(() => resolveReuseGateMode("off")).toThrow();
    expect(synthesizeIntent("GateStarRating")).toBe("gate star rating");
  });
});

describe("canonical role uniqueness", () => {
  const roleSource = (name: string, description: string) => badgeSource(name, description, `\n  canonicalFor: ["payment-success"],`);

  test("create: занятая роль даёт 409 canonical_role_conflict, обходится админским override", async () => {
    const { db, handler } = await setup();
    seedComponent(db, "gate-owner", "GateOwner", { designSystem: "gate-ds", source: RATING_SOURCE, description: "Канонический экран успешной оплаты", meta: { canonicalFor: ["payment-success"] } });

    const conflict = await create(handler, { designSystem: "gate-ds", id: "gate-role", name: "GateRole", source: roleSource("GateRole", "Ещё один экран успешной оплаты заказа"), intent: "экран успешной оплаты заказа" });
    expect(conflict.status).toBe(409);
    const error = await errorOf(conflict);
    expect(error.code).toBe("canonical_role_conflict");
    expect(error.conflictingRoles).toEqual(["payment-success"]);
    expect(error.overrideTemplate!.candidateKeys).toEqual([candidateKey({ designSystem: "gate-ds", id: "gate-owner" })]);
    expect(componentRows(db, "gate-role")).toEqual({ components: 0, revisions: 0 });
    expect(new ReuseDecisionRepo(db).list()[0]).toMatchObject({ decision: "blocked", reason: "canonical_role_conflict:payment-success" });

    const forced = await create(handler, {
      designSystem: "gate-ds", id: "gate-role", name: "GateRole", source: roleSource("GateRole", "Ещё один экран успешной оплаты заказа"), intent: "экран успешной оплаты заказа",
      reuseOverride: { catalogRevision: error.catalogRevision!, candidateKeys: error.overrideTemplate!.candidateKeys, reason: "временная параллельная реализация роли на время миграции" },
    });
    expect(forced.status).toBe(201);
  });

  test("publish: роль, занятая после создания драфта, отвергает публикацию", async () => {
    const { db, handler } = await setup();
    expect((await create(handler, { designSystem: "gate-ds", id: "gate-role", name: "GateRole", source: roleSource("GateRole", "Экран успешной оплаты заказа"), intent: "экран успешной оплаты заказа" })).status).toBe(201);
    // Роль занята уже после создания драфта — publish обязан это увидеть (план §3.5).
    seedComponent(db, "gate-owner", "GateOwner", { designSystem: "gate-ds", source: RATING_SOURCE, description: "Канонический экран успешной оплаты", meta: { canonicalFor: ["payment-success"] } });

    const response = await handler(new Request("http://test/api/components/gate-role/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRev: 1 }) }));
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("canonical_role_conflict");
    // Ни staging-публикации, ни активной версии: проверка стоит до `repo.stage`.
    expect(db.query("SELECT COUNT(*) c FROM component_publishes WHERE component_id='gate-role'").get()).toEqual({ c: 0 });
  }, 30_000);

  test("publish обычного компонента печатает предупреждение о дубликате и не блокирует", async () => {
    const { db, handler } = await setup();
    seedComponent(db, "gate-rating", "GateRating", { designSystem: "gate-ds", source: RATING_SOURCE, description: "Интерактивный рейтинг пятью звёздами" });
    // Обход «PUT → publish»: драфт создаётся посторонним исходником, затем правится в копипасту.
    expect((await create(handler, { designSystem: "gate-ds", id: "gate-star-rating", name: "GateStarRating", source: badgeSource("GateStarRating", "Черновик статусного бейджа заказа"), intent: INTENT })).status).toBe(201);
    expect((await handler(new Request("http://test/api/components/gate-star-rating", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRev: 1, source: RATING_COPY }) }))).status).toBe(200);

    const response = await handler(new Request("http://test/api/components/gate-star-rating/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRev: 2 }) }));
    expect(response.status).toBe(201);
    const published = (await response.json()) as { warnings: string[] };
    expect(published.warnings.some((warning) => warning.includes("duplicate of gate-rating"))).toBe(true);
    // D4: сам артефакт исключён из корпуса — перепубликация не печатает «дубликат самого себя».
    expect(published.warnings.every((warning) => !warning.includes("duplicate of gate-star-rating"))).toBe(true);
  }, 60_000);
});

describe("транзакционность (bun:sqlite)", () => {
  /**
   * Регресс на первопричину требования «`matchAndDecide` строго синхронна» (план §1.2):
   * async-callback в `db.transaction` **молча коммитит** на первом await, поэтому исключение
   * после него ничего не откатывает. Тест фиксирует именно это поведение рантайма — если оно
   * когда-нибудь изменится, требование можно пересмотреть осознанно, а не случайно.
   */
  test("async-callback в db.transaction не откатывает — поэтому гейт синхронный", async () => {
    const { db } = await setup();
    db.run("CREATE TABLE gate_probe (id INTEGER PRIMARY KEY)");
    await expect(db.transaction(async () => {
      db.run("INSERT INTO gate_probe (id) VALUES (1)");
      await Promise.resolve();
      throw new Error("rollback expected but never happens");
    })()).rejects.toThrow("rollback expected");
    expect(db.query("SELECT COUNT(*) c FROM gate_probe").get()).toEqual({ c: 1 });

    // Синхронный callback — контрольная группа: там откат работает.
    expect(() => db.transaction(() => { db.run("INSERT INTO gate_probe (id) VALUES (2)"); throw new Error("sync"); })()).toThrow("sync");
    expect(db.query("SELECT COUNT(*) c FROM gate_probe").get()).toEqual({ c: 1 });
  });

  test("создание компонента и аудит-строка атомарны: падение create не оставляет решения", async () => {
    const { db } = await setup();
    seedComponent(db, "gate-other", "GateOther", { designSystem: "gate-ds", source: badgeSource("GateOther", "Посторонний компонент каталога"), description: "Посторонний компонент каталога" });
    const input = {
      mode: "enforce" as const, actor: { userId: BOOTSTRAP_ADMIN_ID, isAdmin: true }, designSystem: "gate-ds",
      artifactId: "gate-atomic", name: "GateAtomic", source: RATING_SOURCE,
      meta: { events: [], slots: [], description: "Интерактивный рейтинг пятью звёздами" },
      intent: INTENT, intentProvided: true,
    };
    expect(() => matchAndDecide(db, input, () => {
      db.query("INSERT INTO components (id,name,head_rev,design_system,deleted_at,created_at,updated_at,owner_id) VALUES ('gate-atomic','GateAtomic',1,'gate-ds',NULL,?,?,?)").run(at(0), at(0), BOOTSTRAP_ADMIN_ID);
      throw new Error("create failed after the audit decision was computed");
    })).toThrow("create failed");
    expect(componentRows(db, "gate-atomic")).toEqual({ components: 0, revisions: 0 });
    expect(new ReuseDecisionRepo(db).list()).toEqual([]);

    // И обратный случай: успешный create коммитит решение вместе с компонентом.
    const outcome = matchAndDecide(db, input, () => {
      db.query("INSERT INTO components (id,name,head_rev,design_system,deleted_at,created_at,updated_at,owner_id) VALUES ('gate-atomic','GateAtomic',1,'gate-ds',NULL,?,?,?)").run(at(0), at(0), BOOTSTRAP_ADMIN_ID);
      return { id: "gate-atomic" };
    });
    expect(outcome).toMatchObject({ decision: "accepted_no_match", created: { id: "gate-atomic" } });
    expect(new ReuseDecisionRepo(db).get(outcome.decisionId)).toMatchObject({ decision: "accepted_no_match" });
  });

  test("сбой аудит-записи не превращает 409 в 500: repeatedAttempts уходит null", async () => {
    const { db } = await setup();
    seedComponent(db, "gate-rating", "GateRating", { designSystem: "gate-ds", source: RATING_SOURCE, description: "Интерактивный рейтинг пятью звёздами" });
    const rejection = (() => {
      try {
        matchAndDecide(db, {
          mode: "enforce", actor: { userId: BOOTSTRAP_ADMIN_ID, isAdmin: true }, designSystem: "gate-ds",
          artifactId: "gate-star-rating", name: "GateStarRating", source: RATING_COPY,
          meta: { events: ["press"], slots: [], description: "Пятизвёздочный рейтинг товара в карточке" },
          intent: INTENT, intentProvided: true,
        }, () => ({ id: "gate-star-rating" }));
        return null;
      } catch (error) { return error as ReuseGateRejection; }
    })();
    expect(rejection).toBeInstanceOf(ReuseGateRejection);

    // Таблица аудита недоступна — запись обязана провалиться молча.
    db.run("DROP TABLE catalog_reuse_decisions");
    expect(recordBlockedAttempt(db, rejection!.attempt)).toBeNull();
  });
});
