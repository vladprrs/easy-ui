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
  // The tile link opens a NEW player session with fresh document state (CJM stateOverrides are
  // tile-only). Since checkout@2 the cart totals are $cond-driven, so with /cart/count = 0 the
  // checkout button is correctly disabled here.
  await expect(page.getByRole("button", { name: "Оформить" })).toBeDisabled();

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

  // Unknown published version (W0-4): a dedicated state with working escape links.
  await page.goto("/p/checkout/v/999/cjm");
  await expect(page.getByRole("heading", { name: "Версия 999 не опубликована" })).toBeVisible();
  await expect(page.getByRole("link", { name: "К галерее" })).toBeVisible();
  await page.getByRole("link", { name: "Открыть текущую" }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/cjm$/);
  await expect(page.getByRole("list", { name: "CJM screens" })).toBeVisible();

  // Same state in the player at /p/:id/v/N; «Открыть текущую» lands on the draft player.
  await page.goto("/p/checkout/v/99");
  await expect(page.getByRole("heading", { name: "Версия 99 не опубликована" })).toBeVisible();
  await page.getByRole("link", { name: "Открыть текущую" }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/s\/catalog$/);

  // A missing prototype still reads as prototype-not-found.
  await page.goto("/p/no-such-proto/v/1");
  await expect(page.getByRole("heading", { name: "Prototype not found" })).toBeVisible();
});
