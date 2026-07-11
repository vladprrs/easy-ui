import { expect, test } from "@playwright/test";

const checkoutNotes = [
  "Покупатель замечает новинку в каталоге и открывает карточку товара.",
  "Покупатель изучает кроссовки, цену и добавляет товар в корзину.",
  "В корзине лежит одна пара кроссовок, заказ готов к оформлению.",
  "Покупатель проверяет предзаполненные данные доставки и переходит к оплате.",
  "Оплата завершена, покупатель получает подтверждение заказа.",
];

test("checkout CJM opens from gallery and preserves player history semantics", async ({ page }) => {
  await page.goto("/");
  const checkoutCard = page.getByRole("listitem").filter({ hasText: "Мобильное оформление заказа" });
  await checkoutCard.getByRole("link", { name: "CJM", exact: true }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/cjm$/);

  const journey = page.getByRole("list", { name: "CJM screens" });
  await expect(journey).toBeVisible();
  await expect(journey).not.toHaveAttribute("aria-hidden", "true");
  for (const screenName of ["Каталог", "Товар", "Корзина", "Оформление", "Успех"]) {
    await expect(page.getByRole("heading", { name: screenName, exact: true })).toBeVisible();
  }
  for (const note of checkoutNotes) await expect(page.getByText(note, { exact: true })).toBeVisible();
  await expect(page.getByText("Лёгкие кроссовки × 1", { exact: true })).toBeVisible();

  expect(await page.evaluate(() => document.body.style.pointerEvents)).not.toBe("none");
  const cartOverlay = page.getByRole("link", { name: /Открыть экран “Корзина”.*в плеере/ });
  await expect(cartOverlay).toBeVisible();
  await cartOverlay.click();
  await expect(page).toHaveURL(/\/p\/checkout\/s\/cart$/);
  await expect(page.getByRole("button", { name: "Back" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Оформить" })).toBeEnabled();

  await page.goBack();
  await expect(page).toHaveURL(/\/p\/checkout\/cjm$/);
  await expect(page.getByRole("list", { name: "CJM screens" })).toBeVisible();

  await page.getByRole("link", { name: "Открыть плеер" }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/s\/catalog$/);
  await page.getByRole("link", { name: "CJM", exact: true }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/cjm$/);
});

test("checkout CJM supports direct load and rejects an unknown version", async ({ page }) => {
  await page.goto("/p/checkout/cjm");
  await expect(page.getByRole("list", { name: "CJM screens" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Мобильное оформление заказа" })).toBeVisible();

  await page.goto("/p/checkout/v/999/cjm");
  await expect(page.getByRole("heading", { name: "Prototype not found" })).toBeVisible();
});
