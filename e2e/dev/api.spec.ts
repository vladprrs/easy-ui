import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { STARTER_DS_ID, starterPrototypeFromFile } from "../starter-ds.fixture";
import { createFixtureComponent } from "./reuse.fixture";

const api = "/api";

test("API revisions, publishing, component bundles, and shim ABI work end to end", async ({ request, page }) => {
  const seeded = await request.get(`${api}/prototypes`);
  expect(seeded.ok()).toBeTruthy();
  expect((await seeded.json()).map((item: { id: string }) => item.id)).toEqual(
    expect.arrayContaining(["checkout", "hello-world", "settings", "scale-demo", "composition-demo", "e2e-starter-prototype"]),
  );

  const apiPrototypeId = "api-revision-flow";
  const apiDoc = await starterPrototypeFromFile("test/fixtures/hello-world.json", { id: apiPrototypeId, name: "API revision flow" });
  expect((await request.post(`${api}/prototypes`, { data: { doc: apiDoc } })).status()).toBe(201);
  const draft = await (await request.get(`${api}/prototypes/${apiPrototypeId}/draft`)).json();
  const saved = await request.put(`${api}/prototypes/${apiPrototypeId}`, {
    data: { doc: { ...draft.doc, name: "Hello API" }, baseRev: draft.rev },
  });
  expect(saved.ok()).toBeTruthy();
  expect(await saved.json()).toMatchObject({ rev: draft.rev + 1, warnings: expect.any(Array) });

  const conflict = await request.put(`${api}/prototypes/${apiPrototypeId}`, {
    data: { doc: { ...draft.doc, name: "Stale" }, baseRev: draft.rev },
  });
  expect(conflict.status()).toBe(409);
  expect(await conflict.json()).toMatchObject({ error: { code: "revision_conflict", currentRev: draft.rev + 1 } });

  const invalid = await request.put(`${api}/prototypes/${apiPrototypeId}`, {
    data: { doc: { ...draft.doc, id: "wrong-id" }, baseRev: draft.rev + 1 },
  });
  expect(invalid.status()).toBe(422);
  expect(await invalid.json()).toMatchObject({ error: { code: "validation_failed", issues: expect.any(Array) } });

  const published = await request.post(`${api}/prototypes/${apiPrototypeId}/publish`, { data: { baseRev: draft.rev + 1 } });
  expect(published.status()).toBe(201);
  expect(await published.json()).toMatchObject({ version: 1, rev: draft.rev + 1 });
  expect(await (await request.get(`${api}/prototypes/${apiPrototypeId}/versions`)).json()).toEqual([
    expect.objectContaining({ version: 1, rev: draft.rev + 1 }),
  ]);

  const source = await readFile("server/fixtures/rating-stars.tsx", "utf8");
  const created = await createFixtureComponent(request, api, {
    id: "api-rating-stars", name: "ApiRatingStars", source, designSystem: STARTER_DS_ID, intent: "Collects product ratings for the API lifecycle scenario",
  }, {
    reason: "Отдельная API lifecycle фикстура проверяет публикацию, бандл и shim-контракт",
    allowedCandidateKeys: [`component:${STARTER_DS_ID}:ui-rating-stars`],
  });
  expect(created.status()).toBe(201);
  const componentPublish = await request.post(`${api}/components/api-rating-stars/publish`, { data: { baseRev: 1 } });
  expect(componentPublish.status()).toBe(201);

  const bundle = await request.get(`${api}/components/api-rating-stars/versions/1/bundle.js`);
  expect(bundle.ok()).toBeTruthy();
  expect(bundle.headers()["cache-control"]).toBe("private, no-store");
  expect(bundle.headers().vary).toContain("Cookie");
  const bundleText = await bundle.text();
  const imports = [...bundleText.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)].map((match) => match[1]);
  expect(imports.length).toBeGreaterThan(0);
  expect(imports.every((specifier) => specifier.startsWith("/api/shims/v1/"))).toBeTruthy();

  const shimDoc = {
    version: 1,
    id: "shim-abi-flow",
    name: "Shim ABI flow",
    designSystem: STARTER_DS_ID,
    device: "mobile",
    startScreen: "rating",
    state: {},
    screens: [{
      id: "rating",
      name: "Rating",
      spec: { root: "stars", elements: { stars: { type: "ApiRatingStars", props: { value: 2 } } } },
    }],
  };
  expect((await request.post(`${api}/prototypes`, { data: { doc: shimDoc } })).status()).toBe(201);
  await page.goto("/p/shim-abi-flow");
  await expect(page.getByRole("button", { name: "★★" })).toBeVisible();
  for (const shim of ["react", "react-dom", "react-jsx-runtime", "zod", "json-render-react"]) {
    const keys = await page.evaluate(async (url) => Object.keys(await import(url)), `/api/shims/v1/${shim}.js`);
    expect(keys.length, `${shim} shim exports`).toBeGreaterThan(0);
  }
});

/**
 * RFC candidate-acceptance §6 (волна R3a): `PUT /api/components/:id/provenance` правит ссылку на
 * Figma, **не создавая ни ревизии, ни версии**, и остаётся видимой после обычного source-PUT
 * (cross-revision резолв). Сценарий держит именно этот контракт против живого сервера.
 */
test("provenance PUT edits the Figma link without a new revision or version", async ({ request }) => {
  const componentId = "api-provenance-stars";
  const source = await readFile("server/fixtures/rating-stars.tsx", "utf8");
  const created = await createFixtureComponent(request, api, {
    id: componentId, name: "ApiProvenanceStars", source, designSystem: STARTER_DS_ID,
    intent: "Collects product ratings for the provenance lifecycle scenario",
  }, {
    reason: "Отдельная provenance-фикстура проверяет правку Figma-ссылки без новой версии",
    allowedCandidateKeys: [`component:${STARTER_DS_ID}:ui-rating-stars`, `component:${STARTER_DS_ID}:api-rating-stars`],
  });
  expect(created.status()).toBe(201);
  expect((await request.post(`${api}/components/${componentId}/publish`, { data: { baseRev: 1 } })).status()).toBe(201);

  const figma = { fileKey: "e2eProvenanceKey", nodeIds: ["10:20"] };
  const written = await request.put(`${api}/components/${componentId}/provenance`, { data: { figma } });
  expect(written.status()).toBe(200);
  expect(await written.json()).toMatchObject({ rev: 1, seq: 1, unchanged: false, figma });

  // Ни новой ревизии, ни новой версии — и опубликованная версия уже отдаёт новую provenance.
  const meta = await (await request.get(`${api}/components/${componentId}`)).json() as { headRev: number; versions: unknown[]; figma: unknown };
  expect(meta.headRev).toBe(1);
  expect(meta.versions).toHaveLength(1);
  expect(meta.figma).toEqual(figma);
  expect((await (await request.get(`${api}/components/${componentId}/versions/1`)).json()).figma).toEqual(figma);

  // Повтор идентичного значения дедуплицируется; обычный source-PUT без figma её наследует.
  const repeat = await request.put(`${api}/components/${componentId}/provenance`, { data: { figma } });
  expect(await repeat.json()).toMatchObject({ unchanged: true, seq: null });
  const saved = await request.put(`${api}/components/${componentId}`, { data: { source: `${source}\n// provenance touch\n`, baseRev: 1 } });
  expect(saved.status()).toBe(200);
  expect((await (await request.get(`${api}/components/${componentId}`)).json()).figma).toEqual(figma);
});
