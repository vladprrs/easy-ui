import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { prototypeDocSchema } from "../src/prototype/schema";
import { emptyComponentManifestHash } from "./builtinHash";
import { openDatabase } from "./db";
import { createHandler } from "./main";
import { ComponentRepo } from "./repos/components";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function setup() {
  const dir = await mkdtemp(resolve(process.cwd(), ".host-primitives-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  return { db, handler: createHandler(db, { dataDir: dir }) };
}

const request = (url: string, method = "GET", value?: unknown) => new Request(`http://test/api${url}`, {
  method,
  headers: value === undefined ? undefined : { "content-type": "application/json" },
  body: value === undefined ? undefined : JSON.stringify(value),
});

const overlayDocument = (placement: "top" | "bottom") => prototypeDocSchema.parse({
  version: 1,
  id: "overlay-cycle",
  name: "Overlay lifecycle",
  designSystem: "shadcn",
  device: "mobile",
  startScreen: "main",
  state: {},
  screens: [{
    id: "main",
    name: "Main",
    spec: {
      root: "root",
      elements: {
        root: { type: "Stack", props: {}, children: ["body", "overlay"] },
        body: { type: "Text", props: { text: "Body" } },
        overlay: { type: "Overlay", props: { placement, inset: "md", scrim: false }, children: ["notice"] },
        notice: { type: "Text", props: { text: "Notice" } },
      },
    },
  }],
});

describe("host primitive API lifecycle", () => {
  test("creates, saves and publishes Overlay without component pins or manifest exposure", async () => {
    const { db, handler } = await setup();
    const created = await handler(request("/prototypes", "POST", { doc: overlayDocument("top") }));
    expect(created.status).toBe(201);
    const first = await (await handler(request("/prototypes/overlay-cycle/draft"))).json() as {
      rev: number; components: unknown[]; componentManifestHash: string; builtinCatalogHash: string;
    };
    expect(first.components).toEqual([]);
    expect(first.componentManifestHash).toBe(emptyComponentManifestHash);

    const saved = await handler(request("/prototypes/overlay-cycle", "PUT", { baseRev: 1, doc: overlayDocument("bottom") }));
    expect(saved.status).toBe(200);
    const second = await (await handler(request("/prototypes/overlay-cycle/draft"))).json() as typeof first;
    expect(second.rev).toBe(2);
    expect(second.components).toEqual([]);
    expect(second.componentManifestHash).toBe(emptyComponentManifestHash);
    expect(second.builtinCatalogHash).toBe(first.builtinCatalogHash);

    expect((await handler(request("/prototypes/overlay-cycle/publish", "POST", { baseRev: 2 }))).status).toBe(201);
    const published = await (await handler(request("/prototypes/overlay-cycle/versions/1"))).json() as typeof first;
    expect(published.components).toEqual([]);
    expect(published.componentManifestHash).toBe(emptyComponentManifestHash);

    const manifest = await (await handler(request("/catalog/manifest?designSystem=shadcn"))).json() as { components: { name: string }[] };
    expect(manifest.components.some((component) => component.name === "Overlay")).toBeFalse();
    const summary = await (await handler(request("/design-systems/shadcn"))).json() as { hostPrimitives: unknown[] };
    expect(summary.hostPrimitives).toEqual([]);
    expect(JSON.stringify(summary)).not.toContain('"Overlay"');
    db.close();
  });

  test("reserves host primitive names on create, update and publish, including legacy rows", async () => {
    const { db, handler } = await setup();
    const source = await Bun.file(resolve("server/fixtures/rating-stars.tsx")).text();
    const create = await handler(request("/components", "POST", { id: "overlay", name: "Overlay", source }));
    expect(create.status).toBe(409);

    new ComponentRepo(db).create("legacy-overlay", "Overlay", source);
    const update = await handler(request("/components/legacy-overlay", "PUT", { baseRev: 1, source: source.replace("five-star", "changed") }));
    expect(update.status).toBe(409);
    const publish = await handler(request("/components/legacy-overlay/publish", "POST", { baseRev: 1 }));
    expect(publish.status).toBe(409);
    for (const response of [create, update, publish]) {
      expect(await response.json()).toMatchObject({ error: { code: "already_exists" } });
    }
    db.close();
  });
});
