import { expect, test, type Page } from "@playwright/test";

const mobileContextOptions = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
} as const;

test.use(mobileContextOptions);

const fluidStage = (page: Page) => page.locator('[data-eui-stage-viewport="present-fluid"]');
const fluidScroller = (page: Page) => page.locator('[data-eui-content-scroller="present-fluid"]');

async function expectCanvasScaledToScroller(page: Page, overlayText: string) {
  const scroller = fluidScroller(page);
  const spacer = scroller.locator(":scope > div");
  const stage = fluidStage(page);
  await expect(stage.getByText(overlayText)).toBeAttached();
  await expect.poll(() => stage.evaluate((node) => Number.parseFloat(node.style.transform.slice(6)))).toBeCloseTo(390 / 420, 5);

  const geometry = await scroller.evaluate((node) => {
    const spacerNode = node.firstElementChild as HTMLElement;
    const stageNode = spacerNode.firstElementChild as HTMLElement;
    return {
      clientWidth: node.clientWidth,
      spacerWidth: spacerNode.getBoundingClientRect().width,
      spacerHeight: spacerNode.getBoundingClientRect().height,
      transform: stageNode.style.transform,
    };
  });
  expect(geometry.spacerWidth).toBeCloseTo(geometry.clientWidth, 0);
  expect(geometry.transform).toMatch(/^scale\(0\.9/);
  await expect(spacer).toHaveCSS("overflow", "hidden");
  return geometry;
}

test("mobile override renders checkout fluid and completes the tap flow", async ({ page }) => {
  await page.goto("/p/checkout/present?mobile=1");
  await expect(page).toHaveURL(/\/p\/checkout\/present\/s\/catalog\?mobile=1$/);
  await expect(fluidStage(page)).toBeVisible();
  await expect(page.locator('[data-eui-stage-viewport="player"]')).toHaveCount(0);
  await expect(page.locator("footer")).toHaveCount(0);

  await page.getByRole("button", { name: "Открыть карточку кроссовок" }).tap();
  await expect(page).toHaveURL(/\/p\/checkout\/present\/s\/product\?mobile=1$/);
  await page.getByRole("button", { name: "В корзину" }).tap();
  await expect(page).toHaveURL(/\/p\/checkout\/present\/s\/cart\?mobile=1$/);
  await expect(page.getByText("Лёгкие кроссовки × 1")).toBeVisible();
});

test("flow Overlay stays pinned to the viewport while authored content scrolls", async ({ page }) => {
  await page.goto("/p/e2e-mobile-flow-overlay/present?mobile=1");
  const overlay = page.getByText("Flow Overlay");
  await expect(overlay).toBeVisible();
  const before = await overlay.boundingBox();
  await fluidScroller(page).evaluate((node) => { node.scrollTop = 500; });
  await expect.poll(() => fluidScroller(page).evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  const after = await overlay.boundingBox();
  expect(after?.y).toBeCloseTo(before?.y ?? 0, 0);
  expect(await overlay.evaluate((node) => node.closest('[data-eui-stage-viewport="present-fluid"]') !== null)).toBe(true);
});

test("HUD restarts, counts, auto-closes with clock, and exits an internal entry", async ({ page }) => {
  await page.goto("/p/checkout/s/product?mobile=1");
  // The desktop player chrome is intentionally dense at 390px; force still exercises
  // the real React Router link and gives PresentShell a PUSH/internal entry.
  await page.getByRole("link", { name: "Презентация" }).tap({ force: true });
  await expect(page).toHaveURL(/\/p\/checkout\/present\/s\/product\?mobile=1$/);

  // Install only after application bootstrap and before opening the HUD.
  await page.clock.install();
  await page.clock.pauseAt(Date.now());
  const fab = page.getByRole("button", { name: "Открыть управление презентацией" });
  await fab.tap();
  const panel = page.getByRole("dialog", { name: "Управление презентацией" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("2 / 5")).toBeVisible();
  await panel.getByRole("button", { name: "Начать сначала" }).tap();
  await expect(page).toHaveURL(/\/p\/checkout\/present\/s\/catalog\?mobile=1$/);

  // Restart changes the stage branch (flow -> canvas) and the HUD may already be
  // collapsed by the interaction timer; reopen it to assert the updated counter.
  await expect(fab).toBeVisible();
  await fab.tap();
  await expect(panel.getByText("1 / 5")).toBeVisible();
  await page.clock.runFor(4_001);
  await expect(panel).toHaveCount(0);
  await expect(fab).toBeVisible();

  await fab.tap();
  const returnToPlayer = page.getByRole("link", { name: "Вернуться в плеер" });
  await expect(returnToPlayer).toBeVisible();
  await returnToPlayer.tap();
  await expect(page).toHaveURL(/\/p\/checkout\/s\/catalog\?mobile=1$/);
});

test("mobile=0 keeps DeviceFrame and the desktop footer", async ({ page }) => {
  await page.goto("/p/checkout/present?mobile=0");
  await expect(page.getByRole("region", { name: "Превью прототипа на устройстве" })).toBeVisible();
  await expect(page.locator('[data-eui-stage-viewport="player"]')).toBeVisible();
  await expect(fluidStage(page)).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Экраны презентации" })).toBeVisible();
  await expect(page.locator("footer")).toBeVisible();
});

test("coarse compact pointer enables fluid mode without an override", async ({ page }) => {
  await page.goto("/p/e2e-mobile-flow-overlay/present");
  const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  test.skip(!coarse, "Chromium context does not expose the requested coarse pointer");
  await expect(fluidStage(page)).toBeVisible();
});

for (const canvas of [
  { screen: "boundary", height: 920, overlay: "Canvas Overlay boundary" },
  { screen: "long", height: 1200, overlay: "Canvas Overlay long" },
] as const) {
  test(`420×${canvas.height} canvas scales Overlay and reaches its bottom`, async ({ page }) => {
    await page.goto(`/p/e2e-mobile-canvas/present/s/${canvas.screen}?mobile=1`);
    const geometry = await expectCanvasScaledToScroller(page, canvas.overlay);
    expect(geometry.spacerHeight).toBeCloseTo(canvas.height * geometry.clientWidth / 420, 0);

    const scroller = fluidScroller(page);
    await scroller.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await expect.poll(() => scroller.evaluate((node) => Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop))).toBeLessThanOrEqual(1);
    await expect(page.getByText(canvas.overlay)).toBeVisible();
  });
}

test("tablet flow contains wide host Image content inside the compact viewport", async ({ page }) => {
  await page.goto("/p/e2e-tablet-wide-flow/present?mobile=1");
  const scroller = fluidScroller(page);
  const wide = page.getByRole("img", { name: "Широкий планшетный контент" });
  await expect(wide).toBeVisible();
  const initial = await scroller.evaluate((node) => ({ clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }));
  expect(initial.scrollWidth).toBe(initial.clientWidth);
  const [scrollerBox, wideBox] = await Promise.all([scroller.boundingBox(), wide.boundingBox()]);
  expect(wideBox!.x + wideBox!.width).toBeLessThanOrEqual(scrollerBox!.x + scrollerBox!.width + 1);
});
