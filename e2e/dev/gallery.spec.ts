import { expect, test } from "@playwright/test";
import { CUSTOM_DS_PROTOTYPE_ID } from "./custom-ds.fixture";

test.describe("gallery discovery and previews", () => {
  test.use({ viewport: { width: 1024, height: 700 } });

  test("long scale-demo metadata stays inside the grid and remains searchable", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Поиск по названию").fill("Масштабная демонстрация");
    const card = page.getByRole("listitem").filter({ hasText: "Масштабная демонстрация" });
    await expect(card).toBeVisible();
    await expect(card.locator('[data-gallery-preview="scale-demo"]')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);
    const cardBox = (await card.boundingBox())!;
    const titleBox = (await card.getByRole("heading").boundingBox())!;
    expect(titleBox.x).toBeGreaterThanOrEqual(cardBox.x);
    expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
  });

  test("custom DS cards render their published custom component preview", async ({ page }) => {
    const customDraftRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes(`/api/prototypes/${CUSTOM_DS_PROTOTYPE_ID}/draft`)) customDraftRequests.push(request.url());
    });
    await page.goto("/");
    await page.getByLabel("Поиск по названию").fill("Custom DS demo");
    const card = page.getByRole("listitem").filter({ hasText: "Custom DS demo" });
    await expect(card).toBeVisible();
    await expect(card.locator("[data-gallery-preview]")).toHaveCount(1);
    expect(customDraftRequests.length).toBeGreaterThan(0);
  });
});
