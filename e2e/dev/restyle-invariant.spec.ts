import { expect, test, type Locator, type Page } from "@playwright/test";

const prototypeId = "settings";
const prototypeFont = /^(?:"?)(?:Coil|YS Text)/;
const baseTokens = {
  "--primary": "oklch(0.205 0 0)",
  "--background": "oklch(1 0 0)",
  "--radius": "0.625rem",
};

async function expectPrototypeFont(locator: Locator) {
  await expect(locator).toBeVisible();
  expect(await locator.evaluate((element) => getComputedStyle(element).fontFamily)).not.toMatch(prototypeFont);
}

async function expectBaseTokens(page: Page) {
  const values = await page.evaluate((names) => Object.fromEntries(names.map((name) => [
    name,
    getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
  ])), Object.keys(baseTokens));
  expect(values).toEqual(baseTokens);
}

test.describe("restyle prototype invariants", () => {
  for (const { name, path, content } of [
    { name: "player", path: `/p/${prototypeId}`, content: '[data-jr-key="preferences-card"]' },
    { name: "CJM", path: `/p/${prototypeId}/cjm`, content: '[aria-label="CJM screens"] [role="tab"]' },
    { name: "editor", path: `/p/${prototypeId}/edit`, content: '[data-jr-key="preferences-card"]' },
    { name: "debug", path: "/debug", content: "main h1" },
  ]) {
    test(`${name} preserves prototype fonts and shadcn tokens`, async ({ page }) => {
      await page.goto(path);
      await expectPrototypeFont(page.locator(content).first());
      await expectBaseTokens(page);
    });
  }

  test("prototype dialog portal keeps the prototype font", async ({ page }) => {
    await page.goto(`/p/${prototypeId}`);
    await page.getByLabel("Prototype device preview").getByRole("button", { name: "О приложении" }).click();
    await expect(page).toHaveURL(/\/p\/settings\/s\/about$/);
    await expectPrototypeFont(page.getByRole("dialog"));
  });

  test("gallery chrome loads and applies both chrome fonts", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => Promise.all([document.fonts.load("16px Coil"), document.fonts.load('14px "YS Text"')]));
    expect(await page.evaluate(() => document.fonts.check("16px Coil") && document.fonts.check('14px "YS Text"'))).toBe(true);

    const headingFont = await page.getByRole("heading", { level: 1 }).evaluate((element) => getComputedStyle(element).fontFamily);
    const navFont = await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link").first().evaluate((element) => getComputedStyle(element).fontFamily);
    expect(headingFont).toMatch(/^Coil/);
    expect(navFont).toMatch(/^(?:"?YS Text)/);
  });

  test("Storybook preview keeps the story font", async ({ page }) => {
    await page.goto("/library");
    const iframe = page.getByTitle("Story preview");
    await expect(iframe).toHaveAttribute("src", /^\/storybook\/iframe\.html\?id=.+&viewMode=story$/);
    await iframe.evaluate((element: HTMLIFrameElement) => {
      element.src = `http://localhost:6006${element.getAttribute("src")!.replace(/^\/storybook/, "")}`;
    });
    const preview = page.frameLocator('iframe[title="Story preview"]');
    const story = preview.locator("#storybook-root [role=alert]").first();
    await expectPrototypeFont(story);
  });
});
