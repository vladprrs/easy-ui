import { expect, test } from "@playwright/test";
import { ensureStarterDesignSystem, ensureStarterPrototype, starterPrototypeFromFile } from "../starter-ds.fixture";

const api = "/api";

/**
 * Дуо-сцена плеера (план `docs/plans/2026-08-02-multi-surface-flows.md`, W2).
 *
 * Фикстура `test/fixtures/duo-pos.json` — КСО (desktop, canvas-экраны по D2a) плюс
 * приложение покупателя (mobile) на **одной** ДС; стартеризуется в custom-only каталог
 * и публикуется через API (builtin-DS публиковать нельзя). Сервер поднимается с
 * `EASYUI_SURFACES=1` — kill-switch D16 включён в `playwright.config.ts`.
 */
test("duo player: one click on the kiosk drives the phone panel through shared state", async ({ request, page }) => {
  await ensureStarterDesignSystem(request, api);
  const doc = await starterPrototypeFromFile("test/fixtures/duo-pos.json");
  await ensureStarterPrototype(request, doc, { api, message: "E2E duo surfaces fixture" });

  await page.goto("/p/duo-pos");
  await expect(page).toHaveURL(/\/p\/duo-pos\/s\/kso-idle$/);

  const panels = page.getByTestId("surface-panel");
  await expect(panels).toHaveCount(2);
  const kso = page.locator("[data-testid='surface-panel'][data-surface='kso']");
  const app = page.locator("[data-testid='surface-panel'][data-surface='app']");
  await expect(kso).toHaveAttribute("data-focused", "true");
  await expect(app).toHaveAttribute("data-focused", "false");
  // Обе панели живые и читают один стейт.
  await expect(kso.getByText("Касса самообслуживания")).toBeVisible();
  await expect(app.getByText("Приложение покупателя")).toBeVisible();
  await expect(app.getByText("Статус заказа: Нет активного заказа")).toBeVisible();

  // Клик на КСО двигает свою поверхность; вторая панель остаётся на своём экране.
  await kso.getByRole("button", { name: "Сканировать товар" }).click();
  await expect(page).toHaveURL(/\/p\/duo-pos\/s\/kso-scan$/);
  await expect(app.getByText("Статус заказа: Товар отсканирован")).toBeVisible();

  // Оплата на кассе открывает чек в приложении: цель принадлежит второй поверхности,
  // фокус переезжает на неё, экран КСО живёт в query-карте.
  await kso.getByRole("button", { name: "Оплатить" }).click();
  await expect(page).toHaveURL(/\/p\/duo-pos\/s\/app-receipt\?on\.kso=kso-scan$/);
  await expect(app).toHaveAttribute("data-focused", "true");
  await expect(app.getByText("Электронный чек")).toBeVisible();
  // Касса осталась живой панелью и отреагировала на общий стейт.
  await expect(kso.getByText("Оплата принята — чек ушёл в приложение")).toBeVisible();
  // Статус из общего стейта виден на обеих панелях.
  await expect(kso.getByText("Статус заказа: Оплачен")).toBeVisible();
  await expect(app.getByText("Статус заказа: Оплачен")).toBeVisible();

  // Клик по несфокусированной панели работает: она интерактивна (D11).
  await kso.getByRole("button", { name: "Завершить" }).click();
  await expect(page).toHaveURL(/\/p\/duo-pos\/s\/kso-done\?on\.app=app-receipt$/);
  await expect(kso.getByText("Спасибо! Чек в приложении")).toBeVisible();
  await expect(app.getByText("Электронный чек")).toBeVisible();

  // Back/Forward восстанавливают обе панели из URL.
  await page.goBack();
  await expect(page).toHaveURL(/\/p\/duo-pos\/s\/app-receipt\?on\.kso=kso-scan$/);
  await expect(app.getByText("Электронный чек")).toBeVisible();
  await expect(kso.getByText("Оплата принята — чек ушёл в приложение")).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\/p\/duo-pos\/s\/kso-done\?on\.app=app-receipt$/);

  // Restart — обе поверхности на startScreen, карта из query вычищена.
  await page.getByRole("button", { name: "Начать сначала" }).first().click();
  await expect(page).toHaveURL(/\/p\/duo-pos\/s\/kso-idle$/);
  await expect(kso.getByText("Касса самообслуживания")).toBeVisible();
  await expect(app.getByText("Статус заказа: Нет активного заказа")).toBeVisible();
});

test("duo player: deep link restores both panels and falls back on a stale companion", async ({ request, page }) => {
  await ensureStarterDesignSystem(request, api);
  await ensureStarterPrototype(request, await starterPrototypeFromFile("test/fixtures/duo-pos.json"), { api, message: "E2E duo surfaces fixture" });

  const kso = page.locator("[data-testid='surface-panel'][data-surface='kso']");
  const app = page.locator("[data-testid='surface-panel'][data-surface='app']");

  // Corner-кейс отмены воспроизводится одной ссылкой: обе панели заданы URL.
  await page.goto("/p/duo-pos/s/kso-cancelled?on.app=app-cancelled");
  await expect(kso.getByText("Заказ отменён на кассе")).toBeVisible();
  await expect(app.getByText("Оплата отменена")).toBeVisible();

  // Неизвестный экран в карте — фолбэк на startScreen поверхности, URL нормализуется.
  await page.goto("/p/duo-pos/s/kso-scan?on.app=gone-screen");
  await expect(page).toHaveURL(/\/p\/duo-pos\/s\/kso-scan$/);
  await expect(app.getByText("Приложение покупателя")).toBeVisible();

  // Сайдбар сгруппирован по поверхностям, стрелки ходят внутри сфокусированной.
  const sidebar = page.getByRole("complementary", { name: "Экраны" });
  await expect(sidebar.getByRole("region", { name: "КСО" })).toBeVisible();
  await expect(sidebar.getByRole("region", { name: "Приложение" })).toBeVisible();
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(/\/p\/duo-pos\/s\/kso-done/);

  // Клик по заголовку панели переносит фокус, не трогая экраны.
  await app.getByRole("button", { name: "Приложение", exact: true }).click();
  await expect(page).toHaveURL(/\/p\/duo-pos\/s\/app-home\?on\.kso=kso-done$/);
  await expect(app).toHaveAttribute("data-focused", "true");
});
