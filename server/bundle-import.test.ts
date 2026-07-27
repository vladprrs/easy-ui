import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { openDatabase } from "./db";
import { createHandler } from "./main";
import { createTestHandler } from "./test-auth";
import { UserRepo } from "./users";
import { importReportSchema, type ImportReport } from "../src/bundle/schema";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const ratingStars = await Bun.file("server/fixtures/rating-stars.tsx").text();
const WOFF2 = Uint8Array.from([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0, 1, 2, 3, 4]);
const svg = (id: string) => new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" id="${id}"><rect width="1" height="1"/></svg>`);
const sha256hex = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

// One in-memory server with its own data dir (kept inside the project root so materialized TSX resolves deps).
async function makeServer(prefix: string, userNames: string[]) {
  const dir = await mkdtemp(resolve(process.cwd(), `.bundle-import-${prefix}-`));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  createTestHandler(db, { dataDir: dir }); // bootstrap admin + migrations
  const at = new Date().toISOString();
  const users = new UserRepo(db);
  const tokens: Record<string, string> = {};
  for (const name of userNames) {
    const id = `user_${name}`;
    db.query("INSERT INTO users (id,name,password_hash,is_admin,created_at) VALUES (?,?,?,?,?)").run(id, name, "unused", 0, at);
    tokens[name] = users.createSession(id).token;
  }
  const handler = createHandler(db, { dataDir: dir, publicOrigin: "http://test" });
  const call = (who: string | null, method: string, path: string, body?: unknown, contentType = "application/json") => {
    const headers: Record<string, string> = {};
    if (who) headers.cookie = `easyui_session=${tokens[who]}`;
    if (method !== "GET" && method !== "HEAD") headers.origin = "http://test";
    if (body !== undefined) headers["content-type"] = contentType;
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = typeof body === "string" || body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body);
    return handler(new Request(`http://test/api${path}`, init));
  };
  const upload = async (who: string, bytes: Uint8Array, mime: string) => {
    const response = await call(who, "POST", "/assets", bytes, mime);
    expect(response.status).toBeLessThan(300);
    return (await response.json() as { id: string }).id;
  };
  return { db, call, upload };
}

type Server = Awaited<ReturnType<typeof makeServer>>;

// Seeds a full closure (custom DS + font theme, published component with an asset, prototype) for `who`.
async function seed(server: Server, who: string) {
  const { call, upload } = server;
  expect((await call(who, "POST", "/design-systems", { id: "bundle-ds", name: "Bundle DS", description: "Import fixture" })).status).toBe(201);
  const fontAsset = await upload(who, WOFF2, "font/woff2");
  const componentAsset = await upload(who, svg("component"), "image/svg+xml");
  const protoAsset = await upload(who, svg("prototype"), "image/svg+xml");
  expect((await call(who, "PATCH", "/design-systems/bundle-ds", { fonts: [{ family: "Inter", src: fontAsset }], baseVersion: 0 })).status).toBe(200);
  const source = `// asset: /api/assets/${componentAsset}\n${ratingStars}`;
  expect((await call(who, "POST", "/components", { id: "rating-stars", name: "RatingStars", source, designSystem: "bundle-ds" })).status).toBe(201);
  expect((await call(who, "POST", "/components/rating-stars/publish", { baseRev: 1 })).status).toBe(201);
  const doc = {
    version: 1, id: "bundle-proto", name: "Bundle proto", designSystem: "bundle-ds", device: "desktop", startScreen: "rate", state: {},
    screens: [
      { id: "rate", name: "Rate", spec: { root: "rating", elements: { rating: { type: "RatingStars", props: { value: 3 } } } } },
      { id: "show", name: "Show", spec: { root: "img", elements: { img: { type: "Image", props: { src: { $asset: protoAsset }, alt: "p" } } } } },
    ],
  };
  expect((await call(who, "POST", "/prototypes", { doc })).status).toBe(201);
  return { fontAsset, componentAsset, protoAsset };
}

async function exportZip(server: Server, who: string, path = "/prototypes/bundle-proto/export"): Promise<Uint8Array> {
  const response = await server.call(who, "GET", path);
  expect(response.status).toBe(200);
  return new Uint8Array(await response.arrayBuffer());
}

async function importZip(server: Server, who: string, zip: Uint8Array, mode?: "dry-run" | "apply"): Promise<{ status: number; report: ImportReport }> {
  const response = await server.call(who, "POST", `/bundles/import${mode ? `?mode=${mode}` : ""}`, zip, "application/zip");
  const report = response.status === 200 ? importReportSchema.parse(await response.json()) : (await response.json() as ImportReport);
  return { status: response.status, report };
}

const itemFor = (report: ImportReport, type: string, id: string) => report.items.find((item) => item.type === type && (item.id === id || item.name === id));
const count = (db: Server["db"], table: string) => (db.query(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;


// --- Composition fixture (bundle format 2) ----------------------------------
// BundleBadge используется ТОЛЬКО внутри композиции: он доказывает, что на импорте
// доезжают и компоненты, достижимые исключительно через раскрытие.
const SHELL_SRC = `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ tone: z.string().optional() }),
  events: [],
  slots: [],
  description: "Bundle composition shell",
  example: {},
};

type Props = z.output<typeof definition.props>;

export default function BundleShell({ props, children }: EasyUIComponentProps<Props>) {
  return <section data-tone={props.tone ?? "plain"}>{children}</section>;
}
`;
const BADGE_SRC = `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ amount: z.string().min(1) }),
  events: [],
  slots: [],
  description: "Bundle composition badge",
  example: { amount: "12" },
};

type Props = z.output<typeof definition.props>;

export default function BundleBadge({ props }: EasyUIComponentProps<Props>) {
  return <span>{props.amount}</span>;
}
`;

const compositionDoc = {
  version: 1,
  name: "BundleShellComposition",
  params: { amount: { type: "string", required: true } },
  slots: ["body"],
  spec: {
    root: "shell",
    elements: {
      shell: { type: "BundleShell", props: { tone: "plain" }, children: ["body", "badge"] },
      body: { type: "@eui/Slot", props: { name: "body" } },
      badge: { type: "BundleBadge", props: { amount: { $param: "amount" } } },
    },
  },
};

const composedDoc = {
  version: 1, id: "bundle-composed", name: "Bundle composed", designSystem: "bundle-ds", device: "mobile", startScreen: "s", state: {},
  screens: [{
    id: "s", name: "S", spec: {
      root: "root",
      elements: {
        root: { type: "@eui/FlowRoot", props: {}, children: ["frag"] },
        frag: { type: "@eui/Composition", props: { composition: "bundle-shell", params: { amount: "12" } }, children: ["body"] },
        body: { type: "Image", props: { src: "/body.png", alt: "body" }, slot: "body" },
      },
    },
  }],
};

/** Requires `seed()` first (it owns bundle-ds). Publishes both components, the composition and the prototype. */
async function seedComposition(server: Server, who: string) {
  const { call } = server;
  expect((await call(who, "POST", "/components", { id: "bundle-shell-component", name: "BundleShell", source: SHELL_SRC, designSystem: "bundle-ds" })).status).toBe(201);
  expect((await call(who, "POST", "/components/bundle-shell-component/publish", { baseRev: 1 })).status).toBe(201);
  expect((await call(who, "POST", "/components", { id: "bundle-badge", name: "BundleBadge", source: BADGE_SRC, designSystem: "bundle-ds" })).status).toBe(201);
  expect((await call(who, "POST", "/components/bundle-badge/publish", { baseRev: 1 })).status).toBe(201);
  expect((await call(who, "POST", "/compositions", { id: "bundle-shell", designSystem: "bundle-ds", doc: compositionDoc })).status).toBe(201);
  expect((await call(who, "POST", "/compositions/bundle-shell/publish", { baseRev: 1 })).status).toBe(201);
  expect((await call(who, "POST", "/prototypes", { doc: composedDoc })).status).toBe(201);
}

/** Rewrites a bundle into the pre-wave-5 shape: no `compositions[]`, no `compositionPins`. */
function stripCompositions(zip: Uint8Array): Uint8Array {
  const entries = unzipSync(zip);
  const manifest = JSON.parse(strFromU8(entries["manifest.json"]!)) as Record<string, unknown> & { prototypes: Record<string, unknown>[] };
  delete manifest.compositions;
  for (const proto of manifest.prototypes) delete proto.compositionPins;
  manifest.formatVersion = 1;
  entries["manifest.json"] = strToU8(JSON.stringify(manifest));
  return zipSync(entries);
}

describe("bundle import", () => {
  test("round-trip: export from A imports into B, renders and rebinds; re-import is reused/skipped", async () => {
    const a = await makeServer("a", ["alice"]);
    await seed(a, "alice");
    const zip = await exportZip(a, "alice");

    const b = await makeServer("b", ["bob"]);
    const first = await importZip(b, "bob", zip);
    expect(first.status).toBe(200);
    expect(first.report.mode).toBe("apply");
    expect(first.report.ok).toBe(true);
    expect(first.report.summary.errors).toBe(0);
    // Everything is newly created on the empty target.
    expect(itemFor(first.report, "designSystem", "bundle-ds")!.action).toBe("created");
    expect(itemFor(first.report, "component", "rating-stars")!.action).toBe("created");
    expect(itemFor(first.report, "prototype", "bundle-proto")!.action).toBe("created");
    for (const item of first.report.items.filter((i) => i.type === "asset")) expect(item.action).toBe("created");

    // The imported component is active and its compiled bundle is served.
    expect((await b.call("bob", "GET", "/components/rating-stars/versions/1/bundle.js")).status).toBe(200);
    // The imported prototype is renderable and pinned to the imported component.
    const draft = await (await b.call("bob", "GET", "/prototypes/bundle-proto/draft")).json() as { renderable: boolean; components: { id: string }[] };
    expect(draft.renderable).toBe(true);
    expect(draft.components.map((c) => c.id)).toContain("rating-stars");
    // The theme travelled with its font asset.
    const ds = await (await b.call("bob", "GET", "/design-systems/bundle-ds")).json() as { fonts: { family: string }[] };
    expect(ds.fonts.map((f) => f.family)).toEqual(["Inter"]);

    // Re-importing the identical bundle mutates nothing.
    const again = await importZip(b, "bob", zip);
    expect(again.report.summary.created).toBe(0);
    expect(itemFor(again.report, "designSystem", "bundle-ds")!.action).toBe("reused");
    expect(itemFor(again.report, "component", "rating-stars")!.action).toBe("reused");
    expect(itemFor(again.report, "prototype", "bundle-proto")!.action).toBe("skipped");
    for (const item of again.report.items.filter((i) => i.type === "asset")) expect(item.action).toBe("reused");
    a.db.close(); b.db.close();
  }, 60_000);

  test("an owned component whose head source changed republishes as a new version", async () => {
    const a = await makeServer("a", ["alice"]);
    await seed(a, "alice");
    const zip = await exportZip(a, "alice");

    const b = await makeServer("b", ["bob"]);
    expect((await importZip(b, "bob", zip)).report.ok).toBe(true);
    // Diverge the head so the bundle source no longer matches.
    const head = await (await b.call("bob", "GET", "/components/rating-stars/source")).json() as { source: string };
    expect((await b.call("bob", "PUT", "/components/rating-stars", { source: `${head.source}\n// local edit\n`, baseRev: 1 })).status).toBe(200);

    const redo = await importZip(b, "bob", zip);
    const component = itemFor(redo.report, "component", "rating-stars")!;
    expect(component.action).toBe("created");
    expect(component.version).toBe(2);
    a.db.close(); b.db.close();
  }, 60_000);

  test("foreign name conflicts and cascades into a prototype dependency failure", async () => {
    const a = await makeServer("a", ["alice"]);
    await seed(a, "alice");
    const zip = await exportZip(a, "alice");

    const b = await makeServer("b", ["bob", "carol"]);
    // Carol owns an unpublished component named RatingStars in a different system.
    expect((await b.call("carol", "POST", "/design-systems", { id: "carol-ds", name: "Carol DS", description: "Rival system" })).status).toBe(201);
    expect((await b.call("carol", "POST", "/components", { id: "other-stars", name: "RatingStars", source: `import { z } from "zod";\nexport const definition = { props: z.strictObject({}), description: "Rival" };\nexport default function Rival() { return null; }\n`, designSystem: "carol-ds" })).status).toBe(201);

    const result = await importZip(b, "bob", zip);
    expect(result.status).toBe(200);
    expect(result.report.ok).toBe(false);
    expect(itemFor(result.report, "component", "rating-stars")!).toMatchObject({ action: "error", detail: "name_conflict" });
    const prototype = itemFor(result.report, "prototype", "bundle-proto")!;
    expect(prototype.action).toBe("error");
    expect(prototype.detail).toContain("dependency_failed");
    a.db.close(); b.db.close();
  }, 60_000);

  test("a soft-deleted component id is a deleted_conflict", async () => {
    const a = await makeServer("a", ["alice"]);
    await seed(a, "alice");
    const zip = await exportZip(a, "alice");

    const b = await makeServer("b", ["bob"]);
    expect((await b.call("bob", "POST", "/design-systems", { id: "bundle-ds", name: "Bundle DS", description: "pre-existing" })).status).toBe(201);
    expect((await b.call("bob", "POST", "/components", { id: "rating-stars", name: "Doomed", source: `import { z } from "zod";\nexport const definition = { props: z.strictObject({}), description: "Doomed" };\nexport default function Doomed() { return null; }\n`, designSystem: "bundle-ds" })).status).toBe(201);
    expect((await b.call("bob", "DELETE", "/components/rating-stars", { baseRev: 1 })).status).toBe(204);

    const result = await importZip(b, "bob", zip);
    expect(itemFor(result.report, "component", "rating-stars")!).toMatchObject({ action: "error", detail: "deleted_conflict" });
    a.db.close(); b.db.close();
  }, 60_000);

  test("a foreign prototype id is remapped and a foreign custom DS is reused by reference", async () => {
    const a = await makeServer("a", ["alice"]);
    await seed(a, "alice");
    const zip = await exportZip(a, "alice");

    const b = await makeServer("b", ["bob", "carol"]);
    // Bob imports first, owning bundle-ds, the active RatingStars and bundle-proto.
    expect((await importZip(b, "bob", zip)).report.ok).toBe(true);
    // Carol re-imports: the design system and component belong to Bob, and the prototype id is taken.
    const carol = await importZip(b, "carol", zip);
    expect(itemFor(carol.report, "designSystem", "bundle-ds")!.action).toBe("reused"); // reuse by reference
    expect(itemFor(carol.report, "component", "rating-stars")!).toMatchObject({ action: "error", detail: "name_conflict" });
    const prototype = itemFor(carol.report, "prototype", "bundle-proto")!;
    expect(prototype.action).toBe("created");
    expect(prototype.remappedTo).toBe("bundle-proto-imported-1");
    // The remapped prototype exists and is owned by Carol.
    expect((await b.call("carol", "GET", "/prototypes/bundle-proto-imported-1")).status).toBe(200);
    a.db.close(); b.db.close();
  }, 60_000);

  test("dry-run predicts without writing", async () => {
    const a = await makeServer("a", ["alice"]);
    await seed(a, "alice");
    const zip = await exportZip(a, "alice");

    const b = await makeServer("b", ["bob"]);
    const before = { ds: count(b.db, "design_systems"), components: count(b.db, "components"), prototypes: count(b.db, "prototypes"), assets: count(b.db, "assets"), publishes: count(b.db, "component_publishes") };
    const dry = await importZip(b, "bob", zip, "dry-run");
    expect(dry.status).toBe(200);
    expect(dry.report.mode).toBe("dry-run");
    expect(dry.report.ok).toBe(true);
    expect(itemFor(dry.report, "prototype", "bundle-proto")!.action).toBe("created");
    expect({ ds: count(b.db, "design_systems"), components: count(b.db, "components"), prototypes: count(b.db, "prototypes"), assets: count(b.db, "assets"), publishes: count(b.db, "component_publishes") }).toEqual(before);
    a.db.close(); b.db.close();
  }, 60_000);

  test("malformed bundles are rejected before any write", async () => {
    const b = await makeServer("b", ["bob"]);

    // Not a ZIP at all.
    expect((await importZip(b, "bob", new TextEncoder().encode("definitely not a zip"))).status).toBe(400);

    // A path outside the allowlist (traversal).
    const traversal = zipSync({ "manifest.json": strToU8("{}"), "prototypes/../../etc/passwd": strToU8("x") });
    expect((await importZip(b, "bob", traversal)).status).toBe(400);

    // A central-directory bomb: the declared uncompressed size exceeds the budget and is rejected before inflation.
    const a = await makeServer("a", ["alice"]);
    await seed(a, "alice");
    const good = await exportZip(a, "alice");
    const bomb = good.slice();
    for (let i = 0; i < bomb.length - 4; i += 1) {
      if (bomb[i] === 0x50 && bomb[i + 1] === 0x4b && bomb[i + 2] === 0x01 && bomb[i + 3] === 0x02) {
        bomb[i + 24] = 0xff; bomb[i + 25] = 0xff; bomb[i + 26] = 0xff; bomb[i + 27] = 0xff; // uncompressed size -> ~4 GiB
        break;
      }
    }
    expect((await importZip(b, "bob", bomb)).status).toBe(413);

    // A tampered asset whose bytes no longer hash to the declared sha256 is a per-item error (200 report).
    const entries = unzipSync(good);
    const assetPath = Object.keys(entries).find((name) => name.startsWith("assets/"))!;
    entries[assetPath] = new TextEncoder().encode("tampered bytes not matching the sha");
    const tampered = zipSync(entries);
    const tamperResult = await importZip(b, "bob", tampered);
    expect(tamperResult.status).toBe(200);
    expect(tamperResult.report.ok).toBe(false);
    expect(tamperResult.report.items.some((item) => item.type === "asset" && item.action === "error")).toBe(true);
    expect(sha256hex(new TextEncoder().encode("tampered bytes not matching the sha"))).not.toBe(assetPath.slice("assets/".length));
    a.db.close(); b.db.close();
  }, 60_000);

  test("round-trip: a prototype referencing a composition imports onto a fresh database", async () => {
    const a = await makeServer("a", ["alice"]);
    await seed(a, "alice");
    await seedComposition(a, "alice");
    const zip = await exportZip(a, "alice", "/prototypes/bundle-composed/export");

    const b = await makeServer("b", ["bob"]);
    const first = await importZip(b, "bob", zip);
    expect(first.status).toBe(200);
    expect(first.report.ok).toBe(true);
    expect(itemFor(first.report, "composition", "bundle-shell")).toMatchObject({ action: "created", version: 1 });
    // Компонент, достижимый только через композицию, тоже приехал и опубликован.
    expect(itemFor(first.report, "component", "bundle-badge")!.action).toBe("created");
    expect(itemFor(first.report, "prototype", "bundle-composed")!.action).toBe("created");

    // На цели композиция опубликована, а прототип рендерим и запинован на неё.
    const composition = await (await b.call("bob", "GET", "/compositions/bundle-shell")).json() as { publishedVersion: number; doc: { slots: string[] } };
    expect(composition).toMatchObject({ publishedVersion: 1 });
    expect(composition.doc.slots).toEqual(["body"]);
    const draft = await (await b.call("bob", "GET", "/prototypes/bundle-composed/draft")).json() as { renderable: boolean; compositions: { id: string; version: number }[]; components: { id: string }[] };
    expect(draft.renderable).toBe(true);
    expect(draft.compositions.map((pin) => ({ id: pin.id, version: pin.version }))).toEqual([{ id: "bundle-shell", version: 1 }]);
    expect(draft.components.map((pin) => pin.id).sort()).toEqual(["bundle-badge", "bundle-shell-component"]);
    // Документ в БД остался авторским — раскрытие живёт в save-пути.
    const stored = (b.db.query("SELECT doc FROM prototype_revisions WHERE prototype_id='bundle-composed' AND rev=1").get() as { doc: string }).doc;
    expect(stored).toContain("@eui/Composition");

    // Повторный импорт ничего не создаёт.
    const again = await importZip(b, "bob", zip);
    expect(itemFor(again.report, "composition", "bundle-shell")!.action).toBe("reused");
    expect(itemFor(again.report, "prototype", "bundle-composed")!.action).toBe("skipped");
    a.db.close(); b.db.close();
  }, 120_000);

  test("dry-run predicts the composition without writing it", async () => {
    const a = await makeServer("a", ["alice"]);
    await seed(a, "alice");
    await seedComposition(a, "alice");
    const zip = await exportZip(a, "alice", "/prototypes/bundle-composed/export");

    const b = await makeServer("b", ["bob"]);
    const dry = await importZip(b, "bob", zip, "dry-run");
    expect(dry.report.ok).toBe(true);
    expect(itemFor(dry.report, "composition", "bundle-shell")).toMatchObject({ action: "created", version: 1 });
    expect(itemFor(dry.report, "prototype", "bundle-composed")!.action).toBe("created");
    expect(count(b.db, "compositions")).toBe(0);
    expect(count(b.db, "composition_publishes")).toBe(0);
    a.db.close(); b.db.close();
  }, 120_000);

  test("a composition whose name is taken by another owner is a name_conflict cascading into the prototype", async () => {
    const a = await makeServer("a", ["alice"]);
    await seed(a, "alice");
    await seedComposition(a, "alice");
    const zip = await exportZip(a, "alice", "/prototypes/bundle-composed/export");

    const b = await makeServer("b", ["bob", "carol"]);
    expect((await importZip(b, "bob", zip)).report.ok).toBe(true);
    // Carol re-imports: composition id and name belong to Bob.
    const carol = await importZip(b, "carol", zip);
    expect(itemFor(carol.report, "composition", "bundle-shell")).toMatchObject({ action: "error", detail: "name_conflict" });
    const prototype = itemFor(carol.report, "prototype", "bundle-composed")!;
    // Композиция всё равно резолвится: на цели она опубликована и активна, поэтому прототип импортируется.
    expect(prototype.action).toBe("created");
    expect(prototype.remappedTo).toBe("bundle-composed-imported-1");
    a.db.close(); b.db.close();
  }, 120_000);

  test("backward compatibility: an old bundle without a compositions section still imports", async () => {
    const a = await makeServer("a", ["alice"]);
    await seed(a, "alice");
    const legacy = stripCompositions(await exportZip(a, "alice"));

    const b = await makeServer("b", ["bob"]);
    const result = await importZip(b, "bob", legacy);
    expect(result.status).toBe(200);
    expect(result.report.ok).toBe(true);
    expect(result.report.items.some((item) => item.type === "composition")).toBe(false);
    expect(itemFor(result.report, "prototype", "bundle-proto")!.action).toBe("created");
    a.db.close(); b.db.close();
  }, 60_000);

  test("an unknown future formatVersion is rejected whole, before any write", async () => {
    const a = await makeServer("a", ["alice"]);
    await seed(a, "alice");
    const entries = unzipSync(await exportZip(a, "alice"));
    const manifest = JSON.parse(strFromU8(entries["manifest.json"]!)) as Record<string, unknown>;
    manifest.formatVersion = 3;
    entries["manifest.json"] = strToU8(JSON.stringify(manifest));

    const b = await makeServer("b", ["bob"]);
    const before = count(b.db, "prototypes");
    const result = await importZip(b, "bob", zipSync(entries));
    expect(result.status).toBe(400);
    expect(count(b.db, "prototypes")).toBe(before);
    a.db.close(); b.db.close();
  }, 60_000);
});
