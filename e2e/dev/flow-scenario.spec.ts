import { expect, test, type Page } from "@playwright/test";

const scenarioBar = (page: Page) => page.getByTestId("scenario-bar");

test("direct flow and step entry activates ScenarioBar at the canonical occurrence", async ({ page }) => {
  await page.goto("/p/branching-checkout/s/delivery?flow=happy-path&step=2");

  const bar = scenarioBar(page);
  await expect(bar.getByTestId("scenario-flow-button")).toContainText("Успешная оплата");
  await expect(bar.getByRole("status")).toContainText("Шаг 3 из 5");
  // Подписи стрелок несут хоткей (W4-6): шаги ходят по Shift+←/→, а голые ← →
  // остаются за экранами документа.
  await expect(bar.getByRole("button", { name: "Предыдущий шаг · Shift+←" })).toBeEnabled();
  await expect(bar.getByRole("button", { name: "Следующий шаг · Shift+→" })).toBeEnabled();
});

test("prev and next browse in the same player session and synchronize step with replace navigation", async ({ page }) => {
  await page.goto("/p/flows-perf/s/main-0?flow=perf-main&step=0");
  await expect(page.getByText("Сессия чистая", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Запомнить в сессии" }).click();
  await expect(page.getByText("Сессия сохранена", { exact: true })).toBeVisible();
  const historyLength = await page.evaluate(() => history.length);

  await scenarioBar(page).getByRole("button", { name: "Следующий шаг · Shift+→" }).click();
  await expect(page).toHaveURL(/\/p\/flows-perf\/s\/main-1\?flow=perf-main&step=1$/);
  await expect(scenarioBar(page).getByRole("status")).toContainText("Шаг 2 из 50");
  expect(await page.evaluate(() => history.length)).toBe(historyLength);

  // Тот же шаг с клавиатуры: Shift+← идёт по сценарию, не по экранам документа.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Shift+ArrowRight");
  await expect(page).toHaveURL(/\/p\/flows-perf\/s\/main-2\?flow=perf-main&step=2$/);
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(page).toHaveURL(/\/p\/flows-perf\/s\/main-1\?flow=perf-main&step=1$/);

  await scenarioBar(page).getByRole("button", { name: "Предыдущий шаг · Shift+←" }).click();
  await expect(page).toHaveURL(/\/p\/flows-perf\/s\/main-0\?flow=perf-main&step=0$/);
  await expect(page.getByText("Сессия сохранена", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
});

test("a non-canonical repeated-screen step is removed and an occurrence choice restores it", async ({ page }) => {
  await page.goto("/p/branching-checkout/s/cancel-confirm?flow=cancellation&step=3&debug=1");

  await expect(page).toHaveURL(/\/p\/branching-checkout\/s\/cancel-confirm\?flow=cancellation&debug=1$/);
  const bar = scenarioBar(page);
  // Полоса всегда показывает счётчик, а выбор вхождения — один контрол (W4-7).
  await expect(bar.getByRole("status")).toHaveText("Шаг ? из 6 · Шаг не определён");
  const choice = bar.getByRole("combobox", { name: "Шаг сценария" });
  await expect(choice.locator("option")).toHaveText(["Выберите вхождение экрана", "Шаг 3", "Шаг 5"]);

  // Контрол размонтируется ровно в момент успеха (вхождение выбрано — вопроса больше
  // нет), поэтому под нагрузкой change может уйти в уже отсоединённый узел и потеряться.
  // Для человека это один клик; для автоматизации — повтор до подтверждённого шага.
  await expect(async () => {
    await choice.selectOption({ label: "Шаг 5" });
    await expect(page).toHaveURL(/\/p\/branching-checkout\/s\/cancel-confirm\?flow=cancellation&debug=1&step=4$/, { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await expect(bar.getByRole("status")).toContainText("Шаг 5 из 6");
});

test("external navigation outside the route offers a return to step one", async ({ page }) => {
  await page.goto("/p/branching-checkout/s/success?flow=cancellation&step=5");

  const bar = scenarioBar(page);
  await expect(bar.getByRole("status")).toHaveText("Шаг ? из 6 · Текущий экран вне сценария");
  await expect(page).toHaveURL(/\/p\/branching-checkout\/s\/success\?flow=cancellation$/);
  // «К шагу 1» заменена общим выбором шага: вне сценария он предлагает все шаги.
  await bar.getByRole("combobox", { name: "Шаг сценария" }).selectOption("0");
  await expect(page).toHaveURL(/\/p\/branching-checkout\/s\/catalog\?flow=cancellation&step=0$/);
  await expect(bar.getByRole("status")).toContainText("Шаг 1 из 6");
});

test("Player to CJM to a step tile round-trip opens that exact scenario occurrence", async ({ page }) => {
  await page.goto("/p/branching-checkout/s/declined?flow=bank-declined&step=4");
  await page.getByRole("link", { name: "Сценарии", exact: true }).click();
  await expect(page).toHaveURL(/\/p\/branching-checkout\/cjm\?flow=bank-declined&step=4$/);

  // Дефолтный режим CJM — «Сценарии» (T2b): шаг живёт в ленте своей секции.
  // Тайлы монтируются лениво (T2a): обёртка в DOM всегда, тайл — после попадания во вьюпорт.
  // Редизайн (макет 03): тайл ленты открывает лайтбокс, а уже он ведёт в плеер.
  const step = page.locator('.cjm-sheet-section[data-flow-id="cancellation"] li[data-screen-id="cancel-reason"]');
  await step.scrollIntoViewIfNeeded();
  await step.getByRole("button", { name: /Открыть экран «Причина отмены».*в плеере/ }).click();
  const lightbox = page.getByTestId("screen-lightbox");
  await expect(lightbox.getByText("шаг 4 / 6")).toBeVisible();
  await lightbox.getByRole("link", { name: "В плеер →" }).click();
  await expect(page).toHaveURL(/\/p\/branching-checkout\/s\/cancel-reason\?flow=cancellation&step=3$/);
  await expect(scenarioBar(page).getByRole("status")).toContainText("Шаг 4 из 6");

  await page.getByRole("link", { name: "Сценарии", exact: true }).click();
  await page.getByRole("link", { name: "Плеер", exact: true }).click();
  await expect(page).toHaveURL(/\/p\/branching-checkout\/s\/cancel-reason\?flow=cancellation&step=3$/);
});

test("Present strips scenario query, preserves other query, and Escape returns to Player", async ({ page }) => {
  await page.goto("/p/branching-checkout/s/delivery?flow=happy-path&step=2&debug=1&theme=dark");
  // Срез `flow`/`step` больше не молчаливый — он назван в подписи кнопки (W4-11).
  await page.getByRole("link", { name: "Презентация · без сценария" }).click();

  await expect(page).toHaveURL(/\/p\/branching-checkout\/present\/s\/delivery\?debug=1&theme=dark$/);
  await expect(scenarioBar(page)).toHaveCount(0);
  await expect(page.getByText("Esc — вернуться в плеер")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/p\/branching-checkout\/s\/delivery\?debug=1&theme=dark$/);
  await expect(scenarioBar(page).getByTestId("scenario-flow-button")).toContainText("Без сценария");
});
