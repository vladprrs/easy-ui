import { expect, test } from "@playwright/test";

test.describe("new prototype onboarding", () => {
  test("Собрать с агентом → единая внешняя инструкция", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Новый прототип" })).toHaveCount(0);
    await page.getByRole("button", { name: "Собрать с агентом" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Соберите прототип с агентом" });
    await expect(dialog).toContainText("Откройте Codex или Claude со скиллом Easy UI и опишите идею. Агент соберёт прототип и добавит его в галерею.");
    await expect(dialog.getByRole("textbox")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Понятно" }).click();
    await expect(dialog).toHaveCount(0);
  });
});
