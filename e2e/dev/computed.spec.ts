import { expect, test } from "@playwright/test";
import { ensureStarterDesignSystem, ensureStarterPrototype, starterPrototypeFromFile } from "../starter-ds.fixture";

const api = "/api";

// `doc.computed` под реальным плеером: builtin-DS публиковать нельзя (все retired ⇒ 422),
// поэтому та же фикстура `test/fixtures/cart-computed.json` стартеризуется в custom-only
// каталог (`starterizePrototype` — single source of truth) и публикуется через API.
test("computed values recalculate in the player after cart mutations", async ({ request, page }) => {
  await ensureStarterDesignSystem(request, api);
  const doc = await starterPrototypeFromFile("test/fixtures/cart-computed.json");
  await ensureStarterPrototype(request, doc, { api, message: "E2E computed fixture" });

  await page.goto("/p/cart-computed");
  await expect(page).toHaveURL(/\/p\/cart-computed\/s\/catalog$/);
  await expect(page.getByText("Позиций в корзине: 0")).toBeVisible();

  // Кроссовки: 7990 × 1. Счётчик пересчитывается в том же снапшоте, что видит рендер.
  await page.getByRole("button", { name: "Добавить кроссовки" }).click();
  await expect(page.getByText("Позиций в корзине: 1")).toBeVisible();

  // Носки: 490 × 2 ⇒ count 2, sum(qty) 3, sumProduct 7990 + 980 = 8970.
  await page.getByRole("button", { name: "Добавить носки" }).click();
  await expect(page.getByText("Позиций в корзине: 2")).toBeVisible();

  await page.getByRole("button", { name: "Перейти в корзину" }).click();
  await expect(page).toHaveURL(/\/p\/cart-computed\/s\/cart$/);

  await expect(page.getByText("Корзина пуста")).toHaveCount(0);
  // Строки `repeat` печатают только поля item — точное совпадение отделяет их от каталога.
  await expect(page.getByText("Лёгкие кроссовки", { exact: true })).toBeVisible();
  await expect(page.getByText("Носки", { exact: true })).toBeVisible();
  await expect(page.getByText("490 ₽ × 2", { exact: true })).toBeVisible();

  await expect(page.getByText("Позиций: 2")).toBeVisible();
  await expect(page.getByText("Единиц: 3")).toBeVisible();
  await expect(page.getByText("Сумма товаров: 8970 ₽")).toBeVisible();
  // `add`: субтотал + доставка − скидка-литерал = 8970 + 300 − 500.
  await expect(page.getByText("Доставка: 300 ₽")).toBeVisible();
  await expect(page.getByText("Скидка: 500 ₽")).toBeVisible();
  await expect(page.getByText("Итого: 8770 ₽")).toBeVisible();

  await expect(page.getByRole("alert")).toHaveCount(0);
});
