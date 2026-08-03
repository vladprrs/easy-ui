import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { createHandler } from "./main";
import { createTestHandler } from "./test-auth";
import { BOOTSTRAP_ADMIN_ID, UserRepo } from "./users";
import { collectCorpus } from "./catalog/corpus";
import { compositionStructure } from "./catalog/compositionSignature";
import { ComponentFingerprintRepo } from "./repos/componentFingerprints";
import { libraryCatalog } from "./routes/libraryCatalog";
import { routeCatalogCandidates } from "./routes/catalogCandidates";
import { ApiError } from "./http";
import type { CorpusCandidate } from "./catalog/matcher";

/**
 * Корпус матчинга (`server/catalog/corpus.ts`) и discovery-роут `POST|GET /api/catalog/candidates`
 * — план 2026-07-31 §3.1/§3.4/§4 T4, спека §2.
 *
 * Компоненты сидятся прямо в БД: настоящая публикация — подпроцесс extract + typecheck +
 * compile на каждый компонент, а всё проверяемое здесь зависит только от строк
 * `components`/`component_revisions`/`component_publishes`.
 */

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();

function seedSystem(db: Database, id: string, retired = false): void {
  db.query("INSERT INTO design_systems (id,name,description,builtin_provider,created_at,updated_at,owner_id,retired) VALUES (?,?,?,NULL,?,?,?,?)")
    .run(id, `System ${id}`, `seeded ${id}`, at(0), at(0), BOOTSTRAP_ADMIN_ID, retired ? 1 : 0);
}

interface SeedOptions {
  designSystem: string;
  source: string;
  description?: string;
  meta?: Record<string, unknown>;
  /** `false` — head-драфт: ревизия есть, активной публикации нет. */
  publish?: boolean;
  status?: string;
}

function seedComponent(db: Database, id: string, name: string, options: SeedOptions): void {
  const { designSystem, source, publish = true, status = "active" } = options;
  db.query("INSERT INTO components (id,name,head_rev,design_system,deleted_at,created_at,updated_at,owner_id) VALUES (?,?,1,?,NULL,?,?,?)")
    .run(id, name, designSystem, at(0), at(0), BOOTSTRAP_ADMIN_ID);
  db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,figma_json,message,created_at) VALUES (?,1,?,?,NULL,NULL,?)")
    .run(id, source, designSystem, at(1));
  if (!publish) return;
  const meta = { description: options.description ?? "", events: [], slots: [], propsJsonSchema: { type: "object", properties: {} }, ...options.meta };
  db.query("INSERT INTO component_publishes (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,message,published_at) VALUES (?,1,1,?,?,?,?,?,4,NULL,?)")
    .run(id, status, "export default () => null;", JSON.stringify(meta), `sh-${id}`, `bh-${id}`, at(1));
}

/** Вторая публикация со статусом `deprecated`: активной остаётся v1, «последняя» — v2. */
function seedDeprecatingVersion(db: Database, id: string, designSystem: string, replacement: string): void {
  db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,figma_json,message,created_at) VALUES (?,2,?,?,NULL,NULL,?)")
    .run(id, `${sourceFor(id)}\n// v2`, designSystem, at(2));
  const meta = { description: "Старая кнопка оплаты заказа", events: [], slots: [], propsJsonSchema: { type: "object", properties: {} }, replacement };
  db.query("INSERT INTO component_publishes (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,message,published_at) VALUES (?,2,2,'deprecated',?,?,?,?,4,NULL,?)")
    .run(id, "export default () => null;", JSON.stringify(meta), `sh-${id}-2`, `bh-${id}-2`, at(2));
  db.query("UPDATE components SET head_rev=2 WHERE id=?").run(id);
}

/** Разные исходники: одинаковый текст сделал бы сигнал шинглов 1.0 у всех пар. */
const sourceFor = (name: string, extra = ""): string =>
  `import { z } from "zod";\nexport const definition = { props: z.object({ ${name.toLowerCase()}: z.string() }), description: "${name}" };\nexport default function ${name}(props) { return <div className="${name}">{props.${name.toLowerCase()}}${extra}</div>; }\n`;

const dbs: Database[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const db of dbs.splice(0)) db.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function setup(): { db: Database; handler: (request: Request) => Promise<Response> } {
  const db = openDatabase(":memory:");
  dbs.push(db);
  // Хендлер создаётся первым: он же заводит bootstrap-админа, на которого ссылается `owner_id`.
  const handler = createTestHandler(db) as (request: Request) => Promise<Response>;
  seedSystem(db, "cand-ds");
  return { db, handler };
}

/** Каталог для проверки ранжирования по `intent`: три релевантных и три посторонних записи. */
function seedRankingCatalog(db: Database): void {
  const rows: [id: string, name: string, description: string][] = [
    ["cand-pay-button", "CandPayButton", "Кнопка оплаты заказа: запускает платёж и показывает спиннер"],
    ["cand-pay-sheet", "CandPaySheet", "Шторка оплаты заказа со списком карт и кнопкой подтверждения"],
    ["cand-pay-status", "CandPayStatus", "Экран статуса платежа после оплаты заказа"],
    ["cand-avatar", "CandAvatar", "Аватар пользователя с инициалами"],
    ["cand-separator", "CandSeparator", "Горизонтальный разделитель между блоками списка"],
    ["cand-map", "CandMap", "Карта с пином выбранной точки самовывоза"],
  ];
  for (const [id, name, description] of rows) {
    seedComponent(db, id, name, { designSystem: "cand-ds", source: sourceFor(name, id), description });
  }
}

/**
 * Композиция v2 с телом из host-примитивов: типы элементов проверяет только роут композиций
 * (`assertKnownTypes`), а корпус и матчер читают документ как есть.
 */
function compositionDoc(options: {
  name: string;
  description?: string;
  params?: Record<string, { type: string; required?: boolean }>;
  slots?: string[];
  elements?: Record<string, { type: string; props: Record<string, unknown>; children?: string[] }>;
  root?: string;
  canonicalFor?: string[];
}): Record<string, unknown> {
  return {
    version: 2, name: options.name, description: options.description ?? "", atomicLevel: "molecule",
    ...(options.canonicalFor === undefined ? {} : { canonicalFor: options.canonicalFor }),
    params: options.params ?? {}, slots: options.slots ?? [],
    spec: {
      root: options.root ?? "root",
      elements: options.elements ?? {
        root: { type: "Overlay", props: { className: "row" }, children: ["title", "action"] },
        title: { type: "Image", props: { src: "a.png" } },
        action: { type: "Hotspot", props: { label: "Оплатить" } },
      },
    },
  };
}

function seedComposition(db: Database, id: string, name: string, doc: Record<string, unknown>, designSystem = "cand-ds", publish = false): void {
  db.query("INSERT INTO compositions (id,name,head_rev,design_system,deleted_at,delete_reason,created_at,updated_at,owner_id) VALUES (?,?,1,?,NULL,NULL,?,?,?)")
    .run(id, name, designSystem, at(0), at(0), BOOTSTRAP_ADMIN_ID);
  db.query("INSERT INTO composition_revisions (composition_id,rev,doc,design_system,message,author,created_at) VALUES (?,1,?,?,NULL,NULL,?)")
    .run(id, JSON.stringify(doc), designSystem, at(1));
  if (!publish) return;
  db.query("INSERT INTO composition_publishes (composition_id,version,rev,status,source_hash,message,published_at) VALUES (?,1,1,'active',?,NULL,?)")
    .run(id, `csh-${id}`, at(2));
}

interface CandidateRow {
  kind: string; id: string; name: string; designSystem: string; version: number; draft: boolean;
  description: string; canonicalFor: string[]; deprecated: boolean; recommendable: boolean;
  headUsageCount: number; score: number; blocking: boolean; reasons: string[];
}
interface CandidatesResponse {
  designSystem: string;
  catalogRevision: string;
  policyVersion: number;
  candidates: CandidateRow[];
  overrideTemplate?: { catalogRevision: string; candidateKeys: string[] };
}

const post = (handler: (r: Request) => Promise<Response>, body: unknown) =>
  handler(new Request("http://test/api/catalog/candidates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const get = (handler: (r: Request) => Promise<Response>, query: string) =>
  handler(new Request(`http://test/api/catalog/candidates?${query}`));

describe("corpus (server/catalog/corpus.ts)", () => {
  // Критерий §3.6: гейт обязан быть слеп к состоянию кэша. Если бы промах кэша давал пустые
  // шинглы, гейт на свежем проде молча пропускал бы дубликаты (fail-open), а shadow показал бы
  // «ноль блокировок» и это прочитали бы как «ложных срабатываний нет».
  test("корпус на холодном кэше отпечатков идентичен корпусу после прогрева", () => {
    const { db } = setup();
    seedRankingCatalog(db);
    seedComponent(db, "cand-draft", "CandDraft", { designSystem: "cand-ds", source: sourceFor("CandDraft"), publish: false });

    const cache = new ComponentFingerprintRepo(db);
    expect(cache.count()).toBe(0);

    const normalize = (candidates: CorpusCandidate[]) =>
      candidates.map((candidate) => ({ ...candidate, shingles: [...candidate.shingles].sort() }))
        .sort((left, right) => left.id.localeCompare(right.id));

    const cold = normalize(collectCorpus(db, "cand-ds").candidates);
    expect(cache.count()).toBe(7);
    const warm = normalize(collectCorpus(db, "cand-ds").candidates);
    expect(warm).toEqual(cold);

    // И обратно: удаление кэша целиком не меняет корпус — ровно это делает обслуживание.
    db.query("DELETE FROM component_fingerprints").run();
    expect(normalize(collectCorpus(db, "cand-ds").candidates)).toEqual(cold);
    expect(cache.count()).toBe(7);
    // Шинглы реально посчитаны: пустое множество здесь означало бы мёртвый сигнал исходника.
    expect(cold.every((candidate) => candidate.shingles.length > 0)).toBe(true);
  });

  test("head-драфт попадает в корпус без `meta`, активная публикация — с `meta`", () => {
    const { db } = setup();
    seedComponent(db, "cand-published", "CandPublished", { designSystem: "cand-ds", source: sourceFor("CandPublished"), description: "Опубликованный компонент" });
    seedComponent(db, "cand-draft", "CandDraft", { designSystem: "cand-ds", source: sourceFor("CandDraft"), publish: false });

    const byId = new Map(collectCorpus(db, "cand-ds").candidates.map((candidate) => [candidate.id, candidate]));
    expect(byId.get("cand-published")).toMatchObject({ draft: false, version: 1, description: "Опубликованный компонент" });
    expect(byId.get("cand-published")!.meta).toBeDefined();
    expect(byId.get("cand-draft")).toMatchObject({ draft: true, version: 0, description: "" });
    // Ключевой инвариант §3.1: у драфта поля `meta` нет вовсе (а не пустой объект) — иначе
    // матчер посчитал бы props/io объявленными и пустыми и не перенормировал бы веса.
    expect(Object.hasOwn(byId.get("cand-draft")!, "meta")).toBe(false);
  });

  test("удалённые компоненты, отставленные системы и чужие системы в корпус не входят", () => {
    const { db } = setup();
    seedSystem(db, "cand-retired-tmp");
    seedSystem(db, "cand-other");
    seedComponent(db, "cand-live", "CandLive", { designSystem: "cand-ds", source: sourceFor("CandLive"), description: "Живой" });
    seedComponent(db, "cand-deleted", "CandDeleted", { designSystem: "cand-ds", source: sourceFor("CandDeleted"), publish: false });
    db.query("UPDATE components SET deleted_at=? WHERE id=?").run(at(9), "cand-deleted");
    // Систему сначала заполняем, потом отставляем: триггер БД запрещает ссылаться на retired.
    seedComponent(db, "cand-retired-live", "CandRetiredLive", { designSystem: "cand-retired-tmp", source: sourceFor("CandRetiredLive"), description: "Отставленная система" });
    db.query("UPDATE design_systems SET retired=1 WHERE id=?").run("cand-retired-tmp");
    seedComponent(db, "cand-other-live", "CandOtherLive", { designSystem: "cand-other", source: sourceFor("CandOtherLive"), description: "Чужая система" });

    expect(collectCorpus(db, "cand-ds").candidates.map((candidate) => candidate.id)).toEqual(["cand-live"]);
    expect(collectCorpus(db, "cand-retired-tmp").candidates).toEqual([]);
  });

  /**
   * W9: композиции входят в корпус **только** по явному флагу. Дефолт `false` держит гейт
   * создания компонента (`matchReuseProposal`) на прежнем корпусе: 409 по композиции в этой
   * волне не выдаётся вовсе, и молча просочиться в гейт расширение не имеет права.
   */
  test("композиции входят в корпус только с includeCompositions", () => {
    const { db } = setup();
    seedComponent(db, "cand-live", "CandLive", { designSystem: "cand-ds", source: sourceFor("CandLive"), description: "Живой" });
    seedComposition(db, "cand-row", "CandRow", compositionDoc({ name: "CandRow", description: "Строка оплаты", params: { title: { type: "string", required: true } }, slots: [] }), "cand-ds", true);
    seedComposition(db, "cand-draft-row", "CandDraftRow", compositionDoc({ name: "CandDraftRow", description: "Черновая строка" }));

    expect(collectCorpus(db, "cand-ds").candidates.map((candidate) => candidate.id)).toEqual(["cand-live"]);
    const withCompositions = collectCorpus(db, "cand-ds", { includeCompositions: true }).candidates;
    const row = withCompositions.find((candidate) => candidate.id === "cand-row")!;
    expect(row).toMatchObject({ kind: "composition", version: 1, draft: false, description: "Строка оплаты", headUsageCount: 0 });
    // Head-ревизия неопубликованной композиции — тоже кандидат: дубль чаще всего ещё не опубликован.
    expect(withCompositions.find((candidate) => candidate.id === "cand-draft-row")).toMatchObject({ kind: "composition", version: 0, draft: true });
    // Структура тела занимает слот сигнала «тело»; шинглов TSX у композиции нет.
    expect(row.shingles.size).toBe(0);
    expect(row.structure?.fingerprint).toHaveLength(64);
    expect(row.structure!.shingles.size).toBeGreaterThan(0);
    // Параметры видны матчеру как props-схема — на этом строится кросс-типовой мэтч.
    expect(row.meta?.propsJsonSchema).toEqual({ type: "object", properties: { title: { type: "string" } }, required: ["title"] });
  });

  test("структурная сигнатура: значения props не входят, форма дерева входит", () => {
    const same = compositionStructure(compositionDoc({ name: "A", elements: {
      root: { type: "Overlay", props: { className: "x" }, children: ["a"] },
      a: { type: "Image", props: { src: "one.png" } },
    } }));
    const renamedValues = compositionStructure(compositionDoc({ name: "B", elements: {
      root: { type: "Overlay", props: { className: "totally-other" }, children: ["a"] },
      a: { type: "Image", props: { src: "two.png" } },
    } }));
    const otherShape = compositionStructure(compositionDoc({ name: "C", elements: {
      root: { type: "Overlay", props: { className: "x" }, children: ["a", "b"] },
      a: { type: "Image", props: { src: "one.png" } },
      b: { type: "Hotspot", props: { label: "go" } },
    } }));
    expect(same!.fingerprint).toBe(renamedValues!.fingerprint);
    expect(same!.fingerprint).not.toBe(otherShape!.fingerprint);
    // Имена props — часть формы узла: другой набор props это другая структура.
    const otherProps = compositionStructure(compositionDoc({ name: "D", elements: {
      root: { type: "Overlay", props: { gap: 4 }, children: ["a"] },
      a: { type: "Image", props: { src: "one.png" } },
    } }));
    expect(same!.fingerprint).not.toBe(otherProps!.fingerprint);
    // Контракт тоже входит: одинаковое тело с разными параметрами — не дубль.
    const otherParams = compositionStructure(compositionDoc({ name: "E", params: { title: { type: "string" } }, elements: {
      root: { type: "Overlay", props: { className: "x" }, children: ["a"] },
      a: { type: "Image", props: { src: "one.png" } },
    } }));
    expect(same!.fingerprint).not.toBe(otherParams!.fingerprint);
    // Тела нет вовсе — сигнал неприменим, а не пуст.
    expect(compositionStructure({ version: 2, params: {} })).toBeUndefined();
  });

  // §3.4: библиотека, кандидаты и гейт обязаны потреблять одну функцию ревизии. Тест сверяет
  // именно побайтовое равенство: разошедшаяся проекция сделала бы override гейта невалидируемым.
  test("catalogRevision корпуса побайтово равен ревизии `GET /api/catalog/library`", () => {
    const { db } = setup();
    seedSystem(db, "cand-other");
    seedRankingCatalog(db);
    seedComponent(db, "cand-other-live", "CandOtherLive", {
      designSystem: "cand-other", source: sourceFor("CandOtherLive"), description: "Чужая система",
      meta: { atomicLevel: "molecule", scope: "section", canonicalFor: ["payment-success"], replacement: "CandPayButton", slots: ["body"], events: ["submit"] },
    });
    seedComponent(db, "cand-draft", "CandDraft", { designSystem: "cand-ds", source: sourceFor("CandDraft"), publish: false });

    const library = libraryCatalog(db).catalogRevision;
    // Ревизия описывает каталог, а не вид на него: она одинакова для любой запрошенной системы.
    expect(collectCorpus(db, "cand-ds").catalogRevision).toBe(library);
    expect(collectCorpus(db, "cand-other").catalogRevision).toBe(library);
    expect(collectCorpus(db, "cand-ds").catalogRevision).toHaveLength(64);
  });
});

describe("POST|GET /api/catalog/candidates", () => {
  test("POST extracts authoritative source metadata and returns every override key beyond display limit", async () => {
    const { db, handler } = setup();
    const proposedSource = `import { z } from "zod";
export const definition = { props: z.strictObject({ label: z.string() }), description: "Checkout role proposal", canonicalFor: ["payment-success"] };
export default function ProposedCheckout({ label }) { return <button>{label}</button>; }
`;
    seedComponent(db, "structural-copy", "StructuralCopy", {
      designSystem: "cand-ds",
      source: proposedSource,
      description: "Structural checkout copy",
      meta: { canonicalFor: [] },
    });
    seedComponent(db, "role-owner", "RoleOwner", {
      designSystem: "cand-ds",
      source: sourceFor("RoleOwner", "different-role-owner-source"),
      description: "Existing payment success owner",
      meta: { canonicalFor: ["payment-success"] },
    });

    const response = await post(handler, {
      designSystem: "cand-ds",
      intent: "Create checkout payment success action",
      limit: 1,
      proposed: {
        kind: "component",
        id: "proposed-checkout",
        name: "ProposedCheckout",
        source: proposedSource,
        // Deliberately false client metadata: source extraction must win.
        canonicalFor: [],
        propsJsonSchema: { type: "object", properties: {} },
      },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as CandidatesResponse;
    expect(body.candidates).toHaveLength(1);
    expect(body.overrideTemplate).toEqual({
      catalogRevision: body.catalogRevision,
      candidateKeys: ["component:cand-ds:role-owner", "component:cand-ds:structural-copy"],
    });

    const intentOnly = await get(handler, "designSystem=cand-ds&intent=" + encodeURIComponent("Create checkout payment success action") + "&limit=1");
    expect(Object.hasOwn(await intentOnly.json(), "overrideTemplate")).toBe(false);
  });

  test("source-backed POST without an id does not exclude a real catalog-candidate id", async () => {
    const { db, handler } = setup();
    const source = sourceFor("AnonymousProposal", "anonymous-proposal-copy");
    seedComponent(db, "catalog-candidate", "ExistingCatalogCandidate", {
      designSystem: "cand-ds",
      source,
      description: "Existing anonymous proposal copy",
      meta: { canonicalFor: [] },
    });

    const response = await post(handler, {
      designSystem: "cand-ds",
      intent: "Discover an anonymous copied catalog component",
      proposed: { kind: "component", name: "AnonymousProposal", source },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as CandidatesResponse;
    expect(body.overrideTemplate?.candidateKeys).toContain("component:cand-ds:catalog-candidate");
  });

  test("POST source validation returns typed 422 and always removes staging files", async () => {
    const dataDir = await mkdtemp(resolve(process.cwd(), ".catalog-candidates-source-test-"));
    directories.push(dataDir);
    const db = openDatabase(":memory:");
    dbs.push(db);
    const handler = createTestHandler(db, { dataDir }) as (request: Request) => Promise<Response>;
    seedSystem(db, "cand-ds");

    const response = await post(handler, {
      designSystem: "cand-ds",
      intent: "Validate a broken checkout component source",
      proposed: {
        kind: "component",
        id: "broken-checkout",
        name: "BrokenCheckout",
        source: "export default function BrokenCheckout( {",
      },
    });
    expect(response.status).toBe(422);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("validation_failed");
    expect(await readdir(resolve(dataDir, ".staging")).catch(() => [])).toEqual([]);

    const eventResponse = await post(handler, {
      designSystem: "cand-ds",
      intent: "Validate a component with unsupported event schema",
      proposed: {
        kind: "component",
        id: "broken-event-schema",
        name: "BrokenEventSchema",
        source: await Bun.file("server/fixtures/nonserializable-event.tsx").text(),
      },
    });
    expect(eventResponse.status).toBe(422);
    expect((await eventResponse.json() as { error: { code: string } }).error.code).toBe("event_schema_not_serializable");
    expect(await readdir(resolve(dataDir, ".staging")).catch(() => [])).toEqual([]);

    const oversizedResponse = await post(handler, {
      designSystem: "cand-ds",
      intent: "Validate an oversized checkout component source",
      proposed: {
        kind: "component",
        id: "oversized-source",
        name: "OversizedSource",
        source: "x".repeat(262_145),
      },
    });
    expect(oversizedResponse.status).toBe(413);
    expect((await oversizedResponse.json() as { error: { code: string } }).error.code).toBe("payload_too_large");
    expect(await readdir(resolve(dataDir, ".staging")).catch(() => [])).toEqual([]);
  });

  test("ищет кандидатов по intent и отдаёт компактные строки без исходника и схем", async () => {
    const { db, handler } = setup();
    seedRankingCatalog(db);

    const response = await post(handler, { designSystem: "cand-ds", intent: "кнопка оплаты заказа в карточке товара", limit: 3 });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control") ?? "").toContain("no-store");
    const body = (await response.json()) as CandidatesResponse;
    expect(body.designSystem).toBe("cand-ds");
    expect(body.policyVersion).toBe(1);
    expect(body.catalogRevision).toBe(collectCorpus(db, "cand-ds").catalogRevision);
    expect(body.candidates).toHaveLength(3);
    expect(body.candidates[0]).toMatchObject({ kind: "component", draft: false, deprecated: false, recommendable: true });
    // Ответ обязан оставаться компактным (спека §2): ни исходника, ни props-схем, ни примеров.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("propsJsonSchema");
    expect(raw).not.toContain("export default");
    expect(raw).not.toContain("signals");
  });

  /**
   * Приёмка решения калибровки (журнал плана §7, вопрос 2): итоговая политика даёт
   * `source: 0.75`, но при поиске по одному `intent` сигнал исходника **неприменим**, и
   * перенормировка оставляет имя с описанием. Тест фиксирует, что discovery-ранжирование от
   * доминирования `source` не пострадало.
   */
  test("ранжирование по одному intent: релевантные по описанию идут выше посторонних", async () => {
    const { db, handler } = setup();
    seedRankingCatalog(db);

    const body = (await (await post(handler, { designSystem: "cand-ds", intent: "оплата заказа кнопкой в карточке", limit: 6 })).json()) as CandidatesResponse;
    const order = body.candidates.map((candidate) => candidate.id);
    const relevant = ["cand-pay-button", "cand-pay-sheet", "cand-pay-status"];
    const irrelevant = ["cand-avatar", "cand-separator", "cand-map"];
    expect(order.slice(0, 3).sort()).toEqual([...relevant].sort());
    const worstRelevant = Math.min(...body.candidates.filter((candidate) => relevant.includes(candidate.id)).map((candidate) => candidate.score));
    const bestIrrelevant = Math.max(...body.candidates.filter((candidate) => irrelevant.includes(candidate.id)).map((candidate) => candidate.score));
    expect(worstRelevant).toBeGreaterThan(bestIrrelevant);

    // Другой intent — другой топ: ранжирование следует за описанием, а не за порядком в БД.
    const other = (await (await get(handler, "designSystem=cand-ds&intent=" + encodeURIComponent("разделитель между блоками списка"))).json()) as CandidatesResponse;
    expect(other.candidates[0]!.id).toBe("cand-separator");
    // При поиске по одному `intent` применим единственный сигнал — описание, и перенормировка
    // приравнивает score к его значению: дословное попадание даёт 0.8, что выше blocking-порога
    // 0.70 при весе описания 0.05 из 1.00. Порог здесь не применяется — blocking требует
    // структурных улик (props/io/source) либо роли/отпечатка, иначе discovery-поиск объявлял бы
    // «создавать нельзя» без единого структурного основания. Гейт это правило не ослабляет:
    // у него исходник и мета есть всегда.
    expect(other.candidates[0]).toMatchObject({ blocking: false, score: 0.8 });
    expect(other.candidates.slice(1).every((candidate) => candidate.score === 0 && !candidate.blocking)).toBe(true);
  });

  test("proposed с исходником поднимает копипасту в blocking", async () => {
    const { db, handler } = setup();
    seedRankingCatalog(db);
    const copy = sourceFor("CandPayButton", "cand-pay-button");

    const body = (await (await post(handler, {
      designSystem: "cand-ds", intent: "новая кнопка оплаты заказа", limit: 5,
      proposed: { kind: "component", id: "cand-pay-button-2", name: "CandPayButtonTwo", source: copy },
    })).json()) as CandidatesResponse;
    expect(body.candidates[0]).toMatchObject({ id: "cand-pay-button", blocking: true });
    expect(body.candidates[0]!.reasons.some((reason) => reason.includes("normalized source structure"))).toBe(true);
    // D4: сам оцениваемый артефакт исключается из корпуса по `(designSystem, id)`.
    const self = (await (await post(handler, {
      designSystem: "cand-ds", intent: "правка существующей кнопки оплаты", limit: 6,
      proposed: { kind: "component", id: "cand-pay-button", source: copy },
    })).json()) as CandidatesResponse;
    expect(self.candidates.map((candidate) => candidate.id)).not.toContain("cand-pay-button");
  });

  test("deprecated-кандидат возвращается для объяснения, но не как цель переиспользования", async () => {
    const { db, handler } = setup();
    seedComponent(db, "cand-old", "CandOld", { designSystem: "cand-ds", source: sourceFor("CandOld"), description: "Старая кнопка оплаты заказа" });
    // Компонент живёт в каталоге активной v1, но его последняя публикация — deprecated:
    // ровно та же семантика, что у `publishGroups` библиотеки.
    seedDeprecatingVersion(db, "cand-old", "cand-ds", "CandNew");
    seedComponent(db, "cand-new", "CandNew", { designSystem: "cand-ds", source: sourceFor("CandNew"), description: "Новая кнопка оплаты заказа" });

    const body = (await (await post(handler, { designSystem: "cand-ds", intent: "кнопка оплаты заказа", limit: 5 })).json()) as CandidatesResponse;
    const old = body.candidates.find((candidate) => candidate.id === "cand-old")!;
    expect(old).toMatchObject({ deprecated: true, recommendable: false });
    expect(old.reasons.some((reason) => reason.startsWith("deprecated"))).toBe(true);
  });

  test("head-драфт виден в выдаче с version 0", async () => {
    const { db, handler } = setup();
    seedComponent(db, "cand-draft", "CandPayDraft", { designSystem: "cand-ds", source: sourceFor("CandPayDraft"), publish: false });
    const body = (await (await post(handler, { designSystem: "cand-ds", intent: "кнопка оплаты заказа", limit: 5, proposed: { kind: "component", name: "CandPayDraft" } })).json()) as CandidatesResponse;
    expect(body.candidates).toEqual([expect.objectContaining({ id: "cand-draft", draft: true, version: 0 })]);
  });

  test("валидация входа: intent, limit, неизвестная система, композиции, метод", async () => {
    const { db, handler } = setup();
    seedSystem(db, "cand-retired-tmp", true);
    seedRankingCatalog(db);
    const code = async (response: Response) => ({ status: response.status, code: ((await response.json()) as { error: { code: string } }).error.code });

    expect(await code(await post(handler, { designSystem: "cand-ds", intent: "  корот  " }))).toEqual({ status: 422, code: "validation_failed" });
    // Стоп-набор: intent из одних родовых слов не описывает задачу.
    expect(await code(await post(handler, { designSystem: "cand-ds", intent: "компонент element ui" }))).toEqual({ status: 422, code: "validation_failed" });
    expect(await code(await post(handler, { designSystem: "cand-ds", intent: "кнопка оплаты заказа", limit: 0 }))).toEqual({ status: 422, code: "validation_failed" });
    expect(await code(await post(handler, { designSystem: "cand-ds", intent: "кнопка оплаты заказа", limit: 21 }))).toEqual({ status: 422, code: "validation_failed" });
    expect(await code(await post(handler, { designSystem: "cand-ds", intent: "кнопка оплаты заказа", unknown: 1 }))).toEqual({ status: 422, code: "validation_failed" });
    expect(await code(await post(handler, { designSystem: "cand-missing", intent: "кнопка оплаты заказа" }))).toEqual({ status: 404, code: "not_found" });
    expect(await code(await post(handler, { designSystem: "cand-retired-tmp", intent: "кнопка оплаты заказа" }))).toEqual({ status: 404, code: "not_found" });
    // W9: композиционный кандидат больше не отвергается — он получает рекомендательный исход.
    const composition = await post(handler, { designSystem: "cand-ds", intent: "кнопка оплаты заказа", proposed: { kind: "composition" } });
    expect(composition.status).toBe(200);
    expect(((await composition.json()) as { outcome: string }).outcome).toBe("build-composition");
    // Исходник — контракт компонента: у композиции тела в TSX нет.
    expect(await code(await post(handler, { designSystem: "cand-ds", intent: "кнопка оплаты заказа", proposed: { kind: "composition", source: "export default () => null;" } }))).toEqual({ status: 422, code: "validation_failed" });
    expect(await code(await get(handler, "designSystem=cand-ds&intent=" + encodeURIComponent("кнопка оплаты заказа") + "&limit=0"))).toEqual({ status: 422, code: "validation_failed" });
    expect(await code(await handler(new Request("http://test/api/catalog/candidates", { method: "DELETE", headers: { origin: "http://test" } })))).toEqual({ status: 405, code: "method_not_allowed" });

    // Границы limit: 1 и 20 допустимы.
    expect((await post(handler, { designSystem: "cand-ds", intent: "кнопка оплаты заказа", limit: 1 })).status).toBe(200);
    expect((await get(handler, "designSystem=cand-ds&intent=" + encodeURIComponent("кнопка оплаты заказа") + "&limit=20")).status).toBe(200);
    // Дефолт выдачи — 8 (спека §2): шести сидов хватает, чтобы отличить его от «всё подряд».
    const seeded = (await (await post(handler, { designSystem: "cand-ds", intent: "кнопка оплаты заказа" })).json()) as CandidatesResponse;
    expect(seeded.candidates).toHaveLength(6);
  });

  /**
   * Причина существования GET (план §4 T4): `enforceOrigin` (`main.ts:78`) срабатывает только
   * на unsafe-методах, поэтому вызывающий без браузерного Origin (агент, CLI) обязан иметь
   * работающий поисковый путь.
   */
  test("GET работает без заголовка Origin, POST без него — 403 origin_required", async () => {
    const { db } = setup();
    seedRankingCatalog(db);
    const session = new UserRepo(db).createSession(BOOTSTRAP_ADMIN_ID);
    const handler = createHandler(db, {});
    const headers = { cookie: `easyui_session=${session.token}` };
    const query = "designSystem=cand-ds&intent=" + encodeURIComponent("кнопка оплаты заказа");

    expect((await handler(new Request(`http://test/api/catalog/candidates?${query}`, { headers }))).status).toBe(200);
    const rejected = await handler(new Request("http://test/api/catalog/candidates", {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ designSystem: "cand-ds", intent: "кнопка оплаты заказа" }),
    }));
    expect(rejected.status).toBe(403);
    expect(((await rejected.json()) as { error: { code: string } }).error.code).toBe("origin_required");
  });

  /**
   * W9 (находка R1-M9): без композиций в корпусе дубль существующей композиции не
   * детектируется вовсе, и «три исхода» слепы к композициям.
   */
  test("дубль композиции: outcome build-composition с указанием существующей", async () => {
    const { db, handler } = setup();
    seedRankingCatalog(db);
    const existing = compositionDoc({ name: "CandPayRow", description: "Строка оплаты заказа с иконкой и кнопкой", params: { title: { type: "string", required: true } } });
    seedComposition(db, "cand-pay-row", "CandPayRow", existing, "cand-ds", true);

    // Тот же скелет, другие значения props и другое имя: сигнатура структурная, значения в неё
    // не входят — иначе переписанный литерал «чинил» бы дубль.
    const proposedDoc = compositionDoc({
      name: "CandPayRowTwo", description: "Ещё одна строка оплаты заказа", params: { title: { type: "string", required: true } },
      elements: {
        root: { type: "Overlay", props: { className: "line" }, children: ["title", "action"] },
        title: { type: "Image", props: { src: "b.png" } },
        action: { type: "Hotspot", props: { label: "Заплатить" } },
      },
    });
    const response = await post(handler, {
      designSystem: "cand-ds", intent: "строка оплаты заказа с иконкой и кнопкой", limit: 8,
      proposed: { kind: "composition", id: "cand-pay-row-2", name: "CandPayRowTwo", compositionDoc: proposedDoc },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as CandidatesResponse & {
      outcome: string; explanation: string;
      matches: { kind: string; id: string; score: number; blocking: boolean; why: string }[];
      analyzerVerdict?: string; dependencyImpact: { components: unknown[]; unknownTypes: string[] };
    };
    expect(body.outcome).toBe("build-composition");
    expect(body.explanation).toContain("cand-pay-row");
    const duplicate = body.matches.find((match) => match.id === "cand-pay-row")!;
    expect(duplicate).toMatchObject({ kind: "composition", blocking: true });
    expect(duplicate.why).toContain("identical composition body signature");
    // Вердикт анализатора едет в том же ответе (W8g), без второго запроса.
    expect(body.analyzerVerdict).toBe("composition");
    // Тело из одних host-примитивов: компонентов ДС в нём нет, зависимостей тоже.
    expect(body.dependencyImpact).toMatchObject({ components: [], unknownTypes: [] });
  });

  test("кросс-типовой мэтч: сильный кандидат-компонент даёт extend-component", async () => {
    const { db, handler } = setup();
    seedComponent(db, "cand-pay-row-component", "CandPayRow", {
      designSystem: "cand-ds", source: sourceFor("CandPayRow", "row"),
      description: "Строка оплаты заказа с иконкой и кнопкой",
      meta: { canonicalFor: ["payment-row"], atomicLevel: "molecule", propsJsonSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
    });

    const body = await (await post(handler, {
      designSystem: "cand-ds", intent: "строка оплаты заказа с иконкой и кнопкой",
      proposed: {
        kind: "composition", id: "cand-pay-row", name: "CandPayRow", canonicalFor: ["payment-row"],
        compositionDoc: compositionDoc({ name: "CandPayRow", description: "Строка оплаты заказа с иконкой и кнопкой", canonicalFor: ["payment-row"], params: { title: { type: "string", required: true } } }),
      },
    })).json() as { outcome: string; explanation: string; matches: { kind: string; id: string; blocking: boolean }[] };
    expect(body.outcome).toBe("extend-component");
    expect(body.explanation).toContain("cand-pay-row-component");
    expect(body.matches[0]).toMatchObject({ kind: "component", id: "cand-pay-row-component", blocking: true });
  });

  test("вердикт анализатора needs-ownership даёт new-ownership-component", async () => {
    const { db, handler } = setup();
    seedRankingCatalog(db);
    const doc = compositionDoc({
      name: "CandCarousel", description: "Карусель промо-баннеров с автопрокруткой",
      elements: {
        root: { type: "Overlay", props: { autoplayInterval: 3000 }, children: ["slide"] },
        slide: { type: "Image", props: { src: "promo.png" } },
      },
    });
    const body = await (await post(handler, {
      designSystem: "cand-ds", intent: "карусель промо баннеров с автопрокруткой",
      proposed: { kind: "composition", id: "cand-carousel", name: "CandCarousel", compositionDoc: doc },
    })).json() as { outcome: string; analyzerVerdict: string; analysis: { unsupported: { feature: string }[] } };
    expect(body.analyzerVerdict).toBe("needs-ownership-component");
    expect(body.outcome).toBe("new-ownership-component");
    expect(body.analysis.unsupported.map((entry) => entry.feature)).toContain("timer");
  });

  /**
   * План §1.2, A14: share- и capture-принципалы **не анонимны**, они проходят проверку
   * `main.ts:130` и без `requireUser` получили бы полный индекс каталога. HTTP-путь до роута у
   * них закрыт allowlist'ом ссылки, поэтому проверяется сам роут — именно он обязан отказать.
   */
  test("share- и capture-принципалы получают 403", async () => {
    const { db } = setup();
    seedRankingCatalog(db);
    const request = new Request("http://test/api/catalog/candidates?designSystem=cand-ds&intent=" + encodeURIComponent("кнопка оплаты заказа"));
    for (const principal of [
      { kind: "share" as const, scope: { grantId: "share_1", prototypeId: "p", version: 1, allowedUrls: ["/api/catalog/candidates"] } },
      { kind: "capture" as const, scope: { token: "t", allowedUrls: ["/api/catalog/candidates"] } },
      { kind: "anonymous" as const },
    ]) {
      const error = await routeCatalogCandidates(request, db, principal).then(() => null, (thrown: unknown) => thrown as ApiError);
      expect({ kind: principal.kind, status: error?.status, code: error?.code }).toEqual({ kind: principal.kind, status: 403, code: "forbidden" });
    }
  });
});
