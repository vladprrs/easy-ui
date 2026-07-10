import { expect, test } from "@playwright/test";

test("settings tabs, bound switch, dialog and back navigation work", async ({ page }) => {
  await page.goto("/p/settings");
  await expect(page).toHaveURL(/\/p\/settings\/s\/preferences$/);

  const accountTab = page.getByRole("tab", { name: "Аккаунт" });
  await accountTab.click();
  await expect(accountTab).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Интерфейс" }).click();

  await expect(page.getByText("Тёмная тема включена")).toBeHidden();
  await page.getByRole("switch", { name: "Тёмная тема" }).click();
  await expect(page.getByText("Тёмная тема включена")).toBeVisible();

  await page.getByLabel("Prototype device preview").getByRole("button", { name: "О приложении" }).click();
  await expect(page).toHaveURL(/\/p\/settings\/s\/about$/);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: /close/i }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Назад" }).click();
  await expect(page).toHaveURL(/\/p\/settings\/s\/preferences$/);
  await expect(page.getByText("Тёмная тема включена")).toBeVisible();
});
