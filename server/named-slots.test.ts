import { createTestHandler } from "./test-auth";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { catalogManifest } from "./routes/components";
import { toRuntimeSpec } from "../src/prototype/runtimeSpec";
import type { CaptureSlotTreeEntry } from "../src/capture/protocol";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function setup() { const dir = await mkdtemp(resolve(process.cwd(), ".named-slots-test-")); dirs.push(dir); const db = openDatabase(":memory:"); const handler = createTestHandler(db, { dataDir: dir }); return { dir, db, handler }; }
const req = (url: string, method = "GET", value?: unknown) => new Request(`http://test/api${url}`, { method, headers: value ? { "content-type": "application/json" } : undefined, body: value ? JSON.stringify(value) : undefined });
const fixture = (name: string) => Bun.file(resolve("server/fixtures", name)).text();

async function publishPanel(handler: (r: Request) => Promise<Response>) {
  expect((await handler(req("/components", "POST", {designSystem:"yandex-pay", id: "panel", name: "NamedSlotsPanel", source: await fixture("named-slots-panel.tsx"), intent:"Arranges product header and item content into named slots" }))).status).toBe(201);
  return handler(req("/components/panel/publish", "POST", { baseRev: 1 }));
}

const panelDoc = (slot: string) => ({
  version: 1, id: "slotted", name: "Slotted", designSystem: "yandex-pay", device: "desktop", startScreen: "home", state: {},
  screens: [{
    id: "home", name: "Home",
    spec: {
      root: "panel",
      elements: {
        panel: { type: "NamedSlotsPanel", props: { title: "Hi" }, children: ["h", "i", "d"] },
        h: { type: "Image", props: { src: "/header.png", alt: "Header" }, slot: "header" },
        i: { type: "Image", props: { src: "/item.png", alt: "Item" }, slot },
        d: { type: "Image", props: { src: "/default.png", alt: "Default" } },
      },
    },
  }],
});

// Волна 5 (B5): `@eui/Composition` — тоже допустимый slot-родитель. Список слотов берётся
// из документа композиции, а не из `definition.slots`, а раскрытие переносит размещение
// `@eui/Slot` на маршрутизированных детей — так named slots переживают раскрытие.
const compositionDoc = {
  version: 1,
  name: "SlottedPanelComposition",
  params: { title: { type: "string", required: true } },
  slots: ["header", "items"],
  spec: {
    root: "panel",
    elements: {
      panel: { type: "NamedSlotsPanel", props: { title: { $param: "title" } }, children: ["h", "i"] },
      h: { type: "@eui/Slot", props: { name: "header" }, slot: "header" },
      i: { type: "@eui/Slot", props: { name: "items" }, slot: "items" },
    },
  },
};

const compositionScreen = (slot: string) => ({
  version: 1, id: "slotted-composed", name: "Slotted composed", designSystem: "yandex-pay", device: "desktop", startScreen: "home", state: {},
  screens: [{
    id: "home", name: "Home",
    spec: {
      root: "c",
      elements: {
        c: { type: "@eui/Composition", props: { composition: "slotted-panel", params: { title: "Hi" } }, children: ["h", "i"] },
        h: { type: "Image", props: { src: "/header.png", alt: "Header" }, slot: "header" },
        i: { type: "Image", props: { src: "/item.png", alt: "Item" }, slot },
      },
    },
  }],
});

describe("named slots on @eui/Composition (волна 5)", () => {
  test("routes slotted children through the composition into the panel's own named slots", async () => {
    const { db, handler } = await setup();
    expect((await publishPanel(handler)).status).toBe(201);
    expect((await handler(req("/compositions", "POST", { id: "slotted-panel", designSystem: "yandex-pay", doc: compositionDoc }))).status).toBe(201);
    expect((await handler(req("/compositions/slotted-panel/publish", "POST", { baseRev: 1 }))).status).toBe(201);

    const created = await handler(req("/prototypes", "POST", { doc: compositionScreen("items") }));
    expect(created.status).toBe(201);
    // Пин компонента приехал через композицию, а сам документ остался авторским.
    expect(db.query("SELECT component_id id FROM prototype_revision_components WHERE prototype_id='slotted-composed' AND rev=1").all()).toEqual([{ id: "panel" }]);
    const stored = (db.query("SELECT doc FROM prototype_revisions WHERE prototype_id='slotted-composed' AND rev=1").get() as { doc: string }).doc;
    expect(stored).toContain("@eui/Composition");
    expect(stored).not.toContain("NamedSlotsPanel");
    db.close();
  });

  test("rejects a child routed into a slot the composition does not declare", async () => {
    const { db, handler } = await setup();
    expect((await publishPanel(handler)).status).toBe(201);
    expect((await handler(req("/compositions", "POST", { id: "slotted-panel", designSystem: "yandex-pay", doc: compositionDoc }))).status).toBe(201);
    expect((await handler(req("/compositions/slotted-panel/publish", "POST", { baseRev: 1 }))).status).toBe(201);
    const response = await handler(req("/prototypes", "POST", { doc: compositionScreen("footer") }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "validation_failed", issues: [{ message: "unknown slot for composition slotted-panel: footer" }] } });
    db.close();
  });
});

describe("named slots component + prototype save", () => {
  test("publishes a namedSlots component as ABI 2 by capability", async () => {
    const { db, handler } = await setup();
    const published = await publishPanel(handler);
    expect(published.status).toBe(201);
    expect(await published.json()).toMatchObject({ hostAbiVersion: 2 });
    const manifest = catalogManifest(db)[0] as { slots: string[]; capabilities?: Record<string, unknown>; hostAbiVersion: number };
    expect(manifest.slots).toEqual(["header", "items"]);
    expect(manifest.capabilities).toEqual({ namedSlots: true });
    expect(manifest.hostAbiVersion).toBe(2);
    db.close();
  });

  test("save accepts a prototype whose children carry slot fields", async () => {
    const { db, handler } = await setup();
    expect((await publishPanel(handler)).status).toBe(201);
    const response = await handler(req("/prototypes", "POST", { doc: panelDoc("items") }));
    expect(response.status).toBe(201);
    db.close();
  });

  test("save accepts nine default-slot children (карусель, план 2026-08-05 §A2a)", async () => {
    const { db, handler } = await setup();
    expect((await publishPanel(handler)).status).toBe(201);
    const keys = Array.from({ length: 9 }, (_, i) => `s${i}`);
    const response = await handler(req("/prototypes", "POST", { doc: {
      version: 1, id: "carousel", name: "Carousel", designSystem: "yandex-pay", device: "desktop", startScreen: "home", state: {},
      screens: [{ id: "home", name: "Home", spec: { root: "panel", elements: {
        panel: { type: "NamedSlotsPanel", props: { title: "Hi" }, children: keys },
        ...Object.fromEntries(keys.map((key, i) => [key, { type: "Image", props: { src: `/m${i}.png`, alt: `m${i}` } }])),
      } } }],
    } }));
    expect(response.status).toBe(201);
    db.close();
  });

  test("save rejects a prototype referencing an undeclared slot", async () => {
    const { db, handler } = await setup();
    expect((await publishPanel(handler)).status).toBe(201);
    const response = await handler(req("/prototypes", "POST", { doc: panelDoc("footer") }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "validation_failed", issues: [{ message: "unknown slot for NamedSlotsPanel: footer" }] } });
    db.close();
  });
});

/**
 * Слот-привязки случая приёмки (план 2026-08-05 §A6/§A2a). `CaptureComponent.tsx` собирает из
 * `bootstrap.slots.tree` многоэлементное дерево `c` + `s0…sN`; здесь та же форма прогоняется через
 * `toRuntimeSpec`, чтобы зафиксировать маршрутизацию, на которую опирается `easyUiRuntime`
 * (`slotIndices` → `slots[name]`, отсутствие ключа `slot` → неявный `default`).
 */
function captureSlotSpec(parent: string, tree: CaptureSlotTreeEntry[]) {
  const keys = tree.map((_, index) => `s${index}`);
  const elements: Record<string, unknown> = { c: { type: parent, props: { title: "Hi" }, children: keys } };
  tree.forEach((entry, index) => {
    elements[keys[index]!] = { type: entry.name, props: entry.props, ...(entry.slot ? { slot: entry.slot } : {}) };
  });
  return toRuntimeSpec({ root: "c", elements } as Parameters<typeof toRuntimeSpec>[0], { customTypes: new Set([parent, ...tree.map((e) => e.name)]) });
}

describe("capture slot bindings → runtimeSpec (план 2026-08-05 §A6)", () => {
  test("routes two children of a named slot", () => {
    const tree = captureSlotSpec("NamedSlotsPanel", [
      { slot: "items", index: 0, name: "Chip", props: { label: "one" } },
      { slot: "items", index: 1, name: "Chip", props: { label: "two" } },
    ]);
    expect(tree.metadata.c!.slotIndices).toEqual({ items: [0, 1] });
    expect(Object.keys(tree.spec.elements)).toEqual(["c", "s0", "s1"]);
    expect((tree.spec.elements.s0 as { props: Record<string, unknown> }).props.label).toBe("one");
  });

  test("mixes a named slot with default children", () => {
    const tree = captureSlotSpec("NamedSlotsPanel", [
      { slot: "header", index: 0, name: "Chip", props: {} },
      { index: 1, name: "Chip", props: {} },
    ]);
    // Ребёнок без ключа `slot` схлопывается в неявный `default` — канон §A2a.
    expect(tree.metadata.c!.slotIndices).toEqual({ header: [0], default: [1] });
  });

  test("carries nine default-slot children in render order", () => {
    const tree = captureSlotSpec("Carousel", Array.from({ length: 9 }, (_, index) => ({ index, name: "Chip", props: { label: `m${index}` } })));
    // Ни один ребёнок не несёт `slot`, поэтому индексная карта не строится вовсе и
    // `easyUiRuntime` отдаёт весь список как `slots.default`/`children`.
    expect(tree.metadata.c!.slotIndices).toBeUndefined();
    expect((tree.spec.elements.c as { children: string[] }).children).toEqual(Array.from({ length: 9 }, (_, i) => `s${i}`));
    expect(Object.keys(tree.spec.elements)).toHaveLength(10);
  });

  test("keeps the slot-free candidate tree single-element", () => {
    const tree = toRuntimeSpec({ root: "c", elements: { c: { type: "NamedSlotsPanel", props: { title: "Hi" } } } } as Parameters<typeof toRuntimeSpec>[0], { customTypes: new Set(["NamedSlotsPanel"]) });
    expect(Object.keys(tree.spec.elements)).toEqual(["c"]);
    expect(tree.metadata.c!.slotIndices).toBeUndefined();
  });
});
