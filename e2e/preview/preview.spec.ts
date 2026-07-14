import { expect, test } from "@playwright/test";

test("preview serves a checkout deep link through the SPA fallback", async ({ page }) => {
  const response = await page.goto("/p/checkout/s/cart");
  expect(response?.ok()).toBeTruthy();
  await expect(page).toHaveURL(/\/p\/checkout\/s\/cart$/);
  await expect(page.getByRole("button", { name: "Корзина" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Корзина пуста")).toBeVisible();
});

test("production bundle exposes the builtin RuntimeTree marker without devtools", async ({ page }) => {
  await page.goto("/p/hello-world/s/welcome");
  const button = page.getByLabel("Превью прототипа на устройстве").getByRole("button", { name: "Details" });
  await expect(button).toBeVisible();

  await expect(button.locator("xpath=ancestor::*[@data-eui-key][1]")).toHaveAttribute("data-eui-key", "next");
  expect(await button.evaluate((node) => node.closest("[data-jr-key]") === null)).toBe(true);
});

test("preview library uses the same-origin static Storybook index", async ({ page }) => {
  const indexResponse = await page.request.get("/storybook/index.json");
  expect(indexResponse.ok()).toBeTruthy();
  await page.goto("/library");
  await expect(page.getByRole("navigation", { name: "Компоненты" })).toBeVisible();
  await expect(page.getByText(/Storybook is unavailable/)).toHaveCount(0);
  await expect(page.getByTitle("Превью истории")).toHaveAttribute("src", /^\/storybook\/iframe\.html\?id=.+&viewMode=story$/);
});
