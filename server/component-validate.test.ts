import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createTestHandler } from "./test-auth";
import { openDatabase } from "./db";
import { importCacheKeys, sha256 } from "./components/pipeline";
import {
  CANDIDATE_CACHE_TTL_MS,
  candidatesRoot,
  getCandidateBundle,
  gcCandidates,
  readCandidate,
  writeCandidate,
  type CandidateEntry,
} from "./components/candidates";
import { withValidateSlot } from "./components/validate";
import { getLatestDesignSystemContent } from "./designSystems";
import { libraryCatalog } from "./routes/libraryCatalog";

// P8 (план 2026-08-02): validate-префлайт + candidate-кэш; P5.1: no-op PUT с figma-only изменением.
// Компонентный id `validate-stars` уникален для этого файла: кэши import-верификации живут в общем
// процессе `bun test`, и чужие публикации того же id сломали бы утверждения про их ключи.

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

async function setup(options: { validateDisabled?: boolean } = {}) {
  const dir = await mkdtemp(resolve(process.cwd(), ".validate-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  const handler = createTestHandler(db, { dataDir: dir, ...options });
  return { dir, db, handler };
}

const req = (url: string, method = "GET", value?: unknown) =>
  new Request(`http://test/api${url}`, {
    method,
    headers: value ? { "content-type": "application/json" } : undefined,
    body: value ? JSON.stringify(value) : undefined,
  });

const fixture = (name: string) => Bun.file(resolve("server/fixtures", name)).text();
const FIGMA = { fileKey: "abcDEF_-", nodeIds: ["1:2"] };

const createStars = (handler: (r: Request) => Promise<Response>, source: string, extra: Record<string, unknown> = {}) =>
  handler(req("/components", "POST", {
    designSystem: "yandex-pay", id: "validate-stars", name: "ValidateStars", source,
    intent: "Collects star ratings from product card users", ...extra,
  }));

describe("component validate preflight (P8)", () => {
  test("validate preflights head without public state, caches by sourceHash, receipt agrees with publish", async () => {
    const { dir, db, handler } = await setup();
    const source = await fixture("rating-stars.tsx");
    expect((await createStars(handler, source)).status).toBe(201);

    const first = await handler(req("/components/validate-stars/validate", "POST"));
    expect(first.status).toBe(200);
    const receipt = await first.json() as Record<string, unknown> & { warnings: string[] };
    expect(receipt).toMatchObject({ ok: true, cached: false, sourceHash: sha256(source), hostAbiVersion: 1 });
    expect(receipt.bundleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.catalogRevision).toBe(libraryCatalog(db).catalogRevision);
    expect(receipt.themeVersion).toBe(getLatestDesignSystemContent(db, "yandex-pay").latestMetaVersion);
    // Базовая фикстура не объявляет atomicLevel — то же предупреждение, что даёт publish.
    expect(receipt.warnings).toEqual([expect.stringContaining("Atomic design level")]);
    // Никакого public state: ни версии, ни сдвига head.
    expect(await (await handler(req("/components/validate-stars"))).json()).toMatchObject({ headRev: 1, publishedVersion: null, versions: [] });

    const second = await (await handler(req("/components/validate-stars/validate", "POST"))).json() as Record<string, unknown>;
    expect(second).toMatchObject({ ok: true, cached: true, sourceHash: receipt.sourceHash, bundleHash: receipt.bundleHash });

    // TTL: протухшая запись вычищается GC-on-write и префлайт считается заново.
    const entry = await readCandidate(dir, String(receipt.sourceHash));
    expect(entry?.ok).toBe(true);
    await writeCandidate(dir, { ...entry!, createdAt: new Date(Date.now() - CANDIDATE_CACHE_TTL_MS - 60_000).toISOString() });
    const third = await (await handler(req("/components/validate-stars/validate", "POST"))).json() as Record<string, unknown>;
    expect(third).toMatchObject({ ok: true, cached: false, bundleHash: receipt.bundleHash });

    // Publish подтверждает receipt: тот же bundleHash, компиляция детерминирована.
    const published = await handler(req("/components/validate-stars/publish", "POST", { baseRev: 1 }));
    expect(published.status).toBe(201);
    expect(await (await handler(req("/components/validate-stars/versions/1"))).json()).toMatchObject({ bundleHash: receipt.bundleHash });
    db.close();
  }, 90000);

  test("validate catches unsupported stored figma provenance fields with the field named", async () => {
    const { db, handler } = await setup();
    const source = await fixture("rating-stars.tsx");
    expect((await createStars(handler, source, { figma: FIGMA })).status).toBe(201);
    // Write-путь отсекает лишние поля; строка с pageNodeId эмулирует импортированную/legacy ревизию.
    db.run("UPDATE component_revisions SET figma_json=? WHERE component_id=?", [JSON.stringify({ ...FIGMA, pageNodeId: "99:1" }), "validate-stars"]);
    const response = await handler(req("/components/validate-stars/validate", "POST"));
    expect(response.status).toBe(422);
    const body = await response.json() as { error: { code: string; issues: unknown[] } };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.issues).toContainEqual(expect.objectContaining({
      path: ["figma", "pageNodeId"],
      pointer: "/figma/pageNodeId",
      message: expect.stringContaining("pageNodeId"),
    }));
    db.close();
  }, 30000);

  test("validate and publish share stable codes for compile-time failures; failures are cached", async () => {
    const { dir, db, handler } = await setup();
    // Проходит POST/PUT (там только checkSource), но падает на typecheck — дыра, которую ловит префлайт.
    const source = `import { z } from "zod";
const wrong: number = "not a number";
export const definition = { props: z.strictObject({}), description: "Broken types", atomicLevel: "atom" as const, example: {} };
export default function BrokenTypes() { return <div>{wrong}</div>; }`;
    expect((await createStars(handler, source)).status).toBe(201);
    const first = await handler(req("/components/validate-stars/validate", "POST"));
    expect(first.status).toBe(422);
    expect(await first.json()).toMatchObject({ error: { code: "validation_failed" } });
    // Отрицательный результат тоже идемпотентно кэширован по sourceHash.
    expect(await readCandidate(dir, sha256(source))).toMatchObject({ ok: false, failure: { status: 422, code: "validation_failed" } });
    const second = await handler(req("/components/validate-stars/validate", "POST"));
    expect(second.status).toBe(422);
    // Publish падает тем же кодом на том же наборе проверок.
    const published = await handler(req("/components/validate-stars/publish", "POST", { baseRev: 1 }));
    expect(published.status).toBe(422);
    expect(await published.json()).toMatchObject({ error: { code: "validation_failed" } });
    db.close();
  }, 90000);

  test("publish after validate reuses the cached extraction but keeps its own import verification", async () => {
    const { dir, db, handler } = await setup();
    const source = await fixture("rating-stars.tsx");
    // Отдельный id: кэши import-верификации процесс-wide, а первая часть файла уже публиковала validate-stars.
    const seam = { id: "validate-seam", name: "ValidateSeam" };
    expect((await createStars(handler, source, seam)).status).toBe(201);
    expect((await handler(req("/components/validate-seam/validate", "POST"))).status).toBe(200);
    const sourceHash = sha256(source);
    // Кэш publish-верификации (`id@rev`) validate не заселяет — ключ validate привязан к sourceHash.
    expect(importCacheKeys().published).not.toContain("validate-seam@1");
    expect(importCacheKeys().validated).toContain(`validated@${sourceHash}`);
    // Sentinel-доказательство шва preExtracted: если бы publish извлёк заново, подменённое
    // предупреждение из кэша не доехало бы до ответа.
    const entry = await readCandidate(dir, sourceHash);
    entry!.extracted!.warnings.push("SENTINEL cached extraction reused");
    await writeCandidate(dir, entry!);
    const published = await handler(req("/components/validate-seam/publish", "POST", { baseRev: 1 }));
    expect(published.status).toBe(201);
    expect(await published.json()).toMatchObject({ warnings: expect.arrayContaining(["SENTINEL cached extraction reused"]) });
    // Своя import-верификация у publish всё равно была: ключ id@rev появился только после него.
    expect(importCacheKeys().published).toContain("validate-seam@1");
    db.close();
  }, 90000);

  test("validate warns when schema defaults and render fallbacks diverge", async () => {
    const { db, handler } = await setup();
    const source = `import { z } from "zod";
export const definition = {
  props: z.strictObject({ size: z.string(), tone: z.string().default("brand") }),
  description: "Parity probe", atomicLevel: "atom" as const, example: { size: "m", tone: "x" },
};
export default function ParityProbe({ props }: any) { return <div>{props.size ?? "m"}{props.tone ?? "brand"}</div>; }`;
    expect((await createStars(handler, source)).status).toBe(201);
    const receipt = await (await handler(req("/components/validate-stars/validate", "POST"))).json() as { warnings: string[] };
    expect(receipt.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/Parity: prop "size".*no schema \.default\(\)/),
      expect.stringMatching(/Parity: prop "tone".*both a schema \.default\(\) and a render-time/),
    ]));
    db.close();
  }, 90000);

  test("kill-switch hides the route and drops the capability feature", async () => {
    const { db, handler } = await setup({ validateDisabled: true });
    const source = await fixture("rating-stars.tsx");
    expect((await createStars(handler, source)).status).toBe(201);
    expect((await handler(req("/components/validate-stars/validate", "POST"))).status).toBe(404);
    const caps = await (await handler(req("/capabilities"))).json() as { features: Record<string, boolean>; limits: Record<string, number> };
    expect(caps.features.componentValidate).toBe(false);
    expect(caps.limits).toMatchObject({ validateUserConcurrent: 1, validateGlobalConcurrent: 2, validateCacheTtlHours: 24, validateCacheMiB: 32 });
    db.close();
  }, 30000);

  test("validate throttling: per-user 429 and a global queue cap", async () => {
    const slow = () => new Promise<number>((resolvePromise) => setTimeout(() => resolvePromise(1), 30));
    const first = withValidateSlot("user-a", slow);
    await expect(withValidateSlot("user-a", async () => 2)).rejects.toMatchObject({ status: 429, code: "validate_in_flight" });
    await expect(withValidateSlot("user-b", async () => 3)).resolves.toBe(3);
    const second = withValidateSlot("user-b", slow);
    await expect(withValidateSlot("user-c", async () => 4)).rejects.toMatchObject({ status: 429, code: "queue_full" });
    await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
    // Слоты освобождаются — повторный запуск той же учётки снова проходит.
    await expect(withValidateSlot("user-a", async () => 5)).resolves.toBe(5);
  });
});

describe("candidate cache GC (P8)", () => {
  const deadEntry = (hash: string, createdAt: string): CandidateEntry => ({
    version: 1, sourceHash: hash, componentIds: ["c"], createdAt,
    ok: false, failure: { status: 422, code: "validation_failed", message: "x" },
  });

  test("GC purges expired (incl. on write), corrupt and over-cap entries, oldest first", async () => {
    const dir = await mkdtemp(resolve(process.cwd(), ".candidates-test-"));
    dirs.push(dir);
    // TTL: запись, рождённая протухшей, не переживает GC-on-write.
    await writeCandidate(dir, deadEntry("expired", new Date(Date.now() - CANDIDATE_CACHE_TTL_MS - 60_000).toISOString()));
    expect(await readCandidate(dir, "expired")).toBeNull();

    // Битая запись (не JSON) сносится GC.
    await mkdir(candidatesRoot(dir), { recursive: true });
    await mkdir(resolve(candidatesRoot(dir), "corrupt"));
    await writeFile(resolve(candidatesRoot(dir), "corrupt", "result.json"), "not json");
    expect((await gcCandidates(dir)).removed).toBeGreaterThanOrEqual(1);
    expect(await readCandidate(dir, "corrupt")).toBeNull();

    // Потолок байт: вытесняется самая старая запись, свежая остаётся вместе с бандлом.
    const live = (hash: string, createdAt: string): CandidateEntry => ({
      version: 1, sourceHash: hash, componentIds: ["c"], createdAt, ok: true, bundleHash: "b".repeat(64), hostAbiVersion: 1,
    });
    const bytes = "x".repeat(1000);
    await writeCandidate(dir, live("old", new Date(Date.now() - 2000).toISOString()), bytes);
    await writeCandidate(dir, live("fresh", new Date(Date.now() - 1000).toISOString()), bytes);
    expect(await readCandidate(dir, "old")).not.toBeNull();
    await gcCandidates(dir, { maxBytes: 1500 });
    expect(await readCandidate(dir, "old")).toBeNull();
    expect(await readCandidate(dir, "fresh")).not.toBeNull();

    // Lookup для draft-preview: по (componentId, sourceHash), чужому компоненту не отдаётся.
    expect(await getCandidateBundle(dir, "c", "fresh")).toMatchObject({ bundleJs: bytes });
    expect(await getCandidateBundle(dir, "other", "fresh")).toBeNull();
  });
});

describe("PUT figma-only no-op (P5.1)", () => {
  test("byte-identical source+figma answers unchanged with the head rev; changed figma still revises", async () => {
    const { db, handler } = await setup();
    const source = await fixture("rating-stars.tsx");
    expect((await createStars(handler, source, { figma: FIGMA })).status).toBe(201);

    // figma-only no-op: совместимостный инвариант — `rev` в ответе всегда есть.
    const noop = await handler(req("/components/validate-stars", "PUT", { baseRev: 1, figma: FIGMA }));
    expect(noop.status).toBe(200);
    expect(await noop.json()).toEqual({ unchanged: true, rev: 1 });

    // Идентичные source+figma вместе — тот же no-op.
    const noopBoth = await handler(req("/components/validate-stars", "PUT", { baseRev: 1, source, figma: FIGMA }));
    expect(noopBoth.status).toBe(200);
    expect(await noopBoth.json()).toEqual({ unchanged: true, rev: 1 });

    // Ревизия не создавалась.
    expect(await (await handler(req("/components/validate-stars"))).json()).toMatchObject({ headRev: 1 });
    expect(await (await handler(req("/components/validate-stars/revisions"))).json()).toHaveLength(1);

    // Изменившийся figma по-прежнему создаёт ревизию.
    const changed = await handler(req("/components/validate-stars", "PUT", { baseRev: 1, figma: { ...FIGMA, nodeIds: ["1:3"] } }));
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({ rev: 2 });
    expect(await (await handler(req("/components/validate-stars"))).json()).toMatchObject({ headRev: 2, figma: { nodeIds: ["1:3"] } });
    db.close();
  }, 30000);

  test("CAS still guards the no-op answer and identical source without figma stays a 400", async () => {
    const { db, handler } = await setup();
    const source = await fixture("rating-stars.tsx");
    expect((await createStars(handler, source, { figma: FIGMA })).status).toBe(201);
    const stale = await handler(req("/components/validate-stars", "PUT", { baseRev: 99, figma: FIGMA }));
    expect(stale.status).toBe(409);
    const unchangedSource = await handler(req("/components/validate-stars", "PUT", { baseRev: 1, source }));
    expect(unchangedSource.status).toBe(400);
    expect(await unchangedSource.json()).toMatchObject({ error: { code: "invalid_request" } });
    db.close();
  }, 30000);
});
