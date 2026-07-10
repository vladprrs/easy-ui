import { expect, test } from "@playwright/test";

test("library loads the story tree and selects a Storybook iframe", async ({ page }) => {
  await page.goto("/library");
  const tree = page.getByRole("navigation", { name: "Stories" });
  await expect(tree).toBeVisible();
  const stories = tree.getByRole("button");
  await expect(stories.first()).toBeVisible();
  await stories.nth(1).click();
  await expect(page.getByTitle("Story preview")).toHaveAttribute("src", /^\/storybook\/iframe\.html\?id=.+&viewMode=story$/);
});
