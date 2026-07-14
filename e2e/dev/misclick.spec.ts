import { expect, test } from "@playwright/test";

test("non-canvas misclick briefly highlights authored press targets but an interactive click does not", async ({ page }) => {
  await page.goto("/p/hello-world/s/welcome");
  const stage = page.getByLabel("Превью прототипа на устройстве");

  await stage.getByText("Hello, Ada!").click();
  await expect(page.locator('[data-eui-highlight-key="next"]')).toBeVisible();
  await expect(page.getByTestId("misclick-highlights")).toHaveCount(0, { timeout: 1_500 });

  await stage.getByRole("button", { name: "Details" }).click();
  await expect(page).toHaveURL(/\/p\/hello-world\/s\/details$/);
  await expect(page.getByTestId("misclick-highlights")).toHaveCount(0);
});

test("canvas misclick highlights its Hotspot without changing layout or intercepting the real click", async ({ page }) => {
  await page.goto("/p/checkout/s/catalog");
  const stage = page.getByLabel("Превью прототипа на устройстве");

  await stage.getByText("Новинки").click();
  await expect(page.locator('[data-eui-highlight-key="product-hotspot"]')).toBeVisible();
  await expect(page.getByTestId("misclick-highlights")).toHaveCount(0, { timeout: 1_500 });

  await stage.getByRole("button", { name: "Открыть карточку кроссовок" }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/s\/product$/);
  await expect(page.getByTestId("misclick-highlights")).toHaveCount(0);
});
