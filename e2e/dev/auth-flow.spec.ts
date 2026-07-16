import { expect, test } from "@playwright/test";
import { authenticatedBrowserContext, E2E_ADMIN_NAME, E2E_ADMIN_PASSWORD } from "../auth";

test("redirects to login with next and establishes a session", async ({ browser, baseURL }) => {
  expect(baseURL).toBeTruthy();
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto("/users");
  await expect(page).toHaveURL(/\/login\?next=%2Fusers$/);
  await page.getByLabel("Имя").fill(E2E_ADMIN_NAME);
  await page.getByLabel("Пароль").fill(E2E_ADMIN_PASSWORD);
  const loginResponse = page.waitForResponse((response) => response.url().endsWith("/api/auth/login"));
  await page.getByRole("button", { name: "Войти" }).click();
  expect((await loginResponse).status()).toBe(200);
  await expect(page).toHaveURL(/\/users$/);
  expect((await context.cookies()).some((cookie) => cookie.name === "easyui_session")).toBe(true);
  expect((await context.request.get(`${baseURL}/api/auth/me`)).status()).toBe(200);
  await context.close();
});

test("logout button revokes the session and returns to login", async ({ browser, baseURL }) => {
  expect(baseURL).toBeTruthy();
  const context = await authenticatedBrowserContext(browser, baseURL!);
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: "Выйти" }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/auth/me")).status()).toBe(401);
  await context.close();
});
