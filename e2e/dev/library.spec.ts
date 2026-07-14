import { expect, test } from "@playwright/test";

test("library loads the story tree and selects a Storybook iframe", async ({ page }) => {
  await page.goto("/library");
  // Systems are sorted by name, and the e2e custom design system fixture (custom-ds.setup.ts)
  // sorts before Shadcn — pick the builtin system explicitly before asserting its stories.
  await page.locator('[aria-label="Дизайн-системы"]').getByRole("button", { name: "Shadcn", exact: true }).click();
  await expect(page.getByLabel("Фильтры статусов")).toHaveCount(0);
  const tree = page.getByRole("navigation", { name: "Компоненты" });
  await expect(tree).toBeVisible();
  const stories = tree.getByRole("button");
  await expect(stories.first()).toBeVisible();
  await stories.nth(1).click();
  await expect(page.getByTitle("Превью истории")).toHaveAttribute("src", /^\/storybook\/iframe\.html\?id=.+&viewMode=story$/);
});
