import { createTestHandler } from "./test-auth";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { prototypeDocSchema } from "../src/prototype/schema";
import { emptyComponentManifestHash } from "./builtinHash";
import { openDatabase } from "./db";
import { ComponentRepo } from "./repos/components";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function setup() {
  const dir = await mkdtemp(resolve(process.cwd(), ".host-primitives-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  return { db, handler: createTestHandler(db, { dataDir: dir }) };
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
  designSystem: "yandex-pay",
  device: "mobile",
  startScreen: "main",
  state: {},
  screens: [{
    id: "main",
    name: "Main",
    spec: {
      root: "root",
      elements: {
        root: { type: "Image", props: { src: "/body.png", alt: "Body" }, children: ["overlay"] },
        overlay: { type: "Overlay", props: { placement, inset: "md", scrim: false }, children: ["notice"] },
        notice: { type: "Image", props: { src: "/notice.png", alt: "Notice" } },
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

    const manifest = await (await handler(request("/catalog/manifest?designSystem=yandex-pay"))).json() as { components: { name: string }[] };
    expect(manifest.components.some((component) => component.name === "Overlay")).toBeFalse();
    expect((await handler(request("/design-systems", "POST", { id: "custom-host", name: "Custom host", description: "Custom design system" }))).status).toBe(201);
    const discovery = await (await handler(request("/design-systems"))).json() as {
      designSystems: { id: string; components: { name: string }[]; hostPrimitives: Record<string,unknown>[] }[];
    };
    expect(discovery.designSystems.length).toBeGreaterThanOrEqual(2);
    for (const system of discovery.designSystems) {
      expect(system.hostPrimitives).toHaveLength(3);
      expect(system.hostPrimitives).toEqual(expect.arrayContaining([expect.objectContaining({
        name: "Overlay",
        description: "Viewport-anchored content rendered into the current stage host.",
        atomicLevel: "atom",
        layoutNeutral: true,
        slots: ["default"],
        propsJsonSchema: expect.objectContaining({
          type: "object",
          properties: expect.objectContaining({
            placement: expect.objectContaining({ enum: ["top", "bottom", "center", "top-left", "top-right", "bottom-left", "bottom-right"] }),
            inset: expect.objectContaining({ default: "md" }),
            scrim: expect.objectContaining({ default: false }),
          }),
        }),
      }), expect.objectContaining({ name: "Image" }), expect.objectContaining({ name: "Hotspot" })]));
      expect(system.components.some((component) => component.name === "Overlay")).toBeFalse();
      const detail = await (await handler(request(`/design-systems/${system.id}`))).json() as typeof system;
      expect(detail.hostPrimitives).toEqual(system.hostPrimitives);
    }
    db.close();
  });

  test("reserves host primitive names on create, update and publish, including legacy rows", async () => {
    const { db, handler } = await setup();
    const source = await Bun.file(resolve("server/fixtures/rating-stars.tsx")).text();
    const create = await handler(request("/components", "POST", {designSystem:"yandex-pay", id: "overlay", name: "Overlay", source }));
    expect(create.status).toBe(409);
    for (const name of ["Image", "Hotspot"]) {
      const response = await handler(request("/components", "POST", {designSystem:"yandex-pay", id: `host-${name.toLowerCase()}`, name, source }));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "already_exists" } });
    }

    new ComponentRepo(db).create("legacy-overlay", "Overlay", source, "yandex-pay");
    const update = await handler(request("/components/legacy-overlay", "PUT", { baseRev: 1, source: source.replace("five-star", "changed") }));
    expect(update.status).toBe(409);
    const publish = await handler(request("/components/legacy-overlay/publish", "POST", { baseRev: 1 }));
    expect(publish.status).toBe(409);
    for (const response of [create, update, publish]) {
      expect(await response.json()).toMatchObject({ error: { code: "already_exists" } });
    }
    db.close();
  });

  test("saves host Image and flow Hotspot in a custom-only design system without pins", async () => {
    const { db, handler } = await setup();
    expect((await handler(request("/design-systems", "POST", { id: "host-only", name: "Host only", description: "Host content only" }))).status).toBe(201);
    const doc = prototypeDocSchema.parse({
      version: 1, id: "host-content", name: "Host content", designSystem: "host-only", device: "desktop", startScreen: "image", state: {},
      screens: [
        { id: "image", name: "Image", spec: { root: "image", elements: { image: { type: "Image", props: { src: "/images/host.png", alt: "Host", objectFit: "cover" } } } } },
        { id: "hotspot", name: "Hotspot", spec: { root: "hotspot", elements: { hotspot: { type: "Hotspot", props: { x: 0, y: 0, width: 20, height: 20, ariaLabel: "Open" } } } } },
      ],
    });
    expect((await handler(request("/prototypes", "POST", { doc }))).status).toBe(201);
    const saved = await (await handler(request("/prototypes/host-content/draft"))).json() as { components: unknown[]; componentManifestHash: string };
    expect(saved.components).toEqual([]);
    expect(saved.componentManifestHash).toBe(emptyComponentManifestHash);
    db.close();
  });
});
