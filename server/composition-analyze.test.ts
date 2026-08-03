import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { openDatabase } from "./db";
import { createTestHandler } from "./test-auth";
import { routeCompositions } from "./routes/compositions";
import { capabilities } from "./routes/meta";
import type { SharePrincipal } from "./auth";

/**
 * W8g (план 2026-08-03 §5): `POST /api/compositions/analyze` и
 * `POST /api/compositions/:id/preview-tree`.
 *
 * Обе ручки ничего не пишут, поэтому работают независимо от kill-switch'а
 * `EASYUI_COMPOSITION_V3`; preview-tree обязан отражать **фактическое** раскрытие
 * (ветки `when`, case'ы `$switch`, клоны `repeatParam`, слоты и token layout).
 */

const dirs: string[] = [];
const previousEnv = process.env.EASYUI_COMPOSITION_V3;
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  if (previousEnv === undefined) delete process.env.EASYUI_COMPOSITION_V3; else process.env.EASYUI_COMPOSITION_V3 = previousEnv;
});

const component = (db: Database, id: string, name: string, designSystem = "yandex-pay"): void => {
  db.query(`INSERT INTO components (id,name,head_rev,design_system,created_at,updated_at)
    VALUES (?,?,1,?,'now','now')`).run(id, name, designSystem);
  db.query(`INSERT INTO component_revisions (component_id,rev,source,design_system,created_at)
    VALUES (?,1,'export const definition = {}',?,'now')`).run(id, designSystem);
  db.query(`INSERT INTO component_publishes
    (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,published_at)
    VALUES (?,1,1,'active','','{}','source-hash',?,1,'now')`).run(id, `bundle-${id}`);
};

/** Тело v3 со всеми конструкциями, которые обязана показать трасса. */
const richDoc = {
  version: 3,
  name: "FAQ list",
  atomicLevel: "organism",
  params: {
    tone: { type: "enum", values: ["brand", "muted"], default: "brand" },
    items: { type: "array", items: { type: "object", schema: { text: { type: "string", required: true } } }, maxItems: 5, default: [] },
    "with-hint": { type: "boolean", default: true },
  },
  slots: { footer: { required: false } },
  spec: {
    root: "shell",
    elements: {
      shell: {
        type: "Leaf",
        props: { tone: { $switch: { param: "tone", cases: { brand: "accent", muted: "grey" } } } },
        layout: { flow: { kind: "flex", direction: "vertical" }, gap: "sm" },
        children: ["hint", "row", "footer-slot"],
      },
      hint: { type: "Leaf", props: { text: "Hint" }, when: { param: "with-hint", eq: true } },
      row: { type: "Leaf", props: { text: { $item: "text" } }, repeatParam: { param: "items" } },
      "footer-slot": { type: "@eui/Slot", props: { name: "footer" } },
    },
  },
};

async function fixture() {
  const dir = await mkdtemp(resolve(process.cwd(), ".composition-analyze-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  const handler = createTestHandler(db, { dataDir: dir });
  component(db, "leaf", "Leaf");
  const req = (url: string, method = "GET", value?: unknown) => handler(new Request(`http://test/api${url}`, {
    method,
    headers: value === undefined ? undefined : { "content-type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value),
  }));
  return { db, req };
}

describe("POST /api/compositions/analyze", () => {
  test("answers the three verdicts and works with the v3 kill-switch off", async () => {
    delete process.env.EASYUI_COMPOSITION_V3;
    const { req } = await fixture();

    const composition = await req("/compositions/analyze", "POST", { doc: richDoc, designSystem: "yandex-pay" });
    expect(composition.status).toBe(200);
    const analysis = await composition.json() as { verdict: string; reasons: { code: string }[]; unsupported: unknown[]; schemaValid: boolean; dependencyImpact: { components: unknown[]; unknownTypes: string[] } };
    expect(analysis.verdict).toBe("composition");
    expect(analysis.schemaValid).toBe(true);
    expect(analysis.unsupported).toEqual([]);
    expect(analysis.reasons.map((reason) => reason.code)).toContain("analyze/expressible");
    // Импакт зависимостей — существующий usages-механизм: компонент тела найден в ДС.
    expect(analysis.dependencyImpact.components).toEqual([{ componentId: "leaf", name: "Leaf", headUsageCount: 0, immutableUsageCount: 0, safeToRemove: true }]);
    expect(analysis.dependencyImpact.unknownTypes).toEqual([]);

    const extend = await req("/compositions/analyze", "POST", {
      doc: {
        version: 3, name: "Button", atomicLevel: "molecule", slots: [],
        params: { label: { type: "string", default: "Pay" } },
        spec: { root: "button", elements: { button: { type: "Leaf", props: { label: { $param: "label" } } } } },
      },
    });
    expect((await extend.json() as { verdict: string }).verdict).toBe("extend-component");

    const ownership = await req("/compositions/analyze", "POST", {
      doc: {
        version: 3, name: "Poller", atomicLevel: "molecule", slots: [], params: {},
        spec: { root: "row", elements: { row: { type: "Leaf", props: {}, on: { press: { action: "refreshBalance" } } } } },
      },
    });
    const ownershipBody = await ownership.json() as { verdict: string; unsupported: { feature: string; hint: string }[] };
    expect(ownershipBody.verdict).toBe("needs-ownership-component");
    expect(ownershipBody.unsupported[0]!.feature).toBe("custom-action");
    expect(ownershipBody.unsupported[0]!.hint.length).toBeGreaterThan(20);
  });

  test("reports unknown component types of the design system without failing the analysis", async () => {
    const { req } = await fixture();
    const response = await req("/compositions/analyze", "POST", {
      designSystem: "yandex-pay",
      doc: {
        version: 3, name: "Mixed", atomicLevel: "molecule", slots: [], params: {},
        spec: { root: "row", elements: { row: { type: "Leaf", props: {}, children: ["ghost"] }, ghost: { type: "NotPublished", props: {} } } },
      },
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { dependencyImpact: { unknownTypes: string[] } }).dependencyImpact.unknownTypes).toEqual(["NotPublished"]);
  });

  test("rejects unknown fields, a missing doc and an unknown design system", async () => {
    const { req } = await fixture();
    expect((await req("/compositions/analyze", "POST", { doc: {}, nope: 1 })).status).toBe(400);
    expect((await req("/compositions/analyze", "POST", {})).status).toBe(400);
    expect((await req("/compositions/analyze", "POST", { doc: {}, designSystem: "nope" })).status).toBe(422);
  });

  test("is exposed in capabilities.features.compositionAnalyze", async () => {
    const { db } = await fixture();
    expect((capabilities(db).features as Record<string, unknown>).compositionAnalyze).toBe(true);
  });

  test("a share principal is refused (403)", async () => {
    const { db } = await fixture();
    const principal: SharePrincipal = { kind: "share", scope: { grantId: "g", prototypeId: "p", version: 1, allowedUrls: [] } };
    const response = await routeCompositions(
      new Request("http://test/api/compositions/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc: {} }) }),
      db, ["compositions", "analyze"], principal,
    ).catch((error: { status?: number; code?: string }) => error);
    expect((response as { status?: number }).status).toBe(403);
    expect((response as { code?: string }).code).toBe("forbidden");
  });
});

describe("POST /api/compositions/:id/preview-tree", () => {
  const create = async (req: (url: string, method?: string, value?: unknown) => Promise<Response>) => {
    process.env.EASYUI_COMPOSITION_V3 = "1";
    const created = await req("/compositions", "POST", { id: "faq", designSystem: "yandex-pay", doc: richDoc });
    expect(created.status).toBe(201);
  };

  test("mirrors the actual expansion: branches, switches, repeat clones, slots and layout", async () => {
    const { req } = await fixture();
    await create(req);
    // Ручка не пишет — флаг записи v3 для неё безразличен.
    delete process.env.EASYUI_COMPOSITION_V3;

    const response = await req("/compositions/faq/preview-tree", "POST", {
      params: { tone: "muted", "with-hint": false, items: [{ text: "One" }, { text: "Two" }] },
    });
    expect(response.status).toBe(200);
    const preview = await response.json() as {
      compositionId: string; rev: number; designSystem: string;
      resolvedParams: Record<string, unknown>;
      chosenBranches: { elementKey: string; taken: boolean }[];
      switches: { elementKey: string; prop: string; param: string; case: string }[];
      repeatExpansions: { elementKey: string; param: string; count: number }[];
      slotBindings: { slot: string; compositionId: string; required: boolean; filled: boolean; fallbackUsed: boolean }[];
      layoutOwners: { elementKey: string; props: Record<string, unknown> }[];
      expandedTree: { root: string; elements: Record<string, { type: string; props: Record<string, unknown> }> };
      issues: unknown[];
    };

    expect(preview).toMatchObject({ compositionId: "faq", rev: 1, designSystem: "yandex-pay" });
    expect(preview.resolvedParams.tone).toBe("muted");
    expect(preview.chosenBranches).toEqual([{ elementKey: "host$hint", compositionId: "faq", when: { param: "with-hint", eq: true }, taken: false } as never]);
    expect(preview.switches).toEqual([{ elementKey: "host$shell", prop: "tone", param: "tone", case: "muted" }]);
    expect(preview.repeatExpansions).toEqual([{ elementKey: "host$row", param: "items", count: 2 }]);
    // Точки ссылки у превью нет: слот показывается декларативно.
    expect(preview.slotBindings).toEqual([{ slot: "footer", compositionId: "faq", required: false, filled: false, fallbackUsed: false }]);
    expect(preview.layoutOwners[0]).toMatchObject({ elementKey: "host$shell", type: "Leaf" });
    expect(preview.layoutOwners[0]!.props).toMatchObject({ direction: "vertical", gap: "sm" });
    // Диагностика раскрытия доезжает как есть: тестовый `Leaf` не объявляет layout-контракт v1.
    expect(preview.issues).toEqual([{
      code: "composition/layout-unsupported",
      message: "composition faq: element type Leaf does not declare the layout contract v1 and cannot take a token layout",
      path: ["screens", "0", "spec", "elements", "host$shell", "layout"],
    } as never]);

    // Раскрытое дерево — фактическое: ложная ветка снята, клоны на месте, `$switch` подставлен.
    const keys = Object.keys(preview.expandedTree.elements).sort();
    expect(preview.expandedTree.root).toBe("host$shell");
    expect(keys).toEqual(["host$row__r0", "host$row__r1", "host$shell"]);
    expect(preview.expandedTree.elements["host$shell"]!.props.tone).toBe("grey");
    expect(preview.expandedTree.elements["host$row__r0"]!.props.text).toBe("One");
  });

  test("defaults resolve params when the request omits them", async () => {
    const { req } = await fixture();
    await create(req);
    const preview = await (await req("/compositions/faq/preview-tree", "POST", {})).json() as {
      resolvedParams: Record<string, unknown>;
      chosenBranches: { taken: boolean }[];
      switches: { case: string }[];
    };
    expect(preview.resolvedParams).toEqual({ tone: "brand", items: [], "with-hint": true });
    expect(preview.chosenBranches).toEqual([{ elementKey: "host$hint", compositionId: "faq", when: { param: "with-hint", eq: true }, taken: true } as never]);
    expect(preview.switches[0]!.case).toBe("brand");
  });

  test("validates the request and answers 404 for an unknown composition or revision", async () => {
    const { req } = await fixture();
    await create(req);
    expect((await req("/compositions/faq/preview-tree", "POST", { nope: 1 })).status).toBe(400);
    expect((await req("/compositions/faq/preview-tree", "POST", { params: [] })).status).toBe(400);
    expect((await req("/compositions/faq/preview-tree", "POST", { variant: { size: 2 } })).status).toBe(400);
    expect((await req("/compositions/faq/preview-tree", "GET")).status).toBe(405);

    const unknown = await req("/compositions/other/preview-tree", "POST", {});
    expect(unknown.status).toBe(404);
    expect((await unknown.json() as { error: { code: string } }).error.code).toBe("not_found");

    const noRevision = await req("/compositions/faq/preview-tree", "POST", { rev: 7 });
    expect(noRevision.status).toBe(404);
    expect((await noRevision.json() as { error: { code: string } }).error.code).toBe("revision_not_found");
  });

  test("a share principal is refused (403)", async () => {
    const { db, req } = await fixture();
    await create(req);
    const principal: SharePrincipal = { kind: "share", scope: { grantId: "g", prototypeId: "p", version: 1, allowedUrls: [] } };
    const response = await routeCompositions(
      new Request("http://test/api/compositions/faq/preview-tree", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      db, ["compositions", "faq", "preview-tree"], principal,
    ).catch((error: { status?: number }) => error);
    expect((response as { status?: number }).status).toBe(403);
  });
});
