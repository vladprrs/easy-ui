import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const api = "/api";

test("API revisions, publishing, component bundles, and shim ABI work end to end", async ({ request, page }) => {
  const seeded = await request.get(`${api}/prototypes`);
  expect(seeded.ok()).toBeTruthy();
  expect((await seeded.json()).map((item: { id: string }) => item.id)).toEqual(
    expect.arrayContaining(["checkout", "hello-world", "settings", "scale-demo", "composition-demo", "wireframe-demo"]),
  );

  const draft = await (await request.get(`${api}/prototypes/hello-world/draft`)).json();
  const saved = await request.put(`${api}/prototypes/hello-world`, {
    data: { doc: { ...draft.doc, name: "Hello API" }, baseRev: draft.rev },
  });
  expect(saved.ok()).toBeTruthy();
  expect(await saved.json()).toMatchObject({ rev: draft.rev + 1, warnings: expect.any(Array) });

  const conflict = await request.put(`${api}/prototypes/hello-world`, {
    data: { doc: { ...draft.doc, name: "Stale" }, baseRev: draft.rev },
  });
  expect(conflict.status()).toBe(409);
  expect(await conflict.json()).toMatchObject({ error: { code: "revision_conflict", currentRev: draft.rev + 1 } });

  const invalid = await request.put(`${api}/prototypes/hello-world`, {
    data: { doc: { ...draft.doc, id: "wrong-id" }, baseRev: draft.rev + 1 },
  });
  expect(invalid.status()).toBe(422);
  expect(await invalid.json()).toMatchObject({ error: { code: "validation_failed", issues: expect.any(Array) } });

  const published = await request.post(`${api}/prototypes/hello-world/publish`, { data: { baseRev: draft.rev + 1 } });
  expect(published.status()).toBe(201);
  expect(await published.json()).toMatchObject({ version: 1, rev: draft.rev + 1 });
  expect(await (await request.get(`${api}/prototypes/hello-world/versions`)).json()).toEqual([
    expect.objectContaining({ version: 1, rev: draft.rev + 1 }),
  ]);

  const source = await readFile("server/fixtures/rating-stars.tsx", "utf8");
  const created = await request.post(`${api}/components`, {
    data: { id: "api-rating-stars", name: "ApiRatingStars", source },
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
