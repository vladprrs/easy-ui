import { expect, test } from "@playwright/test";

// Рекордер и клиентский прогон сценариев в плеере (волна 6, план 2026-07-27).

test("records a click flow in the player, replays it and saves it next to the prototype", async ({ page }) => {
  await page.goto("/p/hello-world/s/welcome");
  const stage = page.getByLabel("Превью прототипа на устройстве");
  await expect(stage.getByText("Hello, Ada!")).toBeVisible();

  await page.getByTestId("scenario-toggle").click();
  const panel = page.getByRole("complementary", { name: "Сценарии взаимодействия" });
  await expect(panel).toBeVisible();

  // Запись: клик по прототипу продолжает работать (переход происходит), но попадает в шаги.
  await page.getByTestId("scenario-record").click();
  await expect(page.getByTestId("scenario-step-0")).toContainText("welcome");
  await stage.getByRole("button", { name: "Details" }).click();
  await expect(page).toHaveURL(/\/p\/hello-world\/s\/details$/);
  await expect(page.getByTestId("scenario-step-1")).toContainText("Details");
  await expect(page.getByTestId("scenario-step-2")).toContainText("details");
  await page.getByTestId("scenario-record").click();

  // Ручное ожидание текста поверх записи.
  await panel.getByLabel("Тип ожидания").selectOption("expectText");
  await panel.getByLabel("Значение", { exact: true }).fill("This is the second screen.");
  await panel.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(page.getByTestId("scenario-step-3")).toContainText("This is the second screen.");

  // Прогон — все шаги зелёные, а открытый экран остаётся тем же.
  await page.getByTestId("scenario-replay").click();
  await expect(page.getByTestId("scenario-run-summary")).toContainText("4/4 ок");
  await expect(page.getByTestId("scenario-step-status-1")).toHaveText("ок");
  await expect(page).toHaveURL(/\/p\/hello-world\/s\/details$/);

  // Сохранение — сценарий появляется в списке рядом с прототипом.
  await panel.getByLabel("Название сценария").fill("E2E запись");
  await page.getByTestId("scenario-save").click();
  const saved = panel.getByRole("list", { name: "Сохранённые сценарии" });
  await expect(saved.getByText("E2E запись")).toBeVisible();

  // Устаревший шаг не роняет прогон: ключ, которого нет в этой ревизии, помечается «устарел».
  await page.getByTestId("scenario-step-1").getByRole("button", { name: "Удалить шаг" }).click();
  await panel.getByLabel("Тип ожидания").selectOption("expectDisabled");
  await panel.getByLabel("Значение", { exact: true }).fill("no-such-key");
  await panel.getByRole("button", { name: "Добавить", exact: true }).click();
  await page.getByTestId("scenario-replay").click();
  await expect(page.getByTestId("scenario-run-summary")).toContainText("устаревших: 1");

  // Уборка: прогон e2e не оставляет сценариев на общем прототипе.
  await saved.getByRole("button", { name: "Удалить" }).first().click();
  await expect(saved.getByText("E2E запись")).toHaveCount(0);

  // Вне режима записи слушатель снят: клик по прототипу не добавляет шагов.
  const stepsBefore = await page.getByTestId("scenario-steps").locator("li").count();
  await stage.getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/p\/hello-world\/s\/welcome$/);
  await expect(page.getByTestId("scenario-steps").locator("li")).toHaveCount(stepsBefore);
});
