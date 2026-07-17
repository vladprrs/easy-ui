import { expect, test, type Page } from "@playwright/test";

const scenarioBar = (page: Page) => page.getByTestId("scenario-bar");

test("direct flow and step entry activates ScenarioBar at the canonical occurrence", async ({ page }) => {
  await page.goto("/p/branching-checkout/s/delivery?flow=happy-path&step=2");

  const bar = scenarioBar(page);
  await expect(bar.getByRole("combobox", { name: "Сценарий" })).toHaveValue("happy-path");
  await expect(bar.getByRole("status")).toHaveText("Шаг 3 из 5");
  await expect(bar.getByRole("button", { name: "Предыдущий шаг" })).toBeEnabled();
  await expect(bar.getByRole("button", { name: "Следующий шаг" })).toBeEnabled();
});

test("prev and next browse in the same player session and synchronize step with replace navigation", async ({ page }) => {
  await page.goto("/p/flows-perf/s/main-0?flow=perf-main&step=0");
  await expect(page.getByText("Сессия чистая", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Запомнить в сессии" }).click();
  await expect(page.getByText("Сессия сохранена", { exact: true })).toBeVisible();
  const historyLength = await page.evaluate(() => history.length);

  await scenarioBar(page).getByRole("button", { name: "Следующий шаг" }).click();
  await expect(page).toHaveURL(/\/p\/flows-perf\/s\/main-1\?flow=perf-main&step=1$/);
  await expect(scenarioBar(page).getByRole("status")).toHaveText("Шаг 2 из 50");
  expect(await page.evaluate(() => history.length)).toBe(historyLength);

  await scenarioBar(page).getByRole("button", { name: "Предыдущий шаг" }).click();
  await expect(page).toHaveURL(/\/p\/flows-perf\/s\/main-0\?flow=perf-main&step=0$/);
  await expect(page.getByText("Сессия сохранена", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
});

test("a non-canonical repeated-screen step is removed and an occurrence choice restores it", async ({ page }) => {
  await page.goto("/p/branching-checkout/s/cancel-confirm?flow=cancellation&step=3&debug=1");

  await expect(page).toHaveURL(/\/p\/branching-checkout\/s\/cancel-confirm\?flow=cancellation&debug=1$/);
  const bar = scenarioBar(page);
  await expect(bar.getByRole("status")).toHaveText("Шаг не определён");
  const choices = bar.getByRole("group", { name: "Выберите вхождение экрана" });
  await expect(choices.getByRole("button")).toHaveText(["Шаг 3", "Шаг 5"]);

  await choices.getByRole("button", { name: "Шаг 5" }).click();
  await expect(page).toHaveURL(/\/p\/branching-checkout\/s\/cancel-confirm\?flow=cancellation&debug=1&step=4$/);
  await expect(bar.getByRole("status")).toHaveText("Шаг 5 из 6");
});

test("external navigation outside the route offers a return to step one", async ({ page }) => {
  await page.goto("/p/branching-checkout/s/success?flow=cancellation&step=5");

  const bar = scenarioBar(page);
  await expect(bar.getByRole("status")).toHaveText("Текущий экран вне сценария");
  await expect(page).toHaveURL(/\/p\/branching-checkout\/s\/success\?flow=cancellation$/);
  await bar.getByRole("button", { name: "К шагу 1" }).click();
  await expect(page).toHaveURL(/\/p\/branching-checkout\/s\/catalog\?flow=cancellation&step=0$/);
  await expect(bar.getByRole("status")).toHaveText("Шаг 1 из 6");
});

test("Player to CJM to a step tile round-trip opens that exact scenario occurrence", async ({ page }) => {
  await page.goto("/p/branching-checkout/s/declined?flow=bank-declined&step=4");
  await page.getByRole("link", { name: "CJM", exact: true }).click();
  await expect(page).toHaveURL(/\/p\/branching-checkout\/cjm\?flow=bank-declined&step=4$/);

  await page.getByRole("link", { name: /Открыть экран «Причина отмены».*в плеере/ }).click();
  await expect(page).toHaveURL(/\/p\/branching-checkout\/s\/cancel-reason\?flow=cancellation&step=3$/);
  await expect(scenarioBar(page).getByRole("status")).toHaveText("Шаг 4 из 6");

  await page.getByRole("link", { name: "CJM", exact: true }).click();
  await page.getByRole("link", { name: "Плеер", exact: true }).click();
  await expect(page).toHaveURL(/\/p\/branching-checkout\/s\/cancel-reason\?flow=cancellation&step=3$/);
});

test("Present strips scenario query, preserves other query, and Escape returns to Player", async ({ page }) => {
  await page.goto("/p/branching-checkout/s/delivery?flow=happy-path&step=2&debug=1&theme=dark");
  await page.getByRole("link", { name: "Презентация" }).click();

  await expect(page).toHaveURL(/\/p\/branching-checkout\/present\/s\/delivery\?debug=1&theme=dark$/);
  await expect(scenarioBar(page)).toHaveCount(0);
  await expect(page.getByText("Esc — вернуться в плеер")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/p\/branching-checkout\/s\/delivery\?debug=1&theme=dark$/);
  await expect(scenarioBar(page).getByRole("combobox", { name: "Сценарий" })).toHaveValue("");
});
