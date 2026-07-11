import { expect, test } from "@playwright/test";

test("preview serves a checkout deep link through the SPA fallback", async ({ page }) => {
  const response = await page.goto("/p/checkout/s/cart");
  expect(response?.ok()).toBeTruthy();
  await expect(page).toHaveURL(/\/p\/checkout\/s\/cart$/);
  await expect(page.getByRole("button", { name: "Корзина" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Корзина пуста")).toBeVisible();
});

test("preview library uses the same-origin static Storybook index", async ({ page }) => {
  const indexResponse = await page.request.get("/storybook/index.json");
  expect(indexResponse.ok()).toBeTruthy();
  await page.goto("/library");
  await expect(page.getByRole("navigation", { name: "Components" })).toBeVisible();
  await expect(page.getByText(/Storybook is unavailable/)).toHaveCount(0);
  await expect(page.getByTitle("Story preview")).toHaveAttribute("src", /^\/storybook\/iframe\.html\?id=.+&viewMode=story$/);
});
