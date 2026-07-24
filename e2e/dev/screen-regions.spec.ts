import { expect, test, type Locator, type Page } from "@playwright/test";
import { SCREEN_REGIONS_GALLERY_ID, SCREEN_REGIONS_ID } from "../screen-regions.fixture";

const flowRoot = (scope: Page | Locator) => scope.locator('[data-eui-host-primitive="FlowRoot"]');
const fluidStage = (page: Page) => page.locator('[data-eui-stage-viewport="present-fluid"]');
const fluidScroller = (page: Page) => page.locator('[data-eui-content-scroller="present-fluid"]');

/**
 * Framed-плеер и десктопный present теперь извлекают регионы во внутреннюю телефонную
 * сцену `player-stage`: statusBar+header — в верхних пиннед-слотах, footer — в нижнем,
 * контент — в скроллере. `status: "drop"` — тумблер статусбара выключил статусбар (слот пуст).
 */
async function expectRegionsExtracted(scope: Page | Locator, opts: { status: "extract" | "drop" }) {
  const stage = scope.locator('[data-eui-stage-viewport="player-stage"]');
  await expect(stage).toBeVisible();
  const statusSlot = stage.locator('[data-eui-region="statusBar"]');
  const headerSlot = stage.locator('[data-eui-region="header"]');
  const footerSlot = stage.locator('[data-eui-region="footer"]');
  const scroller = stage.locator('[data-eui-content-scroller="player-stage"]');
  // header/footer — в пиннед-слотах, контент — в скроллере (а не в слотах).
  await expect(headerSlot.getByText("E2E fixed header", { exact: true })).toBeVisible();
  await expect(footerSlot.getByRole("button", { name: "Open regionless screen" })).toBeVisible();
  await expect(scroller.getByRole("img", { name: "E2E long region content" })).toBeVisible();
  await expect(headerSlot.getByRole("img", { name: "E2E long region content" })).toHaveCount(0);
  await expect(footerSlot.getByRole("img", { name: "E2E long region content" })).toHaveCount(0);
  if (opts.status === "extract") {
    await expect(statusSlot.getByText("9:41 · E2E status", { exact: true })).toBeVisible();
  } else {
    await expect(scope.getByText("9:41 · E2E status", { exact: true })).toHaveCount(0);
  }
}

async function expectRegionsInline(scope: Page | Locator) {
  const root = flowRoot(scope).filter({ hasText: "E2E fixed header" }).first();
  await expect(root).toBeVisible();
  for (const text of ["9:41 · E2E status", "E2E fixed header", "Open regionless screen"]) {
    await expect(root.getByText(text, { exact: true })).toBeVisible();
  }
  const order = await root.evaluate((node) => {
    const text = node.textContent ?? "";
    return ["9:41 · E2E status", "E2E fixed header", "Open regionless screen"].map((item) => text.indexOf(item));
  });
  expect(order[0]).toBeGreaterThanOrEqual(0);
  expect(order[0]).toBeLessThan(order[1]!);
  expect(order[1]).toBeLessThan(order[2]!);
}

test.describe("mobile fluid screen regions", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test("pins bars, drops status, layers Overlay, and opens a regionless screen at the top", async ({ page }) => {
    await page.goto(`/p/${SCREEN_REGIONS_ID}/present?mobile=1`);
    await expect(page).toHaveURL(new RegExp(`/p/${SCREEN_REGIONS_ID}/present/s/regions\\?mobile=1$`));

    const stage = fluidStage(page);
    const scroller = fluidScroller(page);
    const headerSlot = stage.locator('[data-eui-region="header"]');
    const footerSlot = stage.locator('[data-eui-region="footer"]');
    await expect(headerSlot.getByText("E2E fixed header", { exact: true })).toBeVisible();
    await expect(footerSlot.getByRole("button", { name: "Open regionless screen" })).toBeVisible();
    await expect(page.getByText("9:41 · E2E status", { exact: true })).toHaveCount(0);

    const before = {
      header: await headerSlot.boundingBox(),
      footer: await footerSlot.boundingBox(),
    };
    await scroller.evaluate((node) => { node.scrollTop = 600; });
    await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    const after = {
      header: await headerSlot.boundingBox(),
      footer: await footerSlot.boundingBox(),
    };
    expect(after.header?.y).toBeCloseTo(before.header?.y ?? 0, 0);
    expect(after.footer?.y).toBeCloseTo(before.footer?.y ?? 0, 0);

    const overlayLayer = stage.locator('[data-eui-overlay-layer="present-fluid"]');
    const overlay = overlayLayer.getByText("E2E overlay above footer", { exact: true });
    await expect(overlay).toBeVisible();
    const [overlayBox, footerBox] = await Promise.all([overlay.boundingBox(), footerSlot.boundingBox()]);
    expect(overlayBox!.y).toBeLessThan(footerBox!.y + footerBox!.height);
    expect(Number(await overlayLayer.evaluate((node) => getComputedStyle(node).zIndex)))
      .toBeGreaterThan(Number(await footerSlot.evaluate((node) => getComputedStyle(node).zIndex)));

    const tab = footerSlot.getByRole("button", { name: "Open regionless screen" });
    await tab.tap({ position: { x: 8, y: 4 } });
    await expect(page).toHaveURL(new RegExp(`/p/${SCREEN_REGIONS_ID}/present/s/plain\\?mobile=1$`));
    await expect(page.getByRole("img", { name: "E2E regionless content" })).toBeVisible();
    await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBe(0);
    await expect(headerSlot).toBeEmpty();
    await expect(footerSlot).toBeEmpty();
    const sizes = await stage.evaluate((node) => {
      const content = node.querySelector<HTMLElement>('[data-eui-content-scroller="present-fluid"]')!;
      return { stage: node.clientHeight, content: content.clientHeight };
    });
    expect(sizes.content).toBe(sizes.stage);
  });
});

test.describe("framed player and desktop present region extraction", () => {
  test("framed player and desktop present extract authored regions into pinned slots; the viewer toggle drops status", async ({ page }) => {
    await page.goto(`/p/${SCREEN_REGIONS_ID}/s/regions?mobile=0`);
    await expectRegionsExtracted(page.getByRole("region", { name: "Превью прототипа на устройстве" }), { status: "extract" });

    await page.goto(`/p/${SCREEN_REGIONS_ID}/present/s/regions?mobile=0`);
    await expectRegionsExtracted(page, { status: "extract" });
    const toggle = page.getByRole("button", { name: "Скрыть статус-бар" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    // Тумблер = drop: статусбар исчез, header/footer остались в слотах.
    await expectRegionsExtracted(page, { status: "drop" });
  });
});

test.describe("inline cross-surface rendering", () => {
  test("editor canvas and strip, CJM, and capture render regions inline", async ({ page }) => {
    await page.goto(`/p/${SCREEN_REGIONS_ID}/edit`);
    await expectRegionsInline(page.locator('[data-eui-stage-viewport="editor"]'));
    await expectRegionsInline(page.locator('[data-eui-stage-viewport="editor-strip"]').filter({ hasText: "E2E fixed header" }));

    await page.goto(`/p/${SCREEN_REGIONS_ID}/cjm`);
    await expectRegionsInline(page.locator('[data-eui-stage-viewport="cjm"]').filter({ hasText: "E2E fixed header" }));

    await page.addInitScript(() => localStorage.setItem("eui.statusBarHidden", "true"));
    await page.goto(`/capture/${SCREEN_REGIONS_ID}/s/regions`);
    await expectRegionsInline(page.locator("#eui-capture-surface"));
    expect(await page.evaluate(() => localStorage.getItem("eui.statusBarHidden"))).toBe("true");
  });

  test("Gallery uses a host-only FlowRoot fixture and keeps all regions inline", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Поиск по названию").fill("E2E screen regions gallery host-only");
    const card = page.getByRole("listitem").filter({ hasText: "E2E screen regions gallery host-only" });
    const preview = card.locator(`[data-gallery-preview="${SCREEN_REGIONS_GALLERY_ID}"]`);
    await expect(preview).toBeVisible();
    const root = flowRoot(preview);
    await expect(root).toHaveCount(1);
    for (const name of ["Gallery inline status", "Gallery inline header", "Gallery inline content", "Gallery inline footer"]) {
      await expect(root.getByRole("img", { name })).toBeAttached();
    }
  });
});
