import { expect, request as playwrightRequest, test } from "@playwright/test";
import { authenticatedBrowserContext, authenticatedRequest } from "../auth";
import { AUTH_PREVIEW_LEGACY_BASIC, SHARE_PROTOTYPE_ID, SHARE_PROTOTYPE_NAME } from "./fixture";

const mobileContextOptions = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
} as const;

test("owner creates, sees QR, and revokes a share from the player action slot", async ({ browser, baseURL }) => {
  expect(baseURL).toBeTruthy();
  const ownerRequest = await authenticatedRequest(baseURL!, { legacyBasicAuth: AUTH_PREVIEW_LEGACY_BASIC });
  const meta = await (await ownerRequest.get(`/api/prototypes/${SHARE_PROTOTYPE_ID}`)).json() as { headRev: number; latestVersion: number | null };
  if (meta.latestVersion === null) {
    expect((await ownerRequest.post(`/api/prototypes/${SHARE_PROTOTYPE_ID}/publish`, { data: { baseRev: meta.headRev, message: "Share UI e2e" } })).status()).toBe(201);
  }
  const ownerContext = await authenticatedBrowserContext(browser, baseURL!, { legacyBasicAuth: AUTH_PREVIEW_LEGACY_BASIC });
  const page = await ownerContext.newPage();
  await page.goto(`${baseURL}/p/${SHARE_PROTOTYPE_ID}`);
  const shareAction = page.getByRole("button", { name: "Поделиться" });
  await expect(shareAction).toBeEnabled();
  await shareAction.click();
  const dialog = page.getByRole("dialog", { name: "Поделиться прототипом" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Создать ссылку" }).click();
  const link = dialog.getByRole("textbox", { name: "Новая ссылка" });
  await expect(link).toHaveValue(/^http:\/\/127\.0\.0\.1:4174\/share\/[A-Za-z0-9_-]{43}$/);
  await expect(dialog.getByRole("img", { name: "QR-код ссылки" })).toBeVisible();
  await expect(dialog.getByText(/Версия \d+ · до/)).toBeVisible();
  await dialog.getByRole("button", { name: "Отозвать" }).click();
  await expect(dialog.getByText("Активных ссылок пока нет.")).toBeVisible();
  await ownerContext.close();
  await ownerRequest.dispose();
});

test("scoped share exchanges token, renders all resources, denies foreign scope, and dies on revoke", async ({ browser, baseURL }) => {
  expect(baseURL).toBeTruthy();
  const owner = await authenticatedRequest(baseURL!, { legacyBasicAuth: AUTH_PREVIEW_LEGACY_BASIC });
  const metaResponse = await owner.get(`/api/prototypes/${SHARE_PROTOTYPE_ID}`);
  expect(metaResponse.ok()).toBeTruthy();
  const meta = await metaResponse.json() as { headRev: number; latestVersion: number | null };
  let version = meta.latestVersion;
  if (version === null) {
    const published = await owner.post(`/api/prototypes/${SHARE_PROTOTYPE_ID}/publish`, { data: { baseRev: meta.headRev, message: "Share e2e" } });
    expect(published.status()).toBe(201);
    version = (await published.json() as { version: number }).version;
  }
  const createdResponse = await owner.post(`/api/prototypes/${SHARE_PROTOTYPE_ID}/share`, { data: { version, ttlSeconds: 3600 } });
  expect(createdResponse.status()).toBe(201);
  const grant = await createdResponse.json() as { id: string; url: string };
  expect(grant.url).toMatch(/^http:\/\/127\.0\.0\.1:4174\/share\/[A-Za-z0-9_-]{43}$/);
  const token = grant.url.split("/").at(-1)!;

  // QR/cross-origin contract: an unauthenticated client receives an absolute 303 and a
  // host-only cookie. It has no BasicAuth credentials and does not follow the redirect here.
  const anonymousRequest = await playwrightRequest.newContext({ baseURL });
  const exchange = await anonymousRequest.get(`/share/${token}`, { maxRedirects: 0 });
  expect(exchange.status()).toBe(303);
  expect(exchange.headers().location).toBe(`http://127.0.0.1:4174/share/p/${SHARE_PROTOTYPE_ID}/v/${version}/present/s/welcome`);
  const setCookie = exchange.headers()["set-cookie"] ?? "";
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Lax");
  expect(setCookie).toContain("Path=/");
  expect(setCookie).not.toContain("Domain=");
  expect(setCookie).not.toContain("Secure");
  await anonymousRequest.dispose();

  const shareContext = await browser.newContext(); // deliberately no httpCredentials
  const page = await shareContext.newPage();
  const failedResources: string[] = [];
  page.on("requestfailed", (request) => failedResources.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`));
  // Start at another browser origin, like a QR scanner/webview handing off to the absolute link.
  await page.goto("http://localhost:5173");
  const finalResponse = await page.goto(grant.url);
  expect(finalResponse?.ok()).toBeTruthy();
  await expect(page).toHaveURL(new RegExp(`/share/p/${SHARE_PROTOTYPE_ID}/v/${version}/present/s/welcome$`));
  expect(page.url()).not.toContain(token);
  await expect(page).toHaveTitle(`${SHARE_PROTOTYPE_NAME} v${version} · Просмотр — easy-ui`);
  await expect(page.getByRole("link", { name: "Открыть в easy-ui" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Галерея" })).toHaveCount(0);

  const cookies = await shareContext.cookies(baseURL!);
  const cookie = cookies.find((item) => item.name === "easy_ui_share");
  expect(cookie).toMatchObject({ domain: "127.0.0.1", path: "/", httpOnly: true, secure: false, sameSite: "Lax" });

  // Interactive presentation and its renderer resources all load through the cookie scope.
  const input = page.getByLabel("Name");
  await expect(input).toHaveValue("Ada");
  await input.fill("Lin");
  await page.getByRole("button", { name: "Details" }).click();
  await expect(page).toHaveURL(new RegExp(`/share/p/${SHARE_PROTOTYPE_ID}/v/${version}/present/s/details$`));
  await expect(page.getByText("Share fixture second screen.")).toBeVisible();
  expect(failedResources).toEqual([]);

  // BrowserContext.request shares the browser cookie jar, but gets no BasicAuth credentials.
  expect((await shareContext.request.get(`/api/prototypes/${SHARE_PROTOTYPE_ID}/versions/${version}`)).status()).toBe(200);
  expect((await shareContext.request.get("/api/prototypes")).status()).toBe(401);
  expect((await shareContext.request.get("/api/prototypes/checkout/versions/1")).status()).toBe(401);
  expect((await shareContext.request.get(`/api/prototypes/${SHARE_PROTOTYPE_ID}/versions/999`)).status()).toBe(401);
  expect((await shareContext.request.get(`/p/${SHARE_PROTOTYPE_ID}/v/${version}/present/s/welcome`)).status()).toBe(401);
  expect((await shareContext.request.post(`/api/prototypes/${SHARE_PROTOTYPE_ID}/versions/${version}`)).status()).toBe(401);

  const revoked = await owner.delete(`/api/prototypes/${SHARE_PROTOTYPE_ID}/share/${grant.id}`);
  expect(revoked.status()).toBe(204);
  const afterRevoke = await page.reload({ waitUntil: "domcontentloaded" });
  expect(afterRevoke?.status()).toBe(401);
  await expect(page.getByText("Unauthorized")).toBeVisible();

  await shareContext.close();
  await owner.dispose();
});

test("scoped share preserves mobile overrides through the 303 exchange", async ({ browser, baseURL }) => {
  expect(baseURL).toBeTruthy();
  const owner = await authenticatedRequest(baseURL!, { legacyBasicAuth: AUTH_PREVIEW_LEGACY_BASIC });
  const meta = await (await owner.get(`/api/prototypes/${SHARE_PROTOTYPE_ID}`)).json() as { headRev: number; latestVersion: number | null };
  let version = meta.latestVersion;
  if (version === null) {
    const published = await owner.post(`/api/prototypes/${SHARE_PROTOTYPE_ID}/publish`, {
      data: { baseRev: meta.headRev, message: "Mobile share override e2e" },
    });
    expect(published.status()).toBe(201);
    version = (await published.json() as { version: number }).version;
  }

  for (const mobile of ["1", "0"] as const) {
    const created = await owner.post(`/api/prototypes/${SHARE_PROTOTYPE_ID}/share`, { data: { version, ttlSeconds: 3600 } });
    expect(created.status()).toBe(201);
    const grant = await created.json() as { id: string; url: string };
    const context = await browser.newContext({ baseURL, ...mobileContextOptions });
    const page = await context.newPage();
    let exchangeLocation: string | undefined;
    page.on("response", (response) => {
      if (response.status() === 303 && response.url().startsWith(grant.url)) {
        exchangeLocation = response.headers().location;
      }
    });

    const finalResponse = await page.goto(`${grant.url}?mobile=${mobile}`);
    expect(finalResponse?.ok()).toBeTruthy();
    expect(exchangeLocation).toContain(`mobile=${mobile}`);
    await expect(page).toHaveURL(new RegExp(`/share/p/${SHARE_PROTOTYPE_ID}/v/${version}/present/s/welcome\\?mobile=${mobile}$`));
    if (mobile === "1") {
      await expect(page.locator('[data-eui-stage-viewport="present-fluid"]')).toBeVisible();
      await expect(page.locator("footer")).toHaveCount(0);
    } else {
      await expect(page.getByRole("region", { name: "Превью прототипа на устройстве" })).toBeVisible();
      await expect(page.locator('[data-eui-stage-viewport="player"]')).toBeVisible();
      await expect(page.locator("footer")).toBeVisible();
    }

    await context.close();
    await owner.delete(`/api/prototypes/${SHARE_PROTOTYPE_ID}/share/${grant.id}`);
  }
  await owner.dispose();
});
