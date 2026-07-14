import { expect, test } from "@playwright/test";

// Режим презентации (W1-2): только прототип на экране, интерактивный флоу,
// Esc — возврат в плеер, deep-link на экран, пригодность на мобильном вьюпорте.

test("presentation opens from the player, runs the flow, and Esc returns to the player", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });

  await page.goto("/p/checkout");
  await expect(page).toHaveURL(/\/p\/checkout\/s\/catalog$/);
  await page.getByRole("link", { name: "Презентация" }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/present\/s\/catalog$/);

  // Только прототип: ни глобального хрома, ни PrototypeChrome.
  await expect(page.getByRole("link", { name: "Галерея" })).toHaveCount(0);
  await expect(page.getByTestId("chrome-actions")).toHaveCount(0);
  // Внутренний вход: подсказка Esc вместо «Открыть в easy-ui».
  await expect(page.getByText("Esc — вернуться в плеер")).toBeVisible();
  await expect(page.getByRole("link", { name: "Открыть в easy-ui" })).toHaveCount(0);

  // Полный клик-флоу: каталог → товар → корзина.
  await page.getByRole("button", { name: "Открыть карточку кроссовок" }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/present\/s\/product$/);
  await page.getByRole("button", { name: "В корзину" }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/present\/s\/cart$/);
  await expect(page.getByText("Лёгкие кроссовки × 1")).toBeVisible();

  // Esc возвращает в плеер на тот же экран.
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/p\/checkout\/s\/cart$/);
  await expect(page.getByRole("link", { name: "Галерея" })).toBeVisible();

  expect(consoleErrors).toEqual([]);
});

test("deep link opens the requested screen and offers an easy-ui entry", async ({ page }) => {
  await page.goto("/p/checkout/present/s/product");
  await expect(page).toHaveURL(/\/p\/checkout\/present\/s\/product$/);
  await expect(page.getByRole("button", { name: "В корзину" })).toBeVisible();
  const openInApp = page.getByRole("link", { name: "Открыть в easy-ui" });
  await expect(openInApp).toBeVisible();
  await openInApp.click();
  await expect(page).toHaveURL(/\/p\/checkout\/s\/product$/);
});

test("gallery card opens the presentation at the start screen", async ({ page }) => {
  await page.goto("/");
  const card = page.getByRole("listitem").filter({ hasText: "Мобильное оформление заказа" });
  await card.getByRole("link", { name: "Презентация" }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/present\/s\/catalog$/);
  await expect(page.getByRole("button", { name: "Открыть карточку кроссовок" })).toBeVisible();
});

test.describe("mobile customer viewport", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("presentation fits 390px without cropping and stays interactive", async ({ page }) => {
    await page.goto("/p/checkout/present");
    await expect(page).toHaveURL(/\/p\/checkout\/present\/s\/catalog$/);
    const cta = page.getByRole("button", { name: "Открыть карточку кроссовок" });
    await expect(cta).toBeVisible();

    // Без горизонтальной прокрутки и обрезков: фрейм скейлится в вьюпорт.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const stage = page.getByRole("region", { name: "Превью прототипа на устройстве" });
    const box = (await stage.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390 + 1);

    // Флоу кликается на мобильном вьюпорте.
    await cta.click();
    await expect(page).toHaveURL(/\/p\/checkout\/present\/s\/product$/);
  });
});
