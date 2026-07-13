import { expect, test } from "@playwright/test";

test("checkout keeps session state, then restart invalidates stale history", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: /Мобильное оформление заказа/ }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/s\/catalog$/);
  await expect(page.getByRole("button", { name: "Каталог" })).toHaveAttribute("aria-current", "page");

  await page.getByRole("button", { name: "Открыть карточку кроссовок" }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/s\/product$/);
  await expect(page.getByRole("button", { name: "Товар" })).toHaveAttribute("aria-current", "page");

  await page.getByRole("button", { name: "В корзину" }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/s\/cart$/);
  await expect(page.getByText("Лёгкие кроссовки × 1")).toBeVisible();
  await expect(page.getByText("Итого: 7 990 ₽ · товаров: 1")).toBeVisible();

  await page.getByRole("button", { name: "Оформить" }).click();
  const name = page.getByRole("textbox", { name: "Имя" });
  await name.fill("Анна");
  await page.getByRole("button", { name: "Назад" }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/s\/cart$/);
  await page.getByRole("button", { name: "Оформить" }).click();
  await expect(name).toHaveValue("Анна");

  await page.getByRole("button", { name: "Оплатить" }).click();
  await expect(page.getByText("Заказ оплачен")).toBeVisible();
  await page.getByRole("button", { name: "Начать заново" }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/s\/catalog$/);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goBack();
    await expect(page).toHaveURL(/\/p\/checkout\/s\/catalog$/);
    await expect(page.getByRole("button", { name: "Каталог" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("Заказ оплачен")).toHaveCount(0);
    await expect(page.getByText("Данные заказа")).toHaveCount(0);
  }
});
