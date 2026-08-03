import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { ensureStarterDesignSystem, ensureStarterPrototype, starterPrototypeFromFile } from "../starter-ds.fixture";
import { ensureKsoDesignSystem, KSO_ACCENT, KSO_DS_ID, KSO_PROTOTYPE_ID } from "./duo-kso.fixture";

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

/**
 * W5: тот же дуо-контракт, но на **двух** дизайн-системах (`test/fixtures/duo-kso.json`).
 *
 * Приложение — primary-поверхность на `e2e-starter` (её тема глобальная, как сегодня), КСО —
 * вторая поверхность на `e2e-kso-ds`: её панель оборачивается `ScopedThemeSurface`, и её
 * `color()`-токены обязаны действовать **только** внутри этой панели (D9). Share-ресурсы обеих
 * ДС покрыты серверными тестами волны W3 (`server/prototype-surfaces.test.ts`), здесь —
 * пиксельно наблюдаемая часть: тема второй ДС в DOM плеера.
 */
test("duo player on two design systems: the second panel wears the theme of its own system", async ({ request, page }) => {
  await ensureStarterDesignSystem(request, api);
  await ensureKsoDesignSystem(request, api);
  const doc = JSON.parse(await readFile("test/fixtures/duo-kso.json", "utf8")) as Record<string, unknown>;
  await ensureStarterPrototype(request, doc, { api, message: "E2E duo-kso two-design-system fixture" });

  await page.goto(`/p/${KSO_PROTOTYPE_ID}`);
  await expect(page).toHaveURL(new RegExp(`/p/${KSO_PROTOTYPE_ID}/s/app-home$`));
  const app = page.locator("[data-testid='surface-panel'][data-surface='app']");
  const kso = page.locator("[data-testid='surface-panel'][data-surface='kso']");
  await expect(page.getByTestId("surface-panel")).toHaveCount(2);

  // Scoped-тема — ровно на панели не-primary ДС; primary живёт под глобальным ThemeStyle.
  await expect(kso.locator(`[data-eui-scoped-system='${KSO_DS_ID}']`)).toHaveCount(1);
  await expect(app.locator("[data-eui-scoped-surface]")).toHaveCount(0);
  // Токен `color.kso-accent` второй ДС покрасил её клавишу; кнопки primary-панели его не видят.
  const scanKey = kso.getByRole("button", { name: "Сканировать товар" });
  await expect(scanKey).toHaveCSS("background-color", KSO_ACCENT);
  await expect(app.getByRole("button", { name: "Показать QR кассе" })).not.toHaveCSS("background-color", KSO_ACCENT);

  // Кросс-поверхностный флоу: клик в приложении переносит фокус на кассу.
  await app.getByRole("button", { name: "Показать QR кассе" }).click();
  // Приложение осталось на своём startScreen, поэтому карта `on.*` в query пуста.
  await expect(page).toHaveURL(new RegExp(`/p/${KSO_PROTOTYPE_ID}/s/kso-idle$`));
  await expect(kso).toHaveAttribute("data-focused", "true");

  // Касса пишет общий стейт — приложение читает его на своей панели, оставаясь на своём экране.
  await scanKey.click();
  await expect(page).toHaveURL(new RegExp(`/p/${KSO_PROTOTYPE_ID}/s/kso-scan$`));
  await expect(app.getByText("Статус заказа: Товар отсканирован")).toBeVisible();

  // Оплата на кассе ведёт на экран приложения; касса остаётся живой и показывает новый статус.
  await kso.getByRole("button", { name: "Оплатить" }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${KSO_PROTOTYPE_ID}/s/app-confirm\\?on\\.kso=kso-scan$`));
  await expect(app).toHaveAttribute("data-focused", "true");
  await expect(kso.getByText("Статус заказа: Ожидает подтверждения в приложении")).toBeVisible();

  await app.getByRole("button", { name: "Оплатить" }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${KSO_PROTOTYPE_ID}/s/app-receipt\\?on\\.kso=kso-scan$`));
  await expect(app.getByText("Электронный чек")).toBeVisible();
  await expect(kso.getByText("Оплата принята — чек ушёл в приложение")).toBeVisible();
  // Тема второй ДС пережила навигацию обеих панелей.
  await expect(kso.getByRole("button", { name: "Завершить" })).toHaveCSS("background-color", KSO_ACCENT);

  // Corner-кейс воспроизводится одной ссылкой — карта поверхностей живёт в query.
  await page.goto(`/p/${KSO_PROTOTYPE_ID}/s/kso-timeout?on.app=app-home`);
  await expect(kso.getByText("Подтверждение в приложении не пришло. Товар остался в чеке.")).toBeVisible();
  await expect(app.getByText("Статус заказа: Нет активного заказа")).toBeVisible();
});
