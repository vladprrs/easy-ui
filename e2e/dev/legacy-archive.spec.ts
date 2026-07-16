import { expect, test } from "@playwright/test";

const LEGACY_ARCHIVE_ID = "v15-archived-legacy";

test("v15-unrenderable prototype stays in Archive and every player entry shows the legacy placeholder", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Архив", exact: true }).click();
  const card = page.getByRole("listitem").filter({ hasText: "V15 archived legacy prototype" });
  await expect(card).toBeVisible();
  await expect(card.getByText("В архиве", { exact: true })).toBeVisible();
  await expect(card.getByRole("heading", { name: "Прототип в архиве" })).toBeVisible();
  await card.getByRole("link", { name: "V15 archived legacy prototype" }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${LEGACY_ARCHIVE_ID}`));
  await expect(page.getByRole("heading", { name: "Прототип в архиве" })).toBeVisible();
  await expect(page.getByText("Эта ревизия использует удалённые компоненты и больше не может быть отображена.")).toBeVisible();
});

test("retired systems are absent from create and reject new references and theme patches", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Новый прототип" }).first().click();
  const select = page.getByRole("dialog", { name: "Создание прототипа" }).getByLabel("Дизайн-система");
  await expect(select.locator('option[value="shadcn"]')).toHaveCount(0);
  await expect(select.locator('option[value="wireframe"]')).toHaveCount(0);
  await expect(select.locator('option[value="e2e-starter"]')).toHaveCount(1);

  const retiredCreate = await request.post("/api/prototypes", { data: { doc: {
    version: 1, id: "retired-create-rejected", name: "Retired create", designSystem: "shadcn", device: "mobile", startScreen: "main", state: {},
    screens: [{ id: "main", name: "Main", spec: { root: "image", elements: { image: { type: "Image", props: { src: "/design/cjm-ui/assets/mascot-laptop.png", alt: "Rejected" } } } } }],
  } } });
  expect(retiredCreate.status()).toBe(422);
  expect(await retiredCreate.json()).toMatchObject({ error: { code: "validation_failed" } });

  const retiredPatch = await request.patch("/api/design-systems/shadcn", { data: { baseVersion: 0, tokens: { "color.brand": "#000" } } });
  expect(retiredPatch.status()).toBe(409);
  expect(await retiredPatch.json()).toMatchObject({ error: { code: "design_system_retired" } });
});
