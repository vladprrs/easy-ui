import { expect, test } from "@playwright/test";

test("starter settings flow navigates forward and preserves player back history", async ({ page }) => {
  await page.goto("/p/settings");
  await expect(page).toHaveURL(/\/p\/settings\/s\/preferences$/);
  await page.getByLabel("Превью прототипа на устройстве").getByRole("button", { name: "О приложении" }).click();
  await expect(page).toHaveURL(/\/p\/settings\/s\/about$/);
  await page.getByLabel("Превью прототипа на устройстве").getByRole("button", { name: "Конфиденциальность" }).click();
  await expect(page).toHaveURL(/\/p\/settings\/s\/privacy$/);
  await page.getByLabel("Превью прототипа на устройстве").getByRole("button", { name: "Назад" }).click();
  await expect(page).toHaveURL(/\/p\/settings\/s\/about$/);
});
