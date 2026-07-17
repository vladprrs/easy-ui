import { expect, test } from "@playwright/test";
import { SCREEN_REGIONS_ID } from "../screen-regions.fixture";

test("production bundle keeps FlowRoot and mobile region portal CSS", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/p/${SCREEN_REGIONS_ID}/present/s/regions?mobile=1`);

  const stage = page.locator('[data-eui-stage-viewport="present-fluid"]');
  const header = stage.locator('[data-eui-region="header"]');
  const footer = stage.locator('[data-eui-region="footer"]');
  await expect(header.getByText("E2E fixed header", { exact: true })).toBeVisible();
  await expect(footer.getByRole("button", { name: "Open regionless screen" })).toBeVisible();
  await expect(page.getByText("9:41 · E2E status", { exact: true })).toHaveCount(0);
  await expect(stage.locator('[data-eui-host-primitive="FlowRoot"]')).toBeVisible();
  await expect(stage).toHaveCSS("display", "flex");
  await expect(header).toHaveCSS("z-index", "10");
  await expect(footer).toHaveCSS("z-index", "10");
  await expect(stage.locator('[data-eui-overlay-layer="present-fluid"]')).toHaveCSS("z-index", "20");
});
