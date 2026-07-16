import { expect, test, type Page } from "@playwright/test";
import {
  COMPONENT_PAGE_IDS,
  CUSTOM_DS_COMPONENT_ID,
  ensureComponentPageFixtures,
} from "./dev/custom-ds.fixture";

const pageUrl = (id: string, version = 1) => `/library/c/${id}?v=${version}`;

async function commitText(page: Page, name: string, value: string) {
  const input = page.getByLabel(name, { exact: true });
  await input.fill(value);
  await input.blur();
}

export function componentPageSuite(options: { api: string; seed: boolean; customDsName?: string }) {
  test.describe("component showcase page", () => {
    test.beforeAll(async ({ request }) => {
      if (options.seed) await ensureComponentPageFixtures(request, options.api, options.customDsName);
    });

    test("opens directly and applies live props without reloading", async ({ page }) => {
      await page.goto(pageUrl(COMPONENT_PAGE_IDS.propsBadge, 2));
      const badge = page.locator("[data-props-badge]");
      await expect(badge).toHaveText("Version two · neutral");

      await commitText(page, "label", "Live label");
      await page.getByLabel("tone", { exact: true }).selectOption({ label: "danger" });
      await expect(badge).toHaveText("Live label · danger");
      await expect(page).toHaveURL(/\/library\/c\/e2e-props-badge\?v=2$/);
    });

    test("keeps local state on valid prop changes and recovers after a render error", async ({ page }) => {
      await page.goto(pageUrl(COMPONENT_PAGE_IDS.localState));
      const fixture = page.locator("[data-local-state]");
      const counter = fixture.getByRole("button", { name: "count: 0" });
      await counter.click();
      await fixture.getByRole("button", { name: "count: 1" }).click();
      await commitText(page, "label", "beta");
      await expect(fixture.getByText("prop: beta")).toBeVisible();
      await expect(fixture.getByRole("button", { name: "count: 2" })).toBeVisible();

      await page.getByRole("switch", { name: "crash" }).click();
      await expect(page.getByText("Компонент завершился с ошибкой. Исправьте props, чтобы восстановить превью.")).toBeVisible();
      await page.getByRole("switch", { name: "crash" }).click();
      await expect(page.locator("[data-local-state]").getByText("prop: beta")).toBeVisible();
      await expect(page.locator("[data-local-state]").getByRole("button", { name: "count: 0" })).toBeVisible();
    });

    test("keeps the last valid preview when one field is invalid", async ({ page }) => {
      await page.goto(pageUrl(COMPONENT_PAGE_IDS.typedEvents));
      await expect(page.getByRole("button", { name: "★★★" })).toBeVisible();
      const value = page.getByLabel("value", { exact: true });
      await value.fill("9");
      await value.blur();
      const describedBy = await value.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      await expect(page.locator(`#${describedBy}`)).toBeVisible();
      await expect(page.getByRole("button", { name: "★★★" })).toBeVisible();
      await expect(page.getByRole("button", { name: "★★★★★★★★★" })).toHaveCount(0);
    });

    test("accumulates two required props before mounting the preview", async ({ page }) => {
      await page.goto(pageUrl(COMPONENT_PAGE_IDS.requiredPair));
      await expect(page.getByText("Заполните обязательные props")).toBeVisible();
      await expect(page.locator("[data-required-pair]")).toHaveCount(0);
      await commitText(page, "first", "left");
      await expect(page.getByText("Заполните обязательные props")).toBeVisible();
      await commitText(page, "second", "right");
      await expect(page.locator("[data-required-pair]")).toHaveText("left + right");
    });

    test("shows event docs and escapes source HTML on the code tab", async ({ page }) => {
      await page.goto(pageUrl(COMPONENT_PAGE_IDS.typedEvents));
      await page.getByRole("tab", { name: "Документация" }).click();
      const events = page.getByRole("table", { name: "События компонента" });
      await expect(events.getByRole("row", { name: /rate/ })).toContainText("value");
      await expect(page.getByRole("table", { name: "Props компонента" }).getByRole("row", { name: /value/ })).toContainText("максимум: 5");

      await page.goto(pageUrl(COMPONENT_PAGE_IDS.propsBadge, 2));
      await page.getByRole("tab", { name: "Код" }).click();
      const codePanel = page.getByRole("tabpanel", { name: "Код" });
      const attack = '<script>globalThis.componentPagePwned = true</script>';
      await expect(codePanel.locator("pre")).toContainText(attack);
      await expect(codePanel.locator("script")).toHaveCount(0);
      expect(await page.evaluate(() => (globalThis as typeof globalThis & { componentPagePwned?: boolean }).componentPagePwned)).toBeUndefined();
    });

    test("switches versions while preserving the tab and distinguishes invalid from missing versions", async ({ page }) => {
      await page.goto(pageUrl(COMPONENT_PAGE_IDS.propsBadge, 2));
      await page.getByRole("tab", { name: "Документация" }).click();
      await expect(page.getByText("Props badge version two", { exact: true })).toBeVisible();
      await page.getByLabel("Версия").selectOption("1");
      await expect(page).toHaveURL(/\?v=1$/);
      await expect(page.getByRole("tab", { name: "Документация" })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByText("Props badge version one", { exact: true })).toBeVisible();

      for (const query of ["v=1&v=2", "v=0", "v=01", "v=nope"]) {
        await page.goto(`/library/c/${COMPONENT_PAGE_IDS.propsBadge}?${query}`);
        await expect(page.getByRole("heading", { name: "Некорректный адрес компонента." })).toBeVisible();
      }
      await page.goto(pageUrl(COMPONENT_PAGE_IDS.propsBadge, 999));
      await expect(page.getByText("Версия компонента не найдена.")).toBeVisible();
    });

    test("does not request a rejected version bundle", async ({ page }) => {
      let bundleRequests = 0;
      await page.route("**/components/e2e-rejected-badge/versions/1/bundle.js*", async (route) => {
        bundleRequests += 1;
        await route.abort();
      });
      await page.goto(pageUrl(COMPONENT_PAGE_IDS.rejected));
      await expect(page.getByRole("heading", { name: "Исполнение запрещено статусом версии" })).toBeVisible();
      await expect(page.getByText("Версия имеет статус «Отклонена». Бандл не загружается.")).toBeVisible();
      expect(bundleRequests).toBe(0);
    });

    test("retries a failed root bundle once with a new request", async ({ page }) => {
      let bundleRequests = 0;
      await page.route("**/components/e2e-props-badge/versions/1/bundle.js*", async (route) => {
        bundleRequests += 1;
        if (bundleRequests === 1) {
          await route.fulfill({ status: 500, contentType: "text/javascript", body: "throw new Error('first bundle failure')" });
          return;
        }
        await route.continue();
      });
      await page.goto(pageUrl(COMPONENT_PAGE_IDS.propsBadge));
      await expect(page.locator("[data-props-badge]")).toHaveText("Version one · neutral");
      expect(bundleRequests).toBe(2);
    });

    test("escalates a poisoned shim to a full document reload", async ({ page }) => {
      let failShim = true;
      let failedShimRequests = 0;
      let bundleRequests = 0;
      page.on("request", (request) => {
        if (/\/components\/e2e-props-badge\/versions\/1\/bundle\.js/.test(request.url())) bundleRequests += 1;
      });
      await page.route((url) => /^\/api\/shims\/v\d+\/zod\.js$/.test(url.pathname), async (route) => {
        if (failShim) {
          failedShimRequests += 1;
          await route.fulfill({ status: 500, contentType: "text/javascript", body: "throw new Error('shim failure')" });
          return;
        }
        await route.continue();
      });

      await page.goto(pageUrl(COMPONENT_PAGE_IDS.propsBadge));
      await expect(page.getByText("Повторная загрузка в SPA не помогла. Перезагрузите страницу целиком.")).toBeVisible();
      expect(failedShimRequests).toBe(1);
      expect(bundleRequests).toBe(2);

      failShim = false;
      await page.getByRole("button", { name: "Перезагрузить страницу" }).click();
      await expect(page.locator("[data-props-badge]")).toHaveText("Version one · neutral");
      expect(bundleRequests).toBe(3);
    });

    test("injects placeholders according to named, slotless, and legacy contracts", async ({ page }) => {
      await page.goto(pageUrl(COMPONENT_PAGE_IDS.namedSlots));
      await expect(page.locator("[data-preview-placeholder]")).toHaveText(["Слот: header", "Слот: items", "Слот: default"]);

      await page.goto(pageUrl(COMPONENT_PAGE_IDS.childSensitive));
      await expect(page.locator("[data-child-sensitive]")).toHaveText("slotless: no children");
      await expect(page.locator("[data-preview-placeholder]")).toHaveCount(0);

      await page.goto(pageUrl(COMPONENT_PAGE_IDS.legacySlots));
      await expect(page.locator("[data-preview-placeholder]")).toHaveCount(1);
      await expect(page.locator("[data-preview-placeholder]")).toHaveText("Слот: default");
    });

    test("supports keyboard tab navigation and the registry-only design-system path", async ({ page }) => {
      await page.goto(pageUrl(CUSTOM_DS_COMPONENT_ID));
      await expect(page.getByRole("button", { name: "★★★" })).toBeVisible();

      const component = page.getByRole("tab", { name: "Компонент" });
      const docs = page.getByRole("tab", { name: "Документация" });
      const code = page.getByRole("tab", { name: "Код" });
      await component.focus();
      await component.press("ArrowRight");
      await expect(docs).toBeFocused();
      await expect(docs).toHaveAttribute("aria-selected", "true");
      await docs.press("End");
      await expect(code).toBeFocused();
      await expect(code).toHaveAttribute("aria-selected", "true");
      await code.press("Home");
      await expect(component).toBeFocused();
      await expect(component).toHaveAttribute("aria-selected", "true");
      await component.press("ArrowLeft");
      await expect(code).toBeFocused();
      await expect(code).toHaveAttribute("aria-selected", "true");
    });
  });
}
