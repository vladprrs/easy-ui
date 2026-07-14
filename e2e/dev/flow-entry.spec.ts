import { expect, test, type Page } from "@playwright/test";

// Политика входа в флоу (W1-5): entryReason + document-lifetime nonce.
// Deep-link/reload в середину флоу — баннер «Состояние флоу сброшено»;
// flow-навигация без reload — баннера нет; browse (сайдбар) — replace вне
// flowDepth; query string (?debug=1) переживает все переходы.

const banner = (page: Page) => page.getByTestId("flow-reset-banner");

test("flow navigation shows no banner; reload mid-flow resets state and shows the banner", async ({ page }) => {
  await page.goto("/p/checkout");
  await expect(page).toHaveURL(/\/p\/checkout\/s\/catalog$/);
  await page.getByRole("button", { name: "Открыть карточку кроссовок" }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/s\/product$/);
  await page.getByRole("button", { name: "В корзину" }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/s\/cart$/);
  await expect(page.getByText("Лёгкие кроссовки × 1")).toBeVisible();
  // flow-навигация без reload — баннера нет.
  await expect(banner(page)).toHaveCount(0);

  // Reload: location.state переживает его через history.state.usr, но
  // document-lifetime nonce уже другой — вход трактуется как bootstrap.
  await page.reload();
  await expect(page).toHaveURL(/\/p\/checkout\/s\/cart$/);
  await expect(banner(page)).toBeVisible();

  // «Начать сначала» ведёт на startScreen со свежим состоянием.
  await banner(page).getByRole("button", { name: "Начать сначала" }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/s\/catalog$/);
  await expect(banner(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Открыть карточку кроссовок" })).toBeVisible();
});

test("deep link into the middle of the flow shows the banner; the cross dismisses it", async ({ page }) => {
  await page.goto("/p/checkout/s/cart");
  await expect(page).toHaveURL(/\/p\/checkout\/s\/cart$/);
  await expect(banner(page)).toBeVisible();
  await banner(page).getByRole("button", { name: "Скрыть уведомление о сбросе" }).click();
  await expect(banner(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/p\/checkout\/s\/cart$/);

  // Deep-link на стартовый экран баннера не показывает.
  await page.goto("/p/checkout/s/catalog");
  await expect(page.getByRole("button", { name: "Открыть карточку кроссовок" })).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
});

test("?debug=1 survives all transitions; sidebar browse is replace outside flowDepth", async ({ page }) => {
  await page.goto("/p/checkout?debug=1");
  await expect(page).toHaveURL(/\/p\/checkout\/s\/catalog\?debug=1$/);
  const chromeActions = page.getByTestId("chrome-actions");
  const chromeBack = chromeActions.getByRole("button", { name: "Назад" });
  const sidebar = page.getByRole("complementary", { name: "Экраны" });

  // Reload сохраняет query-флаг и открывает панель; её toggle живёт в actions-слоте.
  const inspectorPanel = page.getByRole("complementary", { name: "Инспектор взаимодействий" });
  await expect(inspectorPanel).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/p\/checkout\/s\/catalog\?debug=1$/);
  await expect(inspectorPanel).toBeVisible();
  const inspectorToggle = chromeActions.getByRole("button", { name: "Инспектор" });
  await expect(inspectorToggle).toHaveAttribute("aria-pressed", "true");
  await inspectorToggle.click();
  await expect(inspectorPanel).toHaveCount(0);

  // browse с глубины 0: flowDepth не растёт — Back прототипа не реагирует.
  await sidebar.getByRole("button", { name: "Товар" }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/s\/product\?debug=1$/);
  await expect(chromeBack).toBeDisabled();
  await expect(banner(page)).toHaveCount(0);

  // flow-переход наращивает глубину и сохраняет query.
  await page.getByRole("button", { name: "В корзину" }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/s\/cart\?debug=1$/);
  await expect(chromeBack).toBeEnabled();

  // browse с глубины 1: replace — Back возвращает на запись до browse-перехода.
  await sidebar.getByRole("button", { name: "Оформление" }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/s\/checkout-form\?debug=1$/);
  await expect(chromeBack).toBeEnabled();
  await chromeBack.click();
  await expect(page).toHaveURL(/\/p\/checkout\/s\/product\?debug=1$/);

  // restart сохраняет query; инспектор (?debug=1) остаётся доступен в хроме.
  await chromeActions.getByRole("button", { name: "Начать сначала" }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/s\/catalog\?debug=1$/);
  await expect(chromeActions.getByRole("button", { name: "Инспектор" })).toBeVisible();
});

test("player hotkeys browse outside flowDepth, toggle zoom, show help, and restart with query", async ({ page }) => {
  await page.goto("/p/hello-world?source=hotkeys");
  await expect(page).toHaveURL(/\/p\/hello-world\/s\/welcome\?source=hotkeys$/);
  const chromeActions = page.getByTestId("chrome-actions");
  const back = chromeActions.getByRole("button", { name: "Назад" });
  const input = page.getByLabel("Name");
  const initialName = await input.inputValue();
  await input.fill("Lin");

  await input.press("ArrowRight");
  await input.press("r");
  await expect(page).toHaveURL(/\/p\/hello-world\/s\/welcome\?source=hotkeys$/);
  await expect(input).toHaveValue(/r/);
  await expect(input).not.toHaveValue(initialName);

  await input.fill("Lin");
  await input.blur();
  const fit = chromeActions.getByRole("button", { name: "Вписать" });
  const actual = chromeActions.getByRole("button", { name: "100%" });
  await expect(fit).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("F");
  await expect(actual).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("f");
  await expect(fit).toHaveAttribute("aria-pressed", "true");

  await page.keyboard.press("Shift+/");
  await expect(page.getByRole("dialog", { name: "Горячие клавиши" })).toBeVisible();
  await page.keyboard.press("Shift+/");
  await expect(page.getByRole("dialog", { name: "Горячие клавиши" })).toHaveCount(0);

  await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(/\/p\/hello-world\/s\/details\?source=hotkeys$/);
  await expect(back).toBeDisabled();
  await page.keyboard.press("R");
  await expect(page).toHaveURL(/\/p\/hello-world\/s\/welcome\?source=hotkeys$/);
  await expect(page.getByLabel("Name")).toHaveValue(initialName);
});

test("presentation deep link shows the compact reset banner", async ({ page }) => {
  await page.goto("/p/checkout/present/s/cart");
  await expect(page).toHaveURL(/\/p\/checkout\/present\/s\/cart$/);
  await expect(banner(page)).toBeVisible();
  await banner(page).getByRole("button", { name: "Начать сначала" }).click();
  await expect(page).toHaveURL(/\/p\/checkout\/present\/s\/catalog$/);
  await expect(banner(page)).toHaveCount(0);
});
