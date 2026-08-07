/**
 * Сага миграционного коммита (план `docs/plans/2026-08-07-migration-feedback-wave.md` §1.3/§W4,
 * миграция v35): фазы поверх **реальных** существующих мутаций, идемпотентность по ключу,
 * per-component lock, resume из `needs-*`, cancel, watchdog зависших фаз и оба гейта.
 *
 * Компонентные id уникальны для файла: кэши import-верификации живут в общем процессе `bun test`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { createTestHandler } from "./test-auth";
import { openDatabase } from "./db";
import { prototypeDocSchema, type PrototypeDoc } from "../src/prototype/schema";
import { AcceptanceOrchestrator } from "./acceptance/orchestrator";
import type { AcceptanceCaptureService } from "./acceptance/gates/types";
import { capabilities } from "./routes/meta";
import {
  MIGRATION_COMMIT_PHASE_TIMEOUT_MS, migrationCommitEnabled, sweepStaleMigrationCommits,
  type MigrationCommitReceipt,
} from "./migration/commit";

const dirs: string[] = [];
const databases: Database[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

type Handler = (request: Request) => Promise<Response>;

const req = (url: string, method = "GET", value?: unknown) =>
  new Request(`http://test/api${url}`, {
    method,
    headers: value === undefined ? undefined : { "content-type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value),
  });

/** Капчур приёмки в этом файле не исполняется: сага промоутит receipt-only (без ранов). */
const noCapture = {
  enqueueComponentCandidate() { throw new Error("acceptance capture must not run in migration commit tests"); },
  get() { throw new Error("acceptance capture must not run in migration commit tests"); },
  outcome() { return undefined; },
  hasBackgroundCapacity() { return true; },
} as unknown as AcceptanceCaptureService;

async function setup(options: { matrix?: boolean } = {}) {
  const dir = await mkdtemp(resolve(process.cwd(), ".migration-commit-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  databases.push(db);
  const orchestrator = options.matrix === false ? undefined : new AcceptanceOrchestrator({ db, dataDir: dir, service: noCapture, autoDrain: false });
  const handler = createTestHandler(db, { dataDir: dir, ...(orchestrator ? { acceptance: orchestrator } : {}) }) as Handler;
  return { dir, db, handler, orchestrator };
}

const fixture = (file = "rating-stars.tsx") => Bun.file(resolve("server/fixtures", file)).text();

async function createComponent(handler: Handler, id: string, name: string, file?: string): Promise<void> {
  const response = await handler(req("/components", "POST", {
    designSystem: "yandex-pay", id, name, source: await fixture(file),
    intent: `Migration commit saga fixture for ${name}`,
  }));
  expect(response.status).toBe(201);
}

/** `{baseRev, sourceHash}` берётся из validate-receipt — ровно как это делает драйвер. */
async function sourceHashOf(handler: Handler, id: string): Promise<string> {
  const receipt = await handler(req(`/components/${id}/validate`, "POST"));
  expect(receipt.status).toBe(200);
  return (await receipt.json() as { sourceHash: string }).sourceHash;
}

const imageScreen = (id: string) => ({
  id, name: id,
  spec: { root: "image", elements: { image: { type: "Image", props: { src: "https://example.com/fixture.png", alt: "Fixture" } } } },
});
const componentScreen = (id: string, type: string) => ({
  id, name: id,
  spec: { root: "card", elements: { card: { type, props: { value: 3 } } } },
});

async function galleryDoc(id: string, screens: unknown[]): Promise<PrototypeDoc> {
  const base = prototypeDocSchema.parse(await Bun.file("test/fixtures/host-content.json").json());
  return prototypeDocSchema.parse({ ...base, id, name: id, startScreen: (screens[0] as { id: string }).id, screens });
}

async function createGallery(handler: Handler, id: string, screens: unknown[]): Promise<void> {
  expect((await handler(req("/prototypes", "POST", { doc: await galleryDoc(id, screens) }))).status).toBe(201);
}

const commitBody = (componentId: string, sourceHash: string, key: string, extra: Record<string, unknown> = {}) => ({
  idempotencyKey: key, componentId, baseRev: 1, sourceHash, ...extra,
});

const receipt = async (response: Response): Promise<MigrationCommitReceipt & { idempotentReplay?: boolean }> =>
  await response.json() as MigrationCommitReceipt & { idempotentReplay?: boolean };

const phaseRow = (db: Database, id: string) =>
  db.query("SELECT phase,phase_started_at started FROM migration_commits WHERE commit_id=?").get(id) as { phase: string; started: string };

describe("migration commit saga (§W4)", () => {
  test("happy path: все шесть фаз проходят поверх реальных мутаций и сага встаёт в complete", async () => {
    const { db, handler } = await setup();
    await createComponent(handler, "mig-happy", "MigHappy");
    await createGallery(handler, "gal-happy", [imageScreen("s1")]);
    const sourceHash = await sourceHashOf(handler, "mig-happy");

    const response = await handler(req("/migration-commits", "POST", commitBody("mig-happy", sourceHash, "key-happy", {
      gallery: { prototypeId: "gal-happy", baseRev: 1, screenFragment: componentScreen("s2", "MigHappy"), message: "migrate MigHappy" },
    })));
    expect(response.status).toBe(201);
    const body = await receipt(response);

    expect(body.phase).toBe("complete");
    expect(body.phasesDone).toEqual(["preflight", "promote", "gallery-save", "verify", "impacted-regression", "audit"]);
    expect(body.regressionMode).toBe("impacted");
    // Фазы исполнили именно существующие мутации: версия компонента и новая ревизия галереи.
    expect(body.result.promote).toMatchObject({ version: 1, rev: 1 });
    expect(body.result.gallery).toMatchObject({ prototypeId: "gal-happy", beforeRev: 1, afterRev: 2, changed: true });
    expect(body.result.verify?.screens.map((screen) => [screen.screenId, screen.renderable])).toEqual([["s2", true]]);
    expect(body.result.regression?.mode).toBe("impacted");
    expect(body.result.regression?.plan?.screens.map((screen) => screen.screenId).sort()).toEqual(["s1", "s2"]);
    expect(body.result.audit?.designSystem).toBe("yandex-pay");

    expect(db.query("SELECT status FROM component_publishes WHERE component_id='mig-happy'").all()).toEqual([{ status: "active" }]);
    expect((db.query("SELECT head_rev rev FROM prototypes WHERE id='gal-happy'").get() as { rev: number }).rev).toBe(2);
    // GET отдаёт ту же квитанцию.
    const fetched = await receipt(await handler(req(`/migration-commits/${body.commitId}`)));
    expect(fetched.phase).toBe("complete");
    expect(fetched.commitId).toBe(body.commitId);
  }, 180_000);

  test("идемпотентный повтор ключа возвращает ту же сагу и не создаёт вторую версию", async () => {
    const { db, handler } = await setup();
    await createComponent(handler, "mig-idem", "MigIdem");
    const sourceHash = await sourceHashOf(handler, "mig-idem");
    const first = await handler(req("/migration-commits", "POST", commitBody("mig-idem", sourceHash, "key-idem")));
    expect(first.status).toBe(201);
    const created = await receipt(first);

    const second = await handler(req("/migration-commits", "POST", commitBody("mig-idem", sourceHash, "key-idem")));
    expect(second.status).toBe(200);
    const replay = await receipt(second);
    expect(replay.commitId).toBe(created.commitId);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.phase).toBe("complete");
    // Ноль новых ревизий каталога: версия ровно одна.
    expect(db.query("SELECT COUNT(*) count FROM component_publishes WHERE component_id='mig-idem'").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) count FROM migration_commits").get()).toEqual({ count: 1 });
  }, 180_000);

  test("per-component lock: активная фаза блокирует свой компонент (409) и не блокирует чужой", async () => {
    const { db, handler } = await setup();
    await createComponent(handler, "mig-lock-a", "MigLockA");
    // Второй компонент — другой фикстуры: одинаковые каталогу они были бы дубликатом, и
    // reuse-гейт (409 component_reuse_required) отказал бы ещё на создании.
    await createComponent(handler, "mig-lock-b", "MigLockB", "props-badge.tsx");
    const hashA = await sourceHashOf(handler, "mig-lock-a");
    const hashB = await sourceHashOf(handler, "mig-lock-b");
    const at = new Date().toISOString();
    // Сага компонента A застряла в активной фазе (процесс, который её двигал, ещё жив).
    db.query(`INSERT INTO migration_commits
      (commit_id,component_id,candidate_id,design_system,gallery_prototype_id,phase,phases_json,request_json,receipt_json,idempotency_key,owner_id,phase_started_at,created_at,updated_at)
      VALUES ('mig_00000000-0000-4000-8000-000000000001','mig-lock-a',NULL,'yandex-pay',NULL,'promote','[]','{}',NULL,'held','u',?,?,?)`).run(at, at, at);

    const blocked = await handler(req("/migration-commits", "POST", commitBody("mig-lock-a", hashA, "key-lock-a")));
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: "migration_commit_in_flight" } });

    // Другой компонент не ждёт чужой саги: лок именно per-component, а не глобальный.
    const other = await handler(req("/migration-commits", "POST", commitBody("mig-lock-b", hashB, "key-lock-b")));
    expect(other.status).toBe(201);
    expect((await receipt(other)).phase).toBe("complete");
  }, 180_000);

  test("commit того же компонента при `needs-*` допустим: ожидающая сага компонент не держит", async () => {
    const { db, handler } = await setup();
    await createComponent(handler, "mig-needs", "MigNeeds");
    const sourceHash = await sourceHashOf(handler, "mig-needs");
    const at = new Date().toISOString();
    db.query(`INSERT INTO migration_commits
      (commit_id,component_id,candidate_id,design_system,gallery_prototype_id,phase,phases_json,request_json,receipt_json,idempotency_key,owner_id,phase_started_at,created_at,updated_at)
      VALUES ('mig_00000000-0000-4000-8000-000000000002','mig-needs',NULL,'yandex-pay',NULL,'needs-gallery-save','[]','{}',NULL,'waiting','u',?,?,?)`).run(at, at, at);

    const response = await handler(req("/migration-commits", "POST", commitBody("mig-needs", sourceHash, "key-needs")));
    expect(response.status).toBe(201);
    expect((await receipt(response)).phase).toBe("complete");
  }, 180_000);

  test("провал фазы ⇒ needs-*, cancel закрывает сагу терминально", async () => {
    const { handler } = await setup();
    await createComponent(handler, "mig-cancel", "MigCancel");
    await createGallery(handler, "gal-cancel", [imageScreen("s1")]);
    const sourceHash = await sourceHashOf(handler, "mig-cancel");

    // Фрагмент ссылается на тип, которого нет в каталоге: схема документа его пропускает (это
    // валидный экран), а сохранение галереи падает на снимке определений — ровно та ситуация,
    // ради которой существует `needs-*`: promote уже необратим, откатывать его нечем.
    const response = await handler(req("/migration-commits", "POST", commitBody("mig-cancel", sourceHash, "key-cancel", {
      gallery: { prototypeId: "gal-cancel", screenFragment: componentScreen("s2", "NoSuchComponent") },
    })));
    expect(response.status).toBe(201);
    const body = await receipt(response);
    // Отказ фазы — состояние саги, а не HTTP-ошибка: 201 с квитанцией, где видно, где встали.
    expect(body.phase).toBe("needs-gallery-save");
    expect(body.error?.code).toBe("validation_failed");
    expect(body.phasesDone).toEqual(["preflight", "promote"]);
    expect(body.phases.at(-1)).toMatchObject({ phase: "gallery-save", status: "failed" });
    // Компенсации нет: промоученная версия остаётся опубликованной.
    expect(body.result.promote).toMatchObject({ version: 1 });

    const cancelled = await handler(req(`/migration-commits/${body.commitId}/cancel`, "POST", { reason: "fragment is wrong" }));
    expect(cancelled.status).toBe(200);
    const closed = await receipt(cancelled);
    expect(closed.phase).toBe("cancelled");
    expect(closed.error).toMatchObject({ code: "cancelled" });
    // Из терминального состояния не возобновляются.
    const advance = await handler(req(`/migration-commits/${body.commitId}/advance`, "POST"));
    expect(advance.status).toBe(409);
    expect(await advance.json()).toMatchObject({ error: { code: "migration_commit_not_resumable" } });
  }, 180_000);

  test("watchdog переводит зависшую фазу в needs-* при следующем запросе, advance продолжает с неё", async () => {
    const { db, handler } = await setup();
    await createComponent(handler, "mig-watch", "MigWatch");
    await createGallery(handler, "gal-watch", [imageScreen("s1")]);
    const sourceHash = await sourceHashOf(handler, "mig-watch");
    const response = await handler(req("/migration-commits", "POST", commitBody("mig-watch", sourceHash, "key-watch", {
      gallery: { prototypeId: "gal-watch", screenFragment: componentScreen("s2", "MigWatch") },
    })));
    const body = await receipt(response);
    expect(body.phase).toBe("complete");

    // Симуляция краха процесса между promote и gallery-save: строка осталась в активной фазе,
    // журнал — с незакрытой записью, `phase_started_at` — за пределами таймаута фазы.
    const stale = new Date(Date.now() - MIGRATION_COMMIT_PHASE_TIMEOUT_MS - 1000).toISOString();
    const promoteOnly = body.phases.slice(0, 2).concat([{ phase: "gallery-save", startedAt: stale, endedAt: null, status: "done" }]);
    db.query("UPDATE migration_commits SET phase='gallery-save', phase_started_at=?, phases_json=?, receipt_json=? WHERE commit_id=?")
      .run(stale, JSON.stringify(promoteOnly), JSON.stringify({ result: { promote: body.result.promote } }), body.commitId);
    // Галерею тоже возвращаем к дововолновому состоянию — иначе фаза увидит уже сохранённый экран.
    db.query("DELETE FROM prototype_revisions WHERE prototype_id='gal-watch' AND rev=2").run();
    db.query("UPDATE prototypes SET head_rev=1 WHERE id='gal-watch'").run();

    // Watchdog исполняется на **любом** запросе к набору, включая GET.
    const swept = await receipt(await handler(req(`/migration-commits/${body.commitId}`)));
    expect(swept.phase).toBe("needs-gallery-save");
    expect(swept.error?.code).toBe("phase_timeout");
    expect(swept.phases.at(-1)).toMatchObject({ phase: "gallery-save", status: "timeout" });

    const resumed = await receipt(await handler(req(`/migration-commits/${body.commitId}/advance`, "POST")));
    expect(resumed.phase).toBe("complete");
    // promote не переигрывается: вторая версия компонента была бы удвоением каталога.
    expect(resumed.phases.filter((entry) => entry.phase === "gallery-save").at(-1)).toMatchObject({ status: "done" });
    expect(db.query("SELECT COUNT(*) count FROM component_publishes WHERE component_id='mig-watch'").get()).toEqual({ count: 1 });
    expect((db.query("SELECT head_rev rev FROM prototypes WHERE id='gal-watch'").get() as { rev: number }).rev).toBe(2);
  }, 180_000);

  test("watchdog: sweep на старте процесса подметает зависшую фазу без единого запроса", async () => {
    const { db } = await setup();
    const stale = new Date(Date.now() - MIGRATION_COMMIT_PHASE_TIMEOUT_MS - 1000).toISOString();
    db.query(`INSERT INTO migration_commits
      (commit_id,component_id,candidate_id,design_system,gallery_prototype_id,phase,phases_json,request_json,receipt_json,idempotency_key,owner_id,phase_started_at,created_at,updated_at)
      VALUES ('mig_00000000-0000-4000-8000-000000000003','mig-boot',NULL,'yandex-pay',NULL,'audit','[]','{}',NULL,'boot','u',?,?,?)`).run(stale, stale, stale);
    expect(sweepStaleMigrationCommits(db)).toBe(1);
    expect(phaseRow(db, "mig_00000000-0000-4000-8000-000000000003").phase).toBe("needs-audit");
    // Повторный проход идемпотентен: `needs-*` вне позитивного списка активных фаз.
    expect(sweepStaleMigrationCommits(db)).toBe(0);
  });

  test("dry-run ничего не пишет и возвращает план фаз, мутаций и превью регрессии", async () => {
    const { db, handler } = await setup();
    await createComponent(handler, "mig-dry", "MigDry");
    await createGallery(handler, "gal-dry", [imageScreen("s1")]);
    const sourceHash = await sourceHashOf(handler, "mig-dry");

    const response = await handler(req("/migration-commits", "POST", commitBody("mig-dry", sourceHash, "key-dry", {
      dryRun: true, gallery: { prototypeId: "gal-dry", screenFragment: imageScreen("s2") },
    })));
    expect(response.status).toBe(200);
    const plan = await response.json() as {
      dryRun: boolean; phases: string[]; regressionMode: string;
      mutations: { phase: string; kind: string; target: string }[];
      preflight: { ok: boolean }; regressionPreview: { summary: { total: number } } | null;
    };
    expect(plan.dryRun).toBe(true);
    expect(plan.phases).toEqual(["preflight", "promote", "gallery-save", "verify", "impacted-regression", "audit"]);
    expect(plan.regressionMode).toBe("impacted");
    expect(plan.preflight.ok).toBe(true);
    expect(plan.mutations.map((mutation) => [mutation.phase, mutation.kind])).toEqual([["promote", "component.promote"], ["gallery-save", "prototype.save"]]);
    expect(plan.regressionPreview?.summary.total).toBe(1);
    // Ноль мутаций: ни строки саги, ни версии, ни новой ревизии галереи.
    expect(db.query("SELECT COUNT(*) count FROM migration_commits").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) count FROM component_publishes WHERE component_id='mig-dry'").get()).toEqual({ count: 0 });
    expect((db.query("SELECT head_rev rev FROM prototypes WHERE id='gal-dry'").get() as { rev: number }).rev).toBe(1);
  }, 180_000);

  test("гейты: без матричной приёмки и с kill-switch набор отвечает 404, capabilities — false", async () => {
    const withoutMatrix = await setup({ matrix: false });
    expect((await withoutMatrix.handler(req("/migration-commits", "POST", { idempotencyKey: "x", componentId: "y", baseRev: 1, sourceHash: "0".repeat(64) }))).status).toBe(404);
    expect((capabilities(withoutMatrix.db, undefined, { acceptanceMatrix: false }).features as Record<string, unknown>).migrationCommit).toBe(false);

    const withMatrix = await setup();
    expect((capabilities(withMatrix.db, undefined, { acceptanceMatrix: true }).features as Record<string, unknown>).migrationCommit).toBe(true);
    expect((capabilities(withMatrix.db, undefined, { acceptanceMatrix: true }).limits as Record<string, unknown>).migrationCommitPhaseTimeoutMs).toBe(MIGRATION_COMMIT_PHASE_TIMEOUT_MS);

    // Kill-switch волны читается по месту (прецедент `impactedSnapEnabled`).
    expect(migrationCommitEnabled("1")).toBe(false);
    expect(migrationCommitEnabled(undefined)).toBe(true);
    const previous = process.env.EASYUI_MIGRATION_COMMIT_DISABLED;
    process.env.EASYUI_MIGRATION_COMMIT_DISABLED = "1";
    try {
      expect((await withMatrix.handler(req("/migration-commits", "POST", { idempotencyKey: "x", componentId: "y", baseRev: 1, sourceHash: "0".repeat(64) }))).status).toBe(404);
      expect((capabilities(withMatrix.db, undefined, { acceptanceMatrix: true }).features as Record<string, unknown>).migrationCommit).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.EASYUI_MIGRATION_COMMIT_DISABLED;
      else process.env.EASYUI_MIGRATION_COMMIT_DISABLED = previous;
    }
  });
});
