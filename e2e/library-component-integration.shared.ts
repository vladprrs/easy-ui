import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  COMPONENT_PAGE_IDS,
  CUSTOM_DS_ID,
  ensureComponentPageFixtures,
} from "./dev/custom-ds.fixture";

const COMPONENT_NAME = "E2ePropsBadge";
const COMPONENT_VERSION = 2;

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function propsBadgeV2IsReady(request: APIRequestContext, api: string) {
  const response = await request.get(`${api}/components/${COMPONENT_PAGE_IDS.propsBadge}`);
  if (!response.ok()) return false;
  const meta = await response.json() as { publishedVersion?: number | null };
  return meta.publishedVersion === COMPONENT_VERSION;
}

async function ensureFixtures(request: APIRequestContext, options: { api: string; customDsName?: string }) {
  // component-page.spec may be seeding the same preview DB in another worker. Its seed is
  // idempotent for a warm DB, but deliberately not a concurrent upsert, so let that worker
  // finish when its first (cheap) design-system write proves that it already started.
  let concurrentSeed = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await request.get(`${options.api}/design-systems/${CUSTOM_DS_ID}`)).ok()) {
      concurrentSeed = true;
      break;
    }
    await pause(100);
  }

  if (!concurrentSeed) {
    await ensureComponentPageFixtures(request, options.api, options.customDsName);
    return;
  }

  for (let attempt = 0; attempt < 480; attempt += 1) {
    if (await propsBadgeV2IsReady(request, options.api)) return;
    await pause(250);
  }
  throw new Error("W5a fixture seed did not publish e2e-props-badge v2 in time");
}

async function openFixtureCard(page: Page) {
  await page.locator('[aria-label="Дизайн-системы"]').getByRole("button", { name: "E2E Starter", exact: true }).click();
  await page.getByRole("navigation", { name: "Компоненты" }).getByRole("button", { name: COMPONENT_NAME, exact: true }).click();
  const link = page.getByRole("link", { name: "Страница компонента" });
  await expect(link).toHaveAttribute("href", `/library/c/${COMPONENT_PAGE_IDS.propsBadge}?v=${COMPONENT_VERSION}`);
  await link.click();
}

export function libraryComponentIntegrationSuite(options: { api: string; seed: boolean; customDsName?: string }) {
  test.describe("Library component-page integration", () => {
    test.beforeAll(async ({ request }) => {
      if (options.seed) await ensureFixtures(request, options);
    });

    test("opens the manifest-entry version from Library and returns with browser Back", async ({ page }) => {
      await page.goto("/library");
      await openFixtureCard(page);

      await expect(page).toHaveURL(`/library/c/${COMPONENT_PAGE_IDS.propsBadge}?v=${COMPONENT_VERSION}`);
      await expect(page.locator("[data-props-badge]")).toHaveText("Version two · neutral");

      await page.goBack();
      await expect(page).toHaveURL(/\/library$/);
      await expect(page.getByRole("heading", { name: "Библиотека компонентов" })).toBeVisible();
    });

    test("keeps the document alive across Gallery, Library, and component-page SPA navigation", async ({ page }) => {
      await page.goto("/");
      await expect(page.locator('[data-gallery-preview-mounted="true"]').first()).toBeVisible();
      await expect(page.locator("head style[data-eui-theme]")).toHaveCount(1);

      const documentMarker = await page.evaluate(() => {
        const marker = `w5b-${crypto.randomUUID()}`;
        (window as Window & { __w5bDocumentMarker?: string }).__w5bDocumentMarker = marker;
        return marker;
      });

      await page.getByRole("link", { name: "Библиотека" }).click();
      await expect(page).toHaveURL(/\/library$/);
      await openFixtureCard(page);

      await expect(page.locator("[data-props-badge]")).toHaveText("Version two · neutral");
      expect(await page.evaluate(() => (window as Window & { __w5bDocumentMarker?: string }).__w5bDocumentMarker)).toBe(documentMarker);
    });
  });
}
