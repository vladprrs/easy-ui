import { expect, test, type Locator, type Page } from "@playwright/test";
import { SCREEN_REGIONS_CANVAS_ID, SCREEN_REGIONS_ID } from "../screen-regions.fixture";

// Телефонная сцена десктопного плеера (план 2026-07-24): фрейм всегда телефонной
// длины (каноник 844), header/footer/statusBar пиннятся в слоты, контент скроллится
// ВНУТРИ фрейма, а canvas-экраны скроллятся до низа без растягивания «телефона».

/** Обёртка-трансформ фрейма (носитель scale, каноническая высота 844 до scale). */
const frameWrapper = (region: Page | Locator) => region.locator('[data-eui-stage-viewport="player"]');
/** Внутренняя сцена регионов (RegionStage). */
const phoneStage = (region: Page | Locator) => region.locator('[data-eui-stage-viewport="player-stage"]');

test.describe("desktop framed player — internal phone scroll", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("footer pins to the phone bottom and tall content scrolls inside the frame (fit and manual zoom)", async ({ page }) => {
    await page.goto(`/p/${SCREEN_REGIONS_ID}/s/regions?mobile=0`);
    const region = page.getByRole("region", { name: "Превью прототипа на устройстве" });
    const stage = phoneStage(region);
    const wrapper = frameWrapper(region);
    const headerSlot = stage.locator('[data-eui-region="header"]');
    const footerSlot = stage.locator('[data-eui-region="footer"]');
    const scroller = stage.locator('[data-eui-content-scroller="player-stage"]');

    // Футер виден сразу, без скролла.
    await expect(footerSlot.getByRole("button", { name: "Open regionless screen" })).toBeVisible();
    await expect(headerSlot.getByText("E2E fixed header", { exact: true })).toBeVisible();

    // Футер прижат к низу фрейма (нижняя грань слота ≈ нижняя грань обёртки-телефона).
    const footerPinnedToFrameBottom = async () => {
      const [frame, footer] = await Promise.all([wrapper.boundingBox(), footerSlot.boundingBox()]);
      expect(Math.abs((footer!.y + footer!.height) - (frame!.y + frame!.height))).toBeLessThan(2);
    };
    await footerPinnedToFrameBottom();

    // Контент скроллится ВНУТРИ фрейма: колесо над фреймом → scrollTop растёт,
    // header/footer bounding box не двигаются.
    const scrollsInsideFrame = async () => {
      await scroller.evaluate((node) => { node.scrollTop = 0; });
      await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBe(0);
      const before = { header: await headerSlot.boundingBox(), footer: await footerSlot.boundingBox() };
      const frame = await wrapper.boundingBox();
      await page.mouse.move(frame!.x + frame!.width / 2, frame!.y + frame!.height / 2);
      await page.mouse.wheel(0, 600);
      await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
      const after = { header: await headerSlot.boundingBox(), footer: await footerSlot.boundingBox() };
      expect(after.header!.y).toBeCloseTo(before.header!.y, 0);
      expect(after.footer!.y).toBeCloseTo(before.footer!.y, 0);
    };

    // (a) fit-масштаб.
    await scrollsInsideFrame();

    // (b) manual zoom ≠ 1: «100%» → фиксированный scale, затем «Увеличить масштаб».
    await page.getByRole("button", { name: "100%" }).click();
    await expect(page.getByRole("button", { name: "100%" })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Увеличить масштаб" }).click();
    // Фрейм по-прежнему телефонной длины (844/390 ≈ 2.16), не растянут.
    const frameBox = await wrapper.boundingBox();
    expect(frameBox!.height / frameBox!.width).toBeCloseTo(844 / 390, 1);
    // Футер всё так же прижат к низу, контент всё так же скроллится внутри.
    await footerPinnedToFrameBottom();
    await scrollsInsideFrame();
  });
});

test.describe("desktop framed player — canvas keeps phone height", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("390×1722 canvas frame stays canonical height and scrolls to the canvas bottom", async ({ page }) => {
    await page.goto(`/p/${SCREEN_REGIONS_CANVAS_ID}/s/canvas?mobile=0`);
    const region = page.getByRole("region", { name: "Превью прототипа на устройстве" });
    const wrapper = frameWrapper(region);
    const scroller = region.locator('[data-eui-content-scroller="player-canvas"]');

    await expect(page.getByText("E2E canvas top", { exact: true })).toBeVisible();

    // Высота видимого фрейма — каноническая (844×scale), НЕ 1722×scale:
    // соотношение сторон обёртки ≈ 844/390, а не 1722/390.
    const frameBox = await wrapper.boundingBox();
    expect(frameBox!.height / frameBox!.width).toBeCloseTo(844 / 390, 1);

    // canvas выше фрейма: внутри — вертикальный скроллер player-canvas.
    await expect(scroller).toHaveCount(1);
    const metrics = await scroller.evaluate((node) => ({ scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }));
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    // clientHeight — натуральные 844 (scale наложен родительским transform), scrollHeight ≈ 1722.
    expect(metrics.clientHeight).toBeCloseTo(844, -1);
    expect(metrics.scrollHeight).toBeGreaterThanOrEqual(1722);

    // Скролл до низа canvas работает — нижний маркер становится виден.
    await scroller.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await expect.poll(() => scroller.evaluate((node) => node.scrollTop))
      .toBe(metrics.scrollHeight - metrics.clientHeight);
    await expect(page.getByText("E2E canvas bottom", { exact: true })).toBeVisible();
  });
});
