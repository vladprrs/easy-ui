import { createTestHandler } from "./test-auth";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { catalogManifest } from "./routes/components";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function setup() { const dir = await mkdtemp(resolve(process.cwd(), ".named-slots-test-")); dirs.push(dir); const db = openDatabase(":memory:"); const handler = createTestHandler(db, { dataDir: dir }); return { dir, db, handler }; }
const req = (url: string, method = "GET", value?: unknown) => new Request(`http://test/api${url}`, { method, headers: value ? { "content-type": "application/json" } : undefined, body: value ? JSON.stringify(value) : undefined });
const fixture = (name: string) => Bun.file(resolve("server/fixtures", name)).text();

async function publishPanel(handler: (r: Request) => Promise<Response>) {
  expect((await handler(req("/components", "POST", { id: "panel", name: "NamedSlotsPanel", source: await fixture("named-slots-panel.tsx") }))).status).toBe(201);
  return handler(req("/components/panel/publish", "POST", { baseRev: 1 }));
}

const panelDoc = (slot: string) => ({
  version: 1, id: "slotted", name: "Slotted", designSystem: "shadcn", device: "desktop", startScreen: "home", state: {},
  screens: [{
    id: "home", name: "Home",
    spec: {
      root: "panel",
      elements: {
        panel: { type: "NamedSlotsPanel", props: { title: "Hi" }, children: ["h", "i", "d"] },
        h: { type: "Text", props: { text: "Header" }, slot: "header" },
        i: { type: "Text", props: { text: "Item" }, slot },
        d: { type: "Text", props: { text: "Default" } },
      },
    },
  }],
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

  test("save rejects a prototype referencing an undeclared slot", async () => {
    const { db, handler } = await setup();
    expect((await publishPanel(handler)).status).toBe(201);
    const response = await handler(req("/prototypes", "POST", { doc: panelDoc("footer") }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "validation_failed", issues: [{ message: "unknown slot for NamedSlotsPanel: footer" }] } });
    db.close();
  });
});
