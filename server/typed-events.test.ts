import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { createHandler } from "./main";
import { catalogManifest } from "./routes/components";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function setup() { const dir = await mkdtemp(resolve(process.cwd(), ".typed-events-test-")); dirs.push(dir); const db = openDatabase(":memory:"); const handler = createHandler(db, { dataDir: dir }); return { dir, db, handler }; }
const req = (url: string, method = "GET", value?: unknown) => new Request(`http://test/api${url}`, { method, headers: value ? { "content-type": "application/json" } : undefined, body: value ? JSON.stringify(value) : undefined });
const fixture = (name: string) => Bun.file(resolve("server/fixtures", name)).text();

describe("typed event payloads + ABI v2", () => {
  test("publishes typed events with a serialized eventPayloads schema, ABI 2 via capabilities", async () => {
    const { db, handler } = await setup();
    expect((await handler(req("/components", "POST", { id: "typed-stars", name: "TypedStars", source: await fixture("typed-events-stars.tsx") }))).status).toBe(201);
    const published = await handler(req("/components/typed-stars/publish", "POST", { baseRev: 1 }));
    expect(published.status).toBe(201);
    expect(await published.json()).toMatchObject({ hostAbiVersion: 2 });

    // eventPayloads is present in the manifest and read-back, events stays a string[].
    const manifest = catalogManifest(db)[0] as { events: string[]; eventPayloads?: Record<string, unknown>; hostAbiVersion: number; capabilities?: Record<string, unknown> };
    expect(manifest.events).toEqual(["rate"]);
    expect(manifest.hostAbiVersion).toBe(2);
    expect(manifest.capabilities).toEqual({ typedEvents: true });
    expect(manifest.eventPayloads?.rate).toMatchObject({ type: "object" });

    const version = await (await handler(req("/components/typed-stars/versions/1"))).json() as { eventPayloads?: Record<string, unknown>; hostAbiVersion: number };
    expect(version.eventPayloads?.rate).toBeDefined();
    expect(version.hostAbiVersion).toBe(2);
    db.close();
  });

  test("rejects a non-serializable event payload schema with event_schema_not_serializable", async () => {
    const { db, handler } = await setup();
    const response = await handler(req("/components", "POST", { id: "bad-event", name: "BadEvent", source: await fixture("nonserializable-event.tsx") }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "event_schema_not_serializable" } });
    db.close();
  });

  test("computes host ABI 2 from an easy-ui/runtime import and maps shims to v2", async () => {
    const { db, handler } = await setup();
    expect((await handler(req("/components", "POST", { id: "token-user", name: "TokenUser", source: await fixture("token-import.tsx") }))).status).toBe(201);
    const published = await handler(req("/components/token-user/publish", "POST", { baseRev: 1 }));
    expect(published.status).toBe(201);
    expect(await published.json()).toMatchObject({ hostAbiVersion: 2 });
    const bundle = await handler(req("/components/token-user/versions/1/bundle.js"));
    const js = await bundle.text();
    expect(js).toContain("/api/shims/v2/easy-ui-runtime.js");
    expect(js).toContain("/api/shims/v2/react-jsx-runtime.js");
    expect(js).not.toContain("/api/shims/v1/");
    db.close();
  });

  test("legacy string[] events publish as ABI 1 with no eventPayloads", async () => {
    const { db, handler } = await setup();
    expect((await handler(req("/components", "POST", { id: "rating-stars", name: "RatingStars", source: await fixture("rating-stars.tsx") }))).status).toBe(201);
    const published = await handler(req("/components/rating-stars/publish", "POST", { baseRev: 1 }));
    expect(await published.json()).toMatchObject({ hostAbiVersion: 1 });
    const manifest = catalogManifest(db)[0] as { events: string[]; eventPayloads?: unknown; hostAbiVersion: number };
    expect(manifest.events).toEqual(["press"]);
    expect(manifest.eventPayloads).toBeUndefined();
    expect(manifest.hostAbiVersion).toBe(1);
    db.close();
  });
});

describe("shims v2 endpoint", () => {
  test("serves v2 standard shims and the easy-ui-runtime module", async () => {
    const { db, handler } = await setup();
    const react = await handler(req("/shims/v2/react.js"));
    expect(react.status).toBe(200);
    expect(react.headers.get("content-type")).toContain("javascript");
    const runtime = await handler(req("/shims/v2/easy-ui-runtime.js"));
    expect(runtime.status).toBe(200);
    const runtimeJs = await runtime.text();
    expect(runtimeJs).toContain("export function token");
    expect(runtimeJs).toContain("export function Icon");
    // v1 has no easy-ui-runtime module.
    expect((await handler(req("/shims/v1/easy-ui-runtime.js"))).status).toBe(404);
    db.close();
  });

  test("serves ABI v3 standard and runtime shims", async () => {
    const { db, handler } = await setup();
    expect((await handler(req("/shims/v3/react.js"))).status).toBe(200);
    const runtime = await handler(req("/shims/v3/easy-ui-runtime.js"));
    expect(runtime.status).toBe(200);
    const source = await runtime.text();
    expect(source).toContain("export function token");
    expect(source).toContain("export function space");
    expect(source).toContain("var(--eui-space-");
    db.close();
  });
});
